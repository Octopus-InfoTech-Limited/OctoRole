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
pub async fn h3_start(app: AppHandle, state: State<'_, AppState>, setup: Option<bool>) -> CmdResult<()> {
    let mut engine = state.h3_engine.try_lock().map_err(|_| "H3 setup or startup is already in progress")?;
    let model = app.path().app_data_dir().map_err(msg)?.join("models/HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit");
    let items: Vec<crate::recipe::Download> = serde_json::from_str(include_str!("../hyperflow/model-downloads.json")).map_err(msg)?;
    let cancel = tokio_util::sync::CancellationToken::new();
    for item in &items {
        let dest = model.join(&item.to);
        if setup.unwrap_or(false) {
            let _ = app.emit("octorole://h3", format!("下載及核對 {}", item.to));
            crate::download::fetch(&state.http, item, &dest, None, &cancel, |_| {}).await.map_err(msg)?;
        } else if !crate::download::is_complete(item, &dest).await {
            return Err("請先下載並核對 H3 模型。".into());
        }
    }
    if setup.unwrap_or(false) {
        let _ = app.emit("octorole://h3", "模型已就緒");
        return Ok(());
    }
    if let Some((child, _)) = engine.as_mut() {
        if child.try_wait().map_err(msg)?.is_none() { return Ok(()); }
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(msg)?;
    let port = listener.local_addr().map_err(msg)?.port();
    drop(listener);
    let helper = app.path().resource_dir().map_err(msg)?.join("../MacOS/mlx-serve");
    let mut child = Command::new(helper)
        .arg("--model").arg(&model).args(["--serve", "--host", "127.0.0.1", "--port"]).arg(port.to_string())
        .current_dir(&model).env("MLX_SERVE_H3_RESIDENT", "0").kill_on_drop(true)
        .spawn().map_err(msg)?;
    for _ in 0..120 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if let Some(status) = child.try_wait().map_err(msg)? {
            return Err(format!("H3 exited ({status})."));
        }
        let response = state.http.get(format!("http://127.0.0.1:{port}/v1/models"))
            .timeout(std::time::Duration::from_secs(1)).send().await;
        if let Ok(response) = response {
            if let Ok(body) = response.json::<Value>().await {
                if body["data"].as_array().is_some_and(|rows| rows.iter().any(|row|
                    row["id"] == "HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit" && row["state"] == "ready")) {
                    *engine = Some((child, port));
                    let _ = app.emit("octorole://h3", "H3 已啟動");
                    return Ok(());
                }
            }
        }
    }
    Err("H3 startup timed out".into())
}

#[tauri::command]
pub async fn h3_render(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Value,
) -> CmdResult<String> {
    let port = {
        let mut engine = state.h3_engine.lock().await;
        let (child, port) = engine.as_mut().ok_or("請先啟動 H3。")?;
        if child.try_wait().map_err(msg)?.is_some() { return Err("請重新啟動 H3。".into()); }
        *port
    };
    let root = state.layout().project_root();
    let res = app.path().resource_dir().map_err(msg)?;
    let mut child = Command::new(res.join("python/bin/python3.11"))
        .env("PATH", res.join("../MacOS"))
        .arg("-u")
        .arg(assets(&app)?.join("render.py"))
        .arg("--root")
        .arg(&root)
        .args(["--project", "-", "--port"]).arg(port.to_string())
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
