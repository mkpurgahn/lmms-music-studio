// MIDI import: turn a standard MIDI file into an editable LMMS project, and master a finished WAV.
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import midiPackage from '@tonejs/midi';
import {
  assertProjectProvenance,
  assertRealpathContained,
  verifyAudioFileProvenance,
  writeDerivedAudioProvenance,
} from './provenance.mjs';

const LMMS_TPQ = 48;
const MAX_NOTES = 100000;

// The value a controller holds at a tick: the last event at or before it, or the fallback.
export function controllerAt(events, tick, fallback) {
  let value = fallback;
  for (const event of events) {
    if (event.ticks > tick) break;
    value = event.value;
  }
  return value;
}

// Sustain pedal spans [down, up) in source ticks. CC64 at 0.5 or more is down.
export function pedalSpans(events, endTick) {
  const spans = [];
  let down = null;
  for (const event of [...events].sort((a, b) => a.ticks - b.ticks)) {
    if (event.value >= 0.5 && down === null) down = event.ticks;
    else if (event.value < 0.5 && down !== null) {
      if (event.ticks > down) spans.push([down, event.ticks]);
      down = null;
    }
  }
  if (down !== null && endTick > down) spans.push([down, endTick]);
  return spans;
}

// Hold each note while the pedal is down at its release, but stop at the next strike of the same pitch.
export function bakePedal(notes, spans) {
  if (!spans.length) return notes;
  const byPitch = new Map();
  for (const note of notes) {
    if (!byPitch.has(note.midi)) byPitch.set(note.midi, []);
    byPitch.get(note.midi).push(note.start);
  }
  for (const list of byPitch.values()) list.sort((a, b) => a - b);
  return notes.map(note => {
    const span = spans.find(([down, up]) => note.end >= down && note.end < up);
    if (!span) return note;
    const next = byPitch.get(note.midi).find(start => start > note.start);
    return { ...note, end: Math.max(note.end, next === undefined ? span[1] : Math.min(span[1], next)) };
  });
}

// Lay bars out in a new order, for example to unfold a repeat the MIDI file plays only once.
// Bars are numbered from 1 and ranges are inclusive. A note belongs to the bar it starts in.
export function applyForm(notes, form, barTicks) {
  const out = [];
  let offset = 0;
  for (const { from, to } of form) {
    if (to < from) throw new Error(`Form range ${from}-${to} runs backwards`);
    const start = (from - 1) * barTicks, end = to * barTicks;
    for (const note of notes) {
      if (note.start >= start && note.start < end) out.push({ ...note, start: note.start - start + offset, end: note.end - start + offset });
    }
    offset += end - start;
  }
  return out;
}

const cleanName = (name, index) => (String(name ?? '').replace(/[^\w -]+/g, '').trim().slice(0, 60)) || `Track ${index + 1}`;

// Convert a parsed MIDI file (from @tonejs/midi) into tracks of LMMS notes at 48 ticks per beat.
// Velocities use the LMMS scale, where 100 is MIDI velocity 127.
export function midiToTracks(midi, {
  bpm, timing = 'score', form, tracks: select, merge, pedal = 'bake', volumeChanges = 'fold', transpose = 0,
} = {}) {
  const ppq = midi.header.ppq;
  if (!(ppq > 0)) throw new Error('The MIDI file has no ticks-per-beat timing');
  const signatures = midi.header.timeSignatures ?? [];
  const meter = signatures[0]?.timeSignature ?? [4, 4];
  if (!Number.isInteger(meter[0]) || meter[0] < 1 || ![1, 2, 4, 8, 16, 32].includes(meter[1])) throw new Error('Unsupported time signature ' + meter.join('/'));
  const meterChanges = signatures.filter(s => s.ticks > 0 && (s.timeSignature[0] !== meter[0] || s.timeSignature[1] !== meter[1]));
  const tempos = midi.header.tempos ?? [];
  const sourceBpm = tempos[0]?.bpm ?? 120;
  const outBpm = Math.round(bpm ?? sourceBpm);
  if (outBpm < 10 || outBpm > 999) throw new Error('Tempo must be 10 to 999 BPM');
  if (form?.length && timing === 'seconds') throw new Error('form needs timing "score"');
  if (form?.length && meterChanges.length) throw new Error('form needs a single time signature; this file changes metre');
  const warnings = [];
  if (meterChanges.length) warnings.push(`The time signature changes ${meterChanges.length} times; the project uses ${meter.join('/')} throughout.`);
  if (tempos.length > 1 && timing === 'score') warnings.push(`The file has ${tempos.length} tempo events; timing "score" plays it at a steady ${outBpm} BPM. Use timing "seconds" to keep the recorded tempo changes.`);

  const sourceTracks = midi.tracks.map((track, index) => ({ track, index })).filter(({ track }) => track.notes.length);
  if (!sourceTracks.length) throw new Error('The MIDI file has no notes');
  let chosen = sourceTracks;
  if (select?.length) {
    chosen = select.map(key => {
      const found = typeof key === 'number' ? sourceTracks.find(({ index }) => index === key)
        : sourceTracks.find(({ track, index }) => cleanName(track.name, index).toLowerCase() === String(key).toLowerCase() || track.name === key);
      if (!found) throw new Error(`No MIDI track with notes matches ${JSON.stringify(key)}. Tracks: ${sourceTracks.map(({ track, index }) => `${index} ${JSON.stringify(cleanName(track.name, index))}`).join(', ')}`);
      return found;
    });
  }
  const barTicks = ppq * 4 * meter[0] / meter[1];
  const endTick = Math.max(...midi.tracks.flatMap(track => track.notes.map(n => n.ticks + n.durationTicks)), 0);
  const report = { ppq, sourceBpm: Number(sourceBpm.toFixed(3)), tempoEvents: tempos.length, sourceMeter: meter, pedalNotesExtended: 0, volumeFolded: false, droppedNotes: 0 };
  const toTick = timing === 'seconds' ? seconds => seconds * outBpm / 60 * LMMS_TPQ : ticks => ticks * LMMS_TPQ / ppq;

  const converted = chosen.map(({ track, index }) => {
    let notes = track.notes.map(n => ({ start: n.ticks, end: n.ticks + n.durationTicks, time: n.time, seconds: n.duration, midi: n.midi + transpose, velocity: n.velocity }));
    if (volumeChanges === 'fold') {
      for (const cc of [7, 11]) {
        const events = [...(track.controlChanges?.[cc] ?? [])].sort((a, b) => a.ticks - b.ticks);
        if (!events.length) continue;
        const loudest = Math.max(...events.map(e => e.value));
        if (loudest <= 0) continue;
        report.volumeFolded = true;
        notes = notes.map(n => ({ ...n, velocity: n.velocity * controllerAt(events, n.start, loudest) / loudest }));
      }
    }
    if (pedal === 'bake') {
      const spans = pedalSpans(track.controlChanges?.[64] ?? [], endTick);
      const before = notes.map(n => n.end);
      notes = bakePedal(notes, spans);
      report.pedalNotesExtended += notes.filter((n, i) => n.end > before[i]).length;
      // Keep seconds in step for timing "seconds": stretch each note's duration in proportion.
      notes = notes.map((n, i) => n.end === before[i] ? n : { ...n, seconds: n.seconds * (n.end - n.start) / Math.max(1, before[i] - n.start) });
    }
    if (form?.length) notes = applyForm(notes, form, barTicks);
    const lmmsNotes = [];
    for (const n of notes) {
      const tick = Math.max(0, Math.round(timing === 'seconds' ? toTick(n.time) : toTick(n.start)));
      const end = Math.round(timing === 'seconds' ? toTick(n.time + n.seconds) : toTick(n.end));
      if (n.midi < 12 || n.midi > 119) { report.droppedNotes++; continue; }
      lmmsNotes.push({ tick, length: Math.max(1, end - tick), midi: n.midi, velocity: Math.max(1, Math.min(100, Math.round(n.velocity * 100))) });
    }
    return { name: cleanName(track.name, index), source: index, notes: lmmsNotes };
  });

  let out = converted;
  if (merge) out = [{ name: merge, source: converted.map(t => t.source), notes: converted.flatMap(t => t.notes) }];
  const seen = new Set();
  for (const track of out) {
    let name = track.name, n = 2;
    while (seen.has(name.toLowerCase()) || name === 'Song length') name = `${track.name} ${n++}`;
    seen.add(name.toLowerCase());
    track.name = name;
    track.notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  }
  const total = out.reduce((sum, t) => sum + t.notes.length, 0);
  if (!total) throw new Error('No notes in the playable range MIDI 12 to 119');
  if (total > MAX_NOTES) throw new Error(`The import has ${total} notes; the limit is ${MAX_NOTES}`);
  const ticksPerBar = 192 * meter[0] / meter[1];
  const lengthTicks = Math.max(...out.flatMap(t => t.notes.map(n => n.tick + n.length)));
  return { bpm: outBpm, meter, ticksPerBar, tracks: out, lengthTicks, lengthBars: Math.ceil(lengthTicks / ticksPerBar), warnings, report };
}

// Build an LMMS document with one piano-roll pattern per track that spans the whole piece.
export function buildDocument(project, imported, { voice, masterVolume, volume, role }) {
  const items = imported.tracks.map(track => ({ name: track.name, voice, volume, pan: 0, rootMidi: 69, patterns: [], ...(role ? { role } : {}) }));
  const doc = project.createSong(imported.bpm, items, masterVolume);
  const [head] = project.children(doc.documentElement, 'head');
  head.setAttribute('timesig_numerator', String(imported.meter[0]));
  head.setAttribute('timesig_denominator', String(imported.meter[1]));
  const byName = new Map(project.tracks(doc).map(t => [t.getAttribute('name'), t]));
  for (const track of imported.tracks) {
    const last = Math.max(...track.notes.map(n => n.tick + n.length));
    const length = Math.max(1, Math.ceil(last / imported.ticksPerBar)) * imported.ticksPerBar;
    const clip = project.add(byName.get(track.name), 'pattern', { name: track.name, pos: 0, len: length, type: 1, steps: 16, muted: 0 });
    for (const n of track.notes) project.add(clip, 'note', { key: n.midi - 12, pos: n.tick, len: n.length, vol: n.velocity, pan: 0 });
  }
  return doc;
}

export function register({ tool, z, root, paths, project, render, dsp, schemas, moduleGuidance }) {
  moduleGuidance.push('To start from an existing score, put a .mid file in the workspace and run import_midi, then shape_performance for a human feel. Pass form to unfold repeats the file plays once. See docs/midi-import.md.');
  const midiFile = z.string().regex(/^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.midi?$/i);

  tool('import_midi', 'Import a standard MIDI file from the workspace as an editable LMMS project: one piano-roll track per MIDI track (or merged into one), the time signature and tempo of the file, sustain pedal baked into note lengths and volume controller changes folded into velocities. form lays bars out in a new order, for example to unfold a repeat. Report the source tempo, metre and any changes it could not keep.', {
    midi: midiFile.describe('A .mid file in the workspace, optionally one folder down.'),
    output: schemas.projectName,
    bpm: z.number().min(10).max(999).optional().describe('Tempo for the project. Default: the first tempo in the file.'),
    timing: z.enum(['score', 'seconds']).default('score').describe('score keeps the written rhythm at a steady tempo. seconds keeps the real timing of a recorded performance, including tempo changes, at the chosen tempo.'),
    form: z.array(z.object({ from: z.number().int().min(1).max(9999), to: z.number().int().min(1).max(9999) })).max(64).optional()
      .describe('Bars to play, in order, numbered from 1 and inclusive. For a repeat with two endings, for example [{from:1,to:31},{from:32,to:39},{from:1,to:31},{from:40,to:47}].'),
    tracks: z.array(z.union([z.string().max(100), z.number().int().min(0).max(255)])).max(16).optional().describe('MIDI tracks to import, by name or index. Default: every track with notes.'),
    merge: z.string().min(1).max(60).regex(/^[\w -]+$/).optional().describe('Merge the chosen tracks into one track with this name, for example "Piano" so both hands play one instrument.'),
    pedal: z.enum(['bake', 'ignore']).default('bake').describe('bake holds notes while the sustain pedal (CC64) is down, because LMMS patterns do not store controllers.'),
    volumeChanges: z.enum(['fold', 'ignore']).default('fold').describe('fold scales note velocities by channel volume (CC7) and expression (CC11).'),
    transpose: z.number().int().min(-48).max(48).default(0),
    voice: z.enum(['pluck', 'bass', 'pad']).default('pluck').describe('Built-in voice for previews in LMMS. Use apply_preset to change it, or export_midi and render_soundfont for a SoundFont instrument.'),
    role: z.enum(['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx']).optional(),
    volume: z.number().min(0).max(200).default(100),
  }, async ({ midi: file, output, bpm, timing, form, tracks, merge, pedal, volumeChanges, transpose, voice, role, volume }) => {
    const full = path.join(root, file);
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile()) throw new Error(`MIDI file "${file}" was not found in the workspace`);
    await assertRealpathContained(full, root, 'MIDI file');
    if (info.size > 4 * 1024 * 1024) throw new Error('Expected a MIDI file up to 4 MiB');
    let parsed;
    try {
      parsed = new midiPackage.Midi(await readFile(full));
    } catch (error) {
      throw new Error('Could not read the MIDI file: ' + error.message);
    }
    const imported = midiToTracks(parsed, { bpm, timing, form, tracks, merge, pedal, volumeChanges, transpose });
    const doc = buildDocument(project, imported, { voice, masterVolume: 86, volume, role });
    await assertProjectProvenance(doc, {
      projectName: output,
      workspaceDir: root,
      soundfontsDir: paths?.soundfonts,
      presetsDir: paths?.presets,
      env: process.env,
    });
    const saved = await project.save(doc, output);
    const info2 = project.songInfo(doc);
    return {
      ...saved, bpm: imported.bpm, meter: imported.meter.join('/'), lengthBars: imported.lengthBars,
      lengthSeconds: Number(info2.lengthSeconds.toFixed(2)),
      tracks: imported.tracks.map(t => ({ name: t.name, source: t.source, notes: t.notes.length,
        range: [Math.min(...t.notes.map(n => n.midi)), Math.max(...t.notes.map(n => n.midi))],
        velocity: [Math.min(...t.notes.map(n => n.velocity)), Math.max(...t.notes.map(n => n.velocity))] })),
      source: imported.report, ...(imported.warnings.length ? { warnings: imported.warnings } : {}),
    };
  });

  tool('master_audio', 'Finish any workspace WAV, for example a render from render_mix or render_soundfont: trim the silence after the last sound, fade the end, bring it to a loudness target under a true-peak ceiling and write WAV or OGG. Report loudness and peak before and after.', {
    audio: schemas.workspaceWav, output: schemas.audioOut,
    targetLufs: schemas.loudnessTarget, ceilingDb: schemas.ceilingTarget,
    trimTail: z.boolean().default(true).describe('Cut the end after the sound has fallen below -70 dBFS, keeping tailSeconds.'),
    tailSeconds: z.number().min(0).max(10).default(1.5),
    fadeOutSeconds: z.number().min(0).max(20).default(1),
  }, async ({ audio: file, output, targetLufs, ceilingDb, trimTail, tailSeconds, fadeOutSeconds }) => {
    const inPath = path.join(root, file);
    const source = await readFile(inPath).catch(() => null);
    if (!source) throw new Error(`Audio "${file}" was not found in the workspace`);
    const inputCheck = await verifyAudioFileProvenance(inPath, { workspaceDir: root, env: process.env });
    const audio = dsp.decodeWav(source);
    const before = { lufs: dsp.loudness(audio).integratedLufs, truePeakDb: dsp.db(dsp.truePeak(audio)) };
    let frames = audio.frames;
    if (trimTail) {
      const floor = 10 ** (-70 / 20);
      let last = 0;
      for (const ch of audio.channels) for (let i = ch.length - 1; i > last; i--) if (Math.abs(ch[i]) > floor) { last = i; break; }
      frames = Math.min(audio.frames, last + 1 + Math.round(tailSeconds * audio.sampleRate));
    }
    let out = frames < audio.frames ? dsp.slice(audio, 0, frames) : audio;
    if (fadeOutSeconds > 0) dsp.fade(out, 0, Math.min(out.frames, Math.round(fadeOutSeconds * out.sampleRate)));
    const mastering = render.masterAudio(out, { targetLufs, ceilingDb });
    const outPath = path.join(root, output);
    await render.writeAudio(outPath, dsp.encodeWav(out));
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool: 'master_audio',
    });
    return { file: output, durationSeconds: Number((out.frames / out.sampleRate).toFixed(2)), trimmedSeconds: Number(((audio.frames - out.frames) / audio.sampleRate).toFixed(2)),
      before, after: { lufs: dsp.loudness(out).integratedLufs, truePeakDb: dsp.db(dsp.truePeak(out)) }, ...(mastering ? { mastering } : {}) };
  });
}
