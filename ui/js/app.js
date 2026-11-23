import { invoke, listen, fileSrc, native } from './bridge.js';
import { t, loc, setLang, getLang, languages } from './i18n.js';
import { projectView, refreshProject, projectName } from './projects.js';
import { dialogueBusy } from './dialogue.js';
import { showH3, h3Busy } from './hyperflow.js';
import { previs } from './previs/view.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (bytes) => (bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1) + ' GB';

const icons = {
  projects: '<path d="M3 6h7l2 3h9v11H3z"/>',
  recipes: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  studio: '<path d="M12 3l2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z"/>',
  works: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/>',
  previs: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/><circle cx="8" cy="10" r="1.6"/><path d="M5.5 16c.6-2 4.4-2 5 0"/>',
  hyperflow: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

const S = {
  tab: native ? 'projects' : 'studio',
  ov: null,
  jobs: {},      // recipe id -> { phase, message, done, total, error }
  logs: {},      // recipe id -> string[]
  starting: {},  // recipe id -> true while waiting for the engine port
  studio: { recipe: null, values: {}, busy: false, status: '', pct: 0, result: null, error: '' },
  works: [],
};

function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ''), bad ? 6000 : 2600);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e?.message ?? e), true);
    throw e;
  }
}

async function refresh() {
  S.ov = await call('overview');
  if (!refresh.langSet) {
    setLang(S.ov.language ?? 'zh-Hant');
    refresh.langSet = true;
  }
  for (const r of S.ov.recipes) if (r.running) delete S.starting[r.id];
  render();
}

function recipeById(id) {
  return S.ov?.recipes.find((r) => r.id === id);
}

// ---------- shell ----------

function renderNav() {
  $('#nav').innerHTML = [...(native ? ['projects'] : []), ...(S.ov.recipes.length > 1 ? ['recipes'] : []), 'previs', 'studio', 'hyperflow', 'works', 'settings']
    .map((k) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[k]}</svg>${t('nav_' + k)}</button>`)
    .join('');
  const badge = document.querySelector('#active-project');
  badge.hidden = !native;
  badge.textContent = projectName();
  const hw = S.ov?.hardware;
  $('#hw').innerHTML = hw ? `<b>${esc(hw.chip || hw.arch)}</b>${hw.memory_gb} GB · ${t('free_space')} ${hw.disk_free_gb} GB` : '';
}

function render() {
  if (!S.ov) return;
  renderNav();
  const view = $('#view');
  const keep = view.scrollTop;
  const banner = native ? '' : `<div class="notice">${t('preview_banner')}</div>`;
  if (S.tab === 'projects') {
    view.innerHTML=projectView(esc);
    refreshProject().catch(e=>toast(String(e),true));
    return;
  }
  if (S.tab === 'hyperflow') return showH3(view, {esc, toast, loadWorks});
  if (S.tab === 'previs') return previs.show(view, { toast }, banner);
  view.innerHTML = banner + { recipes: viewRecipes, studio: viewStudio, works: viewWorks, settings: viewSettings }[S.tab]();
  view.scrollTop = keep;
  for (const pre of view.querySelectorAll('pre.log')) pre.scrollTop = pre.scrollHeight;
}

// ---------- recipes ----------

function viewRecipes() {
  const problems = S.ov.problems.length
    ? `<div class="notice bad"><b>${t('recipe_problems')}</b><br>${S.ov.problems.map(esc).join('<br>')}</div>` : '';
  return `<h1>${t('recipes_title')}</h1><p class="sub">${t('recipes_sub')}</p>${problems}` + S.ov.recipes.map(recipeCard).join('');
}

function recipeCard(r) {
  const job = S.jobs[r.id];
  const busy = r.installing || (job && ['tools', 'download', 'setup'].includes(job.phase));
  const req = r.requires;
  const outdated = r.installed && r.installed_version !== r.version;
  const chips = [
    `<span class="chip ${r.fit}">${t('fit_' + r.fit)}</span>`,
    r.running ? `<span class="chip live">${t('running')}</span>` : `<span class="chip">${t(r.installed ? 'installed' : 'not_installed')}</span>`,
    outdated ? `<span class="chip tight">${t('update_available')}</span>` : '',
    `<span class="chip">${t('download')} ${gb(r.download_bytes)}</span>`,
    req.min_memory_gb ? `<span class="chip">${t('memory')} ${t('min')} ${req.min_memory_gb} GB · ${t('recommended')} ${req.recommended_memory_gb} GB</span>` : '',
    req.disk_gb ? `<span class="chip">${t('disk')} ${req.disk_gb} GB</span>` : '',
  ].join('');

  let actions;
  if (busy) {
    actions = `<button class="btn" data-act="cancel" data-id="${r.id}">${t('cancel')}</button>`;
  } else if (!r.installed) {
    const label = job?.phase === 'cancelled' || job?.phase === 'error' ? 'resume' : 'install';
    actions = `<button class="btn primary" data-act="install" data-id="${r.id}" ${r.fit === 'no' || r.missing_tools.length ? 'disabled' : ''}>${t(label)}</button>`;
  } else {
    const engine = r.running
      ? (r.managed ? `<button class="btn" data-act="stop" data-id="${r.id}">${t('stop')}</button>` : '')
      : `<button class="btn primary" data-act="start" data-id="${r.id}" ${S.starting[r.id] ? 'disabled' : ''}>${t(S.starting[r.id] ? 'starting' : 'start')}</button>`;
    actions = engine
      + (r.studio ? `<button class="btn ${r.running ? 'primary' : ''}" data-act="studio" data-id="${r.id}">${t('open_studio')}</button>` : '')
      + (r.running ? `<button class="btn" data-act="open" data-id="${r.id}">${t('open_engine')}</button>` : '')
      + `<button class="btn link" data-act="folder" data-id="${r.id}">${t('show_folder')}</button>`
      + `<button class="btn link" data-act="install" data-id="${r.id}">${t('reinstall')}</button>`
      + (r.running ? '' : `<button class="btn link danger" data-act="uninstall" data-id="${r.id}">${t('uninstall')}</button>`);
  }

  let progress = '';
  if (busy && job) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    const label = job.phase === 'download'
      ? `${t('phase_download')} · ${esc(job.message)} · ${gb(job.done)} / ${gb(job.total)} (${pct}%)`
      : t('phase_' + job.phase);
    progress = `<div class="bar ${job.phase === 'download' ? '' : 'busy'}"><i style="width:${pct}%"></i></div><div class="small muted">${label}</div>`;
  } else if (job?.phase === 'error') {
    progress = `<div class="notice bad"><b>${t('job_error')}</b><br>${esc(job.error)}</div>`;
  }
  const notes = [
    r.missing_tools.length ? `<div class="notice">${t('missing_tools', { tools: esc(r.missing_tools.join(', ')) })}</div>` : '',
    r.running && !r.managed ? `<div class="notice">${t('external_running')}</div>` : '',
  ].join('');
  const log = S.logs[r.id]?.length ? `<pre class="log">${esc(S.logs[r.id].join('\n'))}</pre>` : '';

  return `<section class="card">
    <h2>${esc(loc(r.name))}</h2>
    <div>${esc(loc(r.summary))}</div>
    <div class="chips">${chips}</div>
    ${r.license_note ? `<div class="small muted" style="margin-bottom:12px">${esc(loc(r.license_note))}</div>` : ''}
    ${notes}
    <div class="row">${actions}</div>
    ${progress}${log}
  </section>`;
}

const recipeActions = {
  async install(id) {
    S.jobs[id] = { phase: 'tools', message: '', done: 0, total: 0 };
    S.logs[id] = [];
    render();
    await call('install_recipe', { id }).catch(() => delete S.jobs[id]);
    render();
  },
  cancel: (id) => call('cancel_install', { id }),
  async start(id) {
    S.starting[id] = true;
    render();
    try {
      await call('start_recipe', { id });
      pollEngine(id);
    } catch {
      delete S.starting[id];
      render();
    }
  },
  async stop(id) {
    await call('stop_recipe', { id });
    setTimeout(refresh, 800);
  },
  studio(id) {
    S.studio.recipe = id;
    S.tab = 'studio';
    render();
  },
  open: (id) => call('open_url', { url: `http://127.0.0.1:${recipeById(id).run.port}/` }),
  folder: (id) => call('reveal', { path: recipeById(id).app_dir }),
  async uninstall(id) {
    if (!confirm(t('uninstall_confirm'))) return;
    await call('uninstall_recipe', { id });
    delete S.jobs[id];
    refresh();
  },
};

async function pollEngine(id, tries = 0) {
  if (!S.starting[id]) return;
  await refresh().catch(() => {});
  if (S.starting[id] && tries < 90) setTimeout(() => pollEngine(id, tries + 1), 2000);
  else if (S.starting[id]) { delete S.starting[id]; render(); }
}

// ---------- studio ----------

function studioRecipes() {
  return S.ov.recipes.filter((r) => r.installed && r.studio);
}

function studioDefaults(r) {
  return Object.fromEntries(r.studio.controls.map((c) => [c.key, c.default ?? '']));
}

function viewStudio() {
  const list = studioRecipes();
  const head = `<h1>${t('studio_title')}</h1><p class="sub">${t('studio_sub')}</p>`;
  if (!list.length) return head + `<div class="card empty">${t('studio_none')} <button class="btn" data-tab="recipes">${t('manage_recipes')}</button></div>`;
  const st = S.studio;
  let r = list.find((x) => x.id === st.recipe);
  if (!r) {
    r = list[0];
    st.recipe = r.id;
    st.values = {};
  }
  if (!Object.keys(st.values).length) st.values = studioDefaults(r);

  const fields = r.studio.controls.map((c) => field(c, st.values[c.key])).join('');
  const last = previs.lastExport();
  const fill = last && r.studio.controls.some((c) => c.previs && last[c.previs])
    ? `<div class="notice"><button type="button" class="btn" data-fill-previs>${t('fill_previs')}</button> <span class="small muted">${t('fill_previs_hint')}</span></div>` : '';
  const picker = list.length > 1
    ? `<label class="field"><span>${t('recipe')}</span><select id="studio-recipe">${list.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(loc(x.name))}</option>`).join('')}</select></label>`
    : `<div class="small muted" style="margin-bottom:12px">${esc(loc(r.name))}</div>`;
  const off = !r.running
    ? `<div class="notice">${t('engine_off')} <button class="btn" data-act="start" data-id="${r.id}" ${S.starting[r.id] ? 'disabled' : ''}>${t(S.starting[r.id] ? 'starting' : 'engine_start_first')}</button></div>` : '';

  let stage;
  if (st.busy) stage = `<div style="width:70%"><div class="bar ${st.pct ? '' : 'busy'}"><i style="width:${st.pct}%"></i></div><div class="muted">${esc(st.status)}</div></div>`;
  else if (st.error) stage = `<div class="notice bad" style="text-align:left">${esc(st.error)}</div>`;
  else if (st.result) stage = media(st.result, true);
  else stage = `<div class="muted">${t('stage_empty')}</div>`;

  return head + `<div class="studio">
    <form class="card" id="studio-form">${picker}${off}${fill}<div class="fields">${fields}</div>
      <button class="btn primary" type="submit" style="width:100%" ${st.busy || !r.running ? 'disabled' : ''}>${t(st.busy ? 'generating' : 'generate')}</button>
    </form>
    <div class="card stage">${stage}</div>
  </div>`;
}

/** Which part of a Previs export fills this control. */
const previsKey = (c) => c.previs ?? (c.type === 'video' ? 'video' : c.type === 'image' ? 'still' : '');

function field(c, value) {
  const label = esc(loc(c.label));
  const name = `name="${esc(c.key)}"`;
  const v = esc(value ?? '');
  let input;
  switch (c.type) {
    case 'textarea': input = `<textarea ${name}>${v}</textarea>`; break;
    case 'select': input = `<select ${name}>${c.choices.map((o) => `<option ${String(o) === String(value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; break;
    case 'int': case 'float': case 'seed':
      input = `<input type="number" ${name} value="${v}" ${c.min != null ? `min="${c.min}"` : ''} ${c.max != null ? `max="${c.max}"` : ''} step="${c.step ?? (c.type === 'float' ? 'any' : 1)}">`; break;
    case 'image': case 'video': {
      const ready = previs.lastExport()?.[previsKey(c)];
      input = `<div class="row"><button type="button" class="btn" data-pick="${esc(c.key)}" data-kind="${c.type}">${t(c.type === 'video' ? 'choose_video' : 'choose_image')}</button>
        ${ready ? `<button type="button" class="btn" data-from-previs="${esc(c.key)}" data-kind="${c.type}">${t('use_previs')}</button>` : ''}
        <span class="small muted" style="flex:1;overflow:hidden;text-overflow:ellipsis">${value ? esc(String(value).split('/').pop()) : t(c.type === 'video' ? 'no_video' : 'no_image')}</span>
        ${value ? `<button type="button" class="btn link" data-unpick="${esc(c.key)}">${t('clear')}</button>` : ''}</div>`; break;
    }
    default: input = `<input type="text" ${name} value="${v}">`;
  }
  const wide = ['textarea', 'text', 'image', 'video'].includes(c.type) || !c.type;
  return `<label class="field ${wide ? 'wide' : ''}"><span>${label}</span>${input}</label>`;
}

function readForm() {
  const form = $('#studio-form');
  if (!form) return;
  const r = recipeById(S.studio.recipe);
  for (const c of r.studio.controls) {
    // Not form.elements[key]: a control called "length" would collide with the collection's own property.
    const el = form.querySelector(`[name="${CSS.escape(c.key)}"]`);
    if (!el) continue;
    S.studio.values[c.key] = ['int', 'float', 'seed'].includes(c.type) || (c.type === 'select' && typeof c.choices[0] === 'number')
      ? Number(el.value) : el.value;
  }
}

async function generate() {
  readForm();
  const st = S.studio;
  const missing = recipeById(st.recipe).studio.controls.find((c) => c.required && (st.values[c.key] ?? '') === '');
  if (missing) return toast(t('need_field', { name: loc(missing.label) }), true);
  Object.assign(st, { busy: true, status: t('st_queued'), pct: 0, error: '', result: null });
  render();
  try {
    const works = await invoke('generate', { id: st.recipe, values: st.values });
    st.result = works[0] ?? null;
  } catch (e) {
    st.error = String(e?.message ?? e);
  }
  st.busy = false;
  render();
}

function media(w, controls = false) {
  const src = esc(fileSrc(w.path));
  if (w.kind === 'video') return `<video src="${src}" ${controls ? 'controls autoplay loop' : 'muted preload="metadata"'}></video>`;
  if (w.kind === 'audio') return controls ? `<audio src="${src}" controls></audio>` : '♪';
  return `<img src="${src}" alt="${esc(w.values?.prompt ?? w.name)}" loading="lazy">`;
}

// ---------- works ----------

function viewWorks() {
  const head = `<h1>${t('works_title')}</h1><p class="sub">${t('works_sub')}</p>`;
  if (!S.works.length) return head + `<div class="card empty">${t('works_empty')}</div>`;
  return head + `<div class="grid">${S.works.map((w, i) => `<button class="tile" data-work="${i}">
    <div class="thumb">${media(w)}</div><div class="cap">${esc(w.values?.prompt ?? w.name)}</div></button>`).join('')}</div>`;
}

async function loadWorks() {
  S.works = await call('list_works');
  if (S.tab === 'works') render();
}

function openWork(i) {
  const w = S.works[i];
  const r = recipeById(w.recipe);
  const labels = Object.fromEntries((r?.studio?.controls ?? []).map((c) => [c.key, loc(c.label)]));
  const rows = Object.entries(w.values ?? {}).map(([k, v]) => `<dt>${esc(labels[k] ?? k)}</dt><dd>${esc(v)}</dd>`).join('');
  const box = $('#lightbox');
  box.innerHTML = `<div class="media">${media(w, true)}</div>
    <div class="info"><dl><dt>${t('recipe')}</dt><dd>${esc(r ? loc(r.name) : w.recipe)}</dd>
      <dt>${new Date(w.created * 1000).toLocaleString(getLang())}</dt>${rows}</dl>
      <div class="row">
        ${r?.installed && w.values ? `<button class="btn primary" data-lb="reuse">${t('reuse')}</button>` : ''}
        <button class="btn" data-lb="reveal">${t('show_folder')}</button>
        <button class="btn danger" data-lb="delete">${t('delete')}</button>
      </div></div>`;
  box.hidden = false;
  box.onclick = async (e) => {
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (!act && e.target.closest('.info, img, video, audio')) return;
    if (act === 'reveal') return call('reveal', { path: w.path });
    if (act === 'delete') {
      if (!confirm(t('delete_confirm'))) return;
      await call('delete_work', { path: w.path });
      await loadWorks();
    }
    if (act === 'reuse') {
      S.studio.recipe = w.recipe;
      S.studio.values = { ...studioDefaults(r), ...w.values };
      S.studio.result = null;
      S.tab = 'studio';
      render();
    }
    box.hidden = true;
    box.innerHTML = '';
  };
}

// ---------- settings ----------

function viewSettings() {
  const hw = S.ov.hardware;
  return `<h1>${t('settings_title')}</h1><p class="sub"></p>
  <section class="card"><h2>${t('this_mac')}</h2>
    <div>${esc(hw.chip || hw.arch)} · ${hw.memory_gb} GB · ${esc(hw.os)} ${esc(hw.os_version)} · ${t('free_space')} ${hw.disk_free_gb} GB</div></section>
  <section class="card"><h2>${t('folder')}</h2><p class="muted small">${t('folder_hint')}</p>
    <div class="row"><code style="flex:1;word-break:break-all">${esc(S.ov.root)}</code>
      <button class="btn" data-set="pick-root">${t('choose')}</button><button class="btn link" data-set="reset-root">${t('reset')}</button></div></section>
  <section class="card"><h2>${t('hf')} <span class="chip ${S.ov.hf_token_set ? 'good' : ''}">${t(S.ov.hf_token_set ? 'hf_set' : 'hf_unset')}</span></h2>
    <p class="muted small">${t('hf_hint')}</p>
    <div class="row"><input type="password" id="hf" placeholder="hf_…" autocomplete="off" style="flex:1" aria-label="${t('hf')}">
      <button class="btn" data-set="save-hf">${t('save')}</button>${S.ov.hf_token_set ? `<button class="btn link" data-set="clear-hf">${t('remove')}</button>` : ''}</div></section>
  <section class="card"><h2>${t('language')}</h2>
    <select id="lang" style="max-width:220px" aria-label="${t('language')}">${languages.map(([k, n]) => `<option value="${k}" ${k === getLang() ? 'selected' : ''}>${n}</option>`).join('')}</select></section>
  <section class="card"><h2>${t('own_recipes')}</h2><button class="btn" data-tab="recipes">${t('manage_recipes')}</button><p class="muted small">${t('own_recipes_hint', { dir: `<code>${esc(S.ov.root)}/recipes</code>` })}</p></section>
  <p class="muted small">OctoRole ${esc(S.version ?? '')}</p>`;
}

async function saveSettings(patch) {
  await call('save_settings', { patch });
  if (Object.hasOwn(patch,'root')) return location.reload();
  toast(t('saved'));
  await refresh();
  loadWorks();
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    readForm();
    if (S.tab === 'previs') await previs.hide();
    S.tab = tab.dataset.tab;
    render();
    if (S.tab === 'works') loadWorks();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) return recipeActions[act.dataset.act]?.(act.dataset.id);
  const work = e.target.closest('[data-work]');
  if (work) return openWork(Number(work.dataset.work));
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    readForm();
    const path = await call(pick.dataset.kind === 'video' ? 'pick_video' : 'pick_image');
    if (path) S.studio.values[pick.dataset.pick] = path;
    return render();
  }
  const fromPrevis = e.target.closest('[data-from-previs]');
  if (fromPrevis) {
    readForm();
    const last = previs.lastExport();
    const c = recipeById(S.studio.recipe).studio.controls.find((x) => x.key === fromPrevis.dataset.fromPrevis);
    S.studio.values[c.key] = last?.[previsKey(c)] ?? '';
    return render();
  }
  if (e.target.closest('[data-fill-previs]')) {
    readForm();
    const last = previs.lastExport() ?? {};
    for (const c of recipeById(S.studio.recipe).studio.controls) {
      const v = c.previs ? last[c.previs] : null;
      if (v != null && v !== '') S.studio.values[c.key] = ['int', 'float'].includes(c.type) ? Math.min(c.max ?? v, Math.max(c.min ?? v, v)) : v;
    }
    return render();
  }
  const unpick = e.target.closest('[data-unpick]');
  if (unpick) {
    readForm();
    S.studio.values[unpick.dataset.unpick] = '';
    return render();
  }
  const set = e.target.closest('[data-set]')?.dataset.set;
  if (set === 'pick-root') {
    const dir = await call('pick_folder');
    if (dir) saveSettings({ root: dir });
  } else if (set === 'reset-root') saveSettings({ root: '' });
  else if (set === 'save-hf') {
    const v = $('#hf').value.trim();
    if (v) saveSettings({ hf_token: v });
  } else if (set === 'clear-hf') saveSettings({ hf_token: '' });
});

async function changeProject(name, create) {
  if (S.studio.busy || h3Busy() || dialogueBusy() || previs.busy()) {
    toast(t('project_busy'),true);
    return render();
  }
  await call('project_open',{name,create});
  location.reload();
}
document.addEventListener('submit', e => {
  if (e.target.id !== 'new-project') return;
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (name) changeProject(name,true).catch(()=>{});
});
document.addEventListener('change', e=>{
  if (e.target.id==='project-select') changeProject(e.target.value,false).catch(()=>render());
});
setInterval(()=>{if(S.tab==='projects')refreshProject().catch(()=>{});},5000);

document.addEventListener('submit', (e) => {
  if (e.target.id === 'studio-form') {
    e.preventDefault();
    generate();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'studio-recipe') {
    S.studio.recipe = e.target.value;
    S.studio.values = {};
    S.studio.result = null;
    render();
  } else if (e.target.id === 'lang') {
    setLang(e.target.value);
    saveSettings({ language: e.target.value });
  }
});

document.addEventListener('keydown', (e) => {
  const box = $('#lightbox');
  if (e.key === 'Escape' && !box.hidden) {
    box.hidden = true;
    box.innerHTML = '';
  }
});

function renderKeepingForm() {
  if (S.tab === 'previs') return renderNav();
  if (S.tab === 'studio') readForm();
  render();
}

async function boot() {
  await listen('octorole://job', (j) => {
    if (j.phase === 'done') {
      delete S.jobs[j.recipe];
      toast(t('job_done'));
    } else if (j.phase === 'cancelled') {
      S.jobs[j.recipe] = { phase: 'cancelled' };
      toast(t('job_cancelled'));
    } else {
      S.jobs[j.recipe] = { phase: j.phase, message: j.message, done: j.done_bytes, total: j.total_bytes, error: j.message };
    }
    if (S.tab === 'recipes') render();
  });
  await listen('octorole://log', ({ recipe, line }) => {
    const log = (S.logs[recipe] ??= []);
    log.push(line);
    if (log.length > 400) log.splice(0, log.length - 400);
    if (S.tab === 'recipes') {
      clearTimeout(boot.logTimer);
      boot.logTimer = setTimeout(render, 150);
    }
  });
  await listen('octorole://studio', (ev) => {
    const st = S.studio;
    if (ev.recipe !== st.recipe || !st.busy) return;
    if (ev.phase === 'progress') {
      st.pct = ev.max ? Math.round((ev.value / ev.max) * 100) : 0;
      st.status = t('st_progress', { v: ev.value, m: ev.max });
    } else if (['queued', 'running', 'saving'].includes(ev.phase)) {
      st.status = t('st_' + ev.phase);
      if (ev.phase === 'saving') st.pct = 100;
    }
    if (S.tab === 'studio') render();
  });
  await listen('octorole://changed', () => refresh().then(renderKeepingForm).catch(() => {}));
  S.version = (await invoke('app_info').catch(() => ({}))).version;
  await refresh();
  loadWorks();
}

boot();
