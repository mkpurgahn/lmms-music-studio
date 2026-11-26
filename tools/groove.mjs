import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import midiPackage from '@tonejs/midi';
// Groove engine for dance styles: swing templates, humanise, ghost notes, fills, drum layering.
// Deterministic for a seed. Operates on note arrays (tick, midi, velocity, length).
const BAR = 192; // ticks per bar at 48 ppq * 4
const STEP = 12; // 16th note
const clave = new Set([0, 6 * STEP, 12 * STEP, BAR + 4 * STEP, BAR + 8 * STEP]);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const grooves = {
  'mpc-swing-60': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.15 : 0),
  'mpc-swing-70': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.25 : 0),
  'ukg-shuffle': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.2 : 0),
  'house-shuffle': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.12 : 0),
  'amapiano-332': (tick) => {
    const pos = tick % BAR;
    if (pos > STEP * 5 && pos < STEP * 8) return tick + STEP * 0.1;
    return tick;
  },
  'afro-clave': (tick) => tick,
  'half-time': (tick) => tick,
  'straight-techno': (tick) => tick,
};

export function applyGroove(notes, template = 'mpc-swing-60', strength = 1) {
  if (strength === 0) return notes.map(note => ({ ...note }));
  if (template === 'afro-clave') {
    return notes.map(note => {
      const accent = clave.has(note.tick % (2 * BAR)) ? 14 : -4;
      const velocity = Math.round((note.velocity ?? 80) + accent * strength);
      return { ...note, velocity: Math.max(1, Math.min(127, velocity)) };
    });
  }
  if (template === 'half-time') {
    // Shift a beat-two backbeat toward beat three, retaining the bar and other voices.
    const snares = new Set(notes.filter(note => note.midi === 38 || note.midi === 40)
      .map(note => `${note.midi}:${note.tick}`));
    return notes.map(note => {
      const shift = Math.round(4 * STEP * strength);
      const backbeat = (note.midi === 38 || note.midi === 40) && note.tick % BAR === 4 * STEP;
      const tick = backbeat && !snares.has(`${note.midi}:${note.tick + shift}`) ? note.tick + shift : note.tick;
      return { ...note, tick };
    }).sort((left, right) => left.tick - right.tick);
  }
  const fn = grooves[template] ?? grooves['mpc-swing-60'];
  return notes.map(n => ({ ...n, tick: Math.round(n.tick + (fn(n.tick) - n.tick) * strength) }));
}

export function humanize(notes, { timingMs = 8, velocityVar = 12, seed = 1, role = 'hat', bpm = 120 } = {}) {
  const random = rng(seed);
  const tight = role === 'kick' || role === 'snare';
  const tScale = tight ? 0.3 : 1;
  const vScale = tight ? 0.5 : 1;
  return notes.map(n => {
    const jitter = (random() - 0.5) * 2 * timingMs * tScale * 48 * bpm / 60000; // 48 ticks per beat at the declared tempo
    const vel = Math.max(1, Math.min(127, (n.velocity ?? 80) + (random() - 0.5) * 2 * velocityVar * vScale));
    return { ...n, tick: Math.max(0, Math.round(n.tick + jitter)), velocity: Math.round(vel) };
  });
}

export function addGhostNotes(notes, { density = 0.3, seed = 1, role = 'snare' } = {}) {
  const random = rng(seed + 7);
  const ghosts = [];
  for (const n of notes) {
    if ([38, 40, 42, 44, 46].includes(n.midi) && random() < density) { // hats/snares
      ghosts.push({ ...n, tick: n.tick + STEP, velocity: Math.round((n.velocity ?? 60) * 0.35), length: STEP * 0.5 });
    }
  }
  return [...notes, ...ghosts].sort((a, b) => a.tick - b.tick);
}

export function addFills(notes, { every = 8, seed = 1, bars = 32 } = {}) {
  const random = rng(seed + 13);
  const fills = [];
  for (let bar = every - 1; bar < bars; bar += every) {
    const base = bar * BAR;
    for (let s = 0; s < 4; s++) {
      fills.push({ tick: base + (12 + s) * STEP, midi: 38, velocity: 70 + random() * 30, length: STEP });
    }
  }
  return [...notes, ...fills].sort((a, b) => a.tick - b.tick);
}

export function layerDrums(notes, { layers = 2, offsetTicks = 2, velScale = 0.8 } = {}) {
  const out = [...notes];
  for (let l = 1; l < layers; l++) {
    out.push(...notes.map(n => ({ ...n, tick: n.tick + offsetTicks * l, velocity: Math.round((n.velocity ?? 80) * velScale) })));
  }
  return out.sort((a, b) => a.tick - b.tick);
}

// Extract a repeating one-bar timing template, normalised from the MIDI PPQ.
export function extractGroove(midi) {
  const bins = Array.from({ length: 16 }, () => []);
  for (const track of midi.tracks) for (const note of track.notes) {
    const tick = note.ticks * 48 / midi.header.ppq;
    const slot = Math.round(tick / STEP);
    bins[((slot % 16) + 16) % 16].push(tick - slot * STEP);
  }
  if (!bins.some(bin => bin.length)) throw new Error('Reference MIDI has no notes');
  return bins.map(bin => bin.length ? bin.reduce((a, b) => a + b, 0) / bin.length : 0);
}

export function applyExtracted(notes, offsets, strength) {
  return notes.map(n => ({ ...n, tick: Math.max(0, Math.round(n.tick + offsets[Math.round(n.tick / STEP) % 16] * strength)) }));
}

export function register({ tool, z, root, project, schemas, moduleGuidance }) {
  moduleGuidance.push('Groove tools write MIDI and editable LMMS projects when output is supplied. Ticks use 48 PPQ. Supply kitSamples from build_kit for custom percussion.');
  const note = z.object({
    tick: z.number().int().min(0).max(192 * 128).describe('Position in ticks, 48 per beat.'),
    midi: z.number().int().min(12).max(119).describe('MIDI pitch.'),
    velocity: z.number().int().min(1).max(127).default(80).describe('MIDI velocity, 1-127.'),
    length: z.number().int().min(1).max(192 * 8).default(12).describe('Duration in ticks, 48 per beat.'),
  });
  const common = {
    notes: z.array(note).min(1).max(4096),
    bpm: z.number().min(45).max(240).default(120).describe('Tempo in beats per minute; used for millisecond timing and file output.'),
    output: schemas.projectName.optional().describe('New editable LMMS project. A matching .mid is written alongside it.'),
    kitSamples: z.array(z.object({ midi: z.number().int().min(12).max(119), file: schemas.workspaceWav })).max(32).default([])
      .describe('Optional workspace drum WAV mapping from build_kit. Unmapped notes use native drum voices.'),
  };
  async function finish(notes, args) {
    notes = notes.map(n => ({ ...n, length: Math.max(1, Math.round(n.length ?? 12)), velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? 80))) }));
    if (!args.output) return { notes };
    const midiName = args.output.replace(/\.mmpz?$/i, '.mid');
    const midi = new midiPackage.Midi();
    midi.header.setTempo(args.bpm);
    const track = midi.addTrack();
    track.channel = 9;
    for (const n of notes) track.addNote({ midi: n.midi, ticks: Math.round(n.tick * midi.header.ppq / 48), durationTicks: Math.round(n.length * midi.header.ppq / 48), velocity: n.velocity / 127 });
    const totalBars = Math.ceil(Math.max(...notes.map(n => n.tick + n.length)) / BAR);
    const items = [...new Set(notes.map(n => n.midi))].map(pitch => {
      const sample = args.kitSamples.find(item => item.midi === pitch)?.file;
      const patterns = [];
      // Split long clips to honour the project's 64-bar pattern limit.
      for (let bar = 0; bar < totalBars; bar += 64) {
        const selected = notes.filter(n => n.midi === pitch && n.tick >= bar * BAR && n.tick < (bar + 64) * BAR)
          .map(n => ({ ...n, tick: n.tick - bar * BAR, length: Math.min(n.length, (bar + 64) * BAR - n.tick) }));
        if (selected.length) patterns.push({ name: 'Groove', bar, bars: Math.min(64, totalBars - bar), notes: selected });
      }
      return { name: `Drum ${pitch}`, role: 'drums', voice: sample ? 'sample' : pitch === 36 ? 'kick' : pitch === 38 ? 'snare' : pitch === 39 ? 'clap' : 'hat',
        ...(sample ? { sample, rootMidi: pitch } : {}), volume: 70, pan: 0, patterns };
    });
    const tracks = items.map(item => schemas.track.parse(item));
    for (const item of tracks) await project.checkTrack(item);
    const doc = project.createSong(args.bpm, tracks, 70);
    // Refuse existing MIDI before creating either output, never replace a workspace asset.
    if (await lstat(path.join(root, midiName)).catch(e => { if (e.code !== 'ENOENT') throw e; })) throw new Error('MIDI output already exists');
    const saved = await project.save(doc, args.output);
    await writeFile(path.join(root, midiName), midi.toArray(), { flag: 'wx' });
    return { ...saved, midi: midiName, notes, bpm: args.bpm };
  }
  tool('apply_groove', 'Apply named swing/clave templates, custom swing percentage or a groove extracted from workspace MIDI. Optionally write MIDI and LMMS output.', {
    ...common, template: z.enum([...Object.keys(grooves), 'midi']).default('mpc-swing-60'),
    strength: z.number().min(0).max(1).default(1),
    swingPercent: z.number().min(50).max(75).optional().describe('Offbeat position as percent of the eighth-note pair, 50 is straight.'),
    referenceMidi: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i).optional(),
  }, async args => {
    let notes;
    if (args.template === 'midi') {
      if (!args.referenceMidi) throw new Error('MIDI groove requires referenceMidi');
      const file = path.join(root, args.referenceMidi), info = await lstat(file);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Expected a regular MIDI file up to 4 MiB');
      notes = applyExtracted(args.notes, extractGroove(new midiPackage.Midi(await readFile(file))), args.strength);
    } else if (args.swingPercent !== undefined) {
      notes = args.notes.map(n => ({ ...n, tick: Math.round(n.tick + (n.tick % 24 === 12 ? 24 * (args.swingPercent / 100 - 0.5) * args.strength : 0)) }));
    } else notes = applyGroove(args.notes, args.template, args.strength);
    return finish(notes, args);
  });
  tool('humanize', 'Add seeded timing jitter in milliseconds and velocity variation; kick/snare remain tighter. Optionally write MIDI and LMMS output.', {
    ...common, timingMs: z.number().min(0).max(40).default(8).describe('Maximum jitter in milliseconds before role scaling.'),
    velocityVar: z.number().min(0).max(40).default(12).describe('Maximum velocity variation in MIDI units.'),
    seed: z.number().int().default(1), role: z.enum(['kick', 'snare', 'hat', 'other']).default('hat'),
  }, async args => finish(humanize(args.notes, args), args));
  tool('add_ghost_notes', 'Add low-velocity ghost notes with seeded density. Optionally write MIDI and LMMS output.', {
    ...common, density: z.number().min(0).max(1).default(0.3), seed: z.number().int().default(1),
  }, async args => finish(addGhostNotes(args.notes, args), args));
  tool('add_fills', 'Add seeded fills every N bars. Optionally write MIDI and LMMS output.', {
    ...common, every: z.number().int().min(4).max(16).default(8), bars: z.number().int().min(4).max(128).default(32), seed: z.number().int().default(1),
  }, async args => finish(addFills(args.notes, args), args));
  tool('layer_drums', 'Layer drum notes with tick offsets and velocity scaling. Optionally write MIDI and LMMS output.', {
    ...common, layers: z.number().int().min(1).max(4).default(2), offsetTicks: z.number().int().min(0).max(24).default(2), velScale: z.number().min(0.1).max(1).default(0.8),
  }, async args => finish(layerDrums(args.notes, args), args));
}
