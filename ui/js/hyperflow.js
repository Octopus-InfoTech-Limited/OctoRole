import {draftKey} from './projects.js';
import { invoke, listen, native } from './bridge.js';
import { showDialogue } from './dialogue.js';
import { getLang } from './i18n.js';

let mode = 'shots';
const storageKey = draftKey('hyperflow-film-v1');
let project, busy = false, status = '', result = '', listening;
const tr = (en, zh) => getLang() === 'en' ? en : zh;
function save() { localStorage.setItem(storageKey, JSON.stringify(project)); }
function progress() {
  const output = document.querySelector('#h3-status');
  if (output) output.textContent = status;
}

export async function showH3(view, {esc, toast, loadWorks}) {
  const title = tr('Six-shot film', '六鏡短劇');
  view.innerHTML = `<h1>HyperFlow H3</h1><div class="row dub-tabs"><button class="btn ${mode==='shots'?'primary':''}" data-mode="shots">${tr('Shots','鏡頭')}</button><button class="btn ${mode==='dub'?'primary':''}" data-mode="dub">${tr('Character dialogue','角色配音')}</button></div><section class="card" id="h3-panel"></section>`;
  view.querySelectorAll('[data-mode]').forEach(b => { b.onclick=()=>{mode=b.dataset.mode;showH3(view,{esc,toast,loadWorks});}; });
  const panel = view.querySelector('#h3-panel');
  if (!native) { panel.textContent = tr('Open the Mac app to render.', '請喺 Mac App 開啟呢頁生成影片。'); return; }
  if (mode === 'dub') {
    const works = await invoke('list_works').catch(() => []);
    const recent = works.find(w => w.kind === 'video' && w.name.startsWith('HyperFlow-six-shots-'));
    if (panel.isConnected) showDialogue(panel, {esc, toast}, recent?.path || result);
    return;
  }
  try {
    if (!project) {
      project = await invoke('h3_defaults');
      try { Object.assign(project, JSON.parse(localStorage.getItem(storageKey)) || {}); } catch {}
    }
    listening ??= listen('octorole://h3', line => { status = line; progress(); });
    await listening;
    if (!panel.isConnected) return;
    const pick = (key, label, value) => `<div class="row"><button class="btn" data-pick="${key}">${label}</button><small>${esc(value)}</small>${value ? `<button class="btn link" data-clear="${key}">×</button>` : ''}</div>`;
    panel.innerHTML = `<h2>${title} · 16:9</h2>
    <p>${tr('1024 × 576 · six 3-second shots · one shared character reference.', '1024 × 576 · 六個約三秒鏡頭 · 全片共用角色參考相。')}</p>
    <button class="btn" data-setup>${tr('Set up engine','安裝引擎')}</button> <button class="btn" data-start>${tr('Start local engine','啟動本機引擎')}</button>
    <fieldset ${busy ? 'disabled' : ''}>
    ${pick('character', tr('Choose character (default: Kai)', '揀角色相（預設：阿啟）'),project.character)}
    ${pick('scene', tr('Choose optional location image','揀場景相（可選）'),project.scene)}
    <label>${tr('Character and continuity','角色同連戲設定')}<textarea data-identity>${esc(project.identity)}</textarea></label>
    ${project.shots.map((shot,i)=>`<section><label>${tr('Shot','鏡頭')} ${i+1}<textarea data-shot="${i}">${esc(shot)}</textarea></label><label>${tr('Caption text','鏡頭字幕（文字）')}<input data-caption="${i}" value="${esc(project.captions?.[i])}"></label>${pick(String(i), tr('Attach rehearsal','加入預演影片'),project.blocking?.[i])}</section>`).join('')}
    <button class="btn primary" data-render>${tr('Render six shots','生成六鏡短劇')}</button></fieldset>
    <p role="status" id="h3-status"></p>${result ? `<button class="btn" data-reveal>${tr('Show finished MP4','顯示成片')}</button>` : ''}`;
    progress();
    panel.oninput = ({target:t}) => {
      if (t.hasAttribute('data-identity')) project.identity = t.value;
      if (t.dataset.shot !== undefined) project.shots[Number(t.dataset.shot)] = t.value;
      if (t.dataset.caption !== undefined) (project.captions ??= Array(6).fill(''))[Number(t.dataset.caption)] = t.value;
      save();
    };
    panel.onclick = async ({target:t}) => {
      try {
        if (t.hasAttribute('data-setup') || t.hasAttribute('data-start')) { await invoke('h3_start',{setup:t.hasAttribute('data-setup')}); return; }
        if (t.hasAttribute('data-reveal')) { await invoke('reveal',{path:result}); return; }
        const key = t.dataset.pick ?? t.dataset.clear;
        if (key !== undefined) {
          const video = /^\d+$/.test(key);
          const path = t.dataset.clear !== undefined ? '' : await invoke(video ? 'pick_video' : 'pick_image');
          if (path == null) return;
          if (video) (project.blocking ??= Array(6).fill(''))[Number(key)] = path;
          else project[key] = path;
          save(); return showH3(view,{esc,toast,loadWorks});
        }
        if (t.hasAttribute('data-render') && !busy) {
          busy = true; result = ''; status = tr('Preparing…','準備緊…');
          panel.querySelector('fieldset').disabled = true; progress();
          try {
            result = await invoke('h3_render',{project});
            status = result; await loadWorks();
          } catch (e) { status = String(e); } finally { busy = false; }
          if (document.querySelector('#h3-panel')) await showH3(view,{esc,toast,loadWorks});
        }
      } catch (error) { toast(String(error),true); }
    };
  } catch (error) { panel.textContent = String(error); }
}

export const h3Busy = () => busy;
