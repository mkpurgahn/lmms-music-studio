// Atelier Instruments workshop: renderers, effects and note generators from the
// atelier-instruments repository. The repository is loaded only when a tool is called.
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './fs-atomic.mjs';
import {
  verifyAudioFileProvenance,
  writeDerivedAudioProvenance,
  writeProvenanceSidecar,
} from './provenance.mjs';

const missing = 'Set LMMS_ATELIER_INSTRUMENTS to the absolute path of an atelier-instruments checkout (one with agent/index.js), or install it so "atelier-instruments/agent" resolves.';
const maxInputBytes = 256 * 1024 * 1024;
const TICKS_PER_BEAT = 48;

let cached = null;

/** Load the atelier-instruments agent API. */
export async function loadWorkshop(directory = process.env.LMMS_ATELIER_INSTRUMENTS) {
  if (cached) return cached;
  if (directory && !path.isAbsolute(directory)) throw new Error('LMMS_ATELIER_INSTRUMENTS must be an absolute directory path.');
  const entry = directory ? path.join(directory, 'agent', 'index.js') : null;
  if (entry && !existsSync(entry)) throw new Error(`${missing} Not found: ${entry}`);
  try {
    cached = await import(entry ? pathToFileURL(entry).href : 'atelier-instruments/agent');
  } catch (error) {
    if (!entry && error.code === 'ERR_MODULE_NOT_FOUND') throw new Error(missing, { cause: error });
    throw error;
  }
  return cached;
}

async function readWorkspace(root, input, limit) {
  const realRoot = await realpath(root);
  const filename = await realpath(path.join(realRoot, input));
  const relative = path.relative(realRoot, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Input must resolve inside LMMS_WORKSPACE.');
  }
  const info = await stat(filename);
  if (!info.isFile() || info.size > limit) throw new Error(`Input must be a file no larger than ${limit} bytes.`);
  return readFile(filename);
}

/** Convert beat-timed notes (velocity 0 to 1) to an LMMS pattern at 48 ticks a beat. */
export function notesToPattern(notes, { name, bar = 0, beatsPerBar = 4, lengthBeats, transpose = 0 }) {
  const kept = [];
  let dropped = 0;
  for (const n of notes) {
    const midi = Math.round(n.midi + transpose);
    if (midi < 12 || midi > 119) {
      dropped += 1;
      continue;
    }
    kept.push({
      tick: Math.max(0, Math.round(n.start * TICKS_PER_BEAT)),
      length: Math.max(1, Math.round(n.duration * TICKS_PER_BEAT)),
      midi,
      velocity: Math.min(200, Math.max(1, Math.round(n.velocity * 100))),
    });
  }
  const end = Math.max(lengthBeats ?? 0, ...kept.map(n => (n.tick + n.length) / TICKS_PER_BEAT));
  const bars = Math.min(64, Math.max(1, Math.ceil(end / beatsPerBar - 1e-9)));
  return { pattern: { name, bar, bars, notes: kept }, dropped };
}

/** An LMMS sample track that plays a workspace WAV once from a bar. */
export function sampleTrack({ name, sample, bar, seconds, bpm, ticksPerBar = 192, role, volume = 100, pan = 0 }) {
  const ticks = Math.max(1, Math.ceil((seconds * bpm / 60) * TICKS_PER_BEAT));
  const bars = Math.min(64, Math.max(1, Math.ceil(ticks / ticksPerBar)));
  const track = {
    name, voice: 'sample', sample, rootMidi: 69, volume, pan,
    patterns: [{ name, bar, bars, notes: [{ tick: 0, length: Math.min(ticks, bars * ticksPerBar), midi: 69, velocity: 100 }] }],
  };
  if (role) track.role = role;
  return track;
}

function summary(result) {
  const out = { sampleRate: result.sampleRate, ...result.stats };
  if (result.info) out.info = result.info;
  return out;
}

export function register({ tool, z, root, schemas, project, moduleGuidance }) {
  const instrument = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe('Instrument id from atelier_list_instruments.');
  const request = {
    preset: z.string().min(1).max(80).optional().describe('Factory preset name. params override it field by field.'),
    params: z.record(z.string(), z.any()).optional().describe('Instrument params. See atelier_describe_instrument for the schema. Unknown fields are rejected.'),
  };
  const place = z.strictObject({
    project: schemas.projectName.describe('Project to add the rendered audio to.'),
    output: schemas.projectName.describe('New project file to write. The source project is not changed.'),
    bar: z.number().int().min(0).max(999).describe('Bar where the audio starts, from 0.'),
    trackName: z.string().min(1).max(100).optional(),
    role: z.enum(['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx']).optional(),
    volume: schemas.volume.optional(),
    pan: z.number().int().min(-100).max(100).optional(),
  }).optional().describe('Also add the WAV to a copy of a project as a sample track starting at a bar.');

  async function write(output, bytes) {
    await writeFileAtomic(path.join(root, output), bytes, { overwrite: false });
  }

  async function placeAudio(spec, file, seconds, fallbackName) {
    if (!spec) return undefined;
    const doc = await project.load(spec.project);
    const info = project.songInfo(doc);
    const name = spec.trackName ?? fallbackName;
    if (project.tracks(doc).some(t => t.getAttribute('name') === name)) throw new Error(`Track name "${name}" is already in use. Pass place.trackName.`);
    const item = sampleTrack({ name, sample: file, bar: spec.bar, seconds, bpm: info.bpm, ticksPerBar: info.ticksPerBar, role: spec.role, volume: spec.volume, pan: spec.pan });
    await project.checkTrack(item);
    const parent = project.container(doc);
    const anchor = project.tracks(doc).find(project.isAnchor);
    project.addTrack(parent, item);
    if (anchor) parent.appendChild(anchor);
    const saved = await project.save(doc, spec.output);
    return { ...saved, track: name, bar: spec.bar, bars: item.patterns[0].bars, bpm: info.bpm };
  }

  tool('atelier_list_instruments', 'List the Atelier workshop instruments: generators that render audio from params, processors that change a workspace WAV, and which ones also return notes for an LMMS pattern.', {},
    async () => ({ instruments: await (await loadWorkshop()).listInstruments() }));

  tool('atelier_describe_instrument', 'Get one Atelier instrument\'s summary, JSON Schema for params, a working example and preset names. Read this before rendering.', {
    instrument, preset: z.string().min(1).max(80).optional().describe('Also return the full params of this preset.'),
  }, async ({ instrument: id, preset }) => {
    const api = await loadWorkshop();
    const description = await api.describeInstrument(id);
    if (preset) description.presetParams = await api.presetParams(id, preset);
    return description;
  });

  tool('atelier_render', 'Render an Atelier generator (riser, impact, game SFX, creature, ambience bed, choir, chords, arpeggio, acid bass) to a new 48 kHz WAV in the workspace. Params are checked strictly and silence is an error. Returns peak and RMS. With place, also adds the WAV to a copy of a project as a sample track at a bar.', {
    instrument, ...request, output: schemas.wavName, place,
  }, async ({ instrument: id, preset, params, output, place: spec }) => {
    const api = await loadWorkshop();
    const result = await api.renderInstrument(id, { preset, params, sampleRate: 48000 });
    await write(output, api.encodeResult(result));
    await writeProvenanceSidecar(path.join(root, output), {
      workspaceDir: root,
      classification: 'pure-synthesis',
      generatorTool: 'atelier_render',
      sources: [{
        kind: 'pure-synthesis',
        pluginOrLibrary: `atelier-workshop:${id}`,
        licence: 'unrestricted-synthesis',
      }],
    });
    const out = { file: output, ...summary(result) };
    if (result.notes) out.notesAvailable = `${result.notes.notes.length} notes. Use atelier_notes for an editable LMMS pattern.`;
    const placed = await placeAudio(spec, output, result.stats.seconds, `${id} ${output.replace(/\.wav$/i, '')}`);
    if (placed) out.placed = placed;
    return out;
  });

  tool('atelier_process', 'Run a workspace WAV through an Atelier processor (pump-sweep sidechain and filter moves, tape-glitch stops and stutters, robot-voice-vocoder) and write a new 48 kHz WAV. Times in params are seconds from the start of the input. With place, also adds the result to a copy of a project at a bar.', {
    instrument, input: schemas.workspaceWav, ...request, output: schemas.wavName, place,
  }, async ({ instrument: id, input, preset, params, output, place: spec }) => {
    const inputCheck = await verifyAudioFileProvenance(path.join(root, input), {
      workspaceDir: root,
      env: process.env,
    });
    const api = await loadWorkshop();
    const bytes = await readWorkspace(root, input, maxInputBytes);
    const result = await api.processAudio(id, bytes, { preset, params, sampleRate: 48000 });
    await write(output, api.encodeResult(result));
    await writeDerivedAudioProvenance(path.join(root, output), [inputCheck], {
      workspaceDir: root,
      generatorTool: 'atelier_process',
    });
    const out = { file: output, input, ...summary(result) };
    const placed = await placeAudio(spec, output, result.stats.seconds, `${id} ${output.replace(/\.wav$/i, '')}`);
    if (placed) out.placed = placed;
    return out;
  });

  tool('atelier_notes', 'Get the notes an Atelier instrument plays (chord-pads voicings, arp-lab arpeggios, acid-bass lines) as an LMMS pattern: ticks at 48 a beat and velocity on the LMMS 1 to 200 scale. Pass the pattern to create_project, add_track or add_pattern to play it on any LMMS sound.', {
    instrument, ...request,
    name: z.string().min(1).max(100).optional(), bar: z.number().int().min(0).max(999).default(0),
    transpose: z.number().int().min(-48).max(48).default(0),
  }, async ({ instrument: id, preset, params, name, bar, transpose }) => {
    const api = await loadWorkshop();
    const result = await api.instrumentNotes(id, { preset, params });
    const { pattern, dropped } = notesToPattern(result.notes, { name: name ?? id, bar, lengthBeats: result.lengthBeats, transpose });
    if (!pattern.notes.length) throw new Error('No notes fall inside the LMMS range of MIDI 12 to 119. Use transpose.');
    const out = { bpm: result.bpm, lengthBeats: result.lengthBeats, pattern };
    if (dropped) out.warning = `${dropped} notes were outside MIDI 12 to 119 and were left out. Use transpose.`;
    if (pattern.bars === 64) out.note = 'Patterns hold at most 64 bars. Longer material was cut at bar 64.';
    return out;
  });

  moduleGuidance?.push('Atelier workshop instruments (atelier_*) add sound design LMMS lacks: trailer risers and impacts, game SFX, creature calls, ambience beds, a formant choir, chord voicings, arpeggios and an acid bassline, plus pump, tape-glitch and vocoder effects on stems. Call atelier_describe_instrument first; render with place to drop the result on a bar, or use atelier_notes to get an editable pattern.');
}
