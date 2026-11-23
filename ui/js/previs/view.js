// The Previs tab: block out who moves where and how the camera sees it,
// then export a reference clip, a still and a prompt draft.
import { invoke, native } from '../bridge.js';
import { t, getLang } from '../i18n.js';
import * as M from './model.js';
import { describe } from './describe.js';
import { Map2D } from './map2d.js';
import { renderControl } from './control.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = P.root) => el.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: svg('<path d="M8 4v16M16 4v16"/>'),
  start: svg('<path d="M6 4v16M19 5l-10 7 10 7z"/>'),
  undo: svg('<path d="M9 13L4 8l5-5"/><path d="M4 8h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 13l5-5-5-5"/><path d="M20 8H10a6 6 0 000 12h3"/>'),
  key: svg('<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 9v6M9 12h6"/>'),
  keyDel: svg('<path d="M12 3l9 9-9 9-9-9z"/><path d="M9 12h6"/>'),
  person: svg('<circle cx="12" cy="6" r="3"/><path d="M5 21v-3a7 7 0 0114 0v3"/>'),
  box: svg('<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  camera: svg('<rect x="3" y="7" width="12" height="10" rx="2"/><path d="M15 11l6-3v8l-6-3z"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

const P = {
  root: null, hooks: null, ready: false,
  scene: null, time: 0, playing: false, sel: { type: 'scene', id: '' },
  history: [], hi: -1, savedName: null, scenes: [],
  promptLang: 'en', exporting: null, lastExport: null, saveTimer: 0, saveState: '',
  map: null, stage: null, stageError: '',
};

if (!native) window.__previs = P; // browser preview only: lets tests inspect the view

const NAME_BAD = /[\/\\:*?"<>|\u0000-\u001f]/;
const validName = (n) => n.length > 0 && n.length <= 60 && !NAME_BAD.test(n) && !n.startsWith('.') && !n.endsWith('.');

// ---------- scene storage ----------

async function refreshList() {
  P.scenes = await invoke('previs_list').catch(() => []);
}

function uniqueName() {
  const used = new Set(P.scenes.map((s) => s.name));
  for (let i = 1; ; i++) {
    const n = t('pv_scene_n', { n: i });
    if (!used.has(n)) return n;
  }
}

function adopt(scene, saved) {
  P.scene = scene;
  P.savedName = saved ? scene.name : null;
  P.history = [JSON.stringify(scene)];
  P.hi = 0;
  P.time = 0;
  P.playing = false;
  P.sel = { type: 'scene', id: '' };
  P.lastExport = null;
  P.map?.fit();
  renderAll();
}

async function openScene(name) {
  await flushSave();
  try {
    const scene = M.normalize(await invoke('previs_load', { name }));
    scene.name = name;
    adopt(scene, true);
  } catch (e) {
    P.hooks.toast(String(e?.message ?? e), true);
  }
}

async function createScene() {
  await flushSave();
  await refreshList();
  adopt(M.demoScene(uniqueName(), t('pv_actor_n', { n: 1 })), false);
  await save();
}

function save() {
  clearTimeout(P.saveTimer);
  P.saveTimer = 0;
  const pending = (P.saving ?? Promise.resolve()).then(writeScene);
  P.saving = pending;
  pending.finally(() => { if (P.saving === pending) P.saving = null; });
  return pending;
}

async function writeScene() {
  if (!P.scene) return;
  const name = P.scene.name;
  try {
    await invoke('previs_save', { name, scene: P.scene });
    if (P.savedName && P.savedName !== name) await invoke('previs_delete', { name: P.savedName }).catch(() => {});
    P.savedName = name;
    P.saveState = 'ok';
  } catch (e) {
    P.saveState = 'bad';
    P.hooks.toast(String(e?.message ?? e), true);
  }
  await refreshList();
  renderBar();
}

function scheduleSave() {
  clearTimeout(P.saveTimer);
  P.saveState = 'pending';
  P.saveTimer = setTimeout(save, 700);
  renderBar();
}

const flushSave = () => (P.saveTimer ? save() : P.saving ?? Promise.resolve());

// ---------- history ----------

function commit() {
  const snapshot = JSON.stringify(P.scene);
  if (snapshot === P.history[P.hi]) return;
  P.history.splice(P.hi + 1);
  P.history.push(snapshot);
  if (P.history.length > 100) P.history.shift();
  P.hi = P.history.length - 1;
  scheduleSave();
}

function travel(step) {
  const next = P.hi + step;
  if (next < 0 || next >= P.history.length) return;
  P.hi = next;
  P.scene = JSON.parse(P.history[next]);
  P.time = Math.min(P.time, P.scene.duration);
  if (!selected()) P.sel = { type: 'scene', id: '' };
  scheduleSave();
  renderAll();
}

// ---------- selection helpers ----------

function selected() {
  const { type, id } = P.sel;
  if (type === 'actor') return P.scene.actors.find((a) => a.id === id);
  if (type === 'prop') return P.scene.props.find((p) => p.id === id);
  return type === 'camera' ? P.scene.camera : P.scene;
}

function trackKeys() {
  if (P.sel.type === 'actor') return selected()?.keys;
  if (P.sel.type === 'camera') return P.scene.camera.keys;
  return null;
}

function select(sel) {
  if (sel.type === P.sel.type && sel.id === P.sel.id) return;
  P.sel = sel;
  refresh({ force: true });
}

// ---------- rendering ----------

function build() {
  const root = document.createElement('div');
  root.className = 'pv';
  root.innerHTML = `
    <div class="row pv-top"><h1>${t('pv_title')}</h1><div class="pv-bar row" id="pv-bar"></div></div>
    ${native ? `<form class="card pv-pane" id="pv-qwen">
      <label for="pv-idea"><b>${t('pv_qwen')}</b></label>
      <textarea id="pv-idea" rows="2" maxlength="2000" required placeholder="${t('pv_qwen_hint')}"></textarea>
      <div class="row"><label>${t('pv_qwen_seconds')} <input id="pv-seconds" type="number" min="1" max="60" step="1" value="8" required style="width:5em"></label>
      <button type="submit" class="btn primary">${t('pv_qwen_generate')}</button>
      <span id="pv-qwen-status" role="status" class="small muted"></span></div>
    </form>` : ''}
    <div class="pv-main">
      <section class="card pv-pane">
        <div class="row spread pv-cap"><b>${t('pv_map')}</b><div class="row">
          <button class="btn icon" data-pv="add-actor" title="${t('pv_add_actor')}" aria-label="${t('pv_add_actor')}">${ICON.plus}${ICON.person}</button>
          <button class="btn icon" data-pv="add-prop" title="${t('pv_add_prop')}" aria-label="${t('pv_add_prop')}">${ICON.plus}${ICON.box}</button>
          <button class="btn icon" data-pv="fit" title="${t('pv_fit')}" aria-label="${t('pv_fit')}">${ICON.fit}</button>
        </div></div>
        <canvas id="pv-map" class="pv-map" tabindex="0" aria-label="${t('pv_map')}"></canvas>
        <div class="small muted">${t('pv_map_hint')}</div>
      </section>
      <section class="card pv-pane">
        <div class="row spread pv-cap"><b>${t('pv_view')}</b></div>
        <div class="pv-screen" id="pv-screen"><canvas id="pv-3d" aria-label="${t('pv_view')}"></canvas></div>
        <div class="small muted">${t('pv_view_hint')}</div>
      </section>
    </div>
    <section class="card pv-pane">
      <div class="row pv-transport">
        <button class="btn icon" data-pv="rewind" title="${t('pv_rewind')}" aria-label="${t('pv_rewind')}">${ICON.start}</button>
        <button class="btn icon primary" data-pv="play" id="pv-play" title="${t('pv_play')}" aria-label="${t('pv_play')}">${ICON.play}</button>
        <span class="pv-clock" id="pv-clock"></span>
        <span class="small muted pv-grow">${t('pv_time_hint')}</span>
        <button class="btn icon" data-pv="add-key" id="pv-add-key" title="${t('pv_add_key')}" aria-label="${t('pv_add_key')}">${ICON.key}</button>
        <button class="btn icon" data-pv="del-key" id="pv-del-key" title="${t('pv_del_key')}" aria-label="${t('pv_del_key')}">${ICON.keyDel}</button>
      </div>
      <div class="pv-tl" id="pv-tracks"></div>
    </section>
    <div class="pv-main">
      <section class="card pv-pane" id="pv-insp"></section>
      <section class="card pv-pane" id="pv-export"></section>
    </div>`;
  return root;
}

function renderBar() {
  if (!P.scene) return;
  const bar = $('#pv-bar');
  const keepName = document.activeElement?.id === 'pv-name';
  const names = P.scenes.map((s) => s.name);
  if (!names.includes(P.scene.name)) names.unshift(P.scene.name);
  const state = { ok: t('pv_saved'), pending: t('pv_saving'), bad: t('pv_save_failed') }[P.saveState] ?? '';
  const html = `
    <label class="pv-inline"><span class="small muted">${t('pv_scene')}</span>
      <select id="pv-open" aria-label="${t('pv_scene')}">${names.map((n) => `<option ${n === P.scene.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <input type="text" id="pv-name" maxlength="60" value="${esc(P.scene.name)}" aria-label="${t('pv_rename')}" title="${t('pv_rename')}">
    <button class="btn" data-pv="new">${t('pv_new')}</button>
    <button class="btn icon danger" data-pv="delete-scene" title="${t('pv_delete_scene')}" aria-label="${t('pv_delete_scene')}">${ICON.trash}</button>
    <span style="flex:1"></span>
    <span class="small ${P.saveState === 'bad' ? 'pv-bad' : 'muted'}" role="status">${state}</span>
    <button class="btn icon" data-pv="undo" title="${t('pv_undo')}" aria-label="${t('pv_undo')}" ${P.hi > 0 ? '' : 'disabled'}>${ICON.undo}</button>
    <button class="btn icon" data-pv="redo" title="${t('pv_redo')}" aria-label="${t('pv_redo')}" ${P.hi < P.history.length - 1 ? '' : 'disabled'}>${ICON.redo}</button>`;
  if (keepName) {
    // Don't yank the field the user is typing in; only refresh what sits around it.
    const typed = $('#pv-name').value;
    bar.innerHTML = html;
    const input = $('#pv-name');
    input.value = typed;
    input.focus();
  } else bar.innerHTML = html;
}

const pct = (time) => `${(M.clamp(time / P.scene.duration, 0, 1) * 100).toFixed(3)}%`;

function renderTracks() {
  const s = P.scene;
  const ticks = [];
  const every = s.duration > 30 ? 5 : s.duration > 12 ? 2 : 1;
  for (let i = 0; i <= s.duration; i += every) ticks.push(`<i class="pv-tick" style="left:${pct(i)}"><span>${i}</span></i>`);
  const lane = (keys, attrs) => `<div class="pv-lane" ${attrs}>${keys.map((k, i) => `<button class="pv-key ${M.sameTime(k.t, P.time) ? 'on' : ''}" data-key="${i}" style="left:${pct(k.t)}" aria-label="${t('pv_key_at', { t: k.t.toFixed(2) })}"></button>`).join('')}<i class="pv-ph"></i></div>`;
  const row = (type, id, label, keys) => `<div class="pv-row ${P.sel.type === type && P.sel.id === id ? 'sel' : ''}" data-track="${type}" data-id="${id}">
    <button class="pv-lab" data-track-label>${label}</button>${lane(keys, '')}</div>`;
  $('#pv-tracks').innerHTML = `<div class="pv-row pv-ruler"><span class="pv-lab"></span><div class="pv-lane" data-ruler>${ticks.join('')}<i class="pv-ph"></i></div></div>`
    + row('camera', '', `${ICON.camera}<span>${t('pv_camera')}</span>`, s.camera.keys)
    + s.actors.map((a) => row('actor', a.id, `<i class="pv-dot" style="background:${a.color}"></i><span>${esc(a.name || '?')}</span>`, a.keys)).join('');
  movePlayheads();
}

function movePlayheads() {
  const left = pct(P.time);
  for (const el of P.root.querySelectorAll('.pv-ph')) el.style.left = left;
  $('#pv-clock').textContent = `${P.time.toFixed(2)} / ${P.scene.duration.toFixed(0)} s`;
  const play = $('#pv-play');
  if (play.dataset.state !== String(P.playing)) {
    play.dataset.state = String(P.playing);
    play.innerHTML = P.playing ? ICON.pause : ICON.play;
    play.title = t(P.playing ? 'pv_pause' : 'pv_play');
    play.setAttribute('aria-label', play.title);
  }
  const keys = trackKeys();
  $('#pv-add-key').disabled = !keys;
  $('#pv-del-key').disabled = !keys || keys.length < 2 || M.keyIndexAt(keys, P.time) < 0;
}

const fld = (label, html, wide = false) => `<label class="field ${wide ? 'wide' : ''}"><span>${label}</span>${html}</label>`;
const fNum = (f, v, min, max, step) => `<input type="number" data-f="${f}" value="${Number(v.toFixed(3))}" min="${min}" max="${max}" step="${step}">`;
const fText = (f, v, ph = '') => `<input type="text" data-f="${f}" value="${esc(v)}" placeholder="${esc(ph)}" maxlength="400">`;
const fColor = (f, v) => `<input type="color" data-f="${f}" value="${v}">`;
const fSel = (f, v, opts) => `<select data-f="${f}">${opts.map(([k, n]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
const fRange = (f, v, min, max, step, unit = '') => `<span class="pv-range"><input type="range" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}"><output>${Number(v.toFixed(2))}${unit}</output></span>`;

function renderInspector() {
  const s = P.scene, el = $('#pv-insp'), type = P.sel.type, it = selected();
  const now = `<span class="chip">${P.time.toFixed(2)} s</span>`;
  const keyChip = (keys) => (M.keyIndexAt(keys, P.time) >= 0 ? `<span class="chip good">${t('pv_on_key')}</span>` : `<span class="chip">${t('pv_makes_key')}</span>`);
  let html;
  if (type === 'actor' && it) {
    const st = M.sampleActor(it, P.time), key = it.keys[M.keyIndexAt(it.keys, P.time)];
    const auto = !key || key.face == null;
    html = `<div class="row spread pv-cap"><b>${ICON.person} ${t('pv_actor')}</b><button class="btn icon danger" data-pv="del-item" title="${t('delete')}" aria-label="${t('delete')}">${ICON.trash}</button></div>
      <div class="fields">${fld(t('pv_name'), fText('a.name', it.name))}${fld(t('pv_color'), fColor('a.color', it.color))}
        ${fld(t('pv_about'), fText('a.about', it.about, t('pv_about_ph')), true)}
        ${fld(t('pv_height'), fRange('a.height', it.height, 0.9, 2.2, 0.05, ' m'), true)}</div>
      <div class="pv-sub row">${t('pv_at_time')} ${now} ${keyChip(it.keys)}</div>
      <div class="fields">${fld(t('pv_pose'), fSel('a.pose', st.pose, M.POSES.map((p) => [p, t('pv_pose_' + p)])))}
        ${fld(t('pv_facing'), `<span class="row"><input type="checkbox" data-f="a.autoface" ${auto ? 'checked' : ''}> ${t('pv_face_auto')}</span>`)}
        ${auto ? '' : fld(t('pv_face_angle'), fRange('a.face', key.face, -180, 180, 5, '°'), true)}</div>`;
  } else if (type === 'prop' && it) {
    html = `<div class="row spread pv-cap"><b>${ICON.box} ${t('pv_prop')}</b><button class="btn icon danger" data-pv="del-item" title="${t('delete')}" aria-label="${t('delete')}">${ICON.trash}</button></div>
      <div class="fields">${fld(t('pv_name'), fText('p.name', it.name))}${fld(t('pv_shape'), fSel('p.kind', it.kind, [['box', t('pv_box')], ['cylinder', t('pv_cylinder')]]))}
        ${fld(t('pv_width'), fNum('p.w', it.w, 0.1, 30, 0.1))}${fld(t('pv_depth'), fNum('p.d', it.d, 0.1, 30, 0.1))}
        ${fld(t('pv_tall'), fNum('p.h', it.h, 0.05, 20, 0.1))}${fld(t('pv_color'), fColor('p.color', it.color))}
        ${fld(t('pv_rotation'), fRange('p.rot', it.rot, -180, 180, 5, '°'), true)}</div>`;
  } else if (type === 'camera') {
    const key = s.camera.keys[M.keyIndexAt(s.camera.keys, P.time)];
    const c = key ?? (() => { const v = M.sampleCamera({ ...s, camera: { ...s.camera, follow: '' } }, P.time); return { y: v.pos[1], ty: v.target[1], fov: v.fov }; })();
    html = `<div class="row spread pv-cap"><b>${ICON.camera} ${t('pv_camera')}</b></div>
      <div class="pv-sub row">${t('pv_at_time')} ${now} ${keyChip(s.camera.keys)}</div>
      <div class="fields">${fld(t('pv_cam_height'), fRange('c.y', c.y, 0.1, 20, 0.1, ' m'), true)}
        ${s.camera.follow ? '' : fld(t('pv_look_height'), fRange('c.ty', c.ty, 0, 10, 0.1, ' m'), true)}
        ${fld(t('pv_fov'), fRange('c.fov', c.fov, 12, 95, 1, '°'), true)}</div>
      <div class="pv-sub">${t('pv_whole_shot')}</div>
      <div class="fields">${fld(t('pv_follow'), fSel('c.follow', s.camera.follow, [['', t('pv_follow_none')], ...s.actors.map((a) => [a.id, a.name || '?'])]))}
        ${fld(t('pv_ease'), fSel('c.ease', s.camera.ease, [['smooth', t('pv_ease_smooth')], ['linear', t('pv_ease_linear')]]))}</div>`;
  } else {
    html = `<div class="row spread pv-cap"><b>${t('pv_shot')}</b></div>
      <div class="fields">${fld(t('pv_duration'), fNum('s.duration', s.duration, 1, 60, 1))}
        ${fld(t('pv_aspect'), fSel('s.aspect', s.aspect, Object.keys(M.ASPECTS).map((a) => [a, a])))}
        ${fld(t('pv_fps'), fSel('s.fps', s.fps, M.FPS.map((f) => [f, f])))}
        ${fld(t('pv_ground'), `<span class="row">${fColor('s.ground', s.ground)}${fColor('s.sky', s.sky)}</span>`)}
        ${fld(t('pv_setting'), fText('s.setting', s.setting, t('pv_setting_ph')), true)}
        ${fld(t('pv_style'), fText('s.style', s.style, t('pv_style_ph')), true)}</div>`;
  }
  el.innerHTML = html;
}

function renderExport() {
  const el = $('#pv-export'), ex = P.exporting, last = P.lastExport;
  if (!P.scene) return;
  const prompt = describe(P.scene, P.promptLang);
  const progress = ex ? `<div class="bar"><i style="width:${ex.pct}%"></i></div><div class="small muted">${t(ex.stage === 'control' ? 'pv_exporting_control' : 'pv_exporting', { pct: ex.pct })}</div>` : '';
  const done = last && !ex ? `<div class="notice good">${t('pv_exported')} <code>${esc(last.dir)}</code>
    ${native ? `<button class="btn link" data-pv="reveal">${t('show_folder')}</button>` : ''}</div>` : '';
  el.innerHTML = `<div class="row spread pv-cap"><b>${t('pv_prompt')}</b>
      <div class="row">${fSel('promptLang', P.promptLang, [['en', 'English'], ['zh', '中文']])}
      <button class="btn" data-pv="copy">${t('pv_copy')}</button></div></div>
    <textarea id="pv-prompt" readonly rows="5" aria-label="${t('pv_prompt')}">${esc(prompt)}</textarea>
    <div class="small muted" style="margin:6px 0 12px">${t('pv_prompt_hint')}</div>
    <div class="row"><button class="btn primary" data-pv="export" ${ex ? 'disabled' : ''}>${t(ex ? 'pv_exporting_short' : 'pv_export')}</button>
      ${ex ? `<button class="btn" data-pv="cancel-export">${t('cancel')}</button>` : ''}
      <span class="small muted">${t('pv_export_hint')}</span></div>${progress}${done}`;
}

function drawStage() {
  if (P.stage && !P.exporting) P.stage.render(P.scene, P.time);
}

/** Redraws whatever depends on the scene or the time. */
function refresh({ force = false } = {}) {
  if (!P.scene) return;
  drawStage();
  P.map.draw();
  renderTracks();
  const active = document.activeElement;
  if (force || !$('#pv-insp').contains(active)) renderInspector();
  if (!P.root.querySelector('#pv-export')?.contains(active) || force) renderExport();
}

function renderAll() {
  renderBar();
  refresh({ force: true });
}

// ---------- editing ----------

const setters = {
  's.duration': (v) => { M.setDuration(P.scene, Number(v) || 1); P.time = Math.min(P.time, P.scene.duration); },
  's.aspect': (v) => { if (M.ASPECTS[v]) P.scene.aspect = v; },
  's.fps': (v) => { P.scene.fps = Number(v); },
  's.ground': (v) => { P.scene.ground = v; },
  's.sky': (v) => { P.scene.sky = v; },
  's.setting': (v) => { P.scene.setting = v; },
  's.style': (v) => { P.scene.style = v; },
  'a.name': (v, a) => { a.name = v.slice(0, 40); },
  'a.about': (v, a) => { a.about = v; },
  'a.color': (v, a) => { a.color = v; },
  'a.height': (v, a) => { a.height = Number(v); },
  'a.pose': (v, a) => { M.setActorKey(a, P.time, { pose: v }); },
  'a.autoface': (v, a) => { M.setActorKey(a, P.time, { face: v ? null : Math.round(M.deg(M.sampleActor(a, P.time).heading) / 5) * 5 }); },
  'a.face': (v, a) => { M.setActorKey(a, P.time, { face: Number(v) }); },
  'p.name': (v, p) => { p.name = v.slice(0, 40); },
  'p.kind': (v, p) => { p.kind = v === 'cylinder' ? 'cylinder' : 'box'; },
  'p.w': (v, p) => { p.w = M.clamp(Number(v) || 1, 0.1, 30); },
  'p.d': (v, p) => { p.d = M.clamp(Number(v) || 1, 0.1, 30); },
  'p.h': (v, p) => { p.h = M.clamp(Number(v) || 1, 0.05, 20); },
  'p.rot': (v, p) => { p.rot = Number(v); },
  'p.color': (v, p) => { p.color = v; },
  'c.y': (v) => { M.setCameraKey(P.scene, P.time, { y: Number(v) }); },
  'c.ty': (v) => { M.setCameraKey(P.scene, P.time, { ty: Number(v) }); },
  'c.fov': (v) => { M.setCameraKey(P.scene, P.time, { fov: Number(v) }); },
  'c.follow': (v) => { P.scene.camera.follow = v; },
  'c.ease': (v) => { P.scene.camera.ease = v === 'linear' ? 'linear' : 'smooth'; },
};

function onField(e, final) {
  const el = e.target, f = el.dataset?.f;
  if (!f) return;
  if (f === 'promptLang') {
    P.promptLang = el.value;
    return renderExport();
  }
  if (el.type === 'number' && !final) return; // wait until the number is complete
  setters[f]?.(el.type === 'checkbox' ? el.checked : el.value, selected());
  if (el.type === 'range') el.nextElementSibling.textContent = el.value + (el.nextElementSibling.textContent.match(/[^\d.\-]+$/)?.[0] ?? '');
  if (final) {
    commit();
    refresh({ force: true });
    P.root.querySelector(`[data-f="${f}"]`)?.focus();
  } else refresh();
}

function setTime(time, { stop = true } = {}) {
  if (stop) P.playing = false;
  P.time = M.clamp(time, 0, P.scene.duration);
  refresh();
}

const actions = {
  new: () => createScene(),
  async 'delete-scene'() {
    if (!confirm(t('pv_delete_scene_confirm', { name: P.scene.name }))) return;
    clearTimeout(P.saveTimer);
    P.saveTimer = 0;
    if (P.savedName) await invoke('previs_delete', { name: P.savedName }).catch((e) => P.hooks.toast(String(e?.message ?? e), true));
    await refreshList();
    if (P.scenes.length) {
      P.saveTimer = 0;
      const scene = M.normalize(await invoke('previs_load', { name: P.scenes[0].name }));
      scene.name = P.scenes[0].name;
      adopt(scene, true);
    } else {
      adopt(M.demoScene(uniqueName(), t('pv_actor_n', { n: 1 })), false);
      await save();
    }
  },
  undo: () => travel(-1),
  redo: () => travel(1),
  'add-actor'() {
    const a = M.newActor(P.scene, t('pv_actor_n', { n: P.scene.actors.length + 1 }));
    P.sel = { type: 'actor', id: a.id };
    commit();
    refresh({ force: true });
  },
  'add-prop'() {
    const p = M.newProp(P.scene);
    P.sel = { type: 'prop', id: p.id };
    commit();
    refresh({ force: true });
  },
  fit: () => P.map.fit(),
  'del-item'() {
    const s = P.scene;
    if (P.sel.type === 'actor') {
      s.actors = s.actors.filter((a) => a.id !== P.sel.id);
      if (s.camera.follow === P.sel.id) s.camera.follow = '';
    } else if (P.sel.type === 'prop') s.props = s.props.filter((p) => p.id !== P.sel.id);
    P.sel = { type: 'scene', id: '' };
    commit();
    refresh({ force: true });
  },
  rewind: () => setTime(0),
  play() {
    P.playing = !P.playing;
    if (P.playing && P.time >= P.scene.duration - 1e-6) P.time = 0;
    if (P.playing) loop.last = performance.now(), requestAnimationFrame(loop);
    refresh({ force: true });
  },
  'add-key'() {
    const it = selected();
    if (P.sel.type === 'actor') M.setActorKey(it, P.time);
    else if (P.sel.type === 'camera') M.setCameraKey(P.scene, P.time);
    else return;
    commit();
    refresh({ force: true });
  },
  'del-key'() {
    const keys = trackKeys();
    if (keys && M.removeKey(keys, P.time)) {
      commit();
      refresh({ force: true });
    }
  },
  async copy() {
    const text = $('#pv-prompt').value;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      $('#pv-prompt').select();
      document.execCommand('copy');
    }
    P.hooks.toast(t('pv_copied'));
  },
  export: () => exportAll(),
  'cancel-export'() { if (P.exporting) P.exporting.cancel = true; },
  reveal: () => invoke('reveal', { path: P.lastExport.dir }).catch((e) => P.hooks.toast(String(e?.message ?? e), true)),
};

function loop(now) {
  if (!P.playing || !P.root.isConnected) { P.playing = false; return; }
  const dt = Math.min((now - loop.last) / 1000, 0.1);
  loop.last = now;
  P.time += dt;
  if (P.time >= P.scene.duration) P.time = 0;
  drawStage();
  P.map.draw();
  movePlayheads();
  for (const k of P.root.querySelectorAll('.pv-key.on')) k.classList.remove('on');
  requestAnimationFrame(loop);
}

// ---------- timeline pointer handling ----------

function laneTime(lane, clientX) {
  const r = lane.getBoundingClientRect();
  return M.snap(M.clamp((clientX - r.left) / r.width, 0, 1) * P.scene.duration);
}

function onTimelineDown(e) {
  const lane = e.target.closest('.pv-lane');
  const rowEl = e.target.closest('.pv-row');
  if (e.target.closest('[data-track-label]')) return select({ type: rowEl.dataset.track, id: rowEl.dataset.id });
  if (!lane) return;
  e.preventDefault();
  const track = rowEl.dataset.track ? { type: rowEl.dataset.track, id: rowEl.dataset.id } : null;
  if (track) P.sel = track;
  const keyEl = e.target.closest('.pv-key');
  const keys = track ? trackKeys() : null;
  let index = keyEl ? Number(keyEl.dataset.key) : -1, dragged = false;
  const startX = e.clientX;
  // The lane is re-rendered while dragging, so measure against a fixed rectangle.
  const rect = lane.getBoundingClientRect();
  setTime(index >= 0 ? keys[index].t : laneTime(lane, e.clientX));
  refresh({ force: true });
  const timeAt = (x) => M.snap(M.clamp((x - rect.left) / rect.width, 0, 1) * P.scene.duration);
  const move = (ev) => {
    if (index >= 0) {
      if (!dragged && Math.abs(ev.clientX - startX) < 4) return;
      dragged = true;
      P.time = M.retimeKey(keys, index, timeAt(ev.clientX), P.scene.duration);
      refresh();
    } else setTime(timeAt(ev.clientX));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (dragged) commit();
    refresh({ force: true });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------- camera control in the 3D view ----------

function bindScreen(canvas) {
  let drag = null;
  const camNow = () => M.sampleCamera(P.scene, P.time);
  canvas.addEventListener('pointerdown', (e) => {
    if (P.exporting) return;
    canvas.setPointerCapture(e.pointerId);
    P.playing = false;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    if (P.sel.type !== 'camera') select({ type: 'camera', id: '' });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved = true;
    const c = camNow();
    const off = [c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]];
    const dist = Math.hypot(...off);
    if (e.shiftKey && !P.scene.camera.follow) {
      const f = M.cameraFrame(c, 1), k = dist * 0.0016;
      const shift = [0, 1, 2].map((i) => -f.right[i] * dx * k + f.up[i] * dy * k);
      M.setCameraKey(P.scene, P.time, {
        x: c.pos[0] + shift[0], y: Math.max(0.1, c.pos[1] + shift[1]), z: c.pos[2] + shift[2],
        tx: c.target[0] + shift[0], ty: Math.max(0, c.target[1] + shift[1]), tz: c.target[2] + shift[2],
      });
    } else {
      const yaw = Math.atan2(off[0], off[2]) - dx * 0.008;
      const pitch = M.clamp(Math.asin(off[1] / dist) + dy * 0.006, -1.2, 1.5);
      M.setCameraKey(P.scene, P.time, {
        x: c.target[0] + Math.sin(yaw) * Math.cos(pitch) * dist,
        y: Math.max(0.1, c.target[1] + Math.sin(pitch) * dist),
        z: c.target[2] + Math.cos(yaw) * Math.cos(pitch) * dist,
      });
    }
    refresh();
  });
  const end = () => {
    if (drag?.moved) { commit(); refresh({ force: true }); }
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  let wheelTimer = 0;
  canvas.addEventListener('wheel', (e) => {
    if (P.exporting) return;
    e.preventDefault();
    const c = camNow();
    const off = [c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]];
    const dist = Math.hypot(...off), next = M.clamp(dist * Math.exp(e.deltaY * 0.0012), 0.6, 80), k = next / dist;
    M.setCameraKey(P.scene, P.time, { x: c.target[0] + off[0] * k, y: Math.max(0.1, c.target[1] + off[1] * k), z: c.target[2] + off[2] * k });
    if (P.sel.type !== 'camera') P.sel = { type: 'camera', id: '' };
    refresh();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { commit(); refresh({ force: true }); }, 350);
  }, { passive: false });
}

// ---------- export ----------

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function recorderType() {
  if (!window.MediaRecorder) return '';
  return ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

async function recordVideo(canvas, job) {
  const mime = recorderType();
  if (!mime || !canvas.captureStream) throw new Error(t('pv_no_recorder'));
  const s = P.scene, fps = s.fps;
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  const manual = typeof track.requestFrame === 'function';
  if (!manual) {
    track.stop();
    stream = canvas.captureStream(fps);
    track = stream.getVideoTracks()[0];
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(e.error ?? new Error('recorder failed'));
  });
  P.stage.render(s, 0, { grid: false });
  rec.start();
  const begin = performance.now();
  // Scene time follows the wall clock, so the clip always plays at true speed;
  // a slow machine drops frames instead of stretching the shot.
  for (let i = 0; !job.cancel; i++) {
    const elapsed = (performance.now() - begin) / 1000;
    if (elapsed >= s.duration) break;
    P.stage.render(s, elapsed, { grid: false });
    if (manual) track.requestFrame();
    job.pct = Math.round((elapsed / s.duration) * 100);
    if (i % 4 === 0) renderExport();
    await sleep(Math.max(0, begin + ((Math.floor(elapsed * fps) + 1) * 1000) / fps - performance.now()));
  }
  P.stage.render(s, s.duration, { grid: false });
  if (manual) track.requestFrame();
  await sleep(1000 / fps);
  rec.stop();
  await stopped;
  track.stop();
  if (job.cancel) return null;
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), file: mime.startsWith('video/mp4') ? 'previs.mp4' : 'previs.webm' };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportAll() {
  if (P.exporting) return;
  if (!P.stage) return P.hooks.toast(P.stageError || t('pv_no_3d'), true);
  P.playing = false;
  const job = (P.exporting = { pct: 0, cancel: false });
  renderExport();
  try {
    await flushSave();
    const name = P.scene.name, canvas = P.stage.canvas;
    const prompt = describe(P.scene, P.promptLang);
    P.stage.render(P.scene, P.time, { grid: false });
    const still = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    job.stage = 'control';
    const control = await renderControl(P.stage, P.scene, async (done, total) => {
      job.pct = Math.round((done / total) * 100);
      if (done % 4 === 0) { renderExport(); await sleep(0); }
      return !job.cancel;
    });
    job.stage = 'video';
    job.pct = 0;
    // The reference clip needs the system recorder; the depth frames do not, so
    // a recorder failure still leaves everything a video recipe needs.
    let video = null, recorderError = '';
    if (control) {
      try { video = await recordVideo(canvas, job); } catch (e) { recorderError = String(e?.message ?? e); }
    }
    if (control && !job.cancel) {
      const files = [['still.png', still], ['control.png', control.blob], ['prompt.txt', new Blob([prompt], { type: 'text/plain' })]];
      if (video) files.unshift([video.file, video.blob]);
      const out = {};
      for (const [file, blob] of files) {
        if (native) out[file] = await invoke('previs_export', { name, file, data: await toBase64(blob) });
        else download(blob, `${name}-${file}`);
      }
      const dir = native ? out['still.png'].replace(/[\/\\][^\/\\]+$/, '') : t('pv_downloads');
      P.lastExport = {
        dir, still: out['still.png'] ?? '', video: video ? out[video.file] ?? '' : '', control: out['control.png'] ?? '',
        prompt, frames: control.frames, width: control.width, height: control.height,
      };
      if (recorderError) P.hooks.toast(t('pv_export_no_clip', { why: recorderError }), true);
      else P.hooks.toast(t('pv_export_done'));
    }
  } catch (e) {
    P.hooks.toast(String(e?.message ?? e), true);
  }
  P.exporting = null;
  refresh({ force: true });
}

// ---------- wiring ----------

function wire(root) {
  root.querySelector('#pv-qwen')?.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget, button = form.querySelector('button');
    if (button.disabled || !P.scene) return;
    const description = form.querySelector('#pv-idea').value.trim();
    if (!description) return form.querySelector('#pv-idea').focus();
    const seconds = form.querySelector('#pv-seconds').valueAsNumber;
    const status = form.querySelector('#pv-qwen-status');
    const started = P.scene;
    button.disabled = true;
    status.textContent = t('pv_qwen_busy');
    try {
      const raw = await invoke('previs_from_qwen', {description, seconds});
      await refreshList();
      if (P.scene === started && P.root === root && !P.exporting) {
        // Let any pending autosave finish before switching scenes.
        await flushSave();
        if (P.saving) await P.saving;
        if (P.saveState !== 'bad' && P.scene === started && !P.saveTimer) adopt(M.normalize(raw), true);
      }
      renderBar();
      status.textContent = t('pv_qwen_done', {name: raw.name});
    } catch (error) {
      status.textContent = String(error?.message ?? error);
    } finally {
      button.disabled = false;
    }
  });
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-pv]')?.dataset.pv;
    if (act) actions[act]?.();
  });
  root.addEventListener('input', (e) => onField(e, false));
  root.addEventListener('change', async (e) => {
    if (e.target.id === 'pv-open') return openScene(e.target.value);
    if (e.target.id === 'pv-name') {
      const name = e.target.value.trim();
      if (name === P.scene.name) return;
      if (!validName(name) || P.scenes.some((s) => s.name === name)) {
        e.target.value = P.scene.name;
        return P.hooks.toast(t(validName(name) ? 'pv_name_taken' : 'pv_name_bad'), true);
      }
      P.scene.name = name;
      commit();
      return save();
    }
    onField(e, true);
  });
  $('#pv-tracks', root).addEventListener('pointerdown', onTimelineDown);
  $('#pv-tracks', root).addEventListener('dblclick', (e) => {
    if (e.target.closest('.pv-lane') && trackKeys() && !e.target.closest('.pv-key')) actions['add-key']();
  });
  document.addEventListener('keydown', (e) => {
    if (!root.isConnected || !P.scene || e.target.closest?.('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === ' ') actions.play();
    else if (mod && e.key.toLowerCase() === 'z') travel(e.shiftKey ? 1 : -1);
    else if (e.key === 'Delete' || e.key === 'Backspace') actions['del-key']();
    else if (e.key === 'ArrowLeft') setTime(M.snap(P.time) - (e.shiftKey ? 1 : M.STEP));
    else if (e.key === 'ArrowRight') setTime(M.snap(P.time) + (e.shiftKey ? 1 : M.STEP));
    else if (e.key.toLowerCase() === 'k') actions['add-key']();
    else return;
    e.preventDefault();
  });
}

async function start() {
  P.promptLang = getLang() === 'en' ? 'en' : 'zh';
  P.map = new Map2D($('#pv-map'), {
    scene: () => P.scene, time: () => P.time, selection: () => P.sel,
    select, changed: () => refresh(), commit: () => { commit(); refresh({ force: true }); },
  });
  try {
    const { Stage3D } = await import('./stage3d.js');
    P.stage = new Stage3D($('#pv-3d'));
    bindScreen($('#pv-3d'));
  } catch (e) {
    P.stageError = t('pv_no_3d');
    $('#pv-screen').innerHTML = `<div class="notice bad">${P.stageError}<br><span class="small">${esc(e?.message ?? e)}</span></div>`;
  }
  await refreshList();
  if (P.scenes.length) await openScene(P.scenes[0].name);
  if (!P.scene) {
    adopt(M.demoScene(uniqueName(), t('pv_actor_n', { n: 1 })), false);
    await save();
  }
  P.saveState = 'ok';
  renderBar();
}

export const previs = {
  /** Puts the persistent Previs view into the page (built on first use). */
  show(view, hooks, banner = '') {
    P.hooks = hooks;
    if (P.root && P.lang !== getLang()) {
      // Labels are baked in when the view is built, so a language change rebuilds it.
      P.root.remove();
      P.root = null;
      P.ready = false;
      P.scene = null;
    }
    if (!P.root) {
      P.lang = getLang();
      P.root = build();
      wire(P.root);
    }
    if (P.root.parentElement !== view) {
      view.innerHTML = banner;
      view.append(P.root);
    }
    if (!P.ready) {
      P.ready = true;
      start();
    } else if (P.scene) {
      P.map.fit();
      refresh({ force: true });
    }
  },
  hide() {
    P.playing = false;
    return flushSave();
  },
  /** Paths of the most recent export, for filling Studio image and video fields. */
  lastExport: () => P.lastExport,
};
