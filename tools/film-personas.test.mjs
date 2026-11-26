import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { encodeWav } from '../audio.mjs';
import { deniedArtistReferences, getPersona, listPersonas, loadPersonas } from './personas.mjs';
import { buildCue, cuePersonas, cueProject } from '../scripts/personas/persona-cues.mjs';
import { chroma, clusterPairs, measureWav, onsets, periodicity, rmsSeries, silentRuns } from '../scripts/personas/persona-measure.mjs';
import { lmmsAvailable, runDemo } from '../scripts/personas/persona-demo.mjs';

const ids = ['action-score', 'dark-synth-scifi', 'epic-fantasy', 'horror-suspense'];
const personas = Object.fromEntries(ids.map(id => [id, getPersona(id)]));
const licences = JSON.parse(readFileSync(new URL('../licences.json', import.meta.url), 'utf8'));

test('the four film personas validate and list with the tempo ranges and defaults the brief asks for', () => {
  const expected = { 'action-score': [90, 140, 132], 'horror-suspense': [40, 80, 60], 'epic-fantasy': [80, 130, 108], 'dark-synth-scifi': [70, 110, 92] };
  for (const [id, [min, max, tempo]] of Object.entries(expected)) {
    const { tempo: actual, kind, testRender } = personas[id];
    assert.deepEqual([actual.min, actual.max, actual.default], [min, max, tempo], id);
    assert.equal(kind, 'film');
    assert.ok(testRender.seconds >= 30 && testRender.seconds <= 60, `${id} demo length`);
  }
  assert.deepEqual(loadPersonas().filter(persona => persona.kind === 'film').map(persona => persona.id).sort(), ids);
  assert.deepEqual(listPersonas({ kind: 'film' }).map(persona => persona.id).sort(), ids);
  assert.deepEqual(listPersonas({ kind: 'film', minBpm: 135, maxBpm: 140 }).map(persona => persona.id), ['action-score']);
  assert.deepEqual(listPersonas({ kind: 'film', tags: ['horror'] }).map(persona => persona.id), ['horror-suspense']);
});

test('persona text names no artist, composer, film or label', () => {
  const text = ids.map(id => readFileSync(new URL(`../personas/${id}.json`, import.meta.url), 'utf8')).join('\n').toLowerCase();
  for (const value of deniedArtistReferences) {
    assert.ok(!text.includes(value.toLowerCase()), 'artist name found in persona data');
  }
  // Library names are allowed only as ids; credits live in licences.json.
  assert.ok(!/versilian|gossner/.test(text));
});

test('modes, instruments and signature features match each archetype', () => {
  const action = personas['action-score'], horror = personas['horror-suspense'], fantasy = personas['epic-fantasy'], scifi = personas['dark-synth-scifi'];
  assert.ok(action.harmony.modes.includes('phrygian') && action.harmony.scales.includes('natural minor'));
  assert.deepEqual(fantasy.harmony.modes, ['dorian', 'mixolydian']);
  assert.ok(horror.harmony.modes.includes('phrygian') && horror.harmony.modes.includes('locrian'));
  assert.ok(scifi.harmony.scales.includes('phrygian') && scifi.harmony.scales.includes('harmonic minor'));
  // Action: all four articulations are reachable across its keyswitch maps.
  const switches = new Set(action.articulations.flatMap(item => Object.keys(item.keyswitches)));
  for (const name of ['sustain', 'staccato', 'marcato', 'spiccato']) assert.ok(switches.has(name), name);
  // Orchestral personas wire an open sample library by id; the synth persona leans on Atelier engines.
  for (const persona of [action, horror, fantasy]) {
    assert.ok(persona.signatureSounds.some(sound => sound.engine === 'sfz'), persona.id);
    for (const item of persona.articulations) {
      assert.ok(licences[item.library], `${persona.id} names ${item.library}, which licences.json does not record`);
      for (const note of Object.values(item.keyswitches)) assert.ok(Number.isInteger(note) && note >= 0 && note <= 127);
    }
  }
  assert.equal(scifi.articulations, undefined);
  assert.ok(scifi.signatureSounds.filter(sound => sound.engine === 'atelier').length >= 3);
  assert.ok(scifi.signatureSounds.every(sound => sound.engine !== 'sfz'));
  assert.ok(fantasy.articulations.some(item => 'staccato' in item.keyswitches && 'sustain-vibrato' in item.keyswitches));
  for (const persona of Object.values(personas)) assert.ok(persona.neverDo.length >= 4, persona.id);
});

test('library licences are recorded, permissive, not bundled, and hashed', () => {
  const entry = licences['vsco-2-ce'];
  assert.equal(entry.licence, 'CC0-1.0');
  assert.equal(entry.bundled, false);
  assert.match(entry.source, /^https:\/\//);
  assert.ok(entry.author && entry.credit && entry.ref);
  assert.match(entry.licenceSha256, /^[0-9a-f]{64}$/);
  for (const hash of Object.values(entry.files)) assert.match(hash, /^[0-9a-f]{64}$/);
  const used = new Set(ids.flatMap(id => buildCue(id).parts.filter(part => part.sampled).map(part => part.sampled.sfz.split('/').pop())));
  for (const file of used) assert.ok(entry.files[file], `${file} is used by a cue but has no recorded hash`);
  for (const sfz of ids.flatMap(id => buildCue(id).parts.filter(part => part.sampled).map(part => part.sampled.sfz))) assert.ok(sfz.startsWith('VSCO-2-CE/'));
});

test('reference cues are seed-stable, in range and fit LMMS project limits', () => {
  assert.deepEqual(cuePersonas.sort(), ids);
  for (const id of ids) {
    const cue = buildCue(id), again = buildCue(id);
    assert.deepEqual(again, cue, `${id} is not stable`);
    assert.equal(cue.bpm, personas[id].tempo.default);
    assert.ok(cue.seconds >= 30 && cue.seconds <= 60, `${id}: ${cue.seconds} s`);
    const project = cueProject(cue);
    assert.equal(new Set(project.tracks.map(track => track.name)).size, project.tracks.length);
    assert.ok(project.tracks.length <= 48 && project.lengthBars <= 64);
    for (const track of project.tracks) {
      const [pattern] = track.patterns;
      assert.ok(pattern.notes.length >= 1 && pattern.notes.length <= 4096, `${id}/${track.name}`);
      for (const note of pattern.notes) {
        assert.ok(Number.isInteger(note.tick) && note.tick >= 0 && Number.isInteger(note.length) && note.length >= 1);
        assert.ok(note.midi >= 12 && note.midi <= 119 && note.velocity >= 1 && note.velocity <= 127);
        assert.ok(note.tick < cue.bars * 192, `${id}/${track.name} starts after the end`);
      }
    }
    const sampled = cue.parts.filter(part => part.sampled);
    assert.ok(sampled.length <= 8, 'sampled parts stay within eight tracks');
    assert.equal(sampled.length > 0, id !== 'dark-synth-scifi');
    for (const part of project.edits) assert.ok(project.tracks.some(track => track.name === part.args.trackName));
  }
  // The seed changes the material but not the form.
  const horror = buildCue('horror-suspense'), other = buildCue('horror-suspense', { seed: 99 });
  assert.notDeepEqual(horror.parts, other.parts);
  assert.deepEqual(horror.sections, other.sections);
  assert.throws(() => buildCue('action-score', { bpm: 200 }), /bpm must be between/);
  assert.throws(() => buildCue('action-score', { seconds: 20 }), /30 to 60/);
  assert.throws(() => buildCue('action-score', { seconds: 30, bpm: 100 }), /at least 24 bars/);
});

test('sampled notes sit inside the written range of their library file', () => {
  const ranges = { 'CelloEnsSpic.sfz': [36, 77], 'ViolinEnsSusVib.sfz': [55, 86], 'TrumpetStac.sfz': [52, 84], 'FluteStac.sfz': [65, 96], 'Timpani.sfz': [36, 60], 'SViolinTrem.sfz': [55, 96] };
  for (const id of ids) {
    for (const part of buildCue(id).parts.filter(item => item.sampled)) {
      const range = ranges[part.sampled.sfz.split('/').pop()];
      if (range) for (const note of part.notes) assert.ok(note.midi >= range[0] && note.midi <= range[1], `${part.id} ${note.midi}`);
    }
  }
});

const part = (cue, id) => cue.parts.find(item => item.id === id);
const beatsOf = notes => notes.map(note => note.tick / 48);

test('action cue: ostinato in short and long cells, brass punches, articulation switch, cutoff ending', () => {
  const cue = buildCue('action-score'), ostinato = part(cue, 'low-strings-ostinato');
  const bar5 = ostinato.notes.filter(note => note.tick >= 5 * 192 && note.tick < 6 * 192);
  assert.equal(bar5.length, 12, 'three notes on each of four beats');
  assert.deepEqual(bar5.slice(0, 3).map(note => note.length), [9, 9, 20], 'short, short, long');
  assert.ok(bar5[0].velocity > bar5[1].velocity, 'the first note of a beat is accented');
  const phrases = new Set(ostinato.notes.map(note => note.midi));
  assert.ok(phrases.size >= 3, 'the ostinato moves with the chords and leans on the flat second');
  assert.ok(part(cue, 'trumpet-punches').notes.every(note => note.tick >= 12 * 192), 'brass waits for the hit section');
  assert.ok(Math.max(...part(cue, 'trumpet-punches').notes.map(note => note.velocity)) >= 118, 'marcato accents');
  assert.ok(part(cue, 'trumpet-punches').notes.every(note => note.length <= 36), 'punches are short');
  // Sustain in the build, spiccato in the hit section: that is the contrast.
  const sustain = part(cue, 'violins-sustain'), spiccato = part(cue, 'violins-spiccato');
  assert.ok(sustain.notes.filter(note => note.tick < 28 * 192).every(note => note.length >= 180) && spiccato.notes.every(note => note.length <= 12));
  assert.ok(sustain.notes.some(note => note.tick < 12 * 192) && spiccato.notes.every(note => note.tick >= 12 * 192));
  assert.deepEqual(cue.parts.filter(item => item.sampled).map(item => item.sampled.articulation).sort(), ['marcato', 'spiccato', 'spiccato', 'spiccato', 'staccato', 'sustain', 'sustain']);
  const strip = cue.sections.find(item => item.name === 'strip'), last = cue.sections.at(-1);
  assert.equal(strip.bars, 1);
  assert.ok(!ostinato.notes.some(note => note.tick >= strip.bar * 192 && note.tick < (strip.bar + 1) * 192), 'the strip bar drops the ostinato');
  assert.equal(last.name, 'cutoff');
  const tail = cue.parts.flatMap(item => item.notes).filter(note => note.tick >= last.bar * 192);
  assert.ok(tail.every(note => note.tick === last.bar * 192), 'one hit, then nothing');
});

test('horror cue: clusters, withheld silence, accelerating heartbeat, riser that never lands', () => {
  const cue = buildCue('horror-suspense'), withheld = cue.sections.find(item => item.name === 'withheld');
  const from = withheld.bar * 192, to = (withheld.bar + withheld.bars) * 192;
  const notes = cue.parts.flatMap(item => item.notes.map(note => ({ ...note, part: item.id })));
  assert.equal(notes.filter(note => note.tick >= from && note.tick < to).length, 0, 'nothing starts in the withheld bars');
  assert.ok(notes.every(note => note.tick + note.length <= from + 6 || note.tick >= to), 'nothing rings into them');
  assert.ok(notes.filter(note => note.tick < 192 * 2).every(note => note.part === 'contrabass-drone'), 'the opening is one low note');
  const cluster = part(cue, 'viola-cluster-tremolo').notes.filter(note => note.tick === 3 * 192).map(note => note.midi % 12);
  const semitones = cluster.sort((a, b) => a - b).map((value, index, list) => value - (list[index - 1] ?? value));
  assert.ok(semitones.includes(1), 'a minor second in the cluster');
  const heart = part(cue, 'heartbeat').notes.filter(note => note.velocity > 55 || note.length === 24);
  const gaps = heart.slice(1).map((note, index) => note.tick - heart[index].tick).filter(gap => gap > 20);
  assert.ok(gaps[0] > gaps.at(-1) * 1.5, 'the heart-beat speeds up');
  const riser = part(cue, 'violin-riser').notes;
  assert.ok(riser.every((note, index) => index === 0 || note.midi === riser[index - 1].midi + 1), 'a chromatic climb');
  assert.ok(riser.at(-1).velocity > riser[0].velocity * 2, 'it swells');
  assert.ok(Math.max(...riser.map(note => note.tick + note.length)) <= from + 1, 'and is cut, not resolved');
});

test('fantasy cue: modal colour and legato against staccato', () => {
  const cue = buildCue('epic-fantasy'), horn = part(cue, 'horn-call-legato'), flute = part(cue, 'flute-staccato');
  const call = horn.notes.filter(note => note.tick < 4 * 192), lift = horn.notes.filter(note => note.tick >= 16 * 192 && note.tick < 20 * 192);
  assert.equal(call.length, 10);
  assert.ok(call[0].length >= 96 && call[3].length >= 144, 'held, legato notes');
  const pcs = notes => new Set(notes.map(note => note.midi % 12));
  assert.ok(pcs(call).has(5) && !pcs(call).has(6), 'dorian: F natural, no F sharp');
  assert.ok(pcs(lift).has(6) && !pcs(lift).has(5), 'mixolydian lift: F sharp, no F natural');
  assert.ok(flute.notes.every(note => note.length <= 12 && note.tick >= 8 * 192 && note.tick < 12 * 192), 'staccato figures only in the answer');
  assert.ok(!horn.notes.some(note => note.tick >= 8 * 192 && note.tick < 12 * 192), 'the horn rests while the staccato answer plays');
  assert.ok(part(cue, 'harp-figure').notes.length >= 8 * 20, 'a harp figure under almost every bar');
  assert.deepEqual(cue.parts.filter(item => item.sampled).map(item => item.sampled.articulation).filter(name => name === 'staccato' || name === 'spiccato').length > 2, true);
  const end = cue.sections.at(-1);
  assert.equal(end.name, 'open-fifth');
  const finalPitches = [...new Set(cue.parts.flatMap(item => item.notes).filter(note => note.tick >= end.bar * 192 && note.length > 300).map(note => (note.midi - 50) % 12))].sort((a, b) => a - b);
  assert.deepEqual(finalPitches, [0, 7], 'an open fifth, nothing else');
});

test('sci-fi cue: drone, arpeggio, filter movement, pulse bass entering and leaving', () => {
  const cue = buildCue('dark-synth-scifi'), drone = part(cue, 'analog-drone'), arp = part(cue, 'sequenced-arp'), bass = part(cue, 'pulse-bass');
  assert.ok(drone.notes.every(note => note.tick === 0 && note.length >= (cue.bars - 1) * 192), 'the drone runs for the whole cue');
  const bar10 = arp.notes.filter(note => note.tick >= 10 * 192 && note.tick < 11 * 192);
  assert.equal(bar10.length, 16, 'sixteen sixteenths a bar');
  assert.ok(new Set(arp.notes.map(note => note.length)).size >= 3, 'gate changes by section');
  assert.ok(bass.notes[0].tick >= 7 * 192 && bass.notes.at(-1).tick < 14 * 192, 'the bass enters late and leaves before the end');
  const cutoffs = cue.automation.filter(item => item.control === 'cutoff');
  assert.equal(cutoffs.length, 3);
  for (const { points } of cutoffs) {
    assert.ok(points.every(([tick], index) => index === 0 ? tick === 0 : tick > points[index - 1][0]));
    const values = points.map(([, value]) => value);
    assert.ok(Math.max(...values) / Math.min(...values) >= 4, 'the filter opens at least two octaves');
    assert.ok(values.indexOf(Math.max(...values)) > 0 && values.indexOf(Math.max(...values)) < values.length - 1, 'and closes again');
  }
  const project = cueProject(cue);
  assert.equal(project.edits.length, 3);
  assert.ok(project.edits.every(edit => edit.op === 'automate_track' && edit.args.length === cue.bars * 192));
});

// ---- measurement helpers, on synthetic audio ----
const sampleRate = 48000;
function tone(seconds, parts) { // parts: [startSeconds, endSeconds, hz, amplitude]
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (const [from, to, hz, amp] of parts) {
    for (let i = Math.floor(from * sampleRate); i < Math.min(data.length, Math.floor(to * sampleRate)); i++) data[i] += amp * Math.sin(2 * Math.PI * hz * i / sampleRate);
  }
  return { sampleRate, channels: [data, data], frames: data.length };
}

test('silences, onsets and periodicity are found in synthetic audio', () => {
  const audio = tone(10, [[0, 2, 220, 0.5], [6, 10, 220, 0.5]]);
  assert.deepEqual(silentRuns(rmsSeries(audio), { thresholdDb: -60, minSeconds: 1 }), [{ startSeconds: 2, seconds: 4 }]);
  const beats = tone(8.5, Array.from({ length: 16 }, (_, i) => [0.25 + i * 0.5, 0.31 + i * 0.5, 330, 0.6]));
  assert.equal(onsets(beats).length, 16);
  assert.ok(periodicity(beats, 0, 8, 0.5) > 0.7);
  assert.ok(periodicity(beats, 0, 8, 0.5) > periodicity(beats, 0, 8, 0.37) + 0.3);
});

test('a semitone cluster scores higher than a fifth on the pitch-class measure', () => {
  const cluster = tone(8, [[0, 8, 185, 0.15], [0, 8, 196, 0.15], [0, 8, 207.65, 0.15], [0, 8, 220, 0.15]]);
  const fifth = tone(8, [[0, 8, 220, 0.3], [0, 8, 330, 0.3]]);
  assert.ok(clusterPairs(chroma(cluster, 0, 8)) >= 3);
  assert.ok(clusterPairs(chroma(fifth, 0, 8)) <= 1);
});

test('measureWav reports levels, sections and signature checks for a rendered file', () => {
  const cue = buildCue('dark-synth-scifi');
  const seconds = cue.bars * 240 / cue.bpm;
  const audio = tone(seconds, [[0, seconds, 110, 0.3], [seconds / 3, seconds, 440, 0.1]]);
  const report = measureWav(encodeWav(audio), cue);
  assert.equal(report.sections.length, cue.sections.length);
  assert.ok(Number.isFinite(report.integratedLufs) && Number.isFinite(report.truePeakDbfs));
  assert.deepEqual(report.checks.map(check => typeof check.pass), ['boolean', 'boolean', 'boolean', 'boolean']);
  assert.equal(report.clippedSamples, 0);
});

// ---- live renders: skipped cleanly when LMMS is missing ----
const lmmsReady = lmmsAvailable();
const skipNative = lmmsReady ? false : 'LMMS is not installed (set LMMS_EXECUTABLE)';

test('a native demo renders and passes the sci-fi signature checks', { skip: skipNative, timeout: 180000 }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-persona-demo-'));
  try {
    const result = await runDemo('dark-synth-scifi', { workspace, mode: 'native' });
    assert.equal(result.routes.length, 1);
    const { measured } = result.routes[0];
    assert.ok(measured.durationSeconds >= 30 && measured.durationSeconds <= 60);
    assert.ok(measured.integratedLufs < -10 && measured.integratedLufs > -20);
    assert.ok(measured.truePeakDbfs < 0 && measured.clippedSamples === 0);
    for (const check of measured.checks) assert.ok(check.pass, `${check.name}: ${check.detail}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the demo reports a clean skip when its requirements are missing', async () => {
  const result = await runDemo('action-score', { workspace: path.join(tmpdir(), 'lmms-persona-skip'), mode: 'native', env: { LMMS_EXECUTABLE: path.join(tmpdir(), 'no-such-lmms.exe') } });
  assert.deepEqual(result.routes, []);
  assert.match(result.skipped[0].reason, /LMMS was not found/);
});
