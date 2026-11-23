use crate::{msg, previs, AppState, CmdResult};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager, State};
use tokio::{io::AsyncWriteExt, process::Command};

#[tauri::command]
pub async fn previs_from_qwen(
    app: AppHandle,
    state: State<'_, AppState>,
    description: String,
    seconds: u8,
    port: Option<u16>,
    key: Option<String>,
) -> CmdResult<Value> {
    let description = description.trim();
    if description.is_empty() || description.chars().count() > 2000 || !(1..=60).contains(&seconds)
    {
        return Err("請輸入場景描述（最多 2000 字）同 1–60 秒長度。".into());
    }
    let root = state.layout().previs();
    let mut helper = app
        .path()
        .resource_dir()
        .map_err(msg)?
        .join("qwen/director.py");
    if cfg!(debug_assertions) && !helper.is_file() {
        helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("qwen/director.py");
    }
    let mut task = Command::new(app.path().resource_dir().map_err(msg)?.join("python/bin/python3.11"))
        .arg("-I")
        .arg(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(msg)?;
    let mut input = task.stdin.take().ok_or("Missing Qwen input")?;
    input
        .write_all(
            json!({"description":description,"seconds":seconds,"port":port,"key":key})
                .to_string()
                .as_bytes(),
        )
        .await
        .map_err(msg)?;
    drop(input);
    let output = task.wait_with_output().await.map_err(msg)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut scene: Value = serde_json::from_slice(&output.stdout).map_err(msg)?;
    let title = scene["name"]
        .as_str()
        .ok_or("Missing scene name")?
        .to_owned();
    previs::check_name(&title).map_err(msg)?;
    std::fs::create_dir_all(&root).map_err(msg)?;
    for n in 1.. {
        let name = if n == 1 {
            title.clone()
        } else {
            format!("{title} ({n})")
        };
        let dir = root.join(&name);
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                scene["name"] = json!(name);
                if let Err(error) = previs::save(&root, &name, &scene) {
                    let _ = std::fs::remove_dir(&dir);
                    return Err(msg(error));
                }
                return Ok(scene);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(msg(e)),
        }
    }
    unreachable!()
}
