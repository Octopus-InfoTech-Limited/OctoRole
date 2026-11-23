use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Where apps, models and works live. Defaults to ~/OctoRole.
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    /// Hugging Face token, only ever sent to huggingface.co.
    #[serde(default)]
    pub hf_token: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        std::fs::read(file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> anyhow::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn layout(&self) -> Layout {
        let mut layout = Layout::new(self.root_dir());
        layout.project = self.project.as_deref().and_then(|n| crate::previs::check_name(n).ok()).map(String::from);
        layout
    }

    pub fn root_dir(&self) -> PathBuf {
        match self.root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(r) => PathBuf::from(r),
            None => dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("OctoRole"),
        }
    }
}

/// Folder layout under the root.
pub struct Layout {
    pub root: PathBuf,
    project: Option<String>,
}

impl Layout {
    pub fn new(root: PathBuf) -> Self {
        Self { root, project: None }
    }
    pub fn apps(&self) -> PathBuf {
        self.root.join("apps")
    }
    pub fn app(&self, id: &str) -> PathBuf {
        self.apps().join(id)
    }
    pub fn models(&self) -> PathBuf {
        self.root.join("models")
    }
    pub fn project_root(&self) -> PathBuf {
        match &self.project {
            Some(name) => self.root.join("projects").join(name),
            None => self.root.clone(),
        }
    }
    pub fn works(&self) -> PathBuf {
        self.project_root().join("works")
    }
    pub fn tools(&self) -> PathBuf {
        self.root.join("tools")
    }
    pub fn previs(&self) -> PathBuf {
        self.project_root().join("previs")
    }
    pub fn user_recipes(&self) -> PathBuf {
        self.root.join("recipes")
    }
    pub fn marker(&self, id: &str) -> PathBuf {
        self.app(id).join(".octorole-installed.json")
    }
}
