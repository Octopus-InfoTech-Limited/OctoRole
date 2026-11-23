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

// A batch can remove intermediate clips after its final outputs have been verified.
#[derive(serde::Deserialize)]
struct ProgressGroup {
    label: String,
    steps: Vec<Vec<String>>,
    outputs: Vec<String>,
}

fn group_counts(root: &std::path::Path, group: &ProgressGroup) -> Value {
    let ready = |files: &[String]| !files.is_empty() && files.iter().all(|file| {
        let path = std::path::Path::new(file);
        !path.as_os_str().is_empty()
            && path.components().all(|c| matches!(c, std::path::Component::Normal(_)))
            && root.join(path).is_file()
    });
    let total = group.steps.len();
    let delivered = ready(&group.outputs);
    let done = if delivered { total } else { group.steps.iter().filter(|files| ready(files)).count() };
    json!({"label": group.label, "done": done, "total": total, "delivered": delivered})
}

#[tauri::command]
pub fn project_status(state: State<'_, AppState>) -> Value {
    let root = state.layout().project_root();
    let mut groups = Vec::new();
    for name in ["production-plan.json", "hyperflow/production-plan.json"] {
        if let Some(batch) = fs::File::open(root.join(name)).ok()
            .and_then(|file| serde_json::from_reader::<_, Vec<ProgressGroup>>(file.take(1024 * 1024)).ok()) {
            groups.extend(batch);
        }
    }
    let counts: Vec<_> = groups.iter().map(|group| group_counts(&root, group)).collect();
    json!({"groups": counts, "message": recent_log(&root.join("production.log"))})
}

fn recent_log(path: &std::path::Path) -> String {
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
    fn progress_requires_both_versions_and_survives_segment_cleanup() {
        let tmp = std::env::temp_dir().join(format!("octorole-progress-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let g = ProgressGroup { label: "E01".into(), steps: vec![vec!["y".into(), "m".into()]],
            outputs: vec!["final-y".into(), "final-m".into()] };
        fs::write(tmp.join("y"), []).unwrap();
        assert_eq!(group_counts(&tmp,&g)["done"],0);
        fs::write(tmp.join("m"), []).unwrap();
        assert_eq!(group_counts(&tmp,&g)["done"],1);
        fs::remove_file(tmp.join("y")).unwrap();
        for f in &g.outputs { fs::write(tmp.join(f), []).unwrap(); }
        assert_eq!(group_counts(&tmp,&g)["delivered"],true);
        assert_eq!(group_counts(&tmp,&g)["done"],1);
        fs::remove_dir_all(tmp).unwrap();
    }

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
