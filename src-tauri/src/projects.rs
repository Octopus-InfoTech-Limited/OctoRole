use crate::{allow_works, msg, previs, settings::Settings, AppState, CmdResult};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn project_list(state: State<'_, AppState>) -> Value {
    let s = state.settings();
    let base = s.root_dir().join("projects");
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) && previs::check_name(&name).is_ok() {
                names.push(name);
            }
        }
    }
    names.sort();
    json!({"active": s.project, "names": names, "root": s.root_dir()})
}

#[tauri::command]
pub fn project_open(app: AppHandle, state: State<'_, AppState>, name: String, create: bool) -> CmdResult<()> {
    let mut current = state.settings.lock().unwrap();
    let mut next: Settings = current.clone();
    if name.is_empty() && !create {
        next.project = None;
    } else {
        let name = previs::check_name(&name).map_err(msg)?;
        let base = next.root_dir().join("projects");
        fs::create_dir_all(&base).map_err(msg)?;
        let path = base.join(name);
        if create {
            fs::create_dir(&path).map_err(msg)?;
        } else if !fs::symlink_metadata(&path).map_err(msg)?.is_dir() {
            return Err("Project folder unavailable".into());
        }
        next.project = Some(name.into());
    }
    next.save(&state.settings_file).map_err(msg)?;
    allow_works(&app, &next.layout());
    *current = next;
    Ok(())
}

#[tauri::command]
pub fn project_status(state: State<'_, AppState>) -> String {
    let path = state.layout().project_root().join("production.log");
    let Ok(mut file) = fs::File::open(path) else { return String::new() };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(8192))).is_err() { return String::new() }
    let mut tail = Vec::new();
    if file.take(8192).read_to_end(&mut tail).is_err() { return String::new() }
    let lines = String::from_utf8_lossy(&tail);
    let recent: Vec<_> = lines.lines().rev().take(3).collect();
    recent.into_iter().rev().collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_separate_works_and_scenes_but_share_engines_and_models() {
        let mut settings = Settings { root: Some("/tmp/studio".into()), ..Default::default() };
        let legacy = settings.layout();
        settings.project = Some("第一套".into());
        let first = settings.layout();
        settings.project = Some("第二套".into());
        let second = settings.layout();
        assert_eq!(legacy.works(), legacy.root.join("works"));
        assert_eq!(first.works(), legacy.root.join("projects/第一套/works"));
        assert_ne!(first.previs(), second.previs());
        assert_eq!(first.models(), second.models());
        assert_eq!(first.apps(), legacy.apps());
        settings.project = Some("../outside".into());
        assert_eq!(settings.layout().works(), legacy.works());
    }
}
