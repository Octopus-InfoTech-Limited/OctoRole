import {draftKey} from './projects.js';
import { invoke, fileSrc } from './bridge.js';
import { getLang } from './i18n.js';

const tr = (en, zh) => getLang() === 'en' ? en : zh;
const labels = {driver:'阿啟', coach:'阿森', rival:'白頭盔', rookie:'小車手'};
const samples = {yue:['見唔見到前車條鏈？','見到。我等緊佢讓嗰半個位。'], cmn:['看得見前車的鏈條嗎？','看得見。我在等他讓出半個車位。']};
const storage = draftKey('octorole-dialogue-v1');
let drafts = {}, lang = 'yue', busy = false, message = '', outputs = {};
try {
  const saved = JSON.parse(localStorage.getItem(storage));
  if (saved?.drafts) { drafts = saved.drafts; lang = saved.lang === 'cmn' ? 'cmn' : 'yue'; }
} catch {}
function save() { localStorage.setItem(storage,JSON.stringify({lang,drafts})); }
function fresh() {
  return {video:'', music:'score', musicPath:'', musicLevel:22, ambience:'', ambienceLevel:14,
    lines:['coach','driver'].map((voice,i)=>({voice,name:labels[voice],text:samples[lang][i],start:''}))};
}
export function showDialogue(panel, {esc, toast}, latest) {
  const d = drafts[lang] ??= fresh();
  const re = () => { if (panel.isConnected) showDialogue(panel,{esc,toast},latest); };
  const opt = (id, text, selected) => `<option value="${id}" ${selected===id?'selected':''}>${esc(text)}</option>`;
  const picker = (field,label) => `<div class="row"><button type="button" class="btn" data-pick="${field}">${label}</button><small>${esc(d[field]?.split('/').pop()||'')}</small>${d[field]?`<button class="btn link" data-clear="${field}">×</button>`:''}</div>`;
  const level = (key, label) => `<label>${label} <output>${d[key]}%</output><input type="range" min="0" max="100" data-key="${key}" value="${d[key]}"></label>`;
  const result = outputs[lang];
  panel.innerHTML = `<h2>${tr('Character dialogue','角色配音')} · Qwen3-TTS</h2>
    <p>${tr('Write what each character says. The same lines become the subtitles.','輸入角色實際講嘅說話，同一份對白會用嚟配音同出字幕。')}</p>
    <fieldset ${busy?'disabled':''}><div class="row"><label>${tr('Language','語言')} <select data-language>${opt('yue','廣東話',lang)}${opt('cmn','普通話',lang)}</select></label>
    <button class="btn" data-action="setup">${tr('Install local voices','安裝本機聲線')}</button></div>
    ${picker('video',tr('Choose source video (optional)','揀原片（可選）'))}
    ${latest?`<button class="btn" data-action="latest">${tr('Use last H3 film','用最近生成嘅 H3 成片')}</button>`:''}
    <div class="dub-lines">${d.lines.map((line,i)=>`<section data-row="${i}">
    <div class="row"><label>${tr('Character','角色名')}<input data-line="name" maxlength="32" value="${esc(line.name)}"></label>
    <label>${tr('Voice','聲線')}<select data-line="voice">${Object.entries(labels).map(([id,v])=>opt(id,v,line.voice)).join('')}</select></label>
    <label>${tr('Start (seconds)','開始秒數')}<input type="number" step=".01" min="0" max="1800" placeholder="${tr('Auto','自動接續')}" data-line="start" value="${esc(line.start)}"></label>
    <button class="btn link" data-remove="${i}" aria-label="${tr('Remove line','移除對白')}">×</button></div>
    <label>${tr('Dialogue and subtitles','對白及字幕')}<textarea rows="2" maxlength="180" data-line="text">${esc(line.text)}</textarea></label></section>`).join('')}</div>
    <button class="btn" data-action="add">＋ ${tr('Add line','加一句對白')}</button>
    <h3>${tr('Sound mix','混音')}</h3>
    <label>${tr('Background music','背景音樂')}<select data-key="music">${opt('off',tr('Off','關閉'),d.music)}${opt('score',tr('Original instrumental','內置純音樂'),d.music)}${opt('file',tr('My music file','自選音樂檔'),d.music)}</select></label>
    ${d.music==='file'?picker('musicPath',tr('Choose music','揀配樂')):''}
    ${d.music!=='off'?level('musicLevel',tr('Music volume','配樂音量')):''}
    ${picker('ambience',tr('Choose ambience or sound effect','揀環境聲或音效（可選）'))}${d.ambience?level('ambienceLevel',tr('Effect volume','音效音量')):''}
    <p>${tr('The mix replaces the source audio. Music ducks while characters speak.','新混音會取代原片聲軌，角色開口時會自動壓低配樂。')}</p>
    <button class="btn primary" data-action="render">${d.video?tr('Export dubbed MP4','匯出配音 MP4'):tr('Generate audio and subtitles','生成配音及字幕')}</button></fieldset>
    <p role="status">${esc(message)}</p>${result?`<audio controls src="${esc(fileSrc(result.audio))}"></audio> <button class="btn" data-action="reveal">${tr('Show files','顯示成品檔案')}</button>`:''}`;
  panel.oninput = ({target:t}) => {
    if(t.dataset.line) { d.lines[Number(t.closest('[data-row]').dataset.row)][t.dataset.line]=t.value; save(); }
    if(t.dataset.key) { d[t.dataset.key]=t.type==='range'?Number(t.value):t.value; if(t.type==='range') t.parentElement.querySelector('output').textContent=t.value+'%'; save(); }
  };
  panel.onchange = ({target:t}) => {
    if(t.matches('[data-language]')) {lang=t.value;message='';save();re();}
    if(t.dataset.key==='music')re();
  };
  panel.onclick = async ({target:t}) => {
    try {
      if(t.dataset.pick) {
        const field=t.dataset.pick, path=await invoke(field==='video'?'pick_video':'pick_audio');
        if(path){d[field]=path;save();re();} return;
      }
      if(t.dataset.clear){d[t.dataset.clear]='';save();re();return;}
      if(t.dataset.remove!==undefined){d.lines.splice(Number(t.dataset.remove),1);save();re();return;}
      switch(t.dataset.action){
        case 'setup': await invoke('dialogue_setup');break;
        case 'latest': d.video=latest;save();re();break;
        case 'add': d.lines.push({voice:'driver',name:labels.driver,text:'',start:''});save();re();break;
        case 'reveal': await invoke('reveal',{path:result.video||result.audio});break;
        case 'render':
          if(busy)return;
          if(!d.lines.length||d.lines.some(x=>!x.text.trim()||!x.name.trim())) throw Error(tr('Enter a character and dialogue on each row.','每行都要填角色名同對白。'));
          busy=true;message=tr('Generating local voices…','本機配音中…');outputs[lang]=null;re();
          try {outputs[lang]=await invoke('dialogue_render',{spec:{...d,language:lang,lines:d.lines.map(x=>({...x,start:x.start===''?null:Number(x.start)}))}});message=tr('Export complete.','匯出完成。');}
          catch(e){message=String(e);} finally{busy=false;re();} break;
      }
    }catch(e){toast(String(e),true);}
  };
}

export const dialogueBusy = () => busy;
