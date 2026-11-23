use crate::{msg, AppState, CmdResult};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager, State};
use tokio::{io::AsyncWriteExt, process::Command};

fn resources(app: &AppHandle) -> CmdResult<PathBuf> {
    let path = app.path().resource_dir().map_err(msg)?.join("tts");
    if cfg!(debug_assertions) && !path.is_dir() {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tts"));
    }
    Ok(path)
}

#[tauri::command]
pub async fn dialogue_setup(app: AppHandle) -> CmdResult<()> {
    let result = Command::new("/usr/bin/open").args(["-a", "Terminal"])
        .arg(resources(&app)?.join("Install voices.command")).status().await.map_err(msg)?;
    if result.success() { Ok(()) } else { Err("Could not open installer".into()) }
}

#[tauri::command]
pub async fn dialogue_render(app: AppHandle, state: State<'_, AppState>, spec: Value) -> CmdResult<Value> {
    let py = dirs::home_dir().ok_or("Missing home directory")?
        .join("Library/Application Support/OctoRole-TTS/env/bin/python");
    if !py.is_file() { return Err("Please install voices first · 請先安裝本機聲線".into()); }
    let mut task = Command::new(py).arg(resources(&app)?.join("dub.py")).arg(state.layout().project_root())
        .env("PATH","/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin").env("HF_HUB_OFFLINE","1")
        .env("PYTHONNOUSERSITE","1").stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(msg)?;
    let mut stdin = task.stdin.take().ok_or("Missing dialogue input")?;
    stdin.write_all(spec.to_string().as_bytes()).await.map_err(msg)?;
    drop(stdin);
    let out = task.wait_with_output().await.map_err(msg)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().rev().find(|s| !s.trim().is_empty())
            .unwrap_or("Voice rendering failed").to_owned());
    }
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("")).map_err(msg)
}
