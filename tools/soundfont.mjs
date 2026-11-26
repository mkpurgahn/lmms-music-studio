// SoundFont rendering via FluidSynth. Renders a MIDI file through a .sf2/.sf3 to a workspace WAV.
import { existsSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { runCommandSafe } from './fs-atomic.mjs';
import { resolveSoundfontsDir } from './workspace-config.mjs';

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

export function register({ tool, z, root, paths, moduleGuidance }) {
  moduleGuidance.push('For SoundFont instruments, set LMMS_FLUIDSYNTH (or have fluidsynth on PATH) and call render_soundfont with a workspace MIDI and an .sf2/.sf3. See docs/soundfont.md.');
  const getSoundfontsDir = () => paths?.soundfonts ?? resolveSoundfontsDir(process.env);

  tool('list_soundfonts', 'List .sf2 and .sf3 files visible to render_soundfont (workspace and LMMS_SOUNDFONTS, recursive).', {}, async () => {
    const { readdir } = await import('node:fs/promises');
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
    return { soundfonts: found, soundfontsDirectory: sfDir, note: found.length ? 'Pass the path to render_soundfont.' : 'No SoundFonts found. Place .sf2/.sf3 files in the workspace or under LMMS_SOUNDFONTS.' };
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
