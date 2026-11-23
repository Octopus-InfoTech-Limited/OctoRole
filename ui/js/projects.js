import {invoke,native} from './bridge.js';
import {getLang} from './i18n.js';

export const catalog = native ? await invoke('project_list') : {active:null,names:[],root:''};
export function draftKey(key) {
  return catalog.active ? JSON.stringify([catalog.root,catalog.active,key]) : key;
}
const tr=(en,zh)=>getLang()==='en'?en:zh;
export function projectName() {
  return catalog.active || tr('Default workspace','預設工作區');
}
export function projectView(esc) {
  const item = name => `<option value="${esc(name)}" ${name===(catalog.active||'')?'selected':''}>${esc(name||tr('Default workspace','預設工作區'))}</option>`;
  const action = (tab,label) => `<button type="button" class="btn" data-tab="${tab}">${label}</button>`;
  return `<h1>${esc(projectName())}</h1>
  <section class="card"><label>${tr('Open project','開啟項目')}<select id="project-select">${['',...catalog.names].map(item).join('')}</select></label>
  <form id="new-project" class="row"><input name="name" required maxlength="60" aria-label="${tr('Project name','項目名稱')}" placeholder="${tr('New project name','新項目名稱')}"><button class="btn" type="submit">${tr('Create project','建立項目')}</button></form></section>
  <section class="card"><div class="row">${action('previs',tr('Edit previs scenes','編輯預演場景'))}${action('studio',tr('Create with a recipe','用配方創作'))}${action('hyperflow',tr('H3 shots and dialogue','H3 鏡頭及角色配音'))}${action('works',tr('View works','查看作品'))}</div><p id="project-counts" class="muted small"></p></section>
  <section class="card" id="project-monitor" hidden><h2>${tr('Production progress','製作進度')}</h2><pre id="project-progress"></pre></section>`;
}
export async function refreshProject() {
  const slot=document.querySelector('#project-progress');
  if (!slot) return;
  const [scenes,works,status]=await Promise.all([invoke('previs_list'),invoke('list_works'),invoke('project_status')]);
  if (!slot.isConnected) return;
  document.querySelector('#project-counts').textContent=tr(`${scenes.length} scenes · ${works.length} works`,`${scenes.length} 個預演場景 · ${works.length} 件作品`);
  slot.textContent=status;
  slot.parentElement.hidden=!status;
}
