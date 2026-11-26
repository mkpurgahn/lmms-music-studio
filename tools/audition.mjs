// Audition pages, listener feedback and taste memory.
// build_audition_page writes one self-contained HTML file that plays an export_game_audio folder (intro into loop, layers,
// stingers) or compares workspace renders at matched loudness. The listener's notes come back as JSON through read_feedback,
// and durable preferences live in .lmms-taste.json through remember_taste and get_taste.
import { existsSync, readFileSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureStudioServer } from '../library-server.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { sha256File } from './provenance.mjs';

export const feedbackSchema = 'lmms-mcp/audition-feedback';
export const feedbackVersion = 2;
export const supportedFeedbackVersions = [1, 2];
export const STUDIO_DESCRIPTOR_SCHEMA = 'lmms-music-studio/studio-descriptor';
export const tasteFile = '.lmms-taste.json';
export const tasteAreas = ['general', 'arrangement', 'mix', 'sound', 'drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx'];

const AUDITION_CLIENT_JS = readFileSync(new URL('./studio-ui/audition.js', import.meta.url), 'utf8');

// ---------- timing maths ----------
// These functions are also copied into the page with Function.prototype.toString, so the page and the tests run the same code.
// Keep them self-contained: no closures, no imports.

// Seconds in one bar. LMMS uses 48 ticks per quarter note and 192 * numerator / denominator ticks per bar.
export function barSeconds(bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4, denominator = meter && meter[1] ? meter[1] : 4;
  return 240 * numerator / (denominator * bpm);
}
// Bar (counted from zero, like LMMS projects) and beat (counted from one) at a song time in seconds.
export function barBeatAt(seconds, bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4;
  const bar = barSeconds(bpm, meter);
  const position = seconds / bar;
  const whole = Math.floor(position + 1e-9);
  const beat = Math.min(numerator, Math.floor((position - whole) * numerator + 1e-9) + 1);
  return { bar: whole, beat, position };
}
// Map unwrapped play time onto the song timeline: the intro plays once, then the loop repeats forever.
export function wrapSongTime(elapsed, introSeconds, loopSeconds) {
  if (elapsed < introSeconds || !(loopSeconds > 0)) return elapsed;
  return introSeconds + ((elapsed - introSeconds) % loopSeconds);
}
// Where each source starts when playback begins at a song time, all in frames so the join lands on a sample boundary.
// introOffset is null when the intro is already over. The loop starts loopDelay frames after the intro starts.
export function startPlan(songFrame, introFrames, loopFrames) {
  const frame = Math.max(0, Math.round(songFrame));
  if (frame < introFrames) return { introOffset: frame, loopDelay: introFrames - frame, loopOffset: 0 };
  return { introOffset: null, loopDelay: 0, loopOffset: loopFrames > 0 ? (frame - introFrames) % loopFrames : 0 };
}
// The section that contains a bar position, or null.
export function sectionAt(position, sections) {
  let found = null;
  for (const section of sections || []) {
    if (position + 1e-9 >= section.startBar && position < section.startBar + section.bars - 1e-9) found = section;
  }
  return found;
}
// Seconds until the next bar line, for stingers that wait for the downbeat. Zero when already on one.
export function secondsToNextBar(seconds, bpm, meter) {
  const bar = barSeconds(bpm, meter);
  const next = Math.ceil(seconds / bar - 1e-6) * bar;
  return Math.max(0, next - seconds);
}
// Context time for a stinger: the next bar line when quantised (a bar later when the line is under 10 ms away and too
// near to schedule), otherwise 20 ms from now. Always a whole frame at the context rate.
export function stingerTime(now, songSeconds, bpm, meter, rate, quantise) {
  let at = now + 0.02;
  if (quantise) {
    let wait = secondsToNextBar(songSeconds, bpm, meter);
    if (wait < 0.01) wait += barSeconds(bpm, meter);
    at = now + wait;
  }
  return Math.round(at * rate) / rate;
}
// Match files the listener picked to the paths the page needs. A folder pick gives "<chosen folder>/<path inside>", which
// must equal the page-relative path. Loose files match by name only when no two needed paths share that name.
export function matchPicked(needed, picked) {
  const files = {}, missing = [], ambiguous = [];
  const lower = text => text.toLowerCase();
  const baseOf = text => lower(text).split('/').pop();
  for (const src of needed) {
    const want = lower(src);
    let hits = [];
    picked.forEach((file, index) => { if (file.path && lower(file.path).split('/').slice(1).join('/') === want) hits.push(index); });
    if (!hits.length) {
      const loose = [];
      picked.forEach((file, index) => { if (!file.path && lower(file.name) === baseOf(src)) loose.push(index); });
      if (loose.length && needed.filter(other => baseOf(other) === baseOf(src)).length > 1) { ambiguous.push(src); continue; }
      hits = loose;
    }
    if (hits.length === 1) files[src] = hits[0];
    else if (hits.length > 1) ambiguous.push(src);
    else missing.push(src);
  }
  return { files, missing, ambiguous };
}
const pageMaths = [barSeconds, barBeatAt, wrapSongTime, startPlan, sectionAt, secondsToNextBar, stingerTime, matchPicked];

// ---------- page model ----------
// Sections are given in song bars from zero. Missing lengths run to the next section or the end of the song.
export function normaliseSections(sections, songBars) {
  const sorted = [...sections].sort((a, b) => a.startBar - b.startBar);
  return sorted.map((section, index) => {
    if (!(section.startBar >= 0) || (songBars !== undefined && section.startBar >= songBars)) {
      throw new Error(`Section "${section.name}" starts at bar ${section.startBar}, outside the song${songBars !== undefined ? ` (0 to ${songBars})` : ''}`);
    }
    const next = sorted[index + 1]?.startBar ?? songBars;
    const bars = section.bars ?? (next !== undefined ? next - section.startBar : undefined);
    if (!(bars > 0)) throw new Error(`Section "${section.name}" needs a length in bars`);
    return { name: section.name, startBar: section.startBar, bars };
  });
}
// Gains that bring every file down to the quietest one, so A/B judges the music and not the level.
export function matchLoudness(lufsList) {
  const known = lufsList.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!known.length) return lufsList.map(() => 0);
  const target = Math.min(...known);
  return lufsList.map(value => typeof value === 'number' && Number.isFinite(value) ? Number((target - value).toFixed(2)) : 0);
}
const posix = value => value.split(path.sep).join('/');
const plainName = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const plainAudioFile = /^[a-z0-9][a-z0-9_-]{0,119}\.(wav|ogg)$/i;

// Build the page model for an export_game_audio manifest. `base` is the manifest's folder relative to the page ('' when
// the page sits beside it).
export function gameModel(manifest, { sections, title, spectrogram, base = '', manifestFile } = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.loop?.file) throw new Error('Expected an export_game_audio manifest with a loop');
  // The manifest is a workspace file anyone could edit: its name becomes the page name and its files become page sources,
  // so both must be plain names in the manifest's own folder.
  if (typeof manifest.name !== 'string' || !plainName.test(manifest.name)) throw new Error(`Manifest name ${JSON.stringify(manifest.name)} is not a plain name (letters, digits, - and _)`);
  for (const file of [manifest.loop.file, manifest.intro?.file, ...(manifest.files ?? []).map(entry => entry?.file)]) {
    if (file !== undefined && (typeof file !== 'string' || !plainAudioFile.test(file))) throw new Error(`Manifest file ${JSON.stringify(file)} is not a plain WAV or OGG name in the export folder`);
  }
  for (const entry of manifest.files ?? []) if (entry?.role === 'layer' && (typeof entry.layer !== 'string' || !entry.layer)) throw new Error('Manifest layer entry has no layer name');
  if (!Number.isInteger(manifest.loop.endFrame) || !Number.isInteger(manifest.loop.startFrame ?? 0) || manifest.loop.endFrame <= (manifest.loop.startFrame ?? 0)) throw new Error('Manifest loop frames are not valid');
  if (!(manifest.bpm > 0)) throw new Error('Manifest has no tempo');
  const sampleRate = manifest.sampleRate ?? 48000;
  const meter = manifest.timeSignature ?? [4, 4];
  const files = manifest.files ?? [];
  const loopEntry = files.find(file => file.role === 'loop') ?? {};
  const introEntry = files.find(file => file.role === 'intro');
  const introBars = introEntry?.bars ?? 0;
  const loopFrames = manifest.loop.endFrame - manifest.loop.startFrame;
  const loopBars = loopEntry.bars ?? (manifest.bars - introBars);
  const songBars = introBars + loopBars;
  const src = file => base + file;
  const model = {
    kind: 'game', title: title ?? manifest.name, name: manifest.name, source: manifestFile ?? `${manifest.name}.manifest.json`,
    sampleRate, bpm: manifest.bpm, timeSignature: meter, songBars,
    intro: manifest.intro ? { src: src(manifest.intro.file), frames: manifest.intro.frames, bars: introBars } : null,
    loop: { src: src(manifest.loop.file), frames: loopFrames, startFrame: manifest.loop.startFrame, endFrame: manifest.loop.endFrame,
      bars: loopBars, startBar: introBars },
    layers: files.filter(file => file.role === 'layer').map(file => ({ name: file.layer, src: src(file.file), frames: file.frames, tracks: file.tracks ?? [] })),
    stingers: files.filter(file => file.role === 'stinger').map(file => ({ name: file.file.replace(/\.wav$/i, '').replace(`${manifest.name}-stinger-`, ''),
      src: src(file.file), frames: file.frames, startBar: file.startBar, bars: file.bars })),
    compare: [],
    sections: normaliseSections(sections?.length ? sections : [
      ...(introBars ? [{ name: 'Intro', startBar: 0, bars: introBars }] : []),
      { name: 'Loop', startBar: introBars, bars: loopBars },
    ], songBars),
    spectrogram: spectrogram ?? null,
    feedbackName: `${manifest.name}-feedback.json`,
  };
  if (model.intro && model.intro.frames !== Math.round(introBars * barSeconds(model.bpm, meter) * sampleRate)) {
    // export_game_audio cuts the intro at a rounded frame; flag any manifest that disagrees with its own tempo.
    model.warnings = ['The intro length does not match its bar count at this tempo; bar numbers may drift by a frame.'];
  }
  return model;
}
// Build the page model for one or more plain renders. Each file loops over its own length.
export function compareModel(files, { sections, title, spectrogram, bpm, timeSignature, sampleRate = 48000, name = 'audition' } = {}) {
  if (!files.length) throw new Error('Give at least one file');
  if (sections?.length && !bpm) throw new Error('Sections are given in bars, so they need bpm');
  const gains = matchLoudness(files.map(file => file.lufs));
  const longest = Math.max(...files.map(file => file.frames ?? 0));
  const songBars = bpm && longest ? longest / sampleRate / barSeconds(bpm, timeSignature) : undefined;
  return {
    kind: 'compare', title: title ?? (files.length > 1 ? 'A/B comparison' : files[0].src), name, source: null,
    sampleRate, bpm: bpm ?? null, timeSignature: timeSignature ?? [4, 4], songBars: songBars ?? null,
    intro: null, loop: null, layers: [], stingers: [],
    compare: files.map((file, index) => ({ label: String.fromCharCode(65 + index), src: file.src, frames: file.frames ?? null,
      lufs: file.lufs ?? null, gainDb: gains[index] })),
    sections: sections?.length ? normaliseSections(sections, songBars === undefined ? undefined : Math.ceil(songBars * 1000) / 1000) : [],
    spectrogram: spectrogram ?? null,
    feedbackName: `${name}-feedback.json`,
  };
}

// ---------- HTML ----------
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside a script element: no "</script", no HTML comment openers, no line separators that break old parsers.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const css = `
:root{--bg:#f5f4ef;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#dcdad2;--accent:#2f6f5e;--accent-ink:#fff;--warn:#a2462b;--track:#e9e7df;--fill:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#151614;--panel:#1f201d;--ink:#ecebe5;--muted:#9c9b93;--line:#353631;--accent:#6fbf9f;--accent-ink:#0d1210;--warn:#e08a6b;--track:#2b2c28;--fill:#6fbf9f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.sub{color:var(--muted);font-size:13px;margin:0 0 12px}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:7px;padding:6px 11px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.on,button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button:disabled{opacity:.45;cursor:default}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.clock{font:600 26px/1.1 ui-monospace,"Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums;min-width:9ch}
.pos{font:15px ui-monospace,Consolas,monospace;color:var(--muted)}
.sectionname{font-weight:600}
.bar{position:relative;height:26px;background:var(--track);border-radius:6px;margin:10px 0 4px;cursor:pointer;overflow:hidden}
.bar .fill{position:absolute;inset:0 auto 0 0;background:var(--fill);opacity:.35;width:0}
.bar .head{position:absolute;top:0;bottom:0;width:2px;background:var(--fill)}
.bar .mark{position:absolute;top:0;bottom:0;border-left:1px dashed var(--muted);font-size:11px;color:var(--muted);padding-left:3px;white-space:nowrap}
.layer{display:grid;grid-template-columns:minmax(80px,140px) 1fr 58px auto auto;gap:8px;align-items:center;margin:4px 0}
.layer input[type=range]{width:100%}
input[type=range],input[type=checkbox]{accent-color:var(--accent)}
.db{font:13px ui-monospace,Consolas,monospace;color:var(--muted);text-align:right}
.sec{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:6px 0}
.sec:first-of-type{border-top:0}
.stars button{padding:2px 7px;min-width:30px}
textarea{width:100%;min-height:62px;font:inherit;border:1px solid var(--line);border-radius:7px;padding:8px;background:var(--panel);color:var(--ink)}
select{font:inherit;padding:5px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
ul.notes{list-style:none;padding:0;margin:8px 0 0}
ul.notes li{display:flex;gap:8px;align-items:flex-start;border-top:1px solid var(--line);padding:6px 0}
ul.notes .when{font:13px ui-monospace,Consolas,monospace;color:var(--muted);min-width:15ch;cursor:pointer}
ul.notes .text{flex:1;white-space:pre-wrap}
.status{font-size:13px;color:var(--muted)}
.status.err{color:var(--warn)}
.hidden{display:none}
img.spec{max-width:100%;border-radius:6px;display:block}
.kbd{font:12px ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px}
@media (max-width:600px){.layer{grid-template-columns:1fr 1fr;}.clock{font-size:22px}}
`;

const body = `
<main>
<div class="row" style="justify-content:space-between"><div><h1 id="title"></h1><p class="sub" id="subtitle"></p></div><button type="button" id="open-lmms">Open in LMMS</button></div>
<section class="panel" id="loader">
<p class="status" id="status">Loading audio...</p>
<div id="picker" class="hidden">
<p class="sub">Browsers do not let a page opened from disk read files next to it. Choose the folder that holds this page (or select the audio files) and playback starts from there.</p>
<div class="row"><label><button type="button" id="pickfolder">Choose folder</button></label><input type="file" id="folderinput" class="hidden" multiple="multiple" webkitdirectory="webkitdirectory" /><button type="button" id="pickfiles">Choose files</button><input type="file" id="filesinput" class="hidden" multiple="multiple" accept="audio/*" /></div>
</div>
</section>
<section class="panel">
<div class="row"><button type="button" id="play" class="primary" disabled="disabled">Play</button><button type="button" id="restart" disabled="disabled">From start</button><span class="clock" id="clock">0:00.000</span><span class="pos" id="pos"></span><span class="sectionname" id="secname"></span></div>
<div class="bar" id="timeline"><div class="fill" id="fill"></div><div class="head" id="head"></div></div>
<div class="row"><span class="status">Master</span><input type="range" id="master" min="-30" max="6" step="0.5" value="0" /><span class="db" id="masterdb">0.0 dB</span><span class="status"><span class="kbd">Space</span> play or pause, <span class="kbd">N</span> new note</span></div>
</section>
<section class="panel hidden" id="comparepanel"><h2>Compare</h2><div class="row" id="comparebuttons"></div><p class="status" id="compareinfo"></p></section>
<section class="panel hidden" id="layerpanel"><h2>Layers</h2><div class="row" style="margin-bottom:6px"><button type="button" id="modemix">Full mix</button><button type="button" id="modelayers">Layers</button><span class="status" id="mode-banner">Stems (isolated pre-master tracks)</span></div><div id="layers"></div></section>
<section class="panel hidden" id="stingerpanel"><h2>Stingers</h2><div class="row" id="stingers"></div><label class="status"><input type="checkbox" id="quantise" checked="checked" /> Wait for the next bar</label></section>
<section class="panel hidden" id="sectionpanel"><h2>Sections</h2><div id="sections"></div></section>
<section class="panel"><h2>Notes</h2>
<textarea id="notetext" placeholder="What do you hear? The note is pinned to the current time, bar and layer settings."></textarea>
<div class="row" style="margin-top:6px"><button type="button" id="addnote" class="primary">Add note here</button><select id="noterating"><option value="">No rating</option><option value="1">1 poor</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5 great</option></select><span class="status" id="notewhere"></span></div>
<ul class="notes" id="notes"></ul>
<div class="row" style="margin-top:8px"><button type="button" id="send-feedback" class="primary">Send Feedback to Studio</button><button type="button" id="save">Save feedback</button><button type="button" id="copy">Copy feedback</button><span class="status" id="savestatus"></span></div>
</section>
<section class="panel hidden" id="specpanel"><h2>Spectrogram</h2><img class="spec" id="spec" alt="Spectrogram of the render" /></section>
</main>
`;

// Render the model to a complete HTML document. Every asset path in the model is relative to the page.
export function renderPage(model, { pageName = 'audition.html', pageId } = {}) {
  const config = { ...model, schema: feedbackSchema, version: feedbackVersion, pageName, pageId: pageId ?? `${model.source ?? model.name}:${pageName}` };
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="lmms-mcp build_audition_page" />
<title>${escapeHtml(model.title)}</title>
<style>${css}</style>
</head>
<body>${body}
<script type="application/json" id="audition-config">${scriptJson(config)}</script>
<script>
${AUDITION_CLIENT_JS}
</script>
</body>
</html>
`;
}
// Every relative asset path the page loads, for checks.
export function pageAssets(model) {
  return [model.intro?.src, model.loop?.src, ...model.layers.map(layer => layer.src), ...model.stingers.map(stinger => stinger.src),
    ...model.compare.map(file => file.src), model.spectrogram].filter(Boolean);
}

// ---------- feedback ----------
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
const rating = value => Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
const projectFilePattern = /^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i;
const sha256HexPattern = /^[0-9a-f]{64}$/i;

// Validate a feedback document saved or copied from an audition or timeline page (version 1 or 2) and return a clean copy.
export function parseFeedback(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (error) { throw new Error('Feedback is not valid JSON: ' + error.message); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Feedback must be a JSON object');
  if (data.schema !== feedbackSchema) throw new Error(`Expected schema "${feedbackSchema}", got ${JSON.stringify(data.schema)}`);
  if (!supportedFeedbackVersions.includes(data.version)) {
    throw new Error(`Unsupported feedback version ${JSON.stringify(data.version)}; this server reads versions ${supportedFeedbackVersions.join(' and ')}`);
  }
  if (!Array.isArray(data.notes)) throw new Error('Feedback has no notes array');
  if (data.notes.length > maxFeedbackNotes * 10) throw new Error(`Feedback holds ${data.notes.length} notes; at most ${maxFeedbackNotes * 10} can be read`);
  if (Array.isArray(data.sections) && data.sections.length > 200) throw new Error('Feedback holds more than 200 sections');

  let projectFile = null;
  if (data.projectFile !== undefined && data.projectFile !== null && data.projectFile !== '') {
    if (typeof data.projectFile !== 'string' || !projectFilePattern.test(data.projectFile.trim())) {
      throw new Error('Feedback projectFile must be a plain .mmp or .mmpz filename');
    }
    projectFile = data.projectFile.trim();
  }

  let projectSha256 = null;
  if (data.projectSha256 !== undefined && data.projectSha256 !== null && data.projectSha256 !== '') {
    if (typeof data.projectSha256 !== 'string' || !sha256HexPattern.test(data.projectSha256.trim())) {
      throw new Error('Feedback projectSha256 must be a 64-character hex SHA-256 digest');
    }
    projectSha256 = data.projectSha256.trim().toLowerCase();
  }

  const sections = (Array.isArray(data.sections) ? data.sections : []).filter(section => section && typeof section.name === 'string').map(section => {
    const startBar = finite(section.startBar) ? section.startBar : null;
    return {
      name: cleanText(section.name, 60),
      startBar,
      ...(startBar !== null ? { displayStartBar: startBar + 1 } : {}),
      bars: finite(section.bars) ? section.bars : null,
      rating: rating(section.rating),
    };
  });

  const cleanLaneList = list => Array.isArray(list)
    ? list.filter(item => typeof item === 'string' && item.trim()).slice(0, 64).map(item => cleanText(item, 100))
    : [];

  const notes = data.notes.map((note, index) => {
    if (!note || typeof note !== 'object') throw new Error(`Note ${index + 1} is not an object`);
    if (!finite(note.seconds) || note.seconds < 0) throw new Error(`Note ${index + 1} has no valid seconds`);
    const text = cleanText(note.text, 2000);
    if (!text && !rating(note.rating)) throw new Error(`Note ${index + 1} has neither text nor rating`);

    let bar = Number.isInteger(note.bar) && note.bar >= 0 ? note.bar : null;
    const rawDisplayBar = Number.isInteger(note.displayBar) && note.displayBar >= 1 ? note.displayBar : null;
    if (bar === null && rawDisplayBar !== null) {
      bar = rawDisplayBar - 1;
    } else if (bar !== null && rawDisplayBar !== null && rawDisplayBar !== bar + 1) {
      throw new Error(`Note ${index + 1} displayBar (${rawDisplayBar}) must equal bar + 1 (${bar + 1})`);
    }
    const displayBar = bar !== null ? bar + 1 : null;

    const out = {
      seconds: Number(note.seconds.toFixed(3)),
      bar,
      displayBar,
      beat: Number.isInteger(note.beat) && note.beat >= 1 ? note.beat : null,
      section: typeof note.section === 'string' ? cleanText(note.section, 60) : null,
      text,
      rating: rating(note.rating),
      soloedLanes: cleanLaneList(note.soloedLanes),
      mutedLanes: cleanLaneList(note.mutedLanes),
    };
    if (note.mode === 'mix' || note.mode === 'layers' || note.mode === 'stems') out.mode = note.mode;
    if (note.layers && typeof note.layers === 'object') {
      out.layers = Object.fromEntries(Object.entries(note.layers).slice(0, 12).map(([name, layer]) => [cleanText(name, 80),
        { db: finite(layer?.db) ? layer.db : 0, muted: layer?.muted === true, solo: layer?.solo === true }]));
      if (!out.soloedLanes.length) {
        out.soloedLanes = Object.entries(out.layers).filter(([, l]) => l.solo).map(([n]) => n);
      }
      if (!out.mutedLanes.length) {
        out.mutedLanes = Object.entries(out.layers).filter(([, l]) => l.muted).map(([n]) => n);
      }
    }
    if (typeof note.compare === 'string') out.compare = cleanText(note.compare, 4);
    return out;
  });

  return {
    schema: feedbackSchema,
    version: data.version,
    ...(typeof data.kind === 'string' ? { kind: cleanText(data.kind, 24) } : {}),
    title: cleanText(data.title, 200) || null,
    source: typeof data.source === 'string' ? data.source : null,
    page: typeof data.page === 'string' ? data.page : null,
    projectFile,
    projectSha256,
    files: Array.isArray(data.files) ? data.files.filter(file => typeof file === 'string') : [],
    bpm: finite(data.bpm) ? data.bpm : null,
    timeSignature: Array.isArray(data.timeSignature) ? data.timeSignature : null,
    introBars: finite(data.introBars) ? data.introBars : 0,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
    sections,
    notes,
  };
}

// What the listener heard as a short phrase: which layers/lanes were muted or soloed, which A/B file.
function context(note) {
  const parts = [];
  if (note.compare) parts.push(`file ${note.compare}`);
  if (note.mode === 'mix') parts.push('full mix');
  if (note.layers) {
    const entries = Object.entries(note.layers);
    const solo = entries.filter(([, layer]) => layer.solo).map(([name]) => name);
    const muted = entries.filter(([, layer]) => layer.muted).map(([name]) => name);
    const moved = entries.filter(([, layer]) => layer.db !== 0).map(([name, layer]) => `${name} ${layer.db > 0 ? '+' : ''}${layer.db} dB`);
    if (solo.length) parts.push(`solo ${solo.join(', ')}`);
    else if (muted.length) parts.push(`muted ${muted.join(', ')}`);
    if (moved.length) parts.push(moved.join(', '));
  } else {
    if (note.soloedLanes?.length) parts.push(`solo ${note.soloedLanes.join(', ')}`);
    else if (note.mutedLanes?.length) parts.push(`muted ${note.mutedLanes.join(', ')}`);
    else if (note.mode === 'stems') parts.push('stems');
  }
  return parts.join('; ');
}

// Group feedback by section and 0-based bar so an agent can turn each note into an edit at the right place.
export const maxFeedbackNotes = 300;
export function organiseFeedback(feedback) {
  const all = [...feedback.notes].sort((a, b) => a.seconds - b.seconds);
  const kept = all.slice(0, maxFeedbackNotes);
  const sections = feedback.sections.map(section => ({
    ...section,
    endBar: section.startBar !== null && section.bars !== null ? section.startBar + section.bars : null,
    notes: [],
  }));
  const outside = [];
  const normalisedNotes = [];
  for (const note of kept) {
    const heard = context(note) || undefined;
    const entry = {
      bar: note.bar,
      displayBar: note.bar !== null ? note.bar + 1 : null,
      beat: note.beat,
      seconds: note.seconds,
      text: note.text,
      rating: note.rating,
      ...(note.soloedLanes?.length ? { soloedLanes: note.soloedLanes } : {}),
      ...(note.mutedLanes?.length ? { mutedLanes: note.mutedLanes } : {}),
      heard,
    };
    normalisedNotes.push({ ...entry, section: note.section });
    const home = sections.find(section => section.name === note.section) ??
      (note.bar !== null ? sections.find(section => section.startBar !== null && note.bar >= section.startBar && note.bar < section.endBar) : undefined);
    (home ? home.notes : outside).push(entry);
  }
  const byBar = {};
  for (const note of kept) if (note.bar !== null) (byBar[note.bar] ??= []).push(note.text || `rated ${note.rating}/5`);
  const ratings = [...sections.map(section => section.rating), ...all.map(note => note.rating)].filter(value => value !== null);
  const lines = [];
  for (const section of sections) {
    if (section.rating === null && !section.notes.length) continue;
    const span = section.startBar !== null ? ` (bars ${section.startBar} to ${section.endBar !== null ? section.endBar - 1 : '?'})` : '';
    lines.push(`${section.name}${span}: ${section.rating !== null ? `rated ${section.rating}/5` : 'not rated'}${section.notes.length ? `, ${section.notes.length} note${section.notes.length === 1 ? '' : 's'}` : ''}`);
    for (const note of section.notes) lines.push(`  ${note.bar !== null ? `bar ${note.bar} (Display Bar ${note.displayBar}) beat ${note.beat}` : `${note.seconds} s`}: ${note.text}${note.rating ? ` [${note.rating}/5]` : ''}${note.heard ? ` (heard: ${note.heard})` : ''}`);
  }
  for (const note of outside) lines.push(`${note.bar !== null ? `bar ${note.bar} (Display Bar ${note.displayBar}) beat ${note.beat}` : `${note.seconds} s`}: ${note.text}${note.heard ? ` (heard: ${note.heard})` : ''}`);
  const weakest = sections.filter(section => section.rating !== null).sort((a, b) => a.rating - b.rating)[0];
  return {
    version: feedback.version,
    title: feedback.title,
    source: feedback.source,
    projectFile: feedback.projectFile ?? null,
    projectSha256: feedback.projectSha256 ?? null,
    savedAt: feedback.savedAt,
    bpm: feedback.bpm,
    timeSignature: feedback.timeSignature,
    noteCount: all.length,
    ...(all.length > kept.length ? { omittedNotes: all.length - kept.length } : {}),
    averageRating: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)) : null,
    weakestSection: weakest ? { name: weakest.name, rating: weakest.rating } : null,
    sections,
    outsideSections: outside,
    notes: normalisedNotes,
    byBar,
    summary: lines,
  };
}

// ---------- taste memory ----------
const normalise = text => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
export const maxTasteEntries = 500;
export const maxTasteBytes = 1048576;
export const maxTasteText = 400;
const repairHint = `Call remember_taste with repair: true to back it up and keep the valid entries.`;
export function emptyTaste() { return { version: 1, entries: [] }; }
// Why one stored entry is unusable, or null when it is fine.
function tasteEntryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if (typeof entry.id !== 'string' || !/^t\d{1,6}$/.test(entry.id)) return `has id ${JSON.stringify(entry.id)}, expected t followed by digits`;
  if (!tasteAreas.includes(entry.area)) return `has unknown area ${JSON.stringify(entry.area)}`;
  if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > maxTasteText) return `needs text of 1 to ${maxTasteText} characters`;
  if (entry.source !== undefined && typeof entry.source !== 'string') return 'has a source that is not text';
  if (entry.addedAt !== undefined && typeof entry.addedAt !== 'string') return 'has an addedAt that is not text';
  return null;
}
const cleanEntry = entry => ({ id: entry.id, area: entry.area, text: entry.text, ...(entry.source !== undefined ? { source: entry.source.slice(0, 200) } : {}),
  ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}) });
// Read the taste file strictly. Every error names the file and says how to recover.
export function parseTaste(text) {
  if (text.length > maxTasteBytes) throw new Error(`${tasteFile} is larger than ${maxTasteBytes / 1048576} MiB. ${repairHint}`);
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`${tasteFile} is not valid JSON (${error.message}). ${repairHint}`); }
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.entries)) throw new Error(`${tasteFile} is not a version 1 taste file. ${repairHint}`);
  if (data.entries.length > maxTasteEntries) throw new Error(`${tasteFile} holds ${data.entries.length} entries, more than ${maxTasteEntries}. ${repairHint}`);
  const seen = new Set();
  data.entries.forEach((entry, index) => {
    const problem = tasteEntryProblem(entry) ?? (seen.has(entry.id) ? `repeats id ${entry.id}` : null);
    if (problem) throw new Error(`${tasteFile} entry ${index + 1} ${problem}. ${repairHint}`);
    seen.add(entry.id);
  });
  return { version: 1, entries: data.entries.map(cleanEntry) };
}
// Keep whatever can be kept from a damaged taste file. Never throws.
export function salvageTaste(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { store: emptyTaste(), dropped: 'all: the file was not valid JSON' }; }
  const entries = [], seen = new Set();
  let dropped = 0;
  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    if (tasteEntryProblem(entry) || seen.has(entry.id) || entries.length >= maxTasteEntries) { dropped++; continue; }
    seen.add(entry.id);
    entries.push(cleanEntry(entry));
  }
  if (!Array.isArray(data?.entries)) return { store: emptyTaste(), dropped: 'all: the file had no entries list' };
  return { store: { version: 1, entries }, dropped };
}
// Add a preference, or return the existing one when the same words are already stored for that area.
export function addTaste(store, { text, area = 'general', source }, now = new Date().toISOString()) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('A preference needs some text');
  if (clean.length > maxTasteText) throw new Error(`A preference is at most ${maxTasteText} characters`);
  if (!tasteAreas.includes(area)) throw new Error(`Unknown area ${JSON.stringify(area)}`);
  const existing = store.entries.find(entry => entry.area === area && normalise(entry.text) === normalise(clean));
  if (existing) return { store, entry: existing, added: false };
  if (store.entries.length >= maxTasteEntries) throw new Error(`${tasteFile} already holds ${maxTasteEntries} preferences; forget some first`);
  const next = Math.max(0, ...store.entries.map(entry => Number(String(entry.id).replace(/^t/, '')) || 0)) + 1;
  const entry = { id: `t${next}`, area, text: clean, ...(source ? { source } : {}), addedAt: now };
  return { store: { ...store, entries: [...store.entries, entry] }, entry, added: true };
}
export function forgetTaste(store, ids) {
  const drop = new Set(ids);
  const missing = ids.filter(id => !store.entries.some(entry => entry.id === id));
  if (missing.length) throw new Error(`No taste entry with id ${missing.join(', ')}`);
  return { ...store, entries: store.entries.filter(entry => !drop.has(entry.id)) };
}
export function tasteByArea(store, area) {
  const entries = area ? store.entries.filter(entry => entry.area === area || entry.area === 'general') : store.entries;
  const grouped = {};
  for (const entry of entries) (grouped[entry.area] ??= []).push({ id: entry.id, text: entry.text });
  return grouped;
}

// ---------- tools ----------
const audioPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.(wav|ogg)$/i;
const pngPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.png$/i;
const jsonPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _.()-]{0,119}\.json$/i;

export function register({ tool, z, dsp, root, schemas, project: projectApi, paths, logger, moduleGuidance, env = process.env }) {
  const auditionLogger = logger?.child ? logger.child('audition') : undefined;
  moduleGuidance.push(
    'Call get_taste before composing or mixing and follow the listener\'s stored preferences; save new ones with remember_taste when feedback states a lasting preference.',
    'Before asking the listener to judge music, run build_audition_page on the export folder (or on two renders to A/B them) and give them the studioUrl; read their notes back with read_feedback.',
  );
  // Every path read or written goes through here, whether it came from a tool argument or from a file in the workspace.
  const inside = relative => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Expected a path inside the workspace');
    return full;
  };
  const regularFile = async (full, label, maxBytes) => {
    let info;
    try { info = await lstat(full); } catch { throw new Error(`${label} was not found in the workspace`); }
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (maxBytes && info.size > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1048576)} MiB`);
    return info;
  };
  // Write through a temporary name so a reader never sees half a file.
  const writeAtomic = async (full, text, overwrite) => {
    if (!overwrite) {
      try { await lstat(full); throw new Error(`${path.basename(full)} already exists; pass overwrite: true to replace it`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const temporary = `${full}.tmp-${process.pid}-${++temporaryCount}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await writeFile(temporary, text, { flag: 'wx' });
      await rename(temporary, full);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  let temporaryCount = 0;
  const sectionSchema = z.object({ name: z.string().min(1).max(60), startBar: z.number().min(0), bars: z.number().min(0.25).optional() });
  const projectSchema = schemas?.projectName ?? z.string().regex(projectFilePattern);
  const toWorkspaceUrl = (pageDir, assetRelative) => {
    const full = inside(path.resolve(pageDir, assetRelative));
    const rel = posix(path.relative(root, full));
    return '/' + rel.split('/').map(encodeURIComponent).join('/');
  };

  tool('build_audition_page', 'Write a self-contained HTML page and live Studio session descriptor so a person can listen to and judge the music in seconds. Give either an export_game_audio folder (plays the intro into the loop gaplessly, with layer faders, mute and solo, stinger buttons and section jumps) or one to four workspace WAV or OGG files (played in sync and switched A/B at matched loudness). Emits Unified Feedback v2 JSON directly to the workspace via Send Feedback to Studio.', {
    folder: schemas.folderName.optional().describe('Folder written by export_game_audio. The page is written into it.'),
    manifest: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.manifest\.json$/i).optional().describe('Manifest in the folder. Needed only when the folder holds more than one.'),
    files: z.array(z.string().regex(audioPath)).min(1).max(4).optional().describe('Workspace WAV or OGG renders to compare, optionally one folder down. The page is written to the workspace root.'),
    project: projectSchema.optional().describe('Optional workspace LMMS project (.mmp/.mmpz). Derives static bpm and timeSignature, records projectSha256, and enables Open in LMMS.'),
    sections: z.array(sectionSchema).max(32).optional().describe('Named sections in song bars counted from zero (the intro starts at bar 0). Lengths default to the next section.'),
    bpm: z.number().min(20).max(400).optional().describe('Tempo for bar display and sections when comparing files. Derived automatically when project or folder is supplied.'),
    timeSignature: z.tuple([z.number().int().min(1).max(32), z.number().int().min(1).max(32)]).optional(),
    spectrogram: z.string().regex(pngPath).optional().describe('Workspace PNG, for example from analyze_audio, shown under the player.'),
    title: z.string().min(1).max(120).optional(),
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.html$/i).optional().describe('Page file name. Defaults to <name>-audition.html.'),
    overwrite: z.boolean().default(true).describe('Replace an existing page of the same name.'),
  }, async ({ folder, manifest: manifestName, files, project: linkedProject, sections, bpm, timeSignature, spectrogram, title, output, overwrite }) => {
    if (Boolean(folder) === Boolean(files)) throw new Error('Give either folder (an export_game_audio folder) or files (renders to compare), not both');
    if (manifestName && !folder) throw new Error('manifest needs folder');

    let projectFile = null;
    let projectSha256 = null;
    let effectiveBpm = bpm;
    let effectiveTimeSig = timeSignature;

    if (linkedProject) {
      if (!projectApi?.load || !projectApi?.songInfo) {
        throw new Error('Project loader is unavailable in this context');
      }
      const doc = await projectApi.load(linkedProject);
      const info = projectApi.songInfo(doc);
      if (!info.staticTempo) {
        throw new Error(
          `Project "${linkedProject}" contains dynamic <bpm> tempo automation. Static tempo is required for bar-indexed audition feedback; remove tempo automation or omit project.`,
        );
      }
      effectiveBpm ??= info.bpm;
      effectiveTimeSig ??= info.meter;
      projectFile = linkedProject;
      projectSha256 = await sha256File(inside(linkedProject));
    }

    const pageDir = folder ? inside(folder) : root;
    const relativeTo = full => posix(path.relative(pageDir, full));
    let spectrogramSrc = null;
    if (spectrogram) {
      const full = inside(spectrogram);
      await regularFile(full, spectrogram, 32 * 1048576);
      spectrogramSrc = relativeTo(full);
    }
    let model;
    const notes = [];
    if (folder) {
      if (!manifestName) {
        let listing;
        try { listing = await readdir(pageDir); } catch { throw new Error(`Folder "${folder}" was not found in the workspace`); }
        const found = listing.filter(name => name.endsWith('.manifest.json'));
        if (found.length !== 1) throw new Error(found.length ? `Folder "${folder}" holds ${found.length} manifests; pass manifest: one of ${found.join(', ')}` : `Folder "${folder}" has no .manifest.json; run export_game_audio first`);
        manifestName = found[0];
      }
      const manifestPath = path.join(pageDir, manifestName);
      await regularFile(manifestPath, `${folder}/${manifestName}`, 4 * 1048576);
      let manifest;
      try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { throw new Error(`${manifestName} is not valid JSON: ${error.message}`); }
      if (!linkedProject && typeof manifest.source === 'string' && projectFilePattern.test(manifest.source)) {
        const candidateProjPath = inside(manifest.source);
        const st = await lstat(candidateProjPath).catch(() => null);
        if (st?.isFile() && !st.isSymbolicLink()) {
          projectFile = manifest.source;
          projectSha256 = await sha256File(candidateProjPath);
        }
      }
      if (bpm || timeSignature) notes.push('bpm and timeSignature come from the manifest for a game folder; the given values were ignored.');
      model = gameModel(manifest, { sections, title, spectrogram: spectrogramSrc, manifestFile: manifestName });
      for (const asset of pageAssets(model).filter(src => src !== spectrogramSrc)) await regularFile(inside(path.join(pageDir, asset)), `${folder}/${asset}`);
      if (model.warnings) notes.push(...model.warnings);
    } else {
      const measured = [];
      let sampleRate;
      for (const file of files) {
        const full = inside(file);
        await regularFile(full, file, 256 * 1048576);
        // Loudness comes from the WAV; an OGG is measured through a WAV of the same name beside it when there is one.
        const wavFull = /\.ogg$/i.test(file) ? full.replace(/\.ogg$/i, '.wav') : full;
        let lufs = null, frames = null;
        try {
          await regularFile(wavFull, file, 256 * 1048576);
          const audio = dsp.decodeWav(await readFile(wavFull));
          lufs = dsp.loudness(audio).integratedLufs;
          frames = audio.frames;
          sampleRate ??= audio.sampleRate;
        } catch {
          notes.push(`${file}: no WAV to measure, so its level is not matched.`);
        }
        measured.push({ src: relativeTo(full), lufs, frames });
      }
      const base = path.basename(files[0]).replace(/\.(wav|ogg)$/i, '');
      model = compareModel(measured, {
        sections,
        title,
        spectrogram: spectrogramSrc,
        bpm: effectiveBpm,
        timeSignature: effectiveTimeSig,
        sampleRate,
        name: files.length > 1 ? `${base}-ab` : base,
      });
    }

    const sessionId = output ? output.replace(/\.html$/i, '') : model.name;
    model.projectFile = projectFile;
    model.projectSha256 = projectSha256;
    model.session = sessionId;

    const pageName = output ?? `${model.name}-audition.html`;
    if (!/^[a-z0-9][a-z0-9_-]{0,100}\.html$/i.test(pageName)) throw new Error(`Page name ${JSON.stringify(pageName)} is not a plain file name`);
    const html = renderPage(model, { pageName });
    const pagePath = inside(path.join(pageDir, pageName));
    if (path.dirname(pagePath) !== pageDir) throw new Error('The page must be written beside its audio');
    await writeAtomic(pagePath, html, overwrite);
    const relativePage = posix(path.relative(root, pagePath));

    const studioDescriptorName = `${sessionId}.audition.studio.json`;
    const studioDescriptor = {
      ...model,
      schema: STUDIO_DESCRIPTOR_SCHEMA,
      studioKind: 'audition',
      version: feedbackVersion,
      session: sessionId,
      pageName: relativePage,
      pageId: `${model.source ?? model.name}:${relativePage}`,
      feedbackName: `${sessionId}-feedback.json`,
      intro: model.intro ? { ...model.intro, src: toWorkspaceUrl(pageDir, model.intro.src) } : null,
      loop: model.loop ? { ...model.loop, src: toWorkspaceUrl(pageDir, model.loop.src) } : null,
      layers: model.layers.map(l => ({ ...l, src: toWorkspaceUrl(pageDir, l.src) })),
      stingers: model.stingers.map(s => ({ ...s, src: toWorkspaceUrl(pageDir, s.src) })),
      compare: model.compare.map(c => ({ ...c, src: toWorkspaceUrl(pageDir, c.src) })),
      spectrogram: model.spectrogram ? toWorkspaceUrl(pageDir, model.spectrogram) : null,
    };
    await writeFileAtomic(
      inside(studioDescriptorName),
      JSON.stringify(studioDescriptor, null, 2) + '\n',
      { overwrite: true },
    );

    let studioUrl = null;
    if (env?.LMMS_AUTO_SERVER !== '0') {
      const srv = await ensureStudioServer({
        workspaceDir: root,
        soundfontsDir: paths?.soundfonts,
        env,
        logger: auditionLogger,
      });
      studioUrl = `${srv.baseUrl}/studio/audition?session=${encodeURIComponent(sessionId)}`;
    }

    return {
      page: relativePage, path: pagePath, url: 'file:///' + posix(pagePath).replace(/^\/+/, ''),
      ...(studioUrl ? { studioUrl } : {}),
      studioSession: sessionId,
      studioDescriptor: studioDescriptorName,
      bytes: Buffer.byteLength(html), kind: model.kind,
      title: model.title, sampleRate: model.sampleRate, bpm: model.bpm, timeSignature: model.timeSignature,
      ...(projectFile ? { projectFile, projectSha256 } : {}),
      ...(model.intro ? { intro: { src: model.intro.src, frames: model.intro.frames, bars: model.intro.bars } } : {}),
      ...(model.loop ? { loop: { src: model.loop.src, frames: model.loop.frames, bars: model.loop.bars, startBar: model.loop.startBar } } : {}),
      layers: model.layers.map(layer => layer.name), stingers: model.stingers.map(stinger => stinger.name),
      compare: model.compare.map(({ label, src, lufs, gainDb }) => ({ label, src, lufs, gainDb })),
      sections: model.sections, assets: pageAssets(model), feedbackFile: model.feedbackName,
      howToListen: studioUrl
        ? `Open ${studioUrl} in a browser for direct playback, "Send Feedback to Studio", and "Open in LMMS". Offline file (${relativePage}) is also written.`
        : 'Open the page in a browser. Opened from disk, it asks once for its folder; served over http it loads directly. The listener saves or copies feedback for read_feedback.',
      ...(notes.length ? { notes } : {}),
    };
  });

  tool('read_feedback', 'Read listener feedback (v1 or v2) saved or posted from a Studio timeline or audition page and return it grouped by section and 0-based bar, with 1-based displayBar, ratings, weakest section, project revision staleness check, and what the listener was hearing.', {
    file: z.string().regex(jsonPath).optional().describe('Feedback JSON in the workspace, optionally one folder down.'),
    text: z.string().min(2).max(1048576).optional().describe('Feedback JSON pasted from the page\'s Copy feedback button.'),
  }, async ({ file, text }) => {
    if (Boolean(file) === Boolean(text)) throw new Error('Give either file or text');
    let raw = text;
    if (file) {
      const full = inside(file);
      await regularFile(full, file, 4 * 1048576);
      raw = await readFile(full, 'utf8');
    }
    const parsed = parseFeedback(raw);
    const organised = organiseFeedback(parsed);

    let currentProjectSha256 = null;
    let staleProjectRevision = false;
    if (parsed.projectFile) {
      const projPath = inside(parsed.projectFile);
      const st = await lstat(projPath).catch(() => null);
      if (st?.isFile() && !st.isSymbolicLink()) {
        currentProjectSha256 = await sha256File(projPath);
      }
      if (parsed.projectSha256) {
        staleProjectRevision = !currentProjectSha256 || currentProjectSha256.toLowerCase() !== parsed.projectSha256.toLowerCase();
      }
    }

    return {
      ...(file ? { file } : {}),
      ...organised,
      currentProjectSha256,
      staleProjectRevision,
    };
  });

  const tastePath = inside(tasteFile);
  const readTasteText = async () => {
    let info;
    try { info = await lstat(tastePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile()) throw new Error(`${tasteFile} is not a regular file`);
    if (info.size > maxTasteBytes) throw new Error(`${tasteFile} is larger than ${maxTasteBytes / 1048576} MiB. ${repairHint}`);
    return readFile(tastePath, 'utf8');
  };
  const loadTaste = async () => {
    const text = await readTasteText();
    return text === null ? emptyTaste() : parseTaste(text);
  };
  // Writes are serialised: one queue inside this server, and a lock file against a second server on the same workspace.
  let tasteQueue = Promise.resolve();
  const lockPath = tastePath + '.lock';
  const withTasteLock = work => {
    const run = tasteQueue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { await writeFile(lockPath, String(process.pid), { flag: 'wx' }); break; } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const age = await lstat(lockPath).then(info => Date.now() - info.mtimeMs, () => 0);
          if (age > 10000) { await rm(lockPath, { force: true }); continue; }
          if (attempt > 200) throw new Error(`${tasteFile} is locked by another process (${path.basename(lockPath)})`);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      try { return await work(); } finally { await rm(lockPath, { force: true }).catch(() => {}); }
    });
    tasteQueue = run.catch(() => {});
    return run;
  };
  tool('remember_taste', `Store a lasting listener preference in ${tasteFile} in the workspace, for example "leads too busy, keep melodies sparse" or "less reverb on drums". Later sessions read it with get_taste. Repeated wording is stored once. Pass forget with entry ids to remove preferences that no longer hold. Pass repair: true to recover from a damaged file: the original is kept as a backup and the valid entries are kept.`, {
    text: z.string().min(1).max(maxTasteText).optional(),
    area: z.enum(tasteAreas).default('general').describe('What the preference is about: a track role, the mix, the arrangement, sound choice or general.'),
    source: z.string().max(200).optional().describe('Where it came from, for example a feedback file name.'),
    forget: z.array(z.string().regex(/^t\d{1,6}$/)).max(50).optional(),
    repair: z.boolean().default(false).describe(`Back up a damaged ${tasteFile} and keep only its valid entries.`),
  }, async ({ text, area, source, forget, repair }) => withTasteLock(async () => {
    if (!text && !forget?.length && !repair) throw new Error('Give text to remember, forget ids to remove, or repair: true');
    let store, repaired;
    if (repair) {
      const raw = await readTasteText().catch(error => { if (/larger than/.test(error.message)) return ''; throw error; });
      if (raw === null) store = emptyTaste();
      else {
        const salvaged = salvageTaste(raw);
        const backup = `${tasteFile}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await rename(tastePath, inside(backup));
        store = salvaged.store;
        repaired = { kept: store.entries.length, dropped: salvaged.dropped, backup };
      }
    } else store = await loadTaste();
    if (forget?.length) store = forgetTaste(store, forget);
    let result;
    if (text) result = addTaste(store, { text, area, source });
    if (result) store = result.store;
    await writeAtomic(tastePath, JSON.stringify(store, null, 2) + '\n', true);
    return { file: tasteFile, ...(result ? { entry: result.entry, added: result.added } : {}), ...(forget?.length ? { forgotten: forget } : {}),
      ...(repaired ? { repaired } : {}), count: store.entries.length };
  }));
  tool('get_taste', `Read the listener's stored preferences from ${tasteFile}, grouped by area. Call this before composing or mixing. Pass area to get that area and the general entries.`, {
    area: z.enum(tasteAreas).optional(),
  }, async ({ area }) => {
    const store = await loadTaste();
    return { file: tasteFile, count: store.entries.length, preferences: tasteByArea(store, area),
      ...(store.entries.length ? {} : { note: 'No preferences stored yet. Use remember_taste when the listener states one.' }) };
  });
}
