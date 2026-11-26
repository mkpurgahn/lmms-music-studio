// Unit tests for the audition module: timing maths, the manifest-to-page model, the page itself, feedback and taste.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import * as dsp from '../audio.mjs';
import {
  barSeconds, barBeatAt, wrapSongTime, startPlan, sectionAt, secondsToNextBar, normaliseSections, matchLoudness,
  gameModel, compareModel, renderPage, pageAssets, parseFeedback, organiseFeedback, feedbackSchema,
  emptyTaste, addTaste, forgetTaste, tasteByArea, parseTaste, salvageTaste, maxTasteEntries, maxFeedbackNotes,
  matchPicked, stingerTime, register,
} from './audition.mjs';

// The shape export_game_audio writes: 120 bpm 4/4, 2 intro bars, 6 loop bars, two layers and a stinger.
const manifest = {
  name: 'forest', source: 'song.mmp', bpm: 120, timeSignature: [4, 4], bars: 8, sampleRate: 48000, channels: 2, gainDb: 0,
  loop: { file: 'forest-loop.wav', startFrame: 0, endFrame: 576000, seamless: true, tail: 'folded into the loop start' },
  intro: { file: 'forest-intro.wav', frames: 192000, then: 'forest-loop.wav' },
  files: [
    { file: 'forest-loop.wav', role: 'loop', loopStartFrame: 0, loopEndFrame: 576000, bars: 6, frames: 576000 },
    { file: 'forest-intro.wav', role: 'intro', bars: 2, next: 'forest-loop.wav', frames: 192000 },
    { file: 'forest-layer-rhythm.wav', role: 'layer', layer: 'rhythm', tracks: ['Kick', 'Snare'], frames: 576000 },
    { file: 'forest-layer-tonal.wav', role: 'layer', layer: 'tonal', tracks: ['Bass', 'Keys'], frames: 576000 },
    { file: 'forest-stinger-hit.wav', role: 'stinger', startBar: 4, bars: 1, frames: 96000 },
  ],
};

test('bar length follows LMMS ticks: 192 * numerator / denominator ticks of 48 per beat', () => {
  assert.equal(barSeconds(120, [4, 4]), 2);
  assert.equal(barSeconds(120, [3, 4]), 1.5);
  assert.equal(barSeconds(120, [6, 8]), 1.5);
  assert.equal(barSeconds(90), 240 / 90);
});

test('bar and beat at a time count bars from zero and beats from one', () => {
  assert.deepEqual(barBeatAt(0, 120, [4, 4]), { bar: 0, beat: 1, position: 0 });
  assert.equal(barBeatAt(2, 120, [4, 4]).bar, 1);
  assert.equal(barBeatAt(2.5, 120, [4, 4]).beat, 2);
  assert.equal(barBeatAt(3.999, 120, [4, 4]).beat, 4);
  // Floating error just below a bar line must not land in the previous bar.
  assert.equal(barBeatAt(0.1 + 0.2 + 1.7, 120, [4, 4]).bar, 1);
  assert.deepEqual(barBeatAt(1.5 * 3, 120, [3, 4]), { bar: 3, beat: 1, position: 3 });
});

test('song time plays the intro once and wraps the loop', () => {
  assert.equal(wrapSongTime(1, 4, 12), 1);
  assert.equal(wrapSongTime(4, 4, 12), 4);
  assert.equal(wrapSongTime(15.5, 4, 12), 15.5);
  assert.equal(wrapSongTime(16, 4, 12), 4);
  assert.equal(wrapSongTime(30, 4, 12), 6);
  assert.equal(wrapSongTime(30, 0, 12), 6);
  assert.equal(wrapSongTime(5, 0, 0), 5);
});

test('start plan joins intro and loop on adjacent frames', () => {
  // From the top: the loop waits exactly the intro length, so its first frame follows the intro's last.
  assert.deepEqual(startPlan(0, 192000, 576000), { introOffset: 0, loopDelay: 192000, loopOffset: 0 });
  // Mid intro: the remaining intro frames and the loop delay are the same number.
  const mid = startPlan(150000.4, 192000, 576000);
  assert.equal(mid.introOffset + mid.loopDelay, 192000);
  // Past the intro the intro is skipped and the loop starts at the right frame, wrapping after one pass.
  assert.deepEqual(startPlan(192000, 192000, 576000), { introOffset: null, loopDelay: 0, loopOffset: 0 });
  assert.deepEqual(startPlan(192000 + 576000 + 10, 192000, 576000), { introOffset: null, loopDelay: 0, loopOffset: 10 });
  assert.deepEqual(startPlan(5, 0, 100), { introOffset: null, loopDelay: 0, loopOffset: 5 });
});

test('sections: lengths fill to the next section, lookups and validation', () => {
  const sections = normaliseSections([{ name: 'B', startBar: 4 }, { name: 'A', startBar: 0 }], 8);
  assert.deepEqual(sections, [{ name: 'A', startBar: 0, bars: 4 }, { name: 'B', startBar: 4, bars: 4 }]);
  assert.equal(sectionAt(3.99, sections).name, 'A');
  assert.equal(sectionAt(4, sections).name, 'B');
  assert.equal(sectionAt(8, sections), null);
  assert.throws(() => normaliseSections([{ name: 'X', startBar: 9 }], 8), /outside the song/);
  assert.throws(() => normaliseSections([{ name: 'X', startBar: 0 }]), /needs a length/);
});

test('stingers wait for the next bar line', () => {
  assert.equal(secondsToNextBar(0, 120, [4, 4]), 0);
  assert.equal(secondsToNextBar(0.5, 120, [4, 4]), 1.5);
  assert.equal(secondsToNextBar(2, 120, [4, 4]), 0);
  assert.ok(Math.abs(secondsToNextBar(3.9, 120, [4, 4]) - 0.1) < 1e-9);
});

test('loudness matching turns the louder files down to the quietest', () => {
  assert.deepEqual(matchLoudness([-14, -18.5]), [-4.5, 0]);
  assert.deepEqual(matchLoudness([-20, null, -16]), [0, 0, -4]);
  assert.deepEqual(matchLoudness([null]), [0]);
});

test('manifest to page model: intro, loop frames, layers, stingers and default sections', () => {
  const model = gameModel(manifest, { manifestFile: 'forest.manifest.json' });
  assert.equal(model.kind, 'game');
  assert.deepEqual(model.intro, { src: 'forest-intro.wav', frames: 192000, bars: 2 });
  assert.deepEqual(model.loop, { src: 'forest-loop.wav', frames: 576000, startFrame: 0, endFrame: 576000, bars: 6, startBar: 2 });
  assert.deepEqual(model.layers.map(layer => [layer.name, layer.src, layer.tracks]), [
    ['rhythm', 'forest-layer-rhythm.wav', ['Kick', 'Snare']], ['tonal', 'forest-layer-tonal.wav', ['Bass', 'Keys']]]);
  assert.deepEqual(model.stingers.map(s => [s.name, s.src, s.startBar]), [['hit', 'forest-stinger-hit.wav', 4]]);
  assert.deepEqual(model.sections, [{ name: 'Intro', startBar: 0, bars: 2 }, { name: 'Loop', startBar: 2, bars: 6 }]);
  assert.equal(model.songBars, 8);
  assert.equal(model.warnings, undefined);
  assert.equal(model.feedbackName, 'forest-feedback.json');
  assert.deepEqual(pageAssets(model), ['forest-intro.wav', 'forest-loop.wav', 'forest-layer-rhythm.wav', 'forest-layer-tonal.wav', 'forest-stinger-hit.wav']);
  const custom = gameModel(manifest, { sections: [{ name: 'Calm', startBar: 2 }, { name: 'Build', startBar: 5, bars: 3 }] });
  assert.deepEqual(custom.sections, [{ name: 'Calm', startBar: 2, bars: 3 }, { name: 'Build', startBar: 5, bars: 3 }]);
  assert.throws(() => gameModel(manifest, { sections: [{ name: 'Late', startBar: 8 }] }), /outside the song/);
  assert.throws(() => gameModel({ name: 'x' }), /manifest with a loop/);
  const noIntro = gameModel({ ...manifest, intro: undefined, files: manifest.files.filter(f => f.role !== 'intro').map(f => f.role === 'loop' ? { ...f, bars: 8 } : f) });
  assert.equal(noIntro.intro, null);
  assert.deepEqual(noIntro.sections, [{ name: 'Loop', startBar: 0, bars: 8 }]);
});

test('compare model matches loudness and needs bpm for sections', () => {
  const model = compareModel([{ src: 'a.wav', lufs: -12, frames: 480000 }, { src: 'mixes/b.wav', lufs: -15, frames: 480000 }], { bpm: 120, sections: [{ name: 'All', startBar: 0 }] });
  assert.deepEqual(model.compare.map(f => [f.label, f.src, f.gainDb]), [['A', 'a.wav', -3], ['B', 'mixes/b.wav', 0]]);
  assert.deepEqual(model.sections, [{ name: 'All', startBar: 0, bars: 5 }]);
  assert.throws(() => compareModel([{ src: 'a.wav', lufs: -12, frames: 10 }], { sections: [{ name: 'X', startBar: 0 }] }), /need bpm/);
  assert.throws(() => compareModel([]), /at least one/);
});

test('page is valid HTML with the config embedded, script that parses, and no network references', () => {
  const model = gameModel(manifest, { title: 'Forest </script><b>', spectrogram: '../spec.png' });
  const html = renderPage(model, { pageName: 'forest-audition.html' });
  const errors = [];
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(html, 'text/html');
  assert.deepEqual(errors, []);
  assert.equal(html.match(/<\/script>/g).length, 2, 'the title cannot close the script element');
  assert.match(html, /<title>Forest &lt;\/script&gt;&lt;b&gt;<\/title>/);
  const configText = html.match(/<script type="application\/json" id="audition-config">([^<]*)<\/script>/)[1];
  const config = JSON.parse(configText);
  assert.equal(config.loop.frames, 576000);
  assert.equal(config.intro.frames, 192000);
  assert.equal(config.schema, feedbackSchema);
  assert.equal(config.title, 'Forest </script><b>');
  assert.ok(doc.getElementsByTagName('main').length === 1);
  assert.doesNotMatch(html, /https?:\/\/|\/\/cdn|<link /i, 'no network references');
  // The page script compiles and the shared maths functions are in it.
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(script));
  for (const name of ['barBeatAt', 'wrapSongTime', 'startPlan', 'sectionAt', 'secondsToNextBar', 'auditionPage']) assert.match(script, new RegExp(`function ${name}\\(`));
});

test('the page script runs against a stub DOM and asks for the folder when opened from disk', () => {
  const html = renderPage(gameModel(manifest), { pageName: 'p.html' });
  const configText = html.match(/id="audition-config">([^<]*)<\/script>/)[1];
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const elements = {};
  const element = id => elements[id] ??= {
    id, textContent: id === 'audition-config' ? configText : '', value: id === 'master' ? '0' : '', dataset: {}, style: {}, children: [], className: '',
    classList: { hidden: true, remove() { this.hidden = false; }, add() { this.hidden = true; } },
    appendChild(child) { this.children.push(child); return child; }, append(...kids) { this.children.push(...kids); },
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, width: 100 }),
  };
  const created = [];
  const document = {
    title: '', getElementById: element, addEventListener() {},
    createElement: tag => { const el = element(`new-${created.length}`); el.tag = tag; created.push(el); return el; },
    body: { appendChild() {} },
  };
  vm.runInNewContext(script, { document, location: { protocol: 'file:' }, requestAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, HTMLSelectElement: class {}, console });
  assert.equal(document.title, 'forest');
  assert.equal(elements.picker.classList.hidden, false, 'folder picker shown for file:// pages');
  assert.equal(elements.layerpanel.classList.hidden, false);
  assert.equal(elements.stingerpanel.classList.hidden, false);
  assert.equal(elements.sectionpanel.classList.hidden, false);
  assert.match(elements.subtitle.textContent, /120 bpm/);
});

const feedback = {
  schema: feedbackSchema, version: 1, title: 'forest', source: 'forest.manifest.json', bpm: 120, timeSignature: [4, 4], introBars: 2,
  savedAt: '2026-11-14T10:00:00.000Z', files: ['forest-loop.wav'],
  sections: [{ name: 'Intro', startBar: 0, bars: 2, rating: 4 }, { name: 'Loop', startBar: 2, bars: 6, rating: 2 }],
  notes: [
    { seconds: 9.01, bar: 4, beat: 1, section: 'Loop', text: '  Lead too busy here  ', rating: 2, mode: 'layers',
      layers: { rhythm: { db: 0, muted: true, solo: false }, tonal: { db: -3, muted: false, solo: false } } },
    { seconds: 1.2, bar: 0, beat: 3, section: 'Intro', text: 'Nice opening', rating: null, mode: 'mix' },
    { seconds: 30, bar: 15, beat: 1, section: null, text: 'Odd click?', rating: null },
  ],
};

test('feedback parsing validates the schema and cleans notes', () => {
  const parsed = parseFeedback(JSON.stringify(feedback));
  assert.equal(parsed.notes[0].text, 'Lead too busy here');
  assert.deepEqual(parsed.notes[0].layers.rhythm, { db: 0, muted: true, solo: false });
  assert.deepEqual(parseFeedback('```json\n' + JSON.stringify(feedback) + '\n```').notes.length, 3, 'pasted code fences are accepted');
  assert.throws(() => parseFeedback('{'), /not valid JSON/);
  assert.throws(() => parseFeedback({ ...feedback, schema: 'other' }), /Expected schema/);
  assert.equal(parseFeedback({ ...feedback, version: 2 }).version, 2, 'version 2 feedback is supported');
  assert.throws(() => parseFeedback({ ...feedback, version: 3 }), /Unsupported feedback version/);
  assert.throws(() => parseFeedback({ ...feedback, notes: [{ seconds: -1, text: 'x' }] }), /valid seconds/);
  assert.throws(() => parseFeedback({ ...feedback, notes: [{ seconds: 1, text: '' }] }), /neither text nor rating/);
  assert.equal(parseFeedback({ ...feedback, notes: [{ seconds: 1, text: 'x', rating: 9, bar: -2 }] }).notes[0].rating, null);
});

test('feedback is organised by section and bar with what the listener heard', () => {
  const organised = organiseFeedback(parseFeedback(feedback));
  assert.equal(organised.noteCount, 3);
  assert.deepEqual(organised.weakestSection, { name: 'Loop', rating: 2 });
  assert.equal(organised.averageRating, Number(((4 + 2 + 2) / 3).toFixed(2)));
  const loop = organised.sections.find(section => section.name === 'Loop');
  assert.equal(loop.endBar, 8);
  assert.deepEqual(loop.notes.map(note => [note.bar, note.text, note.heard]), [[4, 'Lead too busy here', 'muted rhythm; tonal -3 dB']]);
  assert.equal(organised.sections[0].notes[0].heard, 'full mix');
  assert.equal(organised.outsideSections[0].text, 'Odd click?');
  assert.deepEqual(organised.byBar['4'], ['Lead too busy here']);
  assert.ok(organised.summary.some(line => /Loop \(bars 2 to 7\): rated 2\/5, 1 note/.test(line)));
  // Notes with no section name fall into the section that holds their bar.
  const bySection = organiseFeedback(parseFeedback({ ...feedback, notes: [{ seconds: 5, bar: 2, beat: 3, text: 'Drums enter late' }] }));
  assert.equal(bySection.sections[1].notes[0].text, 'Drums enter late');
});

test('taste memory adds, deduplicates, forgets and groups preferences', () => {
  let store = emptyTaste();
  let result = addTaste(store, { text: 'Leads too busy', area: 'lead' }, 'now');
  assert.deepEqual(result.entry, { id: 't1', area: 'lead', text: 'Leads too busy', addedAt: 'now' });
  store = result.store;
  result = addTaste(store, { text: '  leads   too busy. ', area: 'lead' });
  assert.equal(result.added, false);
  store = addTaste(store, { text: 'Less reverb on drums', area: 'drums', source: 'forest-feedback.json' }).store;
  store = addTaste(store, { text: 'Keep loops under a minute' }).store;
  assert.deepEqual(store.entries.map(entry => entry.id), ['t1', 't2', 't3']);
  assert.deepEqual(tasteByArea(store, 'drums'), { drums: [{ id: 't2', text: 'Less reverb on drums' }], general: [{ id: 't3', text: 'Keep loops under a minute' }] });
  store = forgetTaste(store, ['t1']);
  assert.equal(addTaste(store, { text: 'New one' }).entry.id, 't4', 'ids are not reused after the highest');
  assert.throws(() => forgetTaste(store, ['t9']), /No taste entry/);
  assert.throws(() => addTaste(store, { text: '   ' }), /needs some text/);
  assert.deepEqual(parseTaste(JSON.stringify(store)), store);
  assert.throws(() => parseTaste('{"version":2,"entries":[]}'), /version 1/);
});

// ---------- regressions from review ----------

test('a manifest cannot name files or pages outside its folder', () => {
  assert.throws(() => gameModel({ ...manifest, name: '../../escaped' }), /not a plain name/);
  assert.throws(() => gameModel({ ...manifest, name: 'a/b' }), /not a plain name/);
  assert.throws(() => gameModel({ ...manifest, loop: { ...manifest.loop, file: '../secret.wav' } }), /not a plain WAV or OGG name/);
  assert.throws(() => gameModel({ ...manifest, intro: { ...manifest.intro, file: 'C:/x.wav' } }), /not a plain WAV or OGG name/);
  assert.throws(() => gameModel({ ...manifest, files: [...manifest.files, { file: '..\\up.wav', role: 'stinger', startBar: 0, bars: 1 }] }), /not a plain WAV or OGG name/);
  assert.throws(() => gameModel({ ...manifest, files: [...manifest.files, { file: 'x.html', role: 'layer', layer: 'x' }] }), /not a plain WAV or OGG name/);
  assert.throws(() => gameModel({ ...manifest, loop: { ...manifest.loop, endFrame: 'many' } }), /loop frames/);
});

test('picked files match by path below the chosen folder, never by a shared base name', () => {
  const needed = ['v1/theme.wav', 'v2/theme.wav'];
  const folder = [{ name: 'theme.wav', path: 'work/v2/theme.wav' }, { name: 'theme.wav', path: 'work/v1/theme.wav' }];
  assert.deepEqual(matchPicked(needed, folder), { files: { 'v1/theme.wav': 1, 'v2/theme.wav': 0 }, missing: [], ambiguous: [] });
  // Loose files with the same name cannot be told apart.
  const loose = [{ name: 'theme.wav', path: '' }, { name: 'theme.wav', path: '' }];
  assert.deepEqual(matchPicked(needed, loose).ambiguous, needed);
  // Loose files with distinct names still work, and a missing one is reported.
  assert.deepEqual(matchPicked(['a.wav', 'b.wav'], [{ name: 'B.WAV', path: '' }]), { files: { 'b.wav': 0 }, missing: ['a.wav'], ambiguous: [] });
  // A folder holding only v1 does not stand in for v2.
  assert.deepEqual(matchPicked(needed, [folder[1]]).missing, ['v2/theme.wav']);
});

test('quantised stingers land on the bar line, on a whole frame', () => {
  const rate = 48000;
  // Song at 0.5 s into a 2 s bar, context clock at 10 s: the bar line is at 11.5 s.
  assert.equal(stingerTime(10, 0.5, 120, [4, 4], rate, true), 11.5);
  // Right on a bar line (or within 10 ms) waits a full bar instead of starting late.
  assert.equal(stingerTime(10, 2, 120, [4, 4], rate, true), 12);
  assert.ok(Math.abs(stingerTime(10, 1.995, 120, [4, 4], rate, true) - 12.005) < 1 / rate);
  // Unquantised: 20 ms from now, rounded to a frame.
  const loose = stingerTime(10.0000101, 3, 120, [4, 4], rate, false);
  assert.ok(Math.abs(loose * rate - Math.round(loose * rate)) < 1e-6);
  assert.ok(Math.abs(loose - 10.02) < 1 / rate);
  // Every result is a whole frame.
  for (const song of [0.123, 1.777, 3.3333]) { const at = stingerTime(5.0001, song, 97, [3, 4], rate, true); assert.ok(Math.abs(at * rate - Math.round(at * rate)) < 1e-6); }
});

test('a damaged taste file names itself, says how to recover, and salvage keeps the valid entries', () => {
  assert.throws(() => parseTaste('{oops'), /\.lmms-taste\.json is not valid JSON.*repair: true/);
  assert.throws(() => parseTaste('{"version":1,"entries":[{"id":"t1","area":"lead","text":5}]}'), /\.lmms-taste\.json entry 1 needs text.*repair: true/);
  assert.throws(() => parseTaste('{"version":1,"entries":[{"id":"t1","area":"moon","text":"x"}]}'), /unknown area/);
  assert.throws(() => parseTaste(JSON.stringify({ version: 1, entries: [{ id: 't1', area: 'lead', text: 'a' }, { id: 't1', area: 'lead', text: 'b' }] })), /repeats id t1/);
  assert.throws(() => parseTaste(JSON.stringify({ version: 1, entries: Array.from({ length: maxTasteEntries + 1 }, (_, i) => ({ id: `t${i + 1}`, area: 'mix', text: 'x' })) })), /more than 500/);
  const salvaged = salvageTaste(JSON.stringify({ version: 1, entries: [{ id: 't1', area: 'lead', text: 'keep' }, { id: 't2', area: 'lead', text: 7 }, null, { id: 't1', area: 'mix', text: 'dupe' }] }));
  assert.deepEqual(salvaged, { store: { version: 1, entries: [{ id: 't1', area: 'lead', text: 'keep' }] }, dropped: 3 });
  assert.equal(salvageTaste('not json').store.entries.length, 0);
  let store = emptyTaste();
  for (let i = 0; i < maxTasteEntries; i++) store = addTaste(store, { text: `p${i}` }).store;
  assert.throws(() => addTaste(store, { text: 'one more' }), /already holds 500/);
});

test('read_feedback output is capped and says how many notes it left out', () => {
  const many = { ...feedback, notes: Array.from({ length: maxFeedbackNotes + 25 }, (_, i) => ({ seconds: i, bar: Math.floor(i / 2), beat: 1, text: `n${i}` })) };
  const organised = organiseFeedback(parseFeedback(many));
  assert.equal(organised.noteCount, maxFeedbackNotes + 25);
  assert.equal(organised.omittedNotes, 25);
  const shown = organised.sections.reduce((sum, section) => sum + section.notes.length, organised.outsideSections.length);
  assert.equal(shown, maxFeedbackNotes);
  assert.throws(() => parseFeedback({ ...feedback, notes: Array.from({ length: maxFeedbackNotes * 10 + 1 }, () => ({ seconds: 1, text: 'x' })) }), /at most/);
});

// ---------- the tool handlers, against a temporary workspace ----------
async function workspaceTools() {
  const root = await mkdtemp(path.join(tmpdir(), 'lmms-audition-unit-'));
  const handlers = {}, shapes = {}, moduleGuidance = [];
  register({ tool: (name, description, schema, handler) => { handlers[name] = handler; shapes[name] = z.object(schema); },
    z, dsp, root, schemas: { folderName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i) }, moduleGuidance });
  const call = async (name, args = {}) => handlers[name](shapes[name].parse(args));
  return { root, call, moduleGuidance, done: () => rm(root, { recursive: true, force: true }) };
}
const wav = (seconds, level) => dsp.encodeWav({ sampleRate: 48000, channels: [0, 1].map(() => Float32Array.from({ length: Math.round(seconds * 48000) }, (_, i) => level * Math.sin(i / 20))) });

test('handlers: a manifest that points outside the workspace writes nothing outside it', async () => {
  const w = await workspaceTools();
  try {
    assert.equal(w.moduleGuidance.length, 2);
    await mkdir(path.join(w.root, 'game'));
    for (const file of ['forest-loop.wav', 'forest-intro.wav']) await writeFile(path.join(w.root, 'game', file), wav(0.1, 0.1));
    const small = { ...manifest, loop: { ...manifest.loop, endFrame: 4800 }, files: manifest.files.filter(f => f.role === 'loop' || f.role === 'intro') };
    const escaped = 'escaped-' + path.basename(w.root).replace(/[^a-z0-9]/gi, '');
    const outside = [path.join(w.root, '..', escaped + '-audition.html'), path.join(w.root, '..', '..', escaped + '-audition.html')];
    await writeFile(path.join(w.root, 'game', 'forest.manifest.json'), JSON.stringify({ ...small, name: '../../' + escaped }));
    await assert.rejects(w.call('build_audition_page', { folder: 'game' }), /not a plain name/);
    await writeFile(path.join(w.root, 'game', 'forest.manifest.json'), JSON.stringify({ ...small, loop: { ...small.loop, file: '../../outside.wav' } }));
    await assert.rejects(w.call('build_audition_page', { folder: 'game' }), /not a plain WAV or OGG name/);
    assert.ok(outside.every(file => !existsSync(file)), 'nothing written above the workspace');
    // The honest manifest builds a page inside the folder.
    await writeFile(path.join(w.root, 'game', 'forest.manifest.json'), JSON.stringify(small));
    const page = await w.call('build_audition_page', { folder: 'game' });
    assert.equal(page.page, 'game/forest-audition.html');
    assert.ok(existsSync(path.join(w.root, 'game', 'forest-audition.html')));
    await assert.rejects(w.call('build_audition_page', { files: ['../x.wav'] }));
    await assert.rejects(w.call('build_audition_page', { folder: 'game', spectrogram: '../x.png' }));
    // A/B with two files of the same name in different folders keeps both paths.
    await mkdir(path.join(w.root, 'v1')); await mkdir(path.join(w.root, 'v2'));
    await writeFile(path.join(w.root, 'v1', 'theme.wav'), wav(0.5, 0.1));
    await writeFile(path.join(w.root, 'v2', 'theme.wav'), wav(0.75, 0.4));
    const ab = await w.call('build_audition_page', { files: ['v1/theme.wav', 'v2/theme.wav'] });
    assert.deepEqual(ab.compare.map(file => file.src), ['v1/theme.wav', 'v2/theme.wav']);
    assert.ok(ab.compare[1].gainDb < -10 && ab.compare[0].gainDb === 0);
    assert.equal((await w.call('read_feedback', { text: JSON.stringify(feedback) })).noteCount, 3);
    await assert.rejects(w.call('read_feedback', { file: '../feedback.json' }));
  } finally { await w.done(); }
});

test('handlers: parallel remember_taste calls keep every entry with distinct ids', async () => {
  const w = await workspaceTools();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => w.call('remember_taste', { text: `preference ${i}`, area: 'mix' })));
    assert.deepEqual(results.map(result => result.entry.id).sort(), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    assert.equal((await w.call('get_taste')).count, 8);
    assert.deepEqual(await readdir(w.root), ['.lmms-taste.json'], 'no temporary or lock files left behind');
  } finally { await w.done(); }
});

test('handlers: a damaged taste file reports itself and repair recovers the valid entries', async () => {
  const w = await workspaceTools();
  try {
    const file = path.join(w.root, '.lmms-taste.json');
    await writeFile(file, JSON.stringify({ version: 1, entries: [{ id: 't1', area: 'lead', text: 'keep me' }, { id: 't2', area: 'lead', text: 42 }] }));
    await assert.rejects(w.call('get_taste'), /\.lmms-taste\.json entry 2 needs text.*repair: true/);
    await assert.rejects(w.call('remember_taste', { text: 'new' }), /repair: true/);
    const repaired = await w.call('remember_taste', { repair: true, text: 'new one', area: 'drums' });
    assert.equal(repaired.repaired.kept, 1);
    assert.equal(repaired.repaired.dropped, 1);
    assert.ok(existsSync(path.join(w.root, repaired.repaired.backup)), 'the damaged file is kept as a backup');
    assert.equal(repaired.entry.id, 't2');
    assert.deepEqual((await w.call('get_taste')).preferences, { lead: [{ id: 't1', text: 'keep me' }], drums: [{ id: 't2', text: 'new one' }] });
    await writeFile(file, '{not json');
    await assert.rejects(w.call('get_taste'), /\.lmms-taste\.json is not valid JSON/);
    assert.equal((await w.call('remember_taste', { repair: true })).repaired.dropped, 'all: the file was not valid JSON');
    assert.equal((await w.call('get_taste')).count, 0);
  } finally { await w.done(); }
});
