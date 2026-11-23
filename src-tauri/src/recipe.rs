//! Recipe format. A recipe is a folder holding `recipe.json` plus whatever
//! it references (install script, ComfyUI API workflow).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hardware::Hardware;
use crate::settings::Layout;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub schema: u32,
    pub id: String,
    pub version: String,
    pub name: Localized,
    pub summary: Localized,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub license_note: Option<Localized>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub requires: Requires,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub downloads: Vec<Download>,
    pub setup: Setup,
    pub run: Run,
    #[serde(default)]
    pub studio: Option<Studio>,

    /// Folder the recipe was loaded from. Filled in at load time.
    #[serde(skip)]
    pub dir: PathBuf,
    #[serde(skip_deserializing, default)]
    pub source: String,
}

/// Either a plain string or a map of language code to string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Localized {
    Plain(String),
    Map(HashMap<String, String>),
}

impl Localized {
    /// Text for `lang`, else English, else whatever is there.
    pub fn pick(&self, lang: &str) -> String {
        match self {
            Localized::Plain(s) => s.clone(),
            Localized::Map(m) => m
                .get(lang)
                .or_else(|| m.get("en"))
                .or_else(|| m.values().next())
                .cloned()
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requires {
    #[serde(default)]
    pub arch: Vec<String>,
    #[serde(default)]
    pub min_memory_gb: f64,
    #[serde(default)]
    pub recommended_memory_gb: f64,
    #[serde(default)]
    pub disk_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    /// Path relative to the shared models folder.
    pub to: String,
    #[serde(default)]
    pub license: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setup {
    /// Script path relative to the recipe folder.
    pub script: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    /// Command template; first element is run through /bin/bash.
    pub script: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub port: u16,
    #[serde(default = "default_health")]
    pub health: String,
}

fn default_health() -> String {
    "/".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Studio {
    /// ComfyUI API-format workflow, relative to the recipe folder.
    pub workflow: String,
    pub controls: Vec<Control>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Control {
    pub key: String,
    pub label: Localized,
    /// text | textarea | int | float | seed | select | image | video
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub default: Value,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub choices: Vec<Value>,
    /// The form refuses to run while this control is empty.
    #[serde(default)]
    pub required: bool,
    /// Which part of the last Previs export can fill this control:
    /// still | video | control | prompt | width | height | frames
    #[serde(default)]
    pub previs: Option<String>,
    /// Workflow node inputs this control writes to.
    pub targets: Vec<Target>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    pub node: String,
    pub input: String,
}

fn safe_relative(p: &str) -> bool {
    let path = Path::new(p);
    !p.is_empty()
        && path.is_relative()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}

impl Recipe {
    pub fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA {
            bail!("unsupported recipe schema {}", self.schema);
        }
        let id_ok = !self.id.is_empty()
            && self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            bail!("recipe id must be lowercase letters, digits and hyphens");
        }
        if !safe_relative(&self.setup.script) {
            bail!("setup.script must be a relative path inside the recipe folder");
        }
        for d in &self.downloads {
            let u = url::Url::parse(&d.url).with_context(|| format!("bad url {}", d.url))?;
            if u.scheme() != "https" {
                bail!("downloads must use https: {}", d.url);
            }
            if d.sha256.len() != 64 || !d.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                bail!("bad sha256 for {}", d.to);
            }
            if !safe_relative(&d.to) {
                bail!("download target must be a relative path: {}", d.to);
            }
        }
        if let Some(s) = &self.studio {
            if !safe_relative(&s.workflow) {
                bail!("studio.workflow must be a relative path inside the recipe folder");
            }
        }
        Ok(())
    }

    pub fn load(dir: &Path, source: &str) -> Result<Recipe> {
        let file = dir.join("recipe.json");
        let bytes = std::fs::read(&file).with_context(|| format!("read {}", file.display()))?;
        let mut r: Recipe =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", file.display()))?;
        r.dir = dir.to_path_buf();
        r.source = source.to_string();
        r.validate().with_context(|| format!("recipe {}", file.display()))?;
        Ok(r)
    }

    pub fn download_bytes(&self) -> u64 {
        self.downloads.iter().map(|d| d.bytes).sum()
    }

    /// "good" | "tight" | "no"
    pub fn fit(&self, hw: &Hardware) -> &'static str {
        let arch_ok = self.requires.arch.is_empty() || self.requires.arch.iter().any(|a| a == &hw.arch);
        if !arch_ok || hw.memory_gb + 0.5 < self.requires.min_memory_gb {
            "no"
        } else if hw.memory_gb + 0.5 < self.requires.recommended_memory_gb {
            "tight"
        } else {
            "good"
        }
    }
}

/// Bundled recipes first, then the user's own folder; a user recipe with the
/// same id replaces the bundled one. Broken recipes are reported, not fatal.
pub fn load_all(bundled: &Path, layout: &Layout) -> (Vec<Recipe>, Vec<String>) {
    let mut by_id: Vec<Recipe> = Vec::new();
    let mut problems = Vec::new();
    for (root, source) in [(bundled.to_path_buf(), "bundled"), (layout.user_recipes(), "user")] {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("recipe.json").is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            match Recipe::load(&dir, source) {
                Ok(r) => {
                    by_id.retain(|x| x.id != r.id);
                    by_id.push(r);
                }
                Err(e) => problems.push(format!("{e:#}")),
            }
        }
    }
    (by_id, problems)
}

/// Replace `{recipe_dir}` style placeholders.
pub fn expand(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

pub fn vars(recipe: &Recipe, layout: &Layout) -> Vec<(&'static str, String)> {
    vec![
        ("app_dir", layout.app(&recipe.id).to_string_lossy().to_string()),
        ("models_dir", layout.models().to_string_lossy().to_string()),
        ("tools_dir", layout.tools().to_string_lossy().to_string()),
        ("recipe_dir", recipe.dir.to_string_lossy().to_string()),
        ("port", recipe.run.port.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_relative("checkpoints/a.safetensors"));
        assert!(!safe_relative("../a"));
        assert!(!safe_relative("/etc/passwd"));
        assert!(!safe_relative("a/../../b"));
    }

    #[test]
    fn expands_placeholders() {
        let v = vec![("app_dir", "/x/y".to_string()), ("port", "8188".to_string())];
        assert_eq!(expand("{app_dir}/start.sh:{port}", &v), "/x/y/start.sh:8188");
    }

    #[test]
    fn bundled_recipes_are_valid() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("recipes");
        let layout = Layout::new(PathBuf::from("/nonexistent"));
        let (recipes, problems) = load_all(&dir, &layout);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(!recipes.is_empty());
        for r in recipes {
            assert!(r.dir.join(&r.setup.script).is_file(), "missing setup script");
            if let Some(s) = &r.studio {
                let wf: Value =
                    serde_json::from_slice(&std::fs::read(r.dir.join(&s.workflow)).unwrap()).unwrap();
                for c in &s.controls {
                    for t in &c.targets {
                        assert!(wf[&t.node]["inputs"].get(&t.input).is_some(), "{}.{}", t.node, t.input);
                    }
                }
            }
        }
    }
}
