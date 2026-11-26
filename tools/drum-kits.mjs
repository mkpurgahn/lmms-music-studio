import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import midiPackage from '@tonejs/midi';
import { promisify } from 'node:util';
import { decodeWav, encodeWav, truePeak } from '../audio.mjs';
import { prepareSf2InstrumentSpec, writeSf2PlayerElement } from './soundfont.mjs';
import { resolveSoundfontsDir } from './workspace-config.mjs';

export const SYNTH_DRUM_VOICES = Object.freeze({
  kick: {
    plugin: 'kicker',
    kicker: {
      version: 1, startfreq: 155, endfreq: 36, decay: 280, dist: 0.8, distend: 0.3,
      gain: 0.95, env: 0.16, noise: 0.05, click: 0.25, slope: 0.42,
      startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
    },
  },
  snare: {
    plugin: 'kicker',
    kicker: {
      version: 1, startfreq: 235, endfreq: 142, decay: 195, dist: 0.35, distend: 0.1,
      gain: 0.85, env: 0.42, noise: 0.72, click: 0.5, slope: 0.65,
      startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
    },
    eldata: { fwet: 1, ftype: 1, fcut: 185, fres: 0.7 },
    elvol: { amt: 1, att: 0, hold: 0.01, dec: 0.19, sustain: 0, rel: 0.07 },
  },
  hat: {
    plugin: 'tripleoscillator',
    oscillator: {
      modalgo1: 2, modalgo2: 2, wavetype0: 6, wavetype1: 6, wavetype2: 6,
      vol0: 34, vol1: 24, vol2: 0, coarse0: 0, coarse1: 12, coarse2: 0,
      finel0: 0, finer0: 0, finel1: -4, finer1: 4,
    },
    eldata: { fwet: 1, ftype: 1, fcut: 5800, fres: 1.2 },
    elvol: { amt: 1, att: 0, hold: 0, dec: 0.075, sustain: 0, rel: 0.04 },
  },
  clap: {
    plugin: 'tripleoscillator',
    oscillator: {
      modalgo1: 2, modalgo2: 2, wavetype0: 6, wavetype1: 6, wavetype2: 6,
      vol0: 50, vol1: 40, vol2: 0, coarse0: 0, coarse1: 0, coarse2: 0,
      finel0: -6, finer0: 6, finel1: 4, finer1: -4,
    },
    eldata: { fwet: 1, ftype: 2, fcut: 1650, fres: 1.8 },
    elvol: { amt: 1, att: 0.004, hold: 0.018, dec: 0.16, sustain: 0, rel: 0.08, lshp: 2, lspd: 0.028, lamt: -0.55 },
  },
});

export const DRUM_KIT_NAMES = Object.freeze([
  'tight-synth',
  'house-synth',
  'electro-synth',
  '808-synth',
  'acoustic-cc0',
]);

export const SYNTH_DRUM_KITS = Object.freeze({
  'tight-synth': {
    description: 'Dry, punchy studio synthesizer drum kit (Kicker + filtered noise TripleOscillator).',
    pieces: {
      kick: SYNTH_DRUM_VOICES.kick,
      snare: SYNTH_DRUM_VOICES.snare,
      hat: SYNTH_DRUM_VOICES.hat,
      openhat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 5100, fres: 1.1 },
        elvol: { amt: 1, att: 0, hold: 0.02, dec: 0.25, sustain: 0, rel: 0.12 },
      },
      clap: SYNTH_DRUM_VOICES.clap,
    },
  },
  'house-synth': {
    description: 'Warm 909-inspired four-on-the-floor house synthesizer drum kit.',
    pieces: {
      kick: {
        plugin: 'kicker',
        kicker: {
          version: 1, startfreq: 168, endfreq: 42, decay: 335, dist: 0.9, distend: 0.35,
          gain: 0.95, env: 0.18, noise: 0.06, click: 0.3, slope: 0.45,
          startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
        },
      },
      snare: {
        ...SYNTH_DRUM_VOICES.snare,
        kicker: { ...SYNTH_DRUM_VOICES.snare.kicker, startfreq: 245, endfreq: 152, decay: 215, noise: 0.76 },
      },
      hat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 6200, fres: 1.3 },
        elvol: { amt: 1, att: 0, hold: 0, dec: 0.08, sustain: 0, rel: 0.045 },
      },
      openhat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 5300, fres: 1.25 },
        elvol: { amt: 1, att: 0, hold: 0.03, dec: 0.31, sustain: 0, rel: 0.14 },
      },
      clap: {
        ...SYNTH_DRUM_VOICES.clap,
        eldata: { fwet: 1, ftype: 2, fcut: 1500, fres: 1.9 },
        elvol: { ...SYNTH_DRUM_VOICES.clap.elvol, dec: 0.19, rel: 0.09 },
      },
    },
  },
  'electro-synth': {
    description: 'Snappy modern electro and synthwave drum kit with driven transients.',
    pieces: {
      kick: {
        plugin: 'kicker',
        kicker: {
          version: 1, startfreq: 190, endfreq: 35, decay: 300, dist: 1.15, distend: 0.45,
          gain: 0.92, env: 0.2, noise: 0.08, click: 0.34, slope: 0.5,
          startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
        },
      },
      snare: {
        ...SYNTH_DRUM_VOICES.snare,
        kicker: { ...SYNTH_DRUM_VOICES.snare.kicker, startfreq: 260, endfreq: 150, decay: 235, dist: 0.5, noise: 0.82, click: 0.6 },
      },
      hat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 6800, fres: 1.45 },
        elvol: { amt: 1, att: 0, hold: 0, dec: 0.06, sustain: 0, rel: 0.03 },
      },
      openhat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 5900, fres: 1.35 },
        elvol: { amt: 1, att: 0, hold: 0.02, dec: 0.27, sustain: 0, rel: 0.12 },
      },
      clap: {
        ...SYNTH_DRUM_VOICES.clap,
        eldata: { fwet: 1, ftype: 2, fcut: 1920, fres: 2.0 },
      },
    },
  },
  '808-synth': {
    description: 'Deep sub-booming 808-style analog drum synthesizer kit.',
    pieces: {
      kick: {
        plugin: 'kicker',
        kicker: {
          version: 1, startfreq: 122, endfreq: 31, decay: 620, dist: 0.35, distend: 0.12,
          gain: 0.95, env: 0.11, noise: 0.02, click: 0.18, slope: 0.3,
          startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
        },
      },
      snare: {
        plugin: 'kicker',
        kicker: {
          version: 1, startfreq: 210, endfreq: 162, decay: 185, dist: 0.2, distend: 0.05,
          gain: 0.85, env: 0.35, noise: 0.66, click: 0.42, slope: 0.58,
          startnote: 0, endnote: 0, syncmode: 0, decay_numerator: 4, decay_denominator: 4,
        },
        eldata: { fwet: 1, ftype: 1, fcut: 210, fres: 0.65 },
        elvol: { amt: 1, att: 0, hold: 0.008, dec: 0.17, sustain: 0, rel: 0.06 },
      },
      hat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 7200, fres: 1.5 },
        elvol: { amt: 1, att: 0, hold: 0, dec: 0.055, sustain: 0, rel: 0.025 },
      },
      openhat: {
        ...SYNTH_DRUM_VOICES.hat,
        eldata: { fwet: 1, ftype: 1, fcut: 6400, fres: 1.4 },
        elvol: { amt: 1, att: 0, hold: 0.025, dec: 0.34, sustain: 0, rel: 0.15 },
      },
      clap: {
        ...SYNTH_DRUM_VOICES.clap,
        eldata: { fwet: 1, ftype: 2, fcut: 1420, fres: 2.1 },
        elvol: { amt: 1, att: 0.005, hold: 0.022, dec: 0.21, sustain: 0, rel: 0.1, lshp: 2, lspd: 0.024, lamt: -0.6 },
      },
    },
  },
});

export const ACOUSTIC_CC0_DRUM_MAP = Object.freeze({
  kick: 36,
  snare: 38,
  hat: 42,
  openhat: 46,
  crash: 49,
  ride: 51,
});

export function writeSynthDrumElement(add, instrumentTrack, spec) {
  instrumentTrack.setAttribute('basenote', '57');
  if (spec.plugin === 'kicker') {
    add(add(instrumentTrack, 'instrument', { name: 'kicker' }), 'kicker', spec.kicker);
  } else {
    add(add(instrumentTrack, 'instrument', { name: 'tripleoscillator' }), 'tripleoscillator', spec.oscillator);
  }
  if (spec.eldata) {
    const env = add(instrumentTrack, 'eldata', spec.eldata);
    if (spec.elvol) add(env, 'elvol', spec.elvol);
  }
}

const run = promisify(execFile);
const rate = 48000;
const ceiling = 10 ** (-1.05 / 20); // PCM quantisation margin.
const maxWav = 8 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
const gm = { kick:36, snare:38, clap:39, closedHat:42, openHat:46, rim:37,
  tom:45, crash:49, ride:51, sub808:35, hardstyle:36 };
const kitId = 'freepats-synth-percussion-20220718';
const source = 'https://freepats.zenvoid.org/Percussion/electric-percussion.html';
const pack = 'https://freepats.zenvoid.org/Percussion/SynthesizerPercussion/SynthesizerPercussion-H2-20220718.7z';
const sourceDigest = '7f86e2b3834af5695aac8bd83310df2bc9ff1c7fbc231d0320aa5ced97368bf3';
const selected = [
  ['kick','Kick04.wav','fe8bfae55a9838bfd71ab04685c8dcba7fda114bb85087acdb915641c39b390d'],
  ['snare','Snare09.wav','6d39ad1e54bb792a8bdfb47b98fffecc3d05d795e251116aaef310015ff82dca'],
  ['clap','Clap01.wav','5a469c1e1072b210426e14ca2b020f27f1f4ce459fe116b0af837e4413e47742'],
  ['closedHat','ClosedHiHat01-01.wav','4159b05c0d04a5da8c20eeeb5d465da44c9dc23de1807ea34404a8e2c7a162a4'],
  ['openHat','OpenHiHat02-01.wav','a5558181f324b8cab6a0900c4aaa127c3ddd766163230d3aaa494a0b5e82768c'],
  ['tom','LowTom02-01.wav','3a739daf27956f690e0aeb25e22257b96f5bda415cd31a6d27e679a9e0d49b4a'],
  ['crash','Cymbal01-01.wav','43cc3d70d265dd8bae22cf4d7802b04f912300c162cc3418e47cfe511daeee9a'],
];
const cc0 = selected.map(([role, file, sha256]) =>
  ({ role, file, sha256, midi: gm[role], licence: 'CC0-1.0', author: 'Roberto (FreePats)', source, archive: pack }));

function peakWav(audio) {
  const peak = truePeak(audio);
  if (!Number.isFinite(peak)) throw new Error('Invalid drum audio samples');
  const gain = peak > ceiling ? ceiling / peak : 1;
  const wav = encodeWav({ ...audio, channels: audio.channels.map(ch => ch.map(sample => sample * gain)) });
  const measured = truePeak(decodeWav(wav));
  return { wav, truePeakDb: measured ? Number((20 * Math.log10(measured)).toFixed(3)) : null };
}

export function synthesise({ role, midi, decayMs, click, drive, seed }) {
  const frames = Math.ceil(rate * decayMs / 1000);
  const channel = new Float32Array(frames);
  let state = seed >>> 0 || 1, phase = 0, lowNoise = 0;
  const f = frequency(midi);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, progress = i / frames;
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const noise = (state >>> 0) / 2147483648 - 1;
    lowNoise += .27 * (noise - lowNoise);
    const high = noise - lowNoise;
    phase += 2 * Math.PI * f * (1 + (role === 'sub808' ? .65 : 2.5) * Math.exp(-t / (role === 'sub808' ? .055 : .016))) / rate;
    const tone = Math.sin(phase);
    const metallic = [3019, 4471, 5347, 6827, 7919].reduce((sum, hz) => sum + Math.sign(Math.sin(2 * Math.PI * hz * t)), 0) / 5;
    const attack = click * high * Math.exp(-t / .004);
    let value;
    switch (role) {
      case 'kick': case 'sub808': value = tone + attack; break;
      case 'hardstyle': value = Math.tanh(5 * tone) * .9 + attack + .5 * Math.sin(phase * 3) * Math.exp(-t / .013); break;
      case 'snare': value = .32 * tone * Math.exp(-t / .042) + .78 * high + attack; break;
      case 'clap': value = high * (.28 + .7 * [0, .011, .023].reduce((sum, start) =>
        sum + (t >= start ? Math.exp(-(t - start) / .006) : 0), 0)); break;
      case 'rim': value = .6 * Math.sin(phase * 5.1) + attack; break;
      case 'tom': value = .83 * tone + .19 * Math.sin(1.54 * phase) + attack; break;
      case 'ride': value = .6 * metallic + .24 * high + attack; break;
      case 'crash': value = .35 * metallic + .66 * high + attack; break;
      case 'closedHat': value = (.6 * high + .4 * metallic) * Math.exp(-t / .045) + attack; break;
      case 'openHat': value = .48 * high + .52 * metallic + attack; break;
    }
    const envelope = Math.exp(-4.5 * progress) * Math.min(1, i / 15, (frames - i - 1) / 100);
    channel[i] = (drive ? Math.tanh((1 + 8 * drive) * value) : value) * envelope;
  }
  return { sampleRate: rate, channels: [channel], frames };
}

function interpolate(ch, index) {
  const i = Math.floor(index), mix = index - i;
  return (ch[i] ?? 0) * (1 - mix) + (ch[i + 1] ?? 0) * mix;
}

async function workspaceAudio(root, file) {
  const full = path.resolve(root, file);
  const directory = await realpath(root);
  const resolved = await realpath(full);
  const relative = path.relative(directory, resolved);
  const stat = await lstat(full);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
      !stat.isFile() || stat.size > maxWav) throw new Error('Expected a regular workspace WAV of at most 8 MiB');
  const bytes = await readFile(full);
  const audio = decodeWav(bytes);
  if (audio.sampleRate < 8000 || audio.sampleRate > 192000 || audio.frames / audio.sampleRate > 10 ||
      audio.channels.some(ch => ch.some(sample => !Number.isFinite(sample) || Math.abs(sample) > 1))) {
    throw new Error('Expected finite WAV audio up to 10 seconds, at 8–192 kHz');
  }
  return { ...audio, sha256: sha(bytes) };
}

async function unpack(archive, member, { outer = false } = {}) {
  const command = outer && process.platform !== 'win32' ? 'bsdtar' : 'tar';
  try {
    return (await run(command, ['-xOf', archive, member], { encoding: 'buffer', maxBuffer: maxWav, windowsHide: true })).stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('The FreePats pack needs bsdtar (Windows includes it as tar.exe)');
    throw new Error('Could not extract a verified FreePats pack member: ' + member, { cause: err });
  }
}

export async function fetchFreePats(cache) {
  const directory = path.join(cache, kitId);
  const existing = await lstat(directory).catch(err => { if (err.code !== 'ENOENT') throw err; });
  if (existing) {
    if (!existing.isDirectory()) throw new Error('FreePats cache path must be a directory');
    for (const entry of cc0) {
      const verified = await workspaceAudio(directory, entry.file);
      if (verified.sha256 !== entry.sha256) throw new Error('Cached FreePats file differs: ' + entry.file);
    }
    return { directory, files: cc0, reused: true };
  }
  const response = await fetch(pack, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('FreePats download failed: ' + response.status);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxWav) throw new Error('Unexpected FreePats archive size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (sha(bytes) !== sourceDigest) throw new Error('FreePats archive hash changed; review licence and contents before use');
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmms-freepats-'));
  const extracted = new Map();
  try {
    const outer = path.join(scratch, 'pack.7z'), inner = path.join(scratch, 'kit.tar.gz');
    await writeFile(outer, bytes);
    await writeFile(inner, await unpack(outer, 'SynthesizerPercussion-H2-20220718/SynthesizerPercussion-20220718.h2drumkit', { outer: true }));
    for (const entry of cc0) {
      const wav = await unpack(inner, 'FreePats_synthesizer_percussion_20220718/' + entry.file);
      if (sha(wav) !== entry.sha256) throw new Error('FreePats sample hash changed: ' + entry.file);
      decodeWav(wav);
      extracted.set(entry.file, wav);
    }
  } finally {
    for (const file of ['pack.7z', 'kit.tar.gz']) {
      await unlink(path.join(scratch, file)).catch(err => { if (err.code !== 'ENOENT') throw err; });
    }
    await rmdir(scratch);
  }
  await mkdir(cache, { recursive: true });
  await mkdir(directory);
  for (const [file, wav] of extracted) await writeFile(path.join(directory, file), wav, { flag: 'wx' });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ kit: kitId, archiveSha256: sourceDigest, files: cc0 }, null, 2) + '\n', { flag: 'wx' });
  return { directory, files: cc0, reused: false };
}

export function register({ tool, z, schemas, root, paths, project, moduleGuidance }) {
  const getSoundfontsDir = () => paths?.soundfonts ?? resolveSoundfontsDir(process.env);

  tool('list_drum_kits', 'List available pure native LMMS synthesizer drum kits and verified CC0-1.0 acoustic SoundFont drum kits.', {}, async () => {
    const sfDir = getSoundfontsDir();
    const acousticInstalled = Boolean(
      (sfDir && existsSync(path.join(sfDir, 'virtuosity-drums.sf2'))) ||
      (root && existsSync(path.join(root, 'virtuosity-drums.sf2'))),
    );
    const kits = {};
    for (const [name, def] of Object.entries(SYNTH_DRUM_KITS)) {
      kits[name] = {
        engine: 'synth',
        available: true,
        licence: 'MIT',
        publishable: true,
        pieces: Object.keys(def.pieces),
        description: def.description,
      };
    }
    kits['acoustic-cc0'] = {
      engine: 'sf2',
      sf2: 'virtuosity-drums.sf2',
      bank: 128,
      patch: 0,
      available: acousticInstalled,
      licence: 'CC0-1.0',
      publishable: true,
      pieces: Object.keys(ACOUSTIC_CC0_DRUM_MAP),
      midiMap: ACOUSTIC_CC0_DRUM_MAP,
      description: 'Virtuosity Drums mid-mic GM kit (CC0-1.0) via native sf2player Bank 128 Patch 0.',
    };
    return {
      kits,
      licence: 'CC0-1.0 / MIT',
      publishable: true,
      note: 'All kits use pure native synthesis or verified CC0-1.0 SoundFonts with zero GPL factory drum samples.',
    };
  });

  tool('create_drum_kit', 'Create a new LMMS project containing a ready-to-use pure-synth or CC0 acoustic drum kit with empty pattern clips ready for notes or step grids.', {
    output: schemas.projectName,
    kit: z.enum(DRUM_KIT_NAMES).default('tight-synth'),
    bpm: z.number().min(45).max(240).default(120),
    lengthBars: z.number().int().min(1).max(64).default(8),
    masterVolume: schemas.volume.default(86),
  }, async ({ output, kit: kitName, bpm, lengthBars, masterVolume }) => {
    const volumes = { kick: 88, snare: 78, hat: 64, openhat: 58, clap: 72, crash: 66, ride: 64 };
    const pans = { hat: 20, openhat: -18, clap: 8, crash: -24, ride: 24 };
    const doc = project.createSong(bpm, [], masterVolume);
    const parent = project.container(doc);
    const createdTracks = [];

    if (kitName === 'acoustic-cc0') {
      const sf2Spec = await prepareSf2InstrumentSpec({
        sf2: 'virtuosity-drums.sf2',
        bank: 128,
        patch: 0,
        gain: 1.2,
        root,
        soundfontsDir: getSoundfontsDir(),
      });
      for (const [piece, gmMidi] of Object.entries(ACOUSTIC_CC0_DRUM_MAP)) {
        const trackNode = project.add(parent, 'track', {
          muted: 0, solo: 0, type: 0, name: piece, 'mcp-role': 'drums', 'mcp-drum-midi': gmMidi,
        });
        const instTrack = project.add(trackNode, 'instrumenttrack', {
          vol: volumes[piece] ?? 72, pan: pans[piece] ?? 0, basenote: 57, fxch: 0,
        });
        writeSf2PlayerElement(project.add, project.children, instTrack, sf2Spec);
        project.add(trackNode, 'pattern', { name: piece, pos: 0, len: lengthBars * 192, type: 1, steps: 16, muted: 0 });
        createdTracks.push(piece);
      }
      project.setAnchor(doc, lengthBars);
      return {
        ...(await project.save(doc, output)),
        kit: kitName,
        engine: 'sf2',
        sf2: 'virtuosity-drums.sf2',
        bank: 128,
        patch: 0,
        midiMap: ACOUSTIC_CC0_DRUM_MAP,
        tracks: createdTracks,
        lengthBars,
        licence: 'CC0-1.0',
        licenceId: 'virtuosity-drums',
        publishable: true,
      };
    }

    const synthKit = SYNTH_DRUM_KITS[kitName];
    for (const [piece, spec] of Object.entries(synthKit.pieces)) {
      const trackNode = project.add(parent, 'track', {
        muted: 0, solo: 0, type: 0, name: piece, 'mcp-role': 'drums',
      });
      const instTrack = project.add(trackNode, 'instrumenttrack', {
        vol: volumes[piece] ?? 72, pan: pans[piece] ?? 0, basenote: 57, fxch: 0,
      });
      writeSynthDrumElement(project.add, instTrack, spec);
      project.add(trackNode, 'pattern', { name: piece, pos: 0, len: lengthBars * 192, type: 1, steps: 16, muted: 0 });
      createdTracks.push(piece);
    }
    project.setAnchor(doc, lengthBars);
    return {
      ...(await project.save(doc, output)),
      kit: kitName,
      engine: 'synth',
      tracks: createdTracks,
      lengthBars,
      licence: 'MIT',
      licenceId: 'lmms-mcp-drum-synthesis',
      publishable: true,
    };
  });

  const role = z.enum(Object.keys(gm));
  const midi = z.number().int().min(12).max(119).describe('MIDI note number, 12–119');
  const write = (file, bytes) => writeFile(path.join(root, file), bytes, { flag: 'wx' });
  tool('synth_drums', 'Render deterministic 48 kHz mono drum one-shots and an MIT provenance manifest.', {
    outputDirectory: schemas.folderName,
    hits: z.array(z.object({
      role, midi: midi.min(24).max(84).default(36),
      decayMs: z.number().min(20).max(5000).default(400).describe('Total hit length in milliseconds'),
      click: z.number().min(0).max(1).default(.3).describe('Transient mix, 0–1'),
      drive: z.number().min(0).max(1).default(0).describe('Saturation amount, 0–1'),
      seed: z.number().int().min(0).max(4294967295).default(1),
    })).min(1).max(16),
  }, async ({ outputDirectory, hits }) => {
    await mkdir(path.join(root, outputDirectory));
    const files = [];
    for (const [i, hit] of hits.entries()) {
      const { wav, truePeakDb } = peakWav(synthesise(hit));
      const file = outputDirectory + '/' + hit.role + '-' + (i + 1) + '.wav';
      await write(file, wav);
      files.push({ file, role: hit.role, rootMidi: hit.midi, midi: gm[hit.role], truePeakDb,
        sha256: sha(wav), licence: 'MIT', author: 'LMMS MCP drum synthesizer',
        source: 'https://github.com/SarutobiSasuke8/lmms-mcp', params: hit });
    }
    const manifest = outputDirectory + '/manifest.json';
    await write(manifest, JSON.stringify({ files }, null, 2) + '\n');
    return { directory: outputDirectory, files, manifest };
  });

  tool('fetch_kit', 'Download or reuse the hash-pinned FreePats CC0 one-shots in the user cache. No credentials.', {
    kit: z.literal(kitId).default(kitId),
  }, () => fetchFreePats(path.join(homedir(), '.cache', 'lmms-mcp', 'drum-kits')));

  tool('build_kit', 'Map workspace WAVs to GM drum notes. Save an LMMS trigger project and a Decent Sampler preset.', {
    output: schemas.projectName,
    samples: z.array(z.object({ role, file: schemas.workspaceWav, midi: midi.optional() })).min(1).max(16),
    bpm: z.number().min(45).max(240).default(120).describe('Audition project tempo, BPM'),
  }, async ({ output, samples, bpm }) => {
    const entries = samples.map(entry => ({ ...entry, midi: entry.midi ?? gm[entry.role] }));
    if (new Set(entries.map(entry => entry.midi)).size !== entries.length) throw new Error('Assign a different MIDI note to each sample');
    const files = [];
    for (const entry of entries) files.push({ ...entry, sha256: (await workspaceAudio(root, entry.file)).sha256 });
    const tracks = files.map((entry, i) => ({
      name: entry.role, voice: 'sample', sample: entry.file, rootMidi: entry.midi, role: 'drums', volume: 75, pan: 0,
      patterns: [{ name: entry.role, bars: 1, bar: Math.floor(i / 4), notes: [{ midi: entry.midi, tick: (i % 4) * 48, length: 36, velocity: 90 }] }],
    }));
    const document = project.createSong(bpm, tracks, 70);
    const preset = output.replace(/\.mmpz?$/i, '.dspreset');
    const manifest = output.replace(/\.mmpz?$/i, '.kit.json');
    const midiFile = output.replace(/\.mmpz?$/i, '.mid');
    const mid = new midiPackage.Midi();
    mid.header.setTempo(bpm);
    const percussion = mid.addTrack();
    percussion.channel = 9;
    for (const [i, entry] of files.entries()) {
      percussion.addNote({ midi: entry.midi, ticks: i * mid.header.ppq, durationTicks: Math.floor(mid.header.ppq * .75), velocity: .9 });
    }
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const zones = files.map(({ file, midi: key }) =>
      '    <sample path="' + escape(file) + '" rootNote="' + key + '" loNote="' + key + '" hiNote="' + key + '" />').join('\n');
    for (const file of [output, preset, manifest, midiFile]) {
      const exists = await lstat(path.join(root, file)).catch(err => { if (err.code !== 'ENOENT') throw err; });
      if (exists) throw new Error('Output exists: ' + file);
    }
    await project.save(document, output);
    await write(preset, '<?xml version="1.0" encoding="UTF-8"?>\n<DecentSampler minVersion="1.0.0">\n  <groups><group>\n' + zones + '\n  </group></groups>\n</DecentSampler>\n');
    await write(manifest, JSON.stringify({ files }, null, 2) + '\n');
    await write(midiFile, mid.toArray());
    return { project: output, preset, midi: midiFile, manifest, files };
  });

  tool('layer_drum', 'Layer drum WAVs with millisecond offsets and gain; write a 48 kHz WAV with true peak below −1 dBTP.', {
    output: schemas.wavName,
    layers: z.array(z.object({ file: schemas.workspaceWav,
      offsetMs: z.number().min(0).max(2000).default(0).describe('Delay in milliseconds'),
      gainDb: z.number().min(-48).max(12).default(0).describe('Layer gain in dB'),
    })).min(2).max(8),
  }, async ({ output, layers }) => {
    const inputs = await Promise.all(layers.map(async layer => ({ ...layer, ...await workspaceAudio(root, layer.file),
      start: Math.round(layer.offsetMs * rate / 1000), gain: 10 ** (layer.gainDb / 20) })));
    const frames = Math.max(...inputs.map(instrument => instrument.start + Math.ceil(instrument.frames * rate / instrument.sampleRate)));
    const channels = Array.from({ length: Math.max(...inputs.map(i => i.channels.length)) }, () => new Float32Array(frames));
    for (const input of inputs) for (const [channel, data] of channels.entries()) {
      const samples = input.channels[channel] ?? input.channels[0];
      for (let i = input.start; i < input.start + Math.ceil(input.frames * rate / input.sampleRate); i++) {
        data[i] += input.gain * interpolate(samples, (i - input.start) * input.sampleRate / rate);
      }
    }
    const { wav, truePeakDb } = peakWav({ sampleRate: rate, channels, frames });
    await write(output, wav);
    return { file: output, truePeakDb, inputs: inputs.map(i => ({ file: i.file, sha256: i.sha256 })) };
  });

  tool('tune_drum', 'Retune a pitched workspace WAV by resampling; duration changes with pitch.', {
    input: schemas.workspaceWav, output: schemas.wavName, fromMidi: midi, toMidi: midi,
  }, async ({ input, output, fromMidi, toMidi }) => {
    if (Math.abs(toMidi - fromMidi) > 24) throw new Error('Retune by at most 24 semitones');
    const audio = await workspaceAudio(root, input);
    const ratio = 2 ** ((toMidi - fromMidi) / 12);
    const frames = Math.max(1, Math.floor(audio.frames / ratio));
    const channels = audio.channels.map(ch => Float32Array.from({ length: frames }, (_, i) => interpolate(ch, i * ratio)));
    const { wav, truePeakDb } = peakWav({ ...audio, frames, channels });
    await write(output, wav);
    return { file: output, truePeakDb, fromMidi, toMidi, inputSha256: audio.sha256 };
  });
  moduleGuidance.push('Use list_drum_kits and create_drum_kit for pure-synth kits (tight-synth, house-synth, electro-synth, 808-synth) or the CC0 acoustic kit (acoustic-cc0), synth_drums for MIT WAV one-shots, fetch_kit for FreePats CC0 WAVs, and build_kit to map WAVs to GM notes.');
}
