mod dialogue;
mod comfy;
mod download;
mod hardware;
mod hyperflow;
mod jobs;
mod previs;
mod qwen;
mod projects;
mod recipe;
mod settings;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use recipe::Recipe;
use settings::{Layout, Settings};

struct AppState {
    http: reqwest::Client,
    settings_file: PathBuf,
    bundled_recipes: PathBuf,
    settings: Mutex<Settings>,
    installs: Mutex<HashMap<String, CancellationToken>>,
    /// Engines we started: recipe id -> process group id.
    engines: Mutex<HashMap<String, u32>>,
    h3_engine: tokio::sync::Mutex<Option<(tokio::process::Child, u16)>>,
    generating: Mutex<HashSet<String>>,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
    fn layout(&self) -> Layout {
        self.settings().layout()
    }
    fn recipes(&self) -> (Vec<Recipe>, Vec<String>) {
        recipe::load_all(&self.bundled_recipes, &self.layout())
    }
    fn recipe(&self, id: &str) -> Result<Recipe> {
        self.recipes().0.into_iter().find(|r| r.id == id).ok_or_else(|| anyhow!("unknown recipe {id}"))
    }
}

type CmdResult<T> = std::result::Result<T, String>;

fn msg<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

fn err_chain(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize)]
struct RecipeView {
    #[serde(flatten)]
    recipe: Recipe,
    installed: bool,
    installed_version: Option<String>,
    installing: bool,
    running: bool,
    managed: bool,
    fit: &'static str,
    download_bytes: u64,
    missing_tools: Vec<String>,
    app_dir: String,
}

#[derive(Serialize)]
struct Overview {
    hardware: hardware::Hardware,
    root: String,
    language: Option<String>,
    hf_token_set: bool,
    recipes: Vec<RecipeView>,
    problems: Vec<String>,
}

#[tauri::command]
async fn overview(state: State<'_, AppState>) -> CmdResult<Overview> {
    let settings = state.settings();
    let layout = state.layout();
    let hw = hardware::detect(&layout.root);
    let (recipes, problems) = state.recipes();
    let installing: HashSet<String> = state.installs.lock().unwrap().keys().cloned().collect();
    let managed: HashSet<String> = state.engines.lock().unwrap().keys().cloned().collect();

    let mut views = Vec::new();
    for r in recipes {
        let marker: Option<Value> =
            std::fs::read(layout.marker(&r.id)).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let running = comfy::is_up(&state.http, r.run.port, &r.run.health).await;
        views.push(RecipeView {
            installed: marker.is_some(),
            installed_version: marker.and_then(|m| m["version"].as_str().map(String::from)),
            installing: installing.contains(&r.id),
            running,
            managed: managed.contains(&r.id),
            fit: r.fit(&hw),
            download_bytes: r.download_bytes(),
            missing_tools: jobs::missing_tools(&r, &layout),
            app_dir: layout.app(&r.id).to_string_lossy().to_string(),
            recipe: r,
        });
    }
    Ok(Overview {
        hardware: hw,
        root: layout.root.to_string_lossy().to_string(),
        language: settings.language,
        hf_token_set: settings.hf_token.as_deref().is_some_and(|t| !t.is_empty()),
        recipes: views,
        problems,
    })
}

#[tauri::command]
async fn install_recipe(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let recipe = state.recipe(&id).map_err(err_chain)?;
    let cancel = CancellationToken::new();
    {
        let mut installs = state.installs.lock().unwrap();
        if installs.contains_key(&id) {
            return Err("already installing".into());
        }
        installs.insert(id.clone(), cancel.clone());
    }
    let client = state.http.clone();
    let layout = state.layout();
    let token = state.settings().hf_token.filter(|t| !t.is_empty());
    tauri::async_runtime::spawn(async move {
        jobs::install(app.clone(), client, recipe, layout, token, cancel).await;
        app.state::<AppState>().installs.lock().unwrap().remove(&id);
        let _ = app.emit("octorole://changed", ());
    });
    Ok(())
}

#[tauri::command]
fn cancel_install(state: State<'_, AppState>, id: String) {
    if let Some(c) = state.installs.lock().unwrap().get(&id) {
        c.cancel();
    }
}

#[tauri::command]
async fn uninstall_recipe(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let recipe = state.recipe(&id).map_err(err_chain)?;
    if state.installs.lock().unwrap().contains_key(&id) || state.engines.lock().unwrap().contains_key(&id) {
        return Err("stop the engine or the install first".into());
    }
    let dir = state.layout().app(&recipe.id);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.map_err(msg)?;
    }
    Ok(())
}

async fn start_engine(app: &AppHandle, state: &AppState, id: &str) -> Result<()> {
    let recipe = state.recipe(id)?;
    let layout = state.layout();
    if !layout.marker(id).exists() {
        bail!("not installed yet");
    }
    if state.engines.lock().unwrap().contains_key(id) {
        return Ok(());
    }
    if comfy::is_up(&state.http, recipe.run.port, &recipe.run.health).await {
        bail!("something is already listening on port {}", recipe.run.port);
    }
    let vars = recipe::vars(&recipe, &layout);
    let script = recipe::expand(&recipe.run.script, &vars);
    let args: Vec<String> = recipe.run.args.iter().map(|a| recipe::expand(a, &vars)).collect();
    let app_dir = layout.app(id);

    let mut cmd = tokio::process::Command::new("/bin/bash");
    cmd.arg(&script)
        .args(&args)
        .current_dir(&app_dir)
        .env("PATH", hardware::child_path(&layout.tools()))
        .env("PORT", recipe.run.port.to_string())
        .env("OCTOROLE_ROOT", &layout.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().with_context(|| format!("start {script}"))?;
    let pid = child.id().ok_or_else(|| anyhow!("engine exited immediately"))?;
    state.engines.lock().unwrap().insert(id.to_string(), pid);

    let log_file = app_dir.join("engine.log");
    let _ = tokio::fs::write(&log_file, b"").await;
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let id = id.to_string();
        let log_file = log_file.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
            let mut lines = tokio::io::BufReader::new(stream).lines();
            let mut file = tokio::fs::OpenOptions::new().append(true).open(&log_file).await.ok();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(f) = file.as_mut() {
                    let _ = f.write_all(format!("{line}\n").as_bytes()).await;
                }
                jobs::emit_log(&app, &id, line);
            }
        });
    }

    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        app.state::<AppState>().engines.lock().unwrap().remove(&id);
        jobs::emit_log(&app, &id, format!("engine stopped ({})", status.map(|s| s.to_string()).unwrap_or_default()));
        let _ = app.emit("octorole://changed", ());
    });
    Ok(())
}

#[tauri::command]
async fn start_recipe(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    start_engine(&app, &state, &id).await.map_err(err_chain)
}

#[tauri::command]
async fn stop_recipe(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let pid = state.engines.lock().unwrap().get(&id).copied();
    jobs::kill_group(pid).await;
    Ok(())
}

#[derive(Serialize)]
struct Work {
    path: String,
    name: String,
    /// image | video | audio
    kind: &'static str,
    created: u64,
    recipe: String,
    values: Value,
}

fn media_kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => Some("image"),
        "mp4" | "webm" | "mov" => Some("video"),
        "wav" | "mp3" | "flac" | "m4a" => Some("audio"),
        _ => None,
    }
}

fn work_from(path: &Path) -> Option<Work> {
    let kind = media_kind(path)?;
    let mut side = path.as_os_str().to_owned();
    side.push(".json");
    let meta: Value = std::fs::read(PathBuf::from(side))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let created = meta["created"].as_u64().unwrap_or_else(|| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    });
    Some(Work {
        path: path.to_string_lossy().to_string(),
        name: path.file_name()?.to_string_lossy().to_string(),
        kind,
        created,
        recipe: meta["recipe"].as_str().unwrap_or("").to_string(),
        values: meta["values"].clone(),
    })
}

#[tauri::command]
fn list_works(state: State<'_, AppState>) -> Vec<Work> {
    let mut works: Vec<Work> = std::fs::read_dir(state.layout().works())
        .map(|rd| rd.flatten().filter_map(|e| work_from(&e.path())).collect())
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(state.layout().works()) {
        for entry in entries.flatten() {
            let folder = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) && entry.file_name().to_string_lossy().starts_with("配音-") {
                if let Some(work) = ["dialogue.mp4","mix.wav","dialogue.wav"].iter()
                    .map(|name| folder.join(name)).filter(|path| path.is_file()).find_map(|path| work_from(&path)) {
                    works.push(work);
                }
            }
        }
    }
    works.sort_by(|a, b| b.created.cmp(&a.created).then(b.name.cmp(&a.name)));
    works
}

#[tauri::command]
async fn generate(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    values: HashMap<String, Value>,
) -> CmdResult<Vec<Work>> {
    let recipe = state.recipe(&id).map_err(err_chain)?;
    if !state.generating.lock().unwrap().insert(id.clone()) {
        return Err("already generating".into());
    }
    let works_dir = state.layout().works();
    let sink_app = app.clone();
    let sink_id = id.clone();
    let emit = move |phase: &str, value: u64, max: u64, message: &str| {
        let _ = sink_app.emit(
            "octorole://studio",
            comfy::StudioEvent {
                recipe: sink_id.clone(),
                phase: phase.to_string(),
                value,
                max,
                message: message.to_string(),
            },
        );
    };
    let result = comfy::generate(&emit, &state.http, &recipe, values, &works_dir).await;
    state.generating.lock().unwrap().remove(&id);
    match &result {
        Ok(files) => emit("done", files.len() as u64, files.len() as u64, ""),
        Err(e) => emit("error", 0, 0, &format!("{e:#}")),
    }
    let files = result.map_err(err_chain)?;
    Ok(files.iter().filter_map(|p| work_from(p)).collect())
}

/// Only paths inside the OctoRole root may be touched from the UI.
fn inside(root: &Path, path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path).canonicalize().context("no such file")?;
    let root = root.canonicalize().context("root folder missing")?;
    if !p.starts_with(&root) {
        bail!("path is outside the OctoRole folder");
    }
    Ok(p)
}

#[tauri::command]
fn delete_work(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let p = inside(&state.layout().works(), &path).map_err(err_chain)?;
    std::fs::remove_file(&p).map_err(msg)?;
    let mut side = p.into_os_string();
    side.push(".json");
    let _ = std::fs::remove_file(PathBuf::from(side));
    Ok(())
}

#[tauri::command]
fn reveal(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let root = state.layout().root;
    std::fs::create_dir_all(&root).map_err(msg)?;
    let p = inside(&root, &path).map_err(err_chain)?;
    app.opener().reveal_item_in_dir(p).map_err(msg)
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    let parsed = url::Url::parse(&url).map_err(msg)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(msg)
}

#[tauri::command]
async fn pick_audio(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("Audio", &["wav","aiff","flac","mp3","m4a","aac","ogg"])
        .blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_image(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn previs_list(state: State<'_, AppState>) -> Vec<previs::SceneInfo> {
    previs::list(&state.layout().previs())
}

#[tauri::command]
fn previs_load(state: State<'_, AppState>, name: String) -> CmdResult<Value> {
    previs::load(&state.layout().previs(), &name).map_err(err_chain)
}

#[tauri::command]
fn previs_save(state: State<'_, AppState>, name: String, scene: Value) -> CmdResult<String> {
    previs::save(&state.layout().previs(), &name, &scene)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(err_chain)
}

#[tauri::command]
fn previs_delete(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    previs::delete(&state.layout().previs(), &name).map_err(err_chain)
}

#[tauri::command]
async fn previs_export(state: State<'_, AppState>, name: String, file: String, data: String) -> CmdResult<String> {
    let root = state.layout().previs();
    tokio::task::spawn_blocking(move || previs::export(&root, &name, &file, &data))
        .await
        .map_err(msg)?
        .map(|p| p.to_string_lossy().to_string())
        .map_err(err_chain)
}

#[tauri::command]
async fn pick_video(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Video", &["mp4", "mov", "webm"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Deserialize)]
struct SettingsPatch {
    root: Option<String>,
    /// None leaves the token alone; an empty string clears it.
    hf_token: Option<String>,
    language: Option<String>,
}

fn allow_works(app: &AppHandle, layout: &Layout) {
    let works = layout.works();
    let _ = std::fs::create_dir_all(&works);
    let _ = app.asset_protocol_scope().allow_directory(&works, true);
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, patch: SettingsPatch) -> CmdResult<()> {
    if !state.installs.lock().unwrap().is_empty() || !state.engines.lock().unwrap().is_empty() {
        if patch.root.is_some() {
            return Err("stop running engines and installs before moving the folder".into());
        }
    }
    let mut s = state.settings.lock().unwrap();
    if let Some(root) = patch.root {
        let root = root.trim().to_string();
        if !root.is_empty() && !Path::new(&root).is_absolute() {
            return Err("the folder must be an absolute path".into());
        }
        s.project = None;
        s.root = (!root.is_empty()).then_some(root);
    }
    if let Some(tok) = patch.hf_token {
        let tok = tok.trim().to_string();
        s.hf_token = (!tok.is_empty()).then_some(tok);
    }
    if let Some(lang) = patch.language {
        s.language = Some(lang);
    }
    s.save(&state.settings_file).map_err(err_chain)?;
    allow_works(&app, &s.layout());
    Ok(())
}

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    json!({ "version": app.package_info().version.to_string() })
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings_file = app.path().app_config_dir()?.join("settings.json");
            let settings = Settings::load(&settings_file);
            let mut bundled = app.path().resource_dir()?.join("recipes");
            if cfg!(debug_assertions) && !bundled.is_dir() {
                bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("recipes");
            }
            allow_works(app.handle(), &settings.layout());
            app.manage(AppState {
                http: reqwest::Client::builder()
                    .user_agent(concat!("OctoRole/", env!("CARGO_PKG_VERSION")))
                    .connect_timeout(std::time::Duration::from_secs(20))
                    .build()?,
                settings_file,
                bundled_recipes: bundled,
                settings: Mutex::new(settings),
                installs: Mutex::new(HashMap::new()),
                engines: Mutex::new(HashMap::new()),
                h3_engine: tokio::sync::Mutex::new(None),
                generating: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dialogue::dialogue_setup,
            dialogue::dialogue_render,
            pick_audio,
            hyperflow::h3_defaults,
            hyperflow::h3_start,
            hyperflow::h3_render,
            overview,
            install_recipe,
            cancel_install,
            uninstall_recipe,
            start_recipe,
            stop_recipe,
            generate,
            list_works,
            delete_work,
            reveal,
            open_url,
            pick_image,
            pick_folder,
            pick_video,
            qwen::previs_from_qwen,
            previs_list,
            previs_load,
            previs_save,
            previs_delete,
            previs_export,
            save_settings,
            app_info,
            projects::project_list,
            projects::project_open,
            projects::project_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OctoRole");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            for c in state.installs.lock().unwrap().values() {
                c.cancel();
            }
            for pid in state.engines.lock().unwrap().values() {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-TERM", "--", &format!("-{pid}")])
                    .status();
            }
        }
    });
}
