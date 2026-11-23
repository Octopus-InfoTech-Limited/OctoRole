//! Previs scenes on disk: `<root>/previs/<name>/scene.json` plus exported files.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;

const MAX_SCENE_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 400 * 1024 * 1024;
/// The only file names the UI may write into a scene folder.
const EXPORT_FILES: &[&str] = &["previs.mp4", "previs.webm", "still.png", "control.png", "prompt.txt"];

#[derive(Serialize)]
pub struct SceneInfo {
    pub name: String,
    pub modified: u64,
    pub dir: String,
}

/// A scene name becomes a folder name, so it must be one plain path component.
pub fn check_name(name: &str) -> Result<&str> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 60 {
        bail!("scene name must be 1 to 60 characters");
    }
    if n.starts_with('.') || n.ends_with('.') || n.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c)) {
        bail!("scene name contains characters that cannot be used in a folder name");
    }
    Ok(n)
}

fn scene_dir(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(root.join(check_name(name)?))
}

fn modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn list(root: &Path) -> Vec<SceneInfo> {
    let mut out: Vec<SceneInfo> = std::fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let file = e.path().join("scene.json");
                    let name = e.file_name().to_string_lossy().to_string();
                    (file.is_file() && check_name(&name).is_ok()).then(|| SceneInfo {
                        name,
                        modified: modified(&file),
                        dir: e.path().to_string_lossy().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    out
}

pub fn save(root: &Path, name: &str, scene: &Value) -> Result<PathBuf> {
    if !scene.is_object() {
        bail!("scene must be an object");
    }
    let bytes = serde_json::to_vec_pretty(scene)?;
    if bytes.len() > MAX_SCENE_BYTES {
        bail!("scene is too large");
    }
    let dir = scene_dir(root, name)?;
    std::fs::create_dir_all(&dir)?;
    // Write then rename so a crash never leaves half a scene behind.
    let tmp = dir.join("scene.json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dir.join("scene.json"))?;
    Ok(dir)
}

pub fn load(root: &Path, name: &str) -> Result<Value> {
    let file = scene_dir(root, name)?.join("scene.json");
    let bytes = std::fs::read(&file).with_context(|| format!("cannot open scene {name}"))?;
    if bytes.len() > MAX_SCENE_BYTES {
        bail!("scene is too large");
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn delete(root: &Path, name: &str) -> Result<()> {
    let dir = scene_dir(root, name)?;
    if !dir.join("scene.json").is_file() {
        bail!("no such scene");
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

/// Writes one exported file (base64 from the UI) next to the scene.
pub fn export(root: &Path, name: &str, file: &str, data_base64: &str) -> Result<PathBuf> {
    if !EXPORT_FILES.contains(&file) {
        bail!("unexpected export file name");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .context("export data is not valid base64")?;
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES {
        bail!("export is empty or too large");
    }
    let dir = scene_dir(root, name)?;
    std::fs::create_dir_all(&dir)?;
    if file.starts_with("previs.") {
        // Only one video per scene: drop the other container if it exists.
        for other in ["previs.mp4", "previs.webm"] {
            if other != file {
                let _ = std::fs::remove_file(dir.join(other));
            }
        }
    }
    let path = dir.join(file);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_names_that_escape_the_folder() {
        for bad in ["", "  ", "..", ".hidden", "a/b", "a\\b", "x:y", "tail.", "new\nline", &"n".repeat(61)] {
            assert!(check_name(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in ["Scene 1", "天台黃昏", "shot_02-b"] {
            assert!(check_name(good).is_ok(), "{good:?} should be accepted");
        }
    }

    #[test]
    fn scene_round_trip_and_export() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let scene = json!({"version": 1, "name": "天台", "actors": []});
        save(root, "天台", &scene).unwrap();
        assert_eq!(load(root, "天台").unwrap(), scene);
        assert_eq!(list(root).len(), 1);

        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake");
        let path = export(root, "天台", "still.png", &png).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"\x89PNG fake");
        assert!(export(root, "天台", "../evil.sh", &png).is_err());
        assert!(export(root, "天台", "still.png", "not base64!").is_err());

        export(root, "天台", "previs.webm", &png).unwrap();
        export(root, "天台", "previs.mp4", &png).unwrap();
        assert!(!root.join("天台/previs.webm").exists());

        assert!(delete(root, "../天台").is_err());
        delete(root, "天台").unwrap();
        assert!(list(root).is_empty());
        assert!(delete(root, "天台").is_err());
    }
}
