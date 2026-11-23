//! ComfyUI client: fill a workflow from form values, queue it, follow
//! progress over the websocket and collect the outputs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::recipe::{Control, Recipe};

#[derive(Debug, Clone, Serialize)]
pub struct StudioEvent {
    pub recipe: String,
    /// queued | running | progress | saving | done | error
    pub phase: String,
    pub value: u64,
    pub max: u64,
    pub message: String,
}

/// Receives (phase, value, max, message).
pub type Progress<'a> = &'a (dyn Fn(&str, u64, u64, &str) + Send + Sync);

pub async fn is_up(client: &reqwest::Client, port: u16, health: &str) -> bool {
    let url = format!("http://127.0.0.1:{port}{health}");
    matches!(
        client.get(url).timeout(Duration::from_millis(1500)).send().await,
        Ok(r) if r.status().is_success()
    )
}

fn coerce(control: &Control, raw: Option<&Value>) -> Result<Value> {
    let v = raw.cloned().unwrap_or(Value::Null);
    let v = if v.is_null() { control.default.clone() } else { v };
    let num = |v: &Value| -> Option<f64> {
        v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    };
    let clamp = |n: f64| {
        let n = control.min.map_or(n, |m| n.max(m));
        control.max.map_or(n, |m| n.min(m))
    };
    Ok(match control.kind.as_str() {
        "int" => {
            let n = num(&v).ok_or_else(|| anyhow!("{} needs a number", control.key))?;
            json!(clamp(n).round() as i64)
        }
        "float" => {
            let n = num(&v).ok_or_else(|| anyhow!("{} needs a number", control.key))?;
            json!(clamp(n))
        }
        "seed" => match num(&v) {
            Some(n) if n >= 0.0 => json!(n as u64),
            _ => json!(rand::thread_rng().gen_range(0..u32::MAX as u64)),
        },
        "select" => {
            if !control.choices.is_empty() && !control.choices.contains(&v) {
                bail!("{} is not one of the allowed choices", control.key);
            }
            v
        }
        _ => v,
    })
}

/// Write form values into the workflow. Returns the values actually used
/// (after defaults, clamping and seed randomisation).
pub fn apply_controls(
    workflow: &mut Value,
    controls: &[Control],
    values: &HashMap<String, Value>,
) -> Result<HashMap<String, Value>> {
    let mut used = HashMap::new();
    for c in controls {
        let v = coerce(c, values.get(&c.key))?;
        for t in &c.targets {
            let inputs = workflow
                .get_mut(&t.node)
                .and_then(|n| n.get_mut("inputs"))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("workflow has no node {}", t.node))?;
            inputs.insert(t.input.clone(), v.clone());
        }
        used.insert(c.key.clone(), v);
    }
    Ok(used)
}

async fn upload_image(client: &reqwest::Client, base: &str, path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path).await.with_context(|| format!("read {}", path.display()))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let form = reqwest::multipart::Form::new()
        .part("image", reqwest::multipart::Part::bytes(bytes).file_name(name))
        .text("overwrite", "true");
    let resp = client.post(format!("{base}/upload/image")).multipart(form).send().await?;
    if !resp.status().is_success() {
        bail!("ComfyUI refused the upload ({})", resp.status());
    }
    let v: Value = resp.json().await?;
    let name = v["name"].as_str().ok_or_else(|| anyhow!("upload reply had no name"))?;
    Ok(match v["subfolder"].as_str() {
        Some(sub) if !sub.is_empty() => format!("{sub}/{name}"),
        _ => name.to_string(),
    })
}

fn collect_outputs(history_entry: &Value) -> Vec<(String, String, String)> {
    let mut files = Vec::new();
    if let Some(outputs) = history_entry["outputs"].as_object() {
        for node in outputs.values() {
            let Some(node) = node.as_object() else { continue };
            for list in node.values() {
                let Some(list) = list.as_array() else { continue };
                for item in list {
                    if let Some(name) = item["filename"].as_str() {
                        if item["type"].as_str().unwrap_or("output") == "temp" {
                            continue;
                        }
                        files.push((
                            name.to_string(),
                            item["subfolder"].as_str().unwrap_or("").to_string(),
                            item["type"].as_str().unwrap_or("output").to_string(),
                        ));
                    }
                }
            }
        }
    }
    files
}

pub async fn generate(
    emit: Progress<'_>,
    client: &reqwest::Client,
    recipe: &Recipe,
    mut values: HashMap<String, Value>,
    works_dir: &Path,
) -> Result<Vec<PathBuf>> {
    let studio = recipe.studio.as_ref().ok_or_else(|| anyhow!("this recipe has no studio form"))?;
    let id = recipe.id.as_str();
    let base = format!("http://127.0.0.1:{}", recipe.run.port);
    if !is_up(client, recipe.run.port, &recipe.run.health).await {
        bail!("the engine is not running - start it first");
    }

    for c in studio.controls.iter().filter(|c| c.required) {
        let empty = match values.get(&c.key) {
            None | Some(Value::Null) => c.default.is_null() || c.default.as_str() == Some(""),
            Some(v) => v.as_str() == Some(""),
        };
        if empty {
            bail!("\"{}\" is empty - fill it in first", c.label.pick("en"));
        }
    }

    for c in studio.controls.iter().filter(|c| c.kind == "image" || c.kind == "video") {
        if let Some(p) = values.get(&c.key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let uploaded = upload_image(client, &base, Path::new(p)).await?;
            values.insert(c.key.clone(), json!(uploaded));
        }
    }

    let mut workflow: Value = serde_json::from_slice(
        &tokio::fs::read(recipe.dir.join(&studio.workflow)).await.context("read workflow")?,
    )
    .context("parse workflow")?;
    let used = apply_controls(&mut workflow, &studio.controls, &values)?;

    let client_id = format!("octorole-{:016x}", rand::thread_rng().gen::<u64>());
    let (mut ws, _) = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/ws?clientId={client_id}",
        recipe.run.port
    ))
    .await
    .context("connect to ComfyUI websocket")?;

    let resp = client
        .post(format!("{base}/prompt"))
        .json(&json!({ "prompt": workflow, "client_id": client_id }))
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body["error"]["message"].as_str().unwrap_or("workflow rejected");
        bail!("ComfyUI: {detail} {}", body["node_errors"]);
    }
    let prompt_id = body["prompt_id"].as_str().ok_or_else(|| anyhow!("no prompt_id"))?.to_string();
    emit("queued", 0, 0, "");

    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(30), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(e))) => bail!("websocket error: {e}"),
            Ok(None) => break,
            Err(_) => {
                // Quiet for a while: check whether the job already finished.
                let h: Value = client.get(format!("{base}/history/{prompt_id}")).send().await?.json().await?;
                if h.get(&prompt_id).is_some() {
                    break;
                }
                continue;
            }
        };
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let data = &v["data"];
        if data["prompt_id"].as_str().is_some_and(|p| p != prompt_id) {
            continue;
        }
        match v["type"].as_str().unwrap_or("") {
            "execution_start" => emit("running", 0, 0, ""),
            "progress" => emit(
                "progress",
                data["value"].as_u64().unwrap_or(0),
                data["max"].as_u64().unwrap_or(0),
                "",
            ),
            "executing" if data["node"].is_null() && data["prompt_id"].is_string() => break,
            "execution_success" => break,
            "execution_error" => bail!(
                "{}: {}",
                data["node_type"].as_str().unwrap_or("node"),
                data["exception_message"].as_str().unwrap_or("failed")
            ),
            "execution_interrupted" => bail!("interrupted"),
            _ => {}
        }
    }
    let _ = ws.close(None).await;

    emit("saving", 0, 0, "");
    let mut entry = Value::Null;
    for _ in 0..20 {
        let h: Value = client.get(format!("{base}/history/{prompt_id}")).send().await?.json().await?;
        if let Some(e) = h.get(&prompt_id) {
            entry = e.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    if entry["status"]["status_str"].as_str() == Some("error") {
        bail!("generation failed - see the engine log");
    }
    let outputs = collect_outputs(&entry);
    if outputs.is_empty() {
        bail!("the workflow finished but produced no files");
    }

    tokio::fs::create_dir_all(works_dir).await?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut saved = Vec::new();
    for (i, (name, sub, kind)) in outputs.iter().enumerate() {
        let bytes = client
            .get(format!("{base}/view"))
            .query(&[("filename", name), ("subfolder", sub), ("type", kind)])
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_ascii_lowercase();
        let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let file = works_dir.join(format!("{stamp}-{id}-{i}.{ext}"));
        tokio::fs::write(&file, &bytes).await?;
        let meta = json!({ "recipe": id, "created": stamp, "values": used });
        tokio::fs::write(file.with_extension(format!("{ext}.json")), serde_json::to_vec_pretty(&meta)?).await?;
        saved.push(file);
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe::Target;

    fn control(key: &str, kind: &str, default: Value, node: &str, input: &str) -> Control {
        Control {
            key: key.into(),
            label: crate::recipe::Localized::Plain(key.into()),
            kind: kind.into(),
            default,
            min: Some(1.0),
            max: Some(50.0),
            step: None,
            choices: vec![],
            required: false,
            previs: None,
            targets: vec![Target { node: node.into(), input: input.into() }],
        }
    }

    #[test]
    fn fills_workflow_and_clamps() {
        let mut wf = json!({"3": {"inputs": {"steps": 20, "seed": 1}}, "6": {"inputs": {"text": ""}}});
        let controls = vec![
            control("prompt", "textarea", json!("x"), "6", "text"),
            control("steps", "int", json!(20), "3", "steps"),
            control("seed", "seed", json!(-1), "3", "seed"),
        ];
        let mut values = HashMap::new();
        values.insert("prompt".to_string(), json!("a cat"));
        values.insert("steps".to_string(), json!("999"));
        let used = apply_controls(&mut wf, &controls, &values).unwrap();
        assert_eq!(wf["6"]["inputs"]["text"], "a cat");
        assert_eq!(wf["3"]["inputs"]["steps"], 50);
        assert!(wf["3"]["inputs"]["seed"].as_u64().is_some());
        assert_eq!(used["steps"], 50);
    }

    #[test]
    fn unknown_node_is_an_error() {
        let mut wf = json!({});
        let controls = vec![control("p", "text", json!(""), "9", "text")];
        assert!(apply_controls(&mut wf, &controls, &HashMap::new()).is_err());
    }

    #[test]
    fn collects_images_and_skips_temp() {
        let entry = json!({"outputs": {"9": {"images": [
            {"filename": "a.png", "subfolder": "", "type": "output"},
            {"filename": "p.png", "subfolder": "", "type": "temp"}]}}});
        assert_eq!(collect_outputs(&entry).len(), 1);
    }
}

/// Live check against a running ComfyUI. Needs network and a few GB of disk.
/// OCTOROLE_TEST_MODELS=<models dir> cargo test live_ -- --ignored --nocapture
#[cfg(test)]
mod live {
    use super::*;
    use crate::settings::Layout;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[tokio::test]
    #[ignore]
    async fn live_download_and_generate() {
        let models = PathBuf::from(std::env::var("OCTOROLE_TEST_MODELS").expect("OCTOROLE_TEST_MODELS"));
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("recipes");
        let (recipes, _) = crate::recipe::load_all(&bundled, &Layout::new(PathBuf::from("/nonexistent")));
        let recipe = recipes.into_iter().find(|r| r.id == "comfyui-sd15").unwrap();
        let client = reqwest::Client::new();

        for d in &recipe.downloads {
            let cancel = tokio_util::sync::CancellationToken::new();
            crate::download::fetch(&client, d, &models.join(&d.to), None, &cancel, |_| {}).await.unwrap();
            assert!(crate::download::is_complete(d, &models.join(&d.to)).await);
        }
        if std::env::var("OCTOROLE_TEST_DOWNLOAD_ONLY").is_ok() {
            return;
        }

        let steps_seen = AtomicU64::new(0);
        let emit = |phase: &str, value: u64, max: u64, _: &str| {
            println!("{phase} {value}/{max}");
            if phase == "progress" {
                steps_seen.fetch_max(value, Ordering::SeqCst);
            }
        };
        let mut values = HashMap::new();
        values.insert("width".to_string(), json!(384));
        values.insert("height".to_string(), json!(384));
        values.insert("steps".to_string(), json!(4));
        let out = tempfile::tempdir().unwrap();
        let files = generate(&emit, &client, &recipe, values, out.path()).await.unwrap();
        assert_eq!(files.len(), 1);
        let bytes = std::fs::read(&files[0]).unwrap();
        assert_eq!(&bytes[1..4], b"PNG");
        assert_eq!(steps_seen.load(Ordering::SeqCst), 4);
        if let Ok(keep) = std::env::var("OCTOROLE_TEST_KEEP") {
            std::fs::copy(&files[0], keep).unwrap();
        }
    }
}
