// Native LMMS <sf2player> preset discovery, instrument assignment, and optional FluidSynth MIDI rendering.
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runCommandSafe } from './fs-atomic.mjs';
import { parseSf2Buffer } from './sf2-builder.mjs';
import { PACK_NAMES, TRACKED_LOCK_PATH, loadSoundfontLock } from './soundfont-pack.mjs';
import { ensureLmmsAsciiPath, resolveSoundfontsDir } from './workspace-config.mjs';

const sf2HeaderCache = new Map();

export const sf2PathPattern = /^(?:[a-z0-9][a-z0-9 _.-]{0,79}\/)?[a-z0-9][a-z0-9 _.-]{0,99}\.sf2$/i;

export function resolveSf2Path(relative, { root, soundfontsDir = resolveSoundfontsDir(process.env) } = {}) {
  if (!relative || typeof relative !== 'string') {
    throw new Error('SoundFont path is required');
  }
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('Give the SoundFont relative to LMMS_SOUNDFONTS or the workspace, without .. or absolute paths.');
  }
  if (!/\.sf2$/i.test(relative)) {
    throw new Error(`Expected an .sf2 SoundFont file, got "${relative}"`);
  }
  if (root) {
    const inWorkspace = path.resolve(root, relative);
    if (existsSync(inWorkspace) && !path.relative(root, inWorkspace).startsWith('..')) {
      return { fullPath: inWorkspace, location: 'workspace' };
    }
  }
  if (soundfontsDir) {
    const inLibrary = path.resolve(soundfontsDir, relative);
    if (existsSync(inLibrary) && !path.relative(soundfontsDir, inLibrary).startsWith('..')) {
      return { fullPath: inLibrary, location: 'LMMS_SOUNDFONTS' };
    }
  }
  throw new Error(`SoundFont not found: "${relative}". Install a pack with install_soundfont_pack or place the .sf2 under LMMS_SOUNDFONTS.`);
}

export async function inspectSf2File(fullPath) {
  const resolved = path.resolve(fullPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`SoundFont is not a regular file: ${resolved}`);
  const cacheKey = `${resolved}:${info.size}:${info.mtimeMs}`;
  if (sf2HeaderCache.has(cacheKey)) return sf2HeaderCache.get(cacheKey);

  const raw = await readFile(resolved);
  const parsed = parseSf2Buffer(raw);
  const summary = {
    bytes: info.size,
    bankName: parsed.info.INAM ?? path.basename(resolved, '.sf2'),
    copyright: parsed.info.ICOP ?? null,
    software: parsed.info.ISFT ?? null,
    sampleCount: parsed.samples.length,
    presets: parsed.presets.map(p => ({
      bank: p.bank,
      patch: p.preset,
      name: p.name,
      isDrumBank: p.bank === 128,
    })),
  };
  sf2HeaderCache.set(cacheKey, summary);
  return summary;
}

export async function prepareSf2InstrumentSpec({
  sf2,
  bank = 0,
  patch = 0,
  gain = 1,
  reverb = false,
  chorus = false,
  root,
  soundfontsDir = resolveSoundfontsDir(process.env),
}) {
  const { fullPath, location } = resolveSf2Path(sf2, { root, soundfontsDir });
  const header = await inspectSf2File(fullPath);
  const matched = header.presets.find(p => p.bank === bank && p.patch === patch);
  if (!matched) {
    const available = header.presets.map(p => `bank=${p.bank} patch=${p.patch} ("${p.name}")`).join(', ');
    throw new Error(`SoundFont "${path.basename(fullPath)}" has no preset at bank=${bank} patch=${patch}. Available: ${available || 'none'}`);
  }
  const asciiPath = (await ensureLmmsAsciiPath(fullPath)).replaceAll('\\', '/');
  return {
    sf2,
    fileName: path.basename(fullPath),
    fullPath,
    asciiPath,
    location,
    bank,
    patch,
    gain,
    reverb,
    chorus,
    presetName: matched.name,
  };
}

export function writeSf2PlayerElement(add, children, instrumentTrack, {
  asciiPath,
  bank = 0,
  patch = 0,
  gain = 1,
  reverb = false,
  chorus = false,
}) {
  const hasLinkedIds = node => Boolean(node && Array.from(node.getElementsByTagName('*')).some(child => child.hasAttribute('id')));
  const [previousInstrument] = children(instrumentTrack, 'instrument');
  const [previousEnvelope] = children(instrumentTrack, 'eldata');
  if (hasLinkedIds(previousInstrument) || hasLinkedIds(previousEnvelope)) {
    throw new Error('Existing instrument has linked automation controls');
  }
  if (previousInstrument) instrumentTrack.removeChild(previousInstrument);
  if (previousEnvelope) instrumentTrack.removeChild(previousEnvelope);

  // Empirically verified in LMMS 1.2.2: basenote="57" renders MIDI 60 (<note key="48"/>) at exact C4 (261.6 Hz)
  // and maps Bank 128 drum notes (36 kick, 38 snare, 42 closed hat, 46 open hat) 1:1.
  instrumentTrack.setAttribute('basenote', '57');
  const instNode = add(instrumentTrack, 'instrument', { name: 'sf2player' });
  add(instNode, 'sf2player', {
    src: asciiPath.replaceAll('\\', '/'),
    bank,
    patch,
    gain,
    reverbOn: reverb ? 1 : 0,
    reverbRoomSize: 0.2,
    reverbDamping: 0,
    reverbWidth: 0.5,
    reverbLevel: 0.9,
    chorusOn: chorus ? 1 : 0,
    chorusNum: 3,
    chorusLevel: 2,
    chorusSpeed: 0.3,
    chorusDepth: 8,
  });
}

export function fluidsynthArgs({ midi, soundfont, output, gain = 0.8, sampleRate = 48000, reverb = false, chorus = false, bank, preset }) {
  const args = [
    '-ni',                     // no interactive shell, no MIDI input
    '-g', String(gain),
    '-r', String(sampleRate),
    '-o', 'synth.reverb.active=' + (reverb ? '1' : '0'),
    '-o', 'synth.chorus.active=' + (chorus ? '1' : '0'),
  ];
  if (bank !== undefined) args.push('-o', 'synth.midi-bank-select=gm');
  args.push('-F', output, soundfont, midi);
  return args;
}

export function register({ tool, edit, z, root, paths, project, moduleGuidance }) {
  moduleGuidance.push('For native acoustic instruments in LMMS, call list_sf2_presets to inspect installed CC0 .sf2 SoundFonts, banks, and patch numbers, then use voice: "sf2" in create_project/add_track or call set_sf2_instrument. Use bank: 128, patch: 0 for GM drum SoundFonts such as virtuosity-drums.sf2.');
  const getSoundfontsDir = () => paths?.soundfonts ?? resolveSoundfontsDir(process.env);

  tool('list_sf2_presets', 'List installed .sf2 SoundFonts in LMMS_SOUNDFONTS and the workspace along with every bank, patch number, preset name, and lockfile provenance.', {
    sf2: z.string().regex(sf2PathPattern).optional().describe('Optional .sf2 relative path to inspect a single SoundFont.'),
  }, async ({ sf2 }) => {
    const sfDir = getSoundfontsDir();
    const trackedLock = await loadSoundfontLock(TRACKED_LOCK_PATH).catch(() => null);
    const localLock = sfDir ? await loadSoundfontLock(path.join(sfDir, 'soundfont-lock.json')).catch(() => null) : null;
    const lockByFile = new Map();
    for (const source of [trackedLock?.soundfonts, localLock?.soundfonts]) {
      for (const entry of Object.values(source ?? {})) {
        if (entry?.fileName) lockByFile.set(entry.fileName.toLowerCase(), entry);
      }
    }

    const candidates = [];
    if (sf2) {
      const resolved = resolveSf2Path(sf2, { root, soundfontsDir: sfDir });
      candidates.push({ rel: sf2.replaceAll('\\', '/'), fullPath: resolved.fullPath, location: resolved.location });
    } else {
      const seenFull = new Set();
      const scanDir = async (dir, label, prefix = '') => {
        if (!dir || !existsSync(dir)) return;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = path.resolve(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.') && rel.split('/').length < 4) {
            await scanDir(full, label, rel);
          } else if (entry.isFile() && /\.sf2$/i.test(entry.name) && !seenFull.has(full.toLowerCase())) {
            seenFull.add(full.toLowerCase());
            candidates.push({ rel, fullPath: full, location: label });
          }
        }
      };
      await scanDir(sfDir, 'LMMS_SOUNDFONTS');
      await scanDir(root, 'workspace');
    }

    const soundfonts = [];
    for (const item of candidates) {
      const header = await inspectSf2File(item.fullPath);
      const lockEntry = lockByFile.get(path.basename(item.fullPath).toLowerCase()) ?? null;
      soundfonts.push({
        sf2: item.rel,
        location: item.location,
        bankName: header.bankName,
        licence: lockEntry?.licence ?? header.copyright ?? 'unknown',
        verifiedCc0: lockEntry?.licence === 'CC0-1.0',
        pack: lockEntry?.pack ?? null,
        sha256: lockEntry?.sf2Sha256 ?? null,
        bytes: header.bytes,
        sampleCount: header.sampleCount,
        presets: header.presets,
      });
    }

    return {
      soundfontsDirectory: sfDir,
      count: soundfonts.length,
      soundfonts,
      availablePacks: PACK_NAMES,
      note: soundfonts.length
        ? 'Pass sf2, bank, and patch to voice: "sf2" in create_project/add_track or to set_sf2_instrument.'
        : 'No .sf2 SoundFonts installed yet. Run install_soundfont_pack({ pack: "core" }) or ./setup-libraries-windows.ps1 -Pack core.',
    };
  });

  if (edit && project) {
    edit('set_sf2_instrument', 'Assign an .sf2 SoundFont preset (bank and patch) to an existing LMMS instrument track using native sf2player.', {
      trackName: z.string().min(1).max(100),
      sf2: z.string().regex(sf2PathPattern).describe('Relative .sf2 path in LMMS_SOUNDFONTS or workspace.'),
      bank: z.number().int().min(0).max(128).default(0).describe('MIDI bank number (0 for melodic, 128 for GM drums).'),
      patch: z.number().int().min(0).max(127).default(0).describe('MIDI patch/preset number (0-127).'),
      gain: z.number().min(0.05).max(5).default(1).describe('sf2player output gain (0.05-5).'),
      reverb: z.boolean().default(false),
      chorus: z.boolean().default(false),
    }, async (doc, { trackName, sf2, bank, patch, gain, reverb, chorus }) => {
      const target = project.instrumentOf(doc, trackName);
      const prepared = await prepareSf2InstrumentSpec({
        sf2,
        bank,
        patch,
        gain,
        reverb,
        chorus,
        root,
        soundfontsDir: getSoundfontsDir(),
      });
      writeSf2PlayerElement(project.add, project.children, target, prepared);
      return {
        sf2: prepared.sf2,
        presetName: prepared.presetName,
        bank: prepared.bank,
        patch: prepared.patch,
        gain: prepared.gain,
      };
    });
  }

  tool('list_soundfonts', 'List .sf2 and .sf3 files visible to native sf2player and render_soundfont (workspace and LMMS_SOUNDFONTS, recursive).', {}, async () => {
    const found = [];
    const scan = async (dir, label, base = '') => {
      if (!dir || !existsSync(dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + entry.name : entry.name;
        if (entry.isDirectory() && !entry.name.startsWith('.') && rel.split('/').length < 6) await scan(path.join(dir, entry.name), label, rel);
        else if (entry.isFile() && /\.sf[23]$/i.test(entry.name)) found.push({ path: rel, location: label });
      }
    };
    const sfDir = getSoundfontsDir();
    await scan(root, 'workspace');
    await scan(sfDir, 'LMMS_SOUNDFONTS');
    return { soundfonts: found, soundfontsDirectory: sfDir, note: found.length ? 'Use list_sf2_presets for banks/patches, voice: "sf2" for native LMMS tracks, or render_soundfont for FluidSynth.' : 'No SoundFonts found. Call install_soundfont_pack({ pack: "core" }) or place .sf2/.sf3 files under LMMS_SOUNDFONTS.' };
  });

  tool('render_soundfont', 'Render a MIDI file through a SoundFont (.sf2 or .sf3) using FluidSynth. Writes a WAV into the workspace. Requires fluidsynth on PATH or LMMS_FLUIDSYNTH. Optional bank and preset select the instrument.', {
    midi: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i).describe('MIDI file in the workspace.'),
    soundfont: z.string().min(5).max(400).regex(/\.sf[23]$/i).describe('Path to the .sf2 or .sf3. Relative to the workspace or LMMS_SOUNDFONTS.'),
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i).describe('Output WAV name in the workspace.'),
    gain: z.number().min(0.1).max(2).default(0.8).describe('FluidSynth gain (0.1-2).'),
    sampleRate: z.number().int().min(22050).max(96000).default(48000),
    reverb: z.boolean().default(false),
    chorus: z.boolean().default(false),
    bank: z.number().int().min(0).max(128).optional().describe('Reserved. MIDI program-change events in the file are honoured. Bank selection via this argument is not yet implemented.'),
    preset: z.number().int().min(0).max(127).optional().describe('Reserved. Put a program-change event in the MIDI for reliable instrument selection.'),
    timeoutSeconds: z.number().int().min(10).max(600).default(180),
  }, async ({ midi, soundfont, output, gain, sampleRate, reverb, chorus, bank, preset, timeoutSeconds }) => {
    const fluidsynth = process.env.LMMS_FLUIDSYNTH || 'fluidsynth';
    const midiPath = path.join(root, midi);
    if (!(await lstat(midiPath).catch(() => null))?.isFile()) throw new Error(`MIDI file not found in workspace: ${midi}`);

    const sfDir = getSoundfontsDir();
    const resolveSoundfont = relative => {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Give the SoundFont relative to the workspace or LMMS_SOUNDFONTS, without .. or absolute paths.');
      const inWorkspace = path.resolve(root, relative);
      const inLibrary = sfDir ? path.resolve(sfDir, relative) : null;
      if (existsSync(inWorkspace) && path.relative(root, inWorkspace).startsWith('..') === false) return inWorkspace;
      if (inLibrary && existsSync(inLibrary) && !path.relative(sfDir, inLibrary).startsWith('..')) return inLibrary;
      throw new Error(`SoundFont not found: ${relative}. Place it in the workspace or under LMMS_SOUNDFONTS.`);
    };
    const sfPath = resolveSoundfont(soundfont);
    if (!(await lstat(sfPath).catch(() => null))?.isFile()) throw new Error(`SoundFont is not a file: ${sfPath}`);

    const outPath = path.join(root, output);
    if (existsSync(outPath)) throw new Error('Output already exists');

    const args = fluidsynthArgs({ midi: midiPath, soundfont: sfPath, output: outPath, gain, sampleRate, reverb, chorus, bank, preset });
    try {
      await runCommandSafe(fluidsynth, args, { timeoutMs: timeoutSeconds * 1000 });
    } catch (error) {
      await Promise.allSettled([rm(outPath, { force: true })]);
      if (error.code === 'ENOENT') throw new Error(`FluidSynth not found (${fluidsynth}). Install it or set LMMS_FLUIDSYNTH.`);
      throw new Error('FluidSynth failed: ' + (error.stderr || error.message).toString().trim().split(/\r?\n/).slice(-3).join(' | '));
    }
    if (!existsSync(outPath)) throw new Error('FluidSynth ran but did not write the output WAV');
    return { output, soundfont: path.basename(sfPath), midi, sampleRate, gain, reverb, chorus, bank: bank ?? null, preset: preset ?? null, note: 'WAV is in the workspace. MIDI program changes are honoured. You can load it as a sample track or analyse it with analyze_audio.' };
  });
}

