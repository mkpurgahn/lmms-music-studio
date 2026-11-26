// Library browser: one self-contained HTML page listing every sound the server can reach, with filters, search and
// one-click listening. Covers the measured factory presets, stock LMMS samples, workspace samples, and sample
// libraries under LMMS_SAMPLE_LIBRARIES.
import { existsSync } from 'node:fs';
import { readdir, readFile, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceMeta, applyMeta, audioSeconds, baseOf, facets } from './sound-meta.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { inspectPresetFile, isStrictCopyright, verifyAudioFileProvenance, writeProvenanceSidecar } from './provenance.mjs';

const audioFile = /\.(ogg|wav|flac|mp3)$/i;
// What a sample probably is, from the words in its path. First match wins.
const roleWords = [
  ['kick', /kick|bassdrum|bass_drum|\bbd\b/], ['snare', /snare|rim|sidestick/], ['hat', /hat|hihat|\bhh\b/], ['clap', /clap/], ['cymbal', /crash|ride|cymbal|splash|china/],
  ['tom', /\btom/], ['percussion', /conga|bongo|quinto|tumba|clave|cowbell|shaker|guiro|tamb|maraca|cabasa|agogo|timbale|wood|perc|whistle|triangle/],
  ['piano', /piano|grand|upright/], ['bass', /bass/], ['brass', /trumpet|trombone|horn|brass|tuba|sax/], ['strings', /violin|viola|cello|string|harp|guitar/],
  ['organ', /organ/], ['vocal', /vocal|voice|choir|vox/], ['fx', /fx|effect|noise|zap|sweep|riser/],
];
export function guessRole(relative) {
  const text = relative.toLowerCase().replace(/[_\-./\\]+/g, ' ');
  return roleWords.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}
// A file:// URL that survives spaces, # and other reserved characters in file names.
export function fileUrl(absolute) {
  const parts = absolute.replaceAll('\\', '/').split('/');
  const drive = /^[a-z]:$/i.test(parts[0]) ? parts.shift() : null;
  const encoded = parts.map(encodeURIComponent).join('/');
  return drive ? `file:///${drive}/${encoded}` : `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}
export const relativeUrl = relative => relative.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');

async function walk(directory, { depth = 6, limit = 8000 } = {}, base = directory, out = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) break;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (depth > 0) await walk(full, { depth: depth - 1, limit }, base, out); }
    else if (entry.isFile() && audioFile.test(entry.name)) out.push({ full, relative: path.relative(base, full).replaceAll('\\', '/') });
  }
  return out;
}
const displayName = file => path.basename(file).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

// Sample files as browser items. `source` is the group shown in the Source filter.
export function sampleItems(files, { type, source, url, http }) {
  return files.map(f => {
    const parts = f.relative.split('/');
    return { t: type, n: displayName(f.relative), p: f.relative, s: source, c: parts.length > 1 ? parts.slice(0, -1).join('/') : '', r: guessRole(f.relative),
      g: [path.extname(f.relative).slice(1).toLowerCase()], u: url(f), ...(http ? { w: http(f) } : {}) };
  });
}
// Where a workspace audio file belongs in the page: a finished render at the top level is one of the listener's own
// tracks, a file in a stems or sampler-render folder is a stem, and anything else is a sample.
export function classifyWorkspace(relative) {
  const parts = relative.split('/');
  if (parts.length === 1) return { type: 'track', source: 'My tracks' };
  if (/(-|^)(stems|ds|game)\d*$/i.test(parts[0]) || /^(stems|ds|piano)\d*$/i.test(parts[0])) return { type: 'stem', source: 'Stems: ' + parts[0] };
  return { type: 'workspace', source: 'Workspace: ' + parts[0] };
}
// The audition (mixer) page that belongs to a render, if one was built: "song-club.wav" finds "song-audition.html".
export function auditionFor(relative, pages, suffix = '-audition.html') {
  let name = relative.split('/')[0].replace(/\.[^.]+$/, '');
  for (;;) {
    if (pages.has(name + suffix)) return name + suffix;
    const cut = name.lastIndexOf('-');
    if (cut <= 0) return null;
    name = name.slice(0, cut);
  }
}
// A coarse outline of a recording, 0 to 100 per point, for drawing a waveform to click on.
export function waveformPeaks(audio, points = 200) {
  const frames = audio.channels[0].length, size = Math.max(1, Math.floor(frames / points)), stride = Math.max(1, Math.floor(size / 400)), out = [];
  let top = 0;
  for (let p = 0; p < points && p * size < frames; p++) {
    let peak = 0;
    for (const ch of audio.channels) for (let i = p * size; i < Math.min(frames, (p + 1) * size); i += stride) peak = Math.max(peak, Math.abs(ch[i]));
    out.push(peak);
    top = Math.max(top, peak);
  }
  return out.map(v => (top ? Math.round(v / top * 100) : 0));
}
export function presetItems(facts) {
  return Object.entries(facts).map(([file, m]) => {
    const parts = file.split('/');
    return { t: 'preset', n: displayName(file).replace(/^\d+\s*/, ''), p: file, s: parts[0], c: parts.length > 2 ? parts[1] : '', r: m.role, g: m.tags ?? [], u: null,
      m: [Math.round(m.centroidHz), Math.round(m.attackMs), Math.round(m.sustainDb), Math.round(m.releaseMs), m.pitched ? 1 : 0] };
  });
}

export const previewFolder = 'library-previews';
// A stable, safe file name for the preview of a preset or phrase.
export function previewName(type, id) {
  const slug = id.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-60);
  return `${type}-${slug}-${createHash('sha1').update(type + ':' + id).digest('hex').slice(0, 8)}`;
}
// Cut the silence after the sound, fade the end and bring the peak to -3 dBFS so quiet and loud sounds can be compared by ear.
// Returns null for silence.
export function tidyPreview(audio, { floorDb = -60, padSeconds = 0.08 } = {}) {
  let peak = 0;
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak < 1e-4) return null;
  const floor = peak * 10 ** (floorDb / 20);
  let last = 0;
  for (const ch of audio.channels) for (let i = ch.length - 1; i > last; i--) if (Math.abs(ch[i]) >= floor) { last = i; break; }
  const frames = Math.min(audio.channels[0].length, last + Math.round(audio.sampleRate * padSeconds)), fade = Math.min(frames, Math.round(audio.sampleRate * 0.03)), gain = 10 ** (-3 / 20) / peak;
  const channels = audio.channels.map(ch => { const out = ch.slice(0, frames); for (let i = 0; i < frames; i++) out[i] *= gain * Math.min(1, (frames - i) / fade); return out; });
  return { sampleRate: audio.sampleRate, channels, frames };
}

// Keep the embedded JSON from closing its script tag, and escape the two line separators that JSON allows inside strings.
const lineSeparators = new RegExp(String.fromCharCode(91, 0x2028, 0x2029, 93), 'g');
const escapeForScript = text => text.replace(/</g, '\\u003c').replace(lineSeparators, c => '\\u' + c.charCodeAt(0).toString(16));
export function browserHtml({ title, items, generated, notes = [] }) {
  const data = escapeForScript(JSON.stringify({ items, generated, notes, facets }));
  const safeTitle = title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{--bg:#f6f5f1;--panel:#fff;--ink:#1c1b19;--muted:#6b675f;--line:#dedbd3;--accent:#b4441f;--accent-ink:#fff;--chip:#ece9e1;--good:#2e7d4f;--bar:#c9c4b8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151412;--panel:#1e1d1a;--ink:#ece9e2;--muted:#a09a8e;--line:#34322d;--accent:#e8794f;--accent-ink:#1a1206;--chip:#2a2824;--good:#6fcf97;--bar:#4a463e}}
:root[data-theme="dark"]{--bg:#151412;--panel:#1e1d1a;--ink:#ece9e2;--muted:#a09a8e;--line:#34322d;--accent:#e8794f;--accent-ink:#1a1206;--chip:#2a2824;--good:#6fcf97;--bar:#4a463e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
h1{font-size:19px;margin:0 0 8px;letter-spacing:-.01em}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1 1 220px;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit}
select,button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
button{cursor:pointer}button.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.types{margin:8px 0 0}.types button{padding:6px 12px;border-radius:999px}
.count{color:var(--muted);font-size:13px;margin-left:auto;white-space:nowrap}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:64px;overflow:auto}
.tags button{padding:2px 9px;font-size:12.5px;border-radius:999px;background:var(--chip);border-color:transparent}.tags button.on{background:var(--accent);color:var(--accent-ink)}
main{padding:8px 16px 190px;max-width:1180px;margin:0 auto}
.item{display:grid;grid-template-columns:52px minmax(0,1.5fr) minmax(0,1fr) 190px 68px;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--line)}
.item.sel{background:var(--panel);outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
.play{min-width:46px;height:32px;border-radius:6px;padding:0 8px;font-size:12.5px;display:grid;place-items:center}.play[disabled]{opacity:.35;cursor:default}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.path{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.desc{color:var(--muted);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{display:flex;flex-wrap:wrap;gap:4px}.chip{font-size:11.5px;background:var(--chip);border-radius:999px;padding:1px 8px;white-space:nowrap}.chip.role{background:transparent;border:1px solid var(--line)}
.viz svg{display:block;width:190px;height:38px}.star{border:1px solid var(--line);background:var(--panel);font-size:12px;padding:4px 8px;border-radius:6px;color:var(--muted)}.star.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.bars{display:grid;grid-template-columns:52px 1fr;gap:2px 6px;font-size:10.5px;color:var(--muted);align-items:center}.bars i{display:block;height:6px;border-radius:3px;background:var(--bar)}.bars b{display:block;height:6px;border-radius:3px;background:var(--accent)}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);padding:8px 16px}
footer .now{flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.player button{min-width:52px}.player #toggle{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);min-width:64px;font-weight:600}
.player #seek{flex:2 1 180px;min-width:120px;accent-color:var(--accent)}.time{font-variant-numeric:tabular-nums;font-size:13px;color:var(--muted);white-space:nowrap}
.vol{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:6px}.vol input{width:84px;accent-color:var(--accent)}
.wave{position:relative;height:46px;cursor:pointer;margin-bottom:6px}.wave svg{width:100%;height:46px;display:block}
.prog{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--accent);opacity:.28;pointer-events:none;border-right:2px solid var(--accent)}
a.open{font-size:12.5px;color:var(--accent)}
.more{margin:14px auto;display:block}.empty{color:var(--muted);padding:40px 0;text-align:center}
.note{color:var(--muted);font-size:12.5px;margin:6px 0 0}
[hidden]{display:none!important}.facets{margin-top:8px}.facets select{padding:5px 8px;font-size:13.5px;max-width:220px}
details.src{font-size:12.5px;margin-top:2px}details.src summary{cursor:pointer;color:var(--accent)}details.src pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,Consolas,monospace;background:var(--chip);border-radius:6px;padding:8px;margin:4px 0;max-height:260px;overflow:auto}
.chip.lic{background:transparent;border:1px dashed var(--line)}
@media (max-width:760px){.item{grid-template-columns:52px minmax(0,1fr) 68px}.item .meta,.item .viz{grid-column:2/3}.viz svg{width:100%}}
</style></head><body>
<header>
<h1>${safeTitle}</h1>
<div class="row"><input id="q" type="search" placeholder="Search names, folders, tags..." autocomplete="off">
<select id="source"><option value="">All sources</option></select><select id="role"><option value="">All roles</option></select>
<select id="sort"><option value="name">Sort: name</option><option value="source">Sort: source</option><option value="bright">Sort: brightest first</option><option value="rating">Sort: best rated</option><option value="newest">Sort: newest first</option></select>
<a href="/mix-desk/">Mix Desk</a><button id="playable" type="button">Playable only</button><button id="starred" type="button">Starred</button><button id="clear" type="button">Clear filters</button><span class="count" id="count"></span></div>
<div class="row types" id="types"></div><div class="row facets" id="facets" hidden></div><div class="tags" id="tags"></div>
</header>
<main><div id="list"></div><button class="more" id="more" type="button" hidden>Show more</button><p class="note" id="notes"></p></main>
<footer><div class="wave" id="wave" hidden></div>
<div class="row player"><button id="prev" type="button" title="Previous sound">Prev</button><button id="toggle" type="button" title="Play or pause (space)">Play</button><button id="next" type="button" title="Next sound">Next</button>
<span class="time" id="time">0:00 / 0:00</span><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Position in the sound">
<button id="loop" type="button" title="Repeat this sound">Loop</button><button id="auto" type="button" title="Play the next sound when this one ends">Auto-next</button>
<label class="vol">Vol <input id="vol" type="range" min="0" max="100" value="90" aria-label="Volume"></label>
<span class="now" id="now">Click Play on a row, or use the arrow keys: up and down change sound, left and right move 5 seconds.</span><button id="copy" type="button">Copy my picks</button></div></footer>
<script id="data" type="application/json">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),items=D.items,$=function(id){return document.getElementById(id)};
var typeNames={piece:'Finished pieces',track:'My tracks',stem:'Stems',preset:'Synth presets',stock:'LMMS samples',workspace:'Workspace samples',library:'Library samples',phrase:'Phrases'};
var state={types:{},tags:{},f:{},q:'',source:'',role:'',sort:'name',playable:false,starred:false,shown:150,sel:-1},stars={};
var facetList=(D.facets||[]).filter(function(f){return items.some(function(it){return it.z&&it.z[f[0]]})}),facetSel={};
facetList.forEach(function(f){var s=document.createElement('select');s.setAttribute('aria-label',f[1]);s.dataset.facet=f[0];s.onchange=function(){state.f[f[0]]=this.value;refresh(true)};facetSel[f[0]]=s;$('facets').appendChild(s)});
$('facets').hidden=!facetList.length;
try{stars=JSON.parse(localStorage.getItem('lmms-library-picks')||'{}')}catch(e){}
function save(){try{localStorage.setItem('lmms-library-picks',JSON.stringify(stars))}catch(e){}}
function key(it){return it.t+':'+it.p}
items.forEach(function(it,i){var zs=[];for(var k in (it.z||{}))zs=zs.concat(it.z[k]);it.i=i;it.h=(it.n+' '+it.p+' '+it.s+' '+it.c+' '+it.r+' '+(it.g||[]).join(' ')+' '+zs.join(' ')+' '+(it.d||'')).toLowerCase()});
var typesPresent=Object.keys(typeNames).filter(function(t){return items.some(function(it){return it.t===t})});
typesPresent.forEach(function(t){var b=document.createElement('button');b.type='button';b.textContent=typeNames[t]+' ('+items.filter(function(it){return it.t===t}).length+')';
  b.onclick=function(){state.types[t]=!state.types[t];b.classList.toggle('on',state.types[t]);refresh(true)};$('types').appendChild(b)});
function fillSelect(sel,values,label){var keep=sel.value;sel.innerHTML='<option value="">'+label+'</option>';values.forEach(function(v){var o=document.createElement('option');o.value=v[0];o.textContent=v[0]+' ('+v[1]+')';sel.appendChild(o)});sel.value=keep;if(sel.value!==keep){sel.value='';return true}return false}
function tally(list,fn){var m={};list.forEach(function(it){[].concat(fn(it)).forEach(function(v){if(v)m[v]=(m[v]||0)+1})});return Object.keys(m).map(function(k){return[k,m[k]]}).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0])})}
function matches(it,skip){
  var anyType=typesPresent.some(function(t){return state.types[t]});
  if(anyType&&!state.types[it.t])return false;
  if(skip!=='source'&&state.source&&it.s!==state.source)return false;
  if(skip!=='role'&&state.role&&it.r!==state.role)return false;
  for(var fk in state.f)if(state.f[fk]&&skip!==fk&&((it.z&&it.z[fk])||[]).indexOf(state.f[fk])<0)return false;
  if(state.playable&&!it.u)return false;
  if(state.starred&&!stars[key(it)])return false;
  if(skip!=='tags'){for(var t in state.tags)if(state.tags[t]&&(it.g||[]).indexOf(t)<0)return false}
  if(state.q){var words=state.q.split(/\\s+/);for(var w=0;w<words.length;w++)if(words[w]&&it.h.indexOf(words[w])<0)return false}
  return true}
var current=[];
function refresh(reset){
  if(reset){state.shown=150;state.sel=-1}
  var changed=fillSelect($('source'),tally(items.filter(function(it){return matches(it,'source')}),function(it){return it.s}),'All sources');if(changed)state.source='';
  changed=fillSelect($('role'),tally(items.filter(function(it){return matches(it,'role')}),function(it){return it.r}),'All roles');if(changed)state.role='';
  facetList.forEach(function(f){if(fillSelect(facetSel[f[0]],tally(items.filter(function(it){return matches(it,f[0])}),function(it){return (it.z&&it.z[f[0]])||[]}),f[1]))state.f[f[0]]=''});
  var tagList=tally(items.filter(function(it){return matches(it,'tags')}),function(it){return it.g||[]}).slice(0,40),box=$('tags');box.innerHTML='';
  tagList.forEach(function(v){var b=document.createElement('button');b.type='button';b.textContent=v[0]+' '+v[1];b.className=state.tags[v[0]]?'on':'';b.onclick=function(){state.tags[v[0]]=!state.tags[v[0]];refresh(true)};box.appendChild(b)});
  current=items.filter(function(it){return matches(it)});
  var s=state.sort;current.sort(function(a,b){
    if(s==='bright')return ((b.m&&b.m[0])||0)-((a.m&&a.m[0])||0);
    if(s==='rating')return (b.k||0)-(a.k||0)||a.n.localeCompare(b.n);
    if(s==='source')return a.s.localeCompare(b.s)||a.p.localeCompare(b.p);
    if(s==='newest')return (b.e||0)-(a.e||0)||a.n.localeCompare(b.n);
    return a.n.localeCompare(b.n,undefined,{numeric:true})});
  $('count').textContent=current.length+' of '+items.length;draw()}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function svg(w,h){var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 '+w+' '+h);s.setAttribute('preserveAspectRatio','none');return s}
function rect(s,x,y,w,h,fill,op){var r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',Math.max(w,.6));r.setAttribute('height',h);r.setAttribute('rx',.6);r.setAttribute('fill',fill);if(op)r.setAttribute('opacity',op);s.appendChild(r)}
function viz(it){
  var box=el('div','viz');
  if(it.t==='preset'&&it.m){var b=el('div','bars');[['Bright',Math.min(1,Math.log2(Math.max(it.m[0],100)/100)/6)],['Attack',Math.min(1,it.m[1]/400)],['Sustain',Math.max(0,Math.min(1,1+it.m[2]/40))]].forEach(function(r){b.appendChild(el('span','',r[0]));var track=el('i');var fill=el('b');fill.style.width=Math.round(r[1]*100)+'%';track.appendChild(fill);b.appendChild(track)});box.appendChild(b);return box}
  if(it.v&&it.v.rows){var W=it.v.steps,H=it.v.rows.length*4,s=svg(W,Math.max(H,4));for(var x=0;x<W;x+=it.v.perBar/4)rect(s,x,0,.12,H,'var(--bar)',x%it.v.perBar===0?1:.45);
    it.v.rows.forEach(function(row,y){for(var i=0;i<row[1].length;i++){var c=row[1][i];if(c==='-'||c==='.'||c==='_')continue;rect(s,i+.1,y*4+.6,.8,2.8,'var(--accent)',c==='X'?1:c==='x'?.8:c==='o'?.55:.32)}});
    s.setAttribute('aria-label',it.v.rows.map(function(r){return r[0]}).join(', '));box.title=it.v.rows.map(function(r){return r[0]+'  '+r[1]}).join('\\n');box.appendChild(s);return box}
  if(it.v&&it.v.roll){var lo=1e9,hi=-1e9;it.v.roll.forEach(function(n){lo=Math.min(lo,n[2]);hi=Math.max(hi,n[2])});var span=Math.max(hi-lo+1,8),s2=svg(it.v.steps,span);
    for(var x2=0;x2<it.v.steps;x2+=it.v.perBar/4)rect(s2,x2,0,.12,span,'var(--bar)',x2%it.v.perBar===0?1:.45);
    it.v.roll.forEach(function(n){rect(s2,n[0],hi-n[2],Math.max(n[1]-.1,.5),1,'var(--accent)')});box.title='Drawn over an A minor chord';box.appendChild(s2);return box}
  if(it.v&&it.v.roman){box.appendChild(el('div','path',it.v.roman+'  ('+it.v.mode+')'));return box}
  return box}
function draw(){
  var list=$('list');list.innerHTML='';
  if(!current.length){list.appendChild(el('div','empty','Nothing matches. Clear a filter or change the search.'))}
  current.slice(0,state.shown).forEach(function(it,index){
    var row=el('div','item'+(index===state.sel?' sel':''));row.dataset.index=index;
    var play=el('button','play',it.u?'Play':'-');play.type='button';play.disabled=!it.u;play.title=it.u?'Listen':'No audio for this item yet';play.onclick=function(){select(index,true)};row.appendChild(play);
    var text=el('div');text.appendChild(el('div','name',it.n));text.appendChild(el('div','path',it.t==='phrase'?it.p:(it.s+(it.c?' / '+it.c:''))));if(it.d)text.appendChild(el('div','desc',it.d));
    if(it.w&&it.u&&location.protocol.indexOf('http')===0){
      var desk=el('a','open','Add to desk');desk.href='/mix-desk/?sample='+encodeURIComponent(it.w)+'&label='+encodeURIComponent(it.n);
      text.appendChild(desk);
    }
    if(it.a){var link=el('a','open','Open mixer page (layers, sections, feedback)');link.href=it.a;link.target='_blank';link.rel='noopener';text.appendChild(link)}
    if(it.y){var tl=el('a','open','Open timeline (stems as lanes)');tl.href=it.y;tl.target='_blank';tl.rel='noopener';tl.style.marginRight='12px';text.insertBefore(tl,text.querySelector('a.open'))}
    if(it.su&&/^https?:/.test(it.su)){var sl=el('a','open','Score or source');sl.href=it.su;sl.target='_blank';sl.rel='noopener noreferrer';sl.style.marginRight='12px';text.appendChild(sl)}
    if(it.sn){var det=el('details','src');det.appendChild(el('summary','','Source note'+(it.sp?' ('+it.sp+')':'')));det.appendChild(el('pre','',it.sn));text.appendChild(det)}row.appendChild(text);
    var meta=el('div','meta');meta.appendChild(el('span','chip role',it.r));var z=it.z||{};[].concat(z.era||[],z.genre||[],z.gameUse||[]).slice(0,5).forEach(function(g){meta.appendChild(el('span','chip',g))});(z.licence||[]).forEach(function(g){meta.appendChild(el('span','chip lic',g))});(it.g||[]).slice(0,it.z?3:5).forEach(function(g){meta.appendChild(el('span','chip',g))});
    if(it.l)meta.appendChild(el('span','chip',fmt(it.l)));
    if(it.k)meta.appendChild(el('span','chip','rated '+it.k+'/5'));if(it.x)meta.appendChild(el('span','chip','used '+it.x+'x'));row.appendChild(meta);
    row.appendChild(viz(it));
    var isStarred=Boolean(stars[key(it)]);
    var star=el('button','star'+(isStarred?' on':''),isStarred?'Starred':'Star');star.type='button';star.title='Add to my picks';star.onclick=function(){if(stars[key(it)])delete stars[key(it)];else stars[key(it)]=1;save();var on=Boolean(stars[key(it)]);star.classList.toggle('on',on);star.textContent=on?'Starred':'Star'};row.appendChild(star);
    list.appendChild(row)});
  $('more').hidden=current.length<=state.shown;$('more').textContent='Show more ('+(current.length-state.shown)+' left)';
  $('notes').textContent=(D.notes||[]).join(' ')+' Built '+D.generated+'.'}
var served=location.protocol.indexOf('http')===0,blocked='Could not play this file. Start the library server (node library-server.mjs) and open the page at the address it prints.';var audio=new Audio(),playing=null,seeking=false;audio.volume=.9;audio.addEventListener('error',function(){$('now').textContent=blocked});
function fmt(t){if(!isFinite(t)||t<0)t=0;var m=Math.floor(t/60),s=Math.floor(t%60);return m+':'+(s<10?'0':'')+s}
function tick(){var d=isFinite(audio.duration)&&audio.duration?audio.duration:(playing&&playing.l)||0;$('time').textContent=fmt(audio.currentTime)+' / '+fmt(d);
  if(!seeking)$('seek').value=d?Math.round(audio.currentTime/d*1000):0;var p=$('prog');if(p)p.style.width=(d?Math.min(100,audio.currentTime/d*100):0)+'%';$('toggle').textContent=audio.paused?'Play':'Pause'}
function drawWave(it){var box=$('wave');box.innerHTML='';box.hidden=!(it&&it.f);if(!it||!it.f)return;var s=svg(it.f.length,100);it.f.forEach(function(v,i){rect(s,i+.15,50-v/2,.7,Math.max(v,1),'var(--muted)')});box.appendChild(s);var p=el('div','prog');p.id='prog';box.appendChild(p)}
function seekTo(f){var d=audio.duration;if(d&&isFinite(d)){audio.currentTime=Math.max(0,Math.min(d-.05,f*d));tick()}}
['timeupdate','pause','play','loadedmetadata'].forEach(function(name){audio.addEventListener(name,tick)});
audio.addEventListener('ended',function(){if(state.auto&&!audio.loop)select(state.sel+1,true)});
function select(index,play){
  if(index<0||index>=Math.min(current.length,state.shown))return;
  state.sel=index;var rows=$('list').children;for(var i=0;i<rows.length;i++)rows[i].classList.toggle('sel',i===index);
  var it=current[index];if(rows[index]&&rows[index].scrollIntoView)rows[index].scrollIntoView({block:'nearest'});
  if(play&&it.u){playing=it;drawWave(it);audio.src=served&&it.w?it.w:it.u;audio.play().then(function(){$('now').textContent='Playing: '+it.n+'  ·  '+it.p},function(){$('now').textContent=blocked});$('now').textContent='Loading: '+it.n}else if(!it.u){audio.pause();$('now').textContent=it.n+'  ·  '+it.p+'  (no audio yet)'}}
$('toggle').onclick=function(){if(!playing||state.sel<0)select(Math.max(state.sel,0),true);else if(audio.paused)audio.play().catch(function(){});else audio.pause()};
$('prev').onclick=function(){select(state.sel-1,true)};$('next').onclick=function(){select(state.sel+1,true)};
$('seek').oninput=function(){seeking=true};$('seek').onchange=function(){seeking=false;seekTo(this.value/1000)};
$('wave').onclick=function(e){var r=this.getBoundingClientRect();seekTo((e.clientX-r.left)/r.width)};
$('loop').onclick=function(){audio.loop=!audio.loop;this.classList.toggle('on',audio.loop)};
$('auto').onclick=function(){state.auto=!state.auto;this.classList.toggle('on',state.auto)};
$('vol').oninput=function(){audio.volume=this.value/100};
$('clear').onclick=function(){state.types={};state.tags={};state.f={};facetList.forEach(function(f){facetSel[f[0]].value=''});state.q='';state.source='';state.role='';state.playable=false;state.starred=false;$('q').value='';
  ['playable','starred'].forEach(function(id){$(id).classList.remove('on')});[].forEach.call($('types').children,function(b){b.classList.remove('on')});refresh(true)};
$('more').onclick=function(){state.shown+=300;draw()};
$('q').oninput=function(){state.q=this.value.trim().toLowerCase();refresh(true)};
$('source').onchange=function(){state.source=this.value;refresh(true)};$('role').onchange=function(){state.role=this.value;refresh(true)};
$('sort').onchange=function(){state.sort=this.value;refresh(true)};
$('playable').onclick=function(){state.playable=!state.playable;this.classList.toggle('on',state.playable);refresh(true)};
$('starred').onclick=function(){state.starred=!state.starred;this.classList.toggle('on',state.starred);refresh(true)};
$('copy').onclick=function(){var picks=items.filter(function(it){return stars[key(it)]}).map(function(it){return{type:it.t,name:it.n,path:it.p,source:it.s}});
  var text=JSON.stringify({picks:picks},null,1),done=function(){$('now').textContent=picks.length+' picks copied. Paste them to the agent.'};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,function(){window.prompt('Copy your picks:',text)});else window.prompt('Copy your picks:',text)};
document.addEventListener('keydown',function(e){if(e.target&&/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
  if(e.key==='ArrowDown'){e.preventDefault();select(state.sel+1,true)}else if(e.key==='ArrowUp'){e.preventDefault();select(state.sel-1,true)}
  else if(e.key===' '){e.preventDefault();$('toggle').onclick()}
  else if(e.key==='ArrowRight'){e.preventDefault();audio.currentTime=Math.min((audio.duration||0),audio.currentTime+5)}else if(e.key==='ArrowLeft'){e.preventDefault();audio.currentTime=Math.max(0,audio.currentTime-5)}
  else if(e.key==='s'&&state.sel>=0){var b=$('list').children[state.sel].querySelector('.star');if(b)b.click()}});
refresh(true);
})();
</script></body></html>
`;
}

export function register({ tool, z, dsp, root, schemas, project, render, sounds, paths, moduleGuidance, env = process.env }) {
  moduleGuidance.push('When a person wants to see or hear what sounds are available, call build_library_page and give them the page: it lists every preset, sample and library file with filters, search and one-click listening, and they can star picks and paste them back.');
  tool('build_library_page', 'Write one self-contained HTML page that shows the whole sound library with filters: the measured factory presets, stock LMMS samples, workspace samples and files in LMMS_SAMPLE_LIBRARIES. Workspace renders tagged with tag_sound are listed as finished pieces with filters for composer, era, genre, mood, game use, arrangement and licence, their credits and their source note (<name>.source.md); untagged files are listed as before. Search, filter by type, source, role and tag, sort, click or use the arrow keys to listen, star picks and copy them as JSON.', {
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.html$/i).default('sound-library.html'),
    title: z.string().min(1).max(80).default('Sound library'),
    include: z.array(z.enum(['presets', 'stock', 'workspace', 'libraries'])).min(1).default(['presets', 'stock', 'workspace', 'libraries']),
    overwrite: z.boolean().default(false),
  }, async ({ output, title, include, overwrite }) => {
    const strict = isStrictCopyright(env);
    const target = path.join(root, output);
    if (!overwrite && existsSync(target)) throw new Error('Output already exists. Pass overwrite: true to rebuild it.');
    const items = [], notes = [], counts = {};
    const add = (name, list) => { counts[name] = list.length; items.push(...list); };
    if (include.includes('presets')) {
      try {
        const rawFacts = await sounds.soundFacts();
        let facts = rawFacts;
        if (strict && rawFacts) {
          const filtered = {};
          const hasPresetsDir = Boolean(paths?.presets && existsSync(paths.presets));
          for (const [name, fact] of Object.entries(rawFacts)) {
            if (/^audiofileprocessor\//i.test(name)) continue;
            if (hasPresetsDir) {
              const check = await inspectPresetFile(path.join(paths.presets, name), {
                presetsDir: paths.presets,
                workspaceDir: root,
                soundfontsDir: paths?.soundfonts,
                env,
              });
              if (!check.allowed) continue;
            }
            filtered[name] = fact;
          }
          facts = filtered;
        }
        add('presets', presetItems(facts));
        notes.push('Synth presets have measurements but no audio preview.');
      } catch (error) { notes.push(`Presets were skipped: ${error.message}`); }
    }
    if (include.includes('stock') && paths?.samples) {
      if (strict) {
        add('stock', []);
        notes.push('Stock LMMS samples are excluded in strict copyright mode.');
      } else {
        add('stock', sampleItems(await walk(paths.samples), { type: 'stock', source: 'LMMS stock samples', url: f => fileUrl(f.full), http: f => '/_stock/' + relativeUrl(f.relative) }));
      }
    }
    if (include.includes('workspace')) {
      let files = (await walk(root, { depth: 2 })).filter(f => !f.relative.startsWith(previewFolder + '/'));
      if (strict) {
        const verifiedFiles = [];
        for (const f of files) {
          const ok = await verifyAudioFileProvenance(f.full, { workspaceDir: root, env }).then(() => true, () => false);
          if (ok) verifiedFiles.push(f);
        }
        files = verifiedFiles;
      }
      // A render saved as both WAV and OGG is one track: keep the WAV.
      const wavs = new Set(files.filter(f => /\.wav$/i.test(f.relative)).map(f => f.relative.replace(/\.wav$/i, '')));
      const oggTwins = new Set(files.filter(f => /\.ogg$/i.test(f.relative) && !f.relative.includes('/') && wavs.has(f.relative.replace(/\.ogg$/i, ''))).map(f => f.relative.replace(/\.ogg$/i, '')));
      files = files.filter(f => !(/\.ogg$/i.test(f.relative) && oggTwins.has(f.relative.replace(/\.ogg$/i, ''))));
      const pages = new Set((await readdir(root).catch(() => [])).filter(name => name.endsWith('-audition.html') || name.endsWith('-timeline.html')));
      // Metadata sidecars (<name>.meta.json) and source notes (<name>.source.md). Pages with none work as before.
      const { byBase: tagged, problems } = await workspaceMeta(root);
      if (problems.length) notes.push(`${problems.length} metadata files had problems and were read in part: ${problems.slice(0, 3).join(' | ')}${problems.length > 3 ? ' ...' : ''}`);
      const list = [];
      for (const f of files) {
        const kind = classifyWorkspace(f.relative), [item] = sampleItems([f], { type: kind.type, source: kind.source, url: x => relativeUrl(x.relative) });
        if (oggTwins.has(f.relative.replace(/\.wav$/i, ''))) item.g.push('ogg');
        const info = await lstat(f.full).catch(() => null);
        if (info) item.e = Math.round(info.mtimeMs / 1000);
        if (kind.type === 'track') {
          item.r = 'track';
          const page = auditionFor(f.relative, pages), timeline = auditionFor(f.relative, pages, '-timeline.html');
          if (timeline) item.y = relativeUrl(timeline);
          if (page) item.a = relativeUrl(page);
          // An outline to click on, for WAV renders small enough to read quickly.
          if (/\.wav$/i.test(f.relative) && info && info.size <= 96 * 1024 * 1024) {
            try { const audio = dsp.decodeWav(await readFile(f.full)); item.f = waveformPeaks(audio); item.l = Math.round(audio.frames / audio.sampleRate); } catch { /* listed without an outline */ }
          }
          if (!item.l) { const seconds = await audioSeconds(f.full); if (seconds) item.l = Math.round(seconds); }
        }
        const entry = tagged.get(baseOf(f.relative));
        if (entry) applyMeta(item, entry, { topLevel: kind.type === 'track' });
        list.push(item);
      }
      add('workspace', list);
      const pieces = list.filter(i => i.t === 'piece').length;
      if (pieces) counts.pieces = pieces;
    }
    const libraryRoot = env.LMMS_SAMPLE_LIBRARIES;
    if (include.includes('libraries') && libraryRoot && existsSync(libraryRoot)) {
      if (strict) {
        add('libraries', []);
        notes.push('External unverified sample libraries are excluded in strict copyright mode.');
      } else {
        const list = [];
        for (const entry of await readdir(libraryRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const folder = path.join(libraryRoot, entry.name);
          list.push(...sampleItems(await walk(folder), { type: 'library', source: entry.name, url: f => fileUrl(f.full), http: f => '/_lib/' + relativeUrl(entry.name + '/' + f.relative) }));
        }
        add('libraries', list);
      }
    }
    // Presets play the clip build_library_previews made for them, when there is one.
    const made = new Set((await readdir(path.join(root, previewFolder)).catch(() => [])));
    let withPreview = 0, without = 0;
    for (const item of items.filter(i => i.t === 'preset')) {
      const base = previewName(item.t, item.p), found = ['.ogg', '.wav'].map(ext => base + ext).find(name => made.has(name));
      if (found) { item.u = previewFolder + '/' + found; withPreview++; } else without++;
    }
    if (without) notes[notes.indexOf('Synth presets have measurements but no audio preview.')] = undefined;
    if (without) notes.push(`${without} presets have no audio preview yet. Run build_library_previews to make them.`);
    else if (withPreview) notes.splice(notes.indexOf('Synth presets have measurements but no audio preview.'), 1);
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i] === undefined) notes.splice(i, 1);
    if (!items.length) throw new Error('Nothing to list. Check LMMS_SAMPLE_LIBRARIES and the LMMS install.');
    const html = browserHtml({ title, items, generated: new Date().toISOString().slice(0, 10), notes });
    await writeFileAtomic(target, html, { overwrite });
    const info = await lstat(target);
    return { page: output, path: target, url: fileUrl(target), bytes: info.size, items: items.length, counts, notes,
      next: 'Run "node library-server.mjs" from the server folder and open http://127.0.0.1:18290/sound-library.html: browsers block a page on disk from playing files in other folders. Paste "Copy my picks" back to choose sounds.' };
  });

  tool('build_library_previews', 'Render a short audio clip for factory presets so the library page can play them. Presets play a four-note figure. Clips are trimmed, set to the same peak level and written to the library-previews folder. Work is done in batches: call again until remaining is 0, then rebuild the page with build_library_page.', {
    include: z.array(z.enum(['presets'])).min(1).default(['presets']),
    limit: z.number().int().min(1).max(400).default(120).describe('How many clips to render in this call.'),
    redo: z.boolean().default(false).describe('Render again even when a clip exists.'),
  }, async ({ include, limit, redo }) => {
    const folder = path.join(root, previewFolder), ogg = await render.hasFfmpeg(), ext = ogg ? '.ogg' : '.wav';
    await mkdir(folder, { recursive: true });
    const jobs = [];
    if (include.includes('presets')) for (const preset of Object.keys(await sounds.soundFacts())) jobs.push({ type: 'preset', id: preset });
    const have = new Set(await readdir(folder));
    const skipFile = path.join(folder, 'skipped.json');
    const skipped = redo ? [] : JSON.parse(await readFile(skipFile, 'utf8').catch(() => '[]'));
    const given = new Set(skipped.map(f => f.type + ':' + f.id));
    const todo = jobs.filter(job => redo || (!given.has(job.type + ':' + job.id) && !['.ogg', '.wav'].some(e => have.has(previewName(job.type, job.id) + e))));
    const batch = todo.slice(0, limit), failed = [];
    const songFor = async job => {
      const item = { name: 'Preview', voice: 'preset', preset: job.id, rootMidi: 69, volume: 45, pan: 0,
        patterns: [{ name: 'Preview', bar: 0, bars: 2, notes: [0, 7, 12, 3].map((offset, i) => ({ tick: i * 36, midi: 57 + offset, length: 29, velocity: 76 })) }] };
      return { bpm: 120, bars: 2, items: [item] };
    };
    await render.pool(batch, render.parallelRenders, async job => {
      try {
        const song = await songFor(job), items = song.items.map(t => schemas.track.parse(t));
        for (const item of items) await project.checkTrack(item);
        const doc = project.createSong(song.bpm, items, 80);
        for (const item of items.filter(i => i.preset)) await project.loadPreset(doc, project.instrumentOf(doc, item.name), item.preset, { tuning: 'concert' });
        project.setAnchor(doc, song.bars);
        const clip = tidyPreview(dsp.decodeWav(await render.renderDoc(doc)));
        if (!clip) throw new Error('silent');
        const target = path.join(folder, previewName(job.type, job.id) + ext);
        await rm(target, { force: true });
        await render.writeAudio(target, dsp.encodeWav(clip));
        await writeProvenanceSidecar(target, {
          workspaceDir: root,
          classification: 'pure-synthesis',
          generatorTool: 'build_library_previews',
          sources: [{
            kind: 'pure-synthesis',
            pluginOrLibrary: job.id,
            licence: 'unrestricted-synthesis',
          }],
        });
      } catch (error) { failed.push({ type: job.type, id: job.id, reason: String(error.message).slice(0, 120) }); }
    });
    // Failed clips are remembered so later calls do not retry them for ever.
    if (failed.length) await writeFileAtomic(skipFile, JSON.stringify([...skipped, ...failed], null, 1), { overwrite: true });
    return { folder: previewFolder, format: ext.slice(1), rendered: batch.length - failed.length, failed, remaining: todo.length - batch.length, total: jobs.length,
      next: todo.length - batch.length ? 'Call build_library_previews again for the next batch.' : 'All done. Rebuild the page with build_library_page (overwrite: true).' };
  });
}