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
  tab: native ? 'projects' : 'previs',
  ov: null,
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
  render();
}

// ---------- shell ----------

function renderNav() {
  $('#nav').innerHTML = [...(native ? ['projects'] : []), 'previs', 'hyperflow', 'works', 'settings']
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
  view.innerHTML = banner + { works: viewWorks, settings: viewSettings }[S.tab]();
  view.scrollTop = keep;
  for (const pre of view.querySelectorAll('pre.log')) pre.scrollTop = pre.scrollHeight;
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
  const rows = Object.entries(w.values ?? {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const box = $('#lightbox');
  box.innerHTML = `<div class="media">${media(w, true)}</div>
    <div class="info"><dl><dd>${esc(w.recipe)}</dd>
      <dt>${new Date(w.created * 1000).toLocaleString(getLang())}</dt>${rows}</dl>
      <div class="row">
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
  <section class="card"><h2>${t('language')}</h2>
    <select id="lang" style="max-width:220px" aria-label="${t('language')}">${languages.map(([k, n]) => `<option value="${k}" ${k === getLang() ? 'selected' : ''}>${n}</option>`).join('')}</select></section>
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
    if (S.tab === 'previs') await previs.hide();
    S.tab = tab.dataset.tab;
    render();
    if (S.tab === 'works') loadWorks();
    return;
  }
  const work = e.target.closest('[data-work]');
  if (work) return openWork(Number(work.dataset.work));
  const set = e.target.closest('[data-set]')?.dataset.set;
  if (set === 'pick-root') {
    const dir = await call('pick_folder');
    if (dir) saveSettings({ root: dir });
  } else if (set === 'reset-root') saveSettings({ root: '' });
});

async function changeProject(name, create) {
  if (h3Busy() || dialogueBusy() || previs.busy()) {
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

document.addEventListener('change', (e) => {
  if (e.target.id === 'lang') {
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
  render();
}

async function boot() {
  await listen('octorole://changed', () => refresh().then(renderKeepingForm).catch(() => {}));
  S.version = (await invoke('app_info').catch(() => ({}))).version;
  await refresh();
  loadWorks();
}

boot();
