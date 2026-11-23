// Simulated backend for browser preview only. Never loaded inside the app.
const listeners = {};
const emit = (name, payload) => (listeners[name] ?? []).forEach((cb) => cb(payload));
export function listen(name, cb) { (listeners[name] ??= []).push(cb); return () => {}; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sd15 = await (await fetch('../src-tauri/recipes/comfyui-sd15/recipe.json')).json().catch(() => null);
const state = { installed: false, installing: false, running: false, works: [], cancel: false, settings: { language: null, hf: false, root: '/Users/you/OctoRole' } };

function picture(values) {
  const hue = (Number(values.seed) || 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360} 60% 30%)"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="270" font-size="26" fill="#fff" text-anchor="middle" font-family="sans-serif">preview</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

const SCENES = 'octorole-preview-scenes';
const scenes = () => JSON.parse(localStorage.getItem(SCENES) ?? '{}');

const commands = {
  app_info: () => ({ version: '0.6.0' }),
  overview: () => ({
    hardware: { arch: 'aarch64', os: 'macos', os_version: '15.1', chip: 'Apple M2 Pro', memory_gb: 16, disk_free_gb: 212.4 },
    root: state.settings.root, language: state.settings.language, hf_token_set: state.settings.hf, problems: [],
    recipes: [sd15].filter(Boolean).map((r) => ({ ...r, source: 'bundled', installed: state.installed, installed_version: state.installed ? '1' : null, installing: state.installing, running: state.running, managed: state.running, fit: 'good', download_bytes: r.downloads.reduce((a, d) => a + d.bytes, 0), missing_tools: [], app_dir: state.settings.root + '/apps/' + r.id })),
  }),
  async install_recipe({ id }) {
    state.installing = true; state.cancel = false;
    const total = sd15.downloads[0].bytes;
    (async () => {
      emit('octorole://job', { recipe: id, phase: 'tools', message: '', done_bytes: 0, total_bytes: 0 });
      for (let i = 1; i <= 20; i++) {
        await sleep(180);
        if (state.cancel) { state.installing = false; emit('octorole://job', { recipe: id, phase: 'cancelled', message: '', done_bytes: 0, total_bytes: 0 }); emit('octorole://changed'); return; }
        emit('octorole://job', { recipe: id, phase: 'download', message: sd15.downloads[0].to, done_bytes: total * i / 20, total_bytes: total });
      }
      emit('octorole://log', { recipe: id, line: 'verified checkpoints/v1-5-pruned-emaonly-fp16.safetensors (sha256 ok)' });
      emit('octorole://job', { recipe: id, phase: 'setup', message: '', done_bytes: total, total_bytes: total });
      for (const line of ['==> Installing uv 0.13.9', '==> Fetching ComfyUI', '==> Creating Python 3.12 environment', '==> Installing Python packages', '==> Done']) { await sleep(450); emit('octorole://log', { recipe: id, line }); }
      state.installed = true; state.installing = false;
      emit('octorole://job', { recipe: id, phase: 'done', message: '', done_bytes: 0, total_bytes: 0 });
      emit('octorole://changed');
    })();
  },
  cancel_install() { state.cancel = true; },
  uninstall_recipe() { state.installed = false; },
  async start_recipe({ id }) { emit('octorole://log', { recipe: id, line: 'Starting server' }); setTimeout(() => { state.running = true; emit('octorole://changed'); }, 1500); },
  stop_recipe() { state.running = false; setTimeout(() => emit('octorole://changed'), 100); },
  async generate({ id, values }) {
    const ev = (phase, value = 0, max = 0) => emit('octorole://studio', { recipe: id, phase, value, max, message: '' });
    ev('queued'); await sleep(300); ev('running'); await sleep(500);
    const steps = Number(values.steps) || 20;
    for (let i = 1; i <= steps; i++) { await sleep(70); ev('progress', i, steps); }
    ev('saving'); await sleep(200);
    const used = { ...values, seed: Number(values.seed) >= 0 ? Number(values.seed) : Math.floor(Math.random() * 1e9) };
    const work = { path: picture(used), name: `preview-${state.works.length}.svg`, kind: 'image', created: Math.floor(Date.now() / 1000), recipe: id, values: used };
    state.works.unshift(work); ev('done', 1, 1);
    return [work];
  },
  list_works: () => state.works,
  delete_work({ path }) { state.works = state.works.filter((w) => w.path !== path); },
  reveal() {}, open_url({ url }) { window.open(url, '_blank', 'noopener'); },
  pick_image: () => null, pick_video: () => null,
  previs_list: () => Object.entries(scenes()).map(([name, v]) => ({ name, modified: v.modified, dir: `${state.settings.root}/previs/${name}` })).sort((a, b) => b.modified - a.modified),
  previs_load({ name }) { const v = scenes()[name]; if (!v) throw new Error('no such scene'); return v.scene; },
  previs_save({ name, scene }) { const all = scenes(); all[name] = { scene, modified: Date.now() }; localStorage.setItem(SCENES, JSON.stringify(all)); return name; },
  previs_delete({ name }) { const all = scenes(); delete all[name]; localStorage.setItem(SCENES, JSON.stringify(all)); },
  previs_export: () => '', pick_folder: () => '/Volumes/External/OctoRole',
  save_settings({ patch }) {
    if (patch.root != null) state.settings.root = patch.root || '/Users/you/OctoRole';
    if (patch.hf_token != null) state.settings.hf = !!patch.hf_token;
    if (patch.language != null) state.settings.language = patch.language;
  },
};

export async function invoke(cmd, args) {
  if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
  return commands[cmd](args);
}
