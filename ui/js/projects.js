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
  return `<h1>${esc(projectName())}</h1><div class="project-layout"><div>
  <section class="card"><label>${tr('Open project','開啟項目')}<select id="project-select">${['',...catalog.names].map(item).join('')}</select></label>
  <form id="new-project" class="row"><input name="name" required maxlength="60" aria-label="${tr('Project name','項目名稱')}" placeholder="${tr('New project name','新項目名稱')}"><button class="btn" type="submit">${tr('Create project','建立項目')}</button></form></section>
  <section class="card"><div class="row">${action('previs',tr('Edit previs scenes','編輯預演場景'))}${action('hyperflow',tr('H3 shots and dialogue','H3 鏡頭及角色配音'))}${action('works',tr('View works','查看作品'))}</div><p id="project-counts" class="muted small"></p></section>
  </div><section class="card" id="project-monitor"><h2>${tr('Project progress','項目進度')}</h2><div id="project-totals"></div><div id="project-episodes"></div><p id="project-progress" class="muted small"></p></section></div>`;
}
export async function refreshProject() {
  const slot=document.querySelector('#project-progress');
  if (!slot) return;
  const [scenes,works,status]=await Promise.all([invoke('previs_list'),invoke('list_works'),invoke('project_status')]);
  if (!slot.isConnected) return;
  document.querySelector('#project-counts').textContent=tr(`${scenes.length} scenes · ${works.length} works`,`${scenes.length} 個預演場景 · ${works.length} 件作品`);
  const groups=status.groups;
  const total=groups.reduce((n,g)=>n+g.total,0);
  const done=groups.reduce((n,g)=>n+g.done,0);
  const totals=document.querySelector('#project-totals');
  totals.replaceChildren();
  if (total) {
    const label=tr(`${done} of ${total} takes complete`,`已完成 ${done}／${total} 段`);
    const summary=document.createElement('strong');
    const percent=new Intl.NumberFormat(getLang(),{style:'percent',maximumFractionDigits:1});
    summary.textContent=label+' · '+percent.format(done/total);
    const bar=document.createElement('progress');
    bar.max=total; bar.value=done; bar.setAttribute('aria-label',label);
    totals.append(summary,bar);
  }
  const episodes=document.querySelector('#project-episodes');
  episodes.replaceChildren(...groups.map(group=>{
    const row=document.createElement('div');
    const name=document.createElement('span');
    name.textContent=group.label;
    const count=document.createElement('span');
    count.textContent=group.delivered ? tr('Delivered','已出片') : `${group.done} / ${group.total}`;
    row.append(name,count);
    return row;
  }));
  slot.textContent=status.message.split('\n').filter(Boolean).at(-1) || (total?'':tr('No production queued.','未有製作排程。'));
}
