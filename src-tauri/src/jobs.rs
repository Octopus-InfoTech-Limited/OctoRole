//! Install pipeline: check tools, download files, run the recipe's setup script.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::download;
use crate::hardware;
use crate::recipe::{self, Recipe};
use crate::settings::Layout;

#[derive(Debug, Clone, Serialize)]
pub struct JobEvent {
    pub recipe: String,
    /// tools | download | setup | done | error | cancelled
    pub phase: String,
    pub message: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub recipe: String,
    pub line: String,
}

pub fn emit_log(app: &AppHandle, recipe: &str, line: impl Into<String>) {
    let _ = app.emit("octorole://log", LogLine { recipe: recipe.to_string(), line: line.into() });
}

fn emit_job(app: &AppHandle, recipe: &str, phase: &str, message: &str, done: u64, total: u64) {
    let _ = app.emit(
        "octorole://job",
        JobEvent {
            recipe: recipe.to_string(),
            phase: phase.to_string(),
            message: message.to_string(),
            done_bytes: done,
            total_bytes: total,
        },
    );
}

pub fn missing_tools(recipe: &Recipe, layout: &Layout) -> Vec<String> {
    let path = hardware::child_path(&layout.tools());
    recipe
        .tools
        .iter()
        .filter(|tool| {
            !path
                .split(':')
                .any(|dir| !dir.is_empty() && Path::new(dir).join(tool.as_str()).is_file())
        })
        .cloned()
        .collect()
}

/// Run a bash script, streaming its output as log lines. Kills the whole
/// process group on cancel.
pub async fn run_script(
    app: &AppHandle,
    recipe_id: &str,
    script: &Path,
    args: &[String],
    cwd: &Path,
    layout: &Layout,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut cmd = Command::new("/bin/bash");
    cmd.arg(script)
        .args(args)
        .current_dir(cwd)
        .env("PATH", hardware::child_path(&layout.tools()))
        .env("OCTOROLE_ROOT", &layout.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().with_context(|| format!("start {}", script.display()))?;
    let pid = child.id();

    let h1 = tokio::spawn(pump(child.stdout.take(), app.clone(), recipe_id.to_string()));
    let h2 = tokio::spawn(pump(child.stderr.take(), app.clone(), recipe_id.to_string()));

    let status = tokio::select! {
        _ = cancel.cancelled() => {
            kill_group(pid).await;
            let _ = child.wait().await;
            return Err(anyhow!("cancelled"));
        }
        s = child.wait() => s?,
    };
    let _ = h1.await;
    let _ = h2.await;
    if !status.success() {
        bail!("{} exited with {status}", script.file_name().unwrap_or_default().to_string_lossy());
    }
    Ok(())
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>, app: AppHandle, id: String) {
    if let Some(r) = reader {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(&app, &id, line);
        }
    }
}

pub async fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = Command::new("/bin/kill").args(["-TERM", "--", &format!("-{pid}")]).status().await;
    }
}

pub async fn install(
    app: AppHandle,
    client: reqwest::Client,
    recipe: Recipe,
    layout: Layout,
    hf_token: Option<String>,
    cancel: CancellationToken,
) {
    let id = recipe.id.clone();
    match install_inner(&app, &client, &recipe, &layout, hf_token.as_deref(), &cancel).await {
        Ok(()) => emit_job(&app, &id, "done", "", 0, 0),
        Err(e) if cancel.is_cancelled() => {
            let _ = e;
            emit_job(&app, &id, "cancelled", "", 0, 0)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            emit_log(&app, &id, format!("ERROR: {msg}"));
            emit_job(&app, &id, "error", &msg, 0, 0)
        }
    }
}

async fn install_inner(
    app: &AppHandle,
    client: &reqwest::Client,
    recipe: &Recipe,
    layout: &Layout,
    hf_token: Option<&str>,
    cancel: &CancellationToken,
) -> Result<()> {
    let id = &recipe.id;
    emit_job(app, id, "tools", "", 0, 0);
    let missing = missing_tools(recipe, layout);
    if !missing.is_empty() {
        bail!("missing tools: {}", missing.join(", "));
    }

    let total = recipe.download_bytes();
    let need_gb = recipe.requires.disk_gb;
    let free = hardware::disk_free_bytes(&layout.root) as f64 / (1u64 << 30) as f64;
    let already: u64 = {
        let mut sum = 0;
        for d in &recipe.downloads {
            if download::is_complete(d, &layout.models().join(&d.to)).await {
                sum += d.bytes;
            }
        }
        sum
    };
    let still_needed_gb = (need_gb - already as f64 / (1u64 << 30) as f64).max(0.0);
    if free > 0.0 && free < still_needed_gb && !layout.marker(id).exists() {
        bail!("not enough disk space: {free:.1} GB free, about {still_needed_gb:.1} GB needed");
    }

    let mut base = 0u64;
    for d in &recipe.downloads {
        let dest = layout.models().join(&d.to);
        emit_log(app, id, format!("download {}", d.to));
        let mut last = Instant::now() - Duration::from_secs(1);
        download::fetch(client, d, &dest, hf_token, cancel, |have| {
            if last.elapsed() >= Duration::from_millis(250) || have == d.bytes {
                last = Instant::now();
                emit_job(app, id, "download", &d.to, base + have, total);
            }
        })
        .await?;
        base += d.bytes;
        emit_log(app, id, format!("verified {} (sha256 ok)", d.to));
    }

    emit_job(app, id, "setup", "", total, total);
    let app_dir = layout.app(id);
    tokio::fs::create_dir_all(&app_dir).await?;
    let vars = recipe::vars(recipe, layout);
    let args: Vec<String> = recipe.setup.args.iter().map(|a| recipe::expand(a, &vars)).collect();
    let script = recipe.dir.join(&recipe.setup.script);
    run_script(app, id, &script, &args, &app_dir, layout, cancel).await?;

    let marker = serde_json::json!({ "id": id, "version": recipe.version });
    tokio::fs::write(layout.marker(id), serde_json::to_vec_pretty(&marker)?).await?;
    Ok(())
}
