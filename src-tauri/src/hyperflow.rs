use crate::{msg, AppState, CmdResult};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

fn assets(app: &AppHandle) -> CmdResult<PathBuf> {
    let folder = app.path().resource_dir().map_err(msg)?.join("hyperflow");
    if cfg!(debug_assertions) && !folder.join("render.py").is_file() {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("hyperflow"));
    }
    Ok(folder)
}

#[tauri::command]
pub fn h3_defaults() -> CmdResult<Value> {
    serde_json::from_str(include_str!("../hyperflow/story.json")).map_err(msg)
}

#[tauri::command]
pub async fn h3_start(app: AppHandle, setup: Option<bool>) -> CmdResult<()> {
    let status = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(assets(&app)?.join(if setup.unwrap_or(false) {
            "setup.sh"
        } else {
            "Start HyperFlow.command"
        }))
        .status()
        .await
        .map_err(msg)?;
    if !status.success() {
        return Err("Could not open the engine in Terminal.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn h3_render(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Value,
) -> CmdResult<String> {
    let root = state.layout().root;
    let mut child = Command::new("/usr/bin/python3")
        .arg("-u")
        .arg(assets(&app)?.join("render.py"))
        .arg("--root")
        .arg(&root)
        .args(["--project", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(msg)?;
    let mut input = child.stdin.take().ok_or("Missing renderer input")?;
    input
        .write_all(project.to_string().as_bytes())
        .await
        .map_err(msg)?;
    drop(input);
    let mut lines = BufReader::new(child.stdout.take().ok_or("Missing renderer output")?).lines();
    let events = app.clone();
    let progress = async move {
        let mut last = String::new();
        while let Some(line) = lines.next_line().await? {
            if line.starts_with("Shot ") {
                let _ = events.emit("octorole://h3", &line);
            }
            last = line;
        }
        Ok::<_, std::io::Error>(last)
    };
    let (last, result) = tokio::join!(progress, child.wait_with_output());
    let output = result.map_err(msg)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .rev()
            .take(2500)
            .collect::<String>()
            .chars()
            .rev()
            .collect());
    }
    last.map_err(msg)
}
