import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeWav, encodeWav, fade, fitLength, slice } from '../audio.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { analyseFrames, ffmpegWorks } from './loop-prep.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

const exec = promisify(execFile);

export async function stretch(audio, factor, root, ffmpeg = process.env.LMMS_FFMPEG ?? 'ffmpeg') {
  if (!(factor >= 0.25 && factor <= 4)) throw new Error('Target/source BPM ratio must be within 0.25–4');
  if (factor === 1) return audio;
  if (!(await ffmpegWorks(ffmpeg))) throw new Error('Time stretching requires ffmpeg. Install it or set LMMS_FFMPEG.');
  const temp = await mkdtemp(path.join(root, '.stretch-'));
  try {
    const input = path.join(temp, 'source.wav');
    const output = path.join(temp, 'stretch.wav');
    const filter = factor < 0.5 || factor > 2 ? `atempo=${Math.sqrt(factor)},atempo=${Math.sqrt(factor)}` : `atempo=${factor}`;
    await writeFile(input, encodeWav(audio));
    await exec(ffmpeg, ['-v', 'error', '-nostdin', '-i', input, '-af', filter, '-c:a', 'pcm_f32le', output],
      { timeout: 120000, windowsHide: true });
    const stretched = decodeWav(await readFile(output));
    if (!stretched.frames) throw new Error('Input is too short for time stretching');
    return fitLength(stretched, Math.round(audio.frames / factor));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function slicePoints(audio, bpm, mode) {
  const points = [0];
  const { frames, sampleRate } = audio;
  if (mode === 'sixteenth') {
    const step = sampleRate * 15 / bpm;
    for (let i = 1; Math.round(i * step) < frames; i++) {
      points.push(Math.round(i * step));
      if (points.length > 128) throw new Error('The break has more than 128 slices');
    }
  } else {
    const { onset, hop } = analyseFrames(audio);
    let peak = 0;
    for (const value of onset) peak = Math.max(value, peak);
    const threshold = peak * 0.18;
    const minGap = Math.round(sampleRate * 0.045);
    for (let i = 1; i + 1 < onset.length; i++) {
      const at = i * hop;
      if (onset[i] <= threshold || onset[i] < onset[i - 1] || onset[i] <= onset[i + 1]) continue;
      if (at - points.at(-1) < minGap || frames - at < minGap) continue;
      points.push(at);
      if (points.length > 128) throw new Error('The break has more than 128 slices');
    }
  }
  return [...points, frames];
}

export function readPattern(pattern, count) {
  if (pattern === undefined) return Array.from({ length: count }, (_, i) => i);
  const tokens = pattern.trim().split(/[ ,]+/);
  if (tokens.length > 128 || tokens.some(token => !/^\d{1,3}$/.test(token) || Number(token) < 1 || Number(token) > count)) {
    throw new Error(`Pattern must contain 1–128 slice numbers in 1–${count}`);
  }
  return tokens.map(token => Number(token) - 1);
}

async function readBreak(root, name, limit) {
  const file = path.join(root, name);
  const inputCheck = await verifyAudioFileProvenance(file, { workspaceDir: root, env: process.env });
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 128 * 1024 ** 2) throw new Error('Expected a regular workspace WAV up to 128 MiB');
  const audio = decodeWav(await readFile(file));
  if (!audio.frames || audio.frames / audio.sampleRate > limit) throw new Error(`Expected a WAV up to ${limit} seconds`);
  return { audio, inputCheck };
}

export function register({ tool, z, root, schemas }) {
  const common = {
    audio: schemas.workspaceWav, sourceBpm: z.number().min(30).max(320), targetBpm: z.number().min(30).max(320),
  };
  tool('time_stretch', 'Change a workspace WAV to a target tempo without transposing it. Output has the exact frame count for the BPM ratio. Requires ffmpeg for tempo changes.', {
    ...common, output: schemas.wavName,
  }, async ({ audio, output, sourceBpm, targetBpm }) => {
    const { audio: decoded, inputCheck } = await readBreak(root, audio, 120);
    const result = await stretch(decoded, targetBpm / sourceBpm, root);
    const outPath = path.join(root, output);
    await writeFileAtomic(outPath, encodeWav(result), { overwrite: false });
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool: 'time_stretch',
    });
    return { file: output, frames: result.frames, sampleRate: result.sampleRate, sourceBpm, targetBpm };
  });

  tool('chop_break', 'Stretch a drum break to a target tempo, slice on sixteenth notes or detected transients and reorder its slices using one-based numbers. Writes individual WAVs and a sequenced WAV with a manifest.', {
    ...common, outputDirectory: schemas.folderName, mode: z.enum(['sixteenth', 'transient']).default('sixteenth'),
    pattern: z.string().max(640).optional(),
  }, async ({ audio, sourceBpm, targetBpm, outputDirectory, mode, pattern }) => {
    const { audio: decoded, inputCheck } = await readBreak(root, audio, 30);
    const stretched = await stretch(decoded, targetBpm / sourceBpm, root);
    const points = slicePoints(stretched, targetBpm, mode);
    const order = readPattern(pattern, points.length - 1);
    const { sampleRate } = stretched;
    const frames = order.reduce((total, i) => total + points[i + 1] - points[i], 0);
    if (frames > sampleRate * 120) throw new Error('The sequenced break exceeds 120 seconds');
    const channels = stretched.channels.map(() => new Float32Array(frames));
    const slices = [];
    const fragments = points.slice(0, -1).map((start, i) => {
      const end = points[i + 1];
      const file = `slice-${String(i + 1).padStart(3, '0')}.wav`;
      slices.push({ file, startFrame: start, endFrame: end });
      const edge = Math.min(Math.round(sampleRate * 0.002), Math.floor((end - start) / 4));
      return fade(slice(stretched, start, end), edge, edge);
    });
    let offset = 0;
    for (const index of order) {
      const fragment = fragments[index];
      channels.forEach((channel, i) => channel.set(fragment.channels[i], offset));
      offset += fragment.frames;
    }
    const directory = path.join(root, outputDirectory);
    const manifest = { directory: outputDirectory, audio: 'sequence.wav', sampleRate, frames, sourceBpm, targetBpm, mode, slices,
      pattern: order.map(i => i + 1) };
    await mkdir(directory);
    try {
      for (let i = 0; i < slices.length; i++) {
        const slicePath = path.join(directory, slices[i].file);
        await writeFileAtomic(slicePath, encodeWav(fragments[i]), { overwrite: false });
        await writeDerivedAudioProvenance(slicePath, [inputCheck], {
          workspaceDir: root,
          generatorTool: 'chop_break',
        });
      }
      const seqPath = path.join(directory, 'sequence.wav');
      await writeFileAtomic(seqPath, encodeWav({ sampleRate, channels }), { overwrite: false });
      await writeDerivedAudioProvenance(seqPath, [inputCheck], {
        workspaceDir: root,
        generatorTool: 'chop_break',
      });
      await writeFileAtomic(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { overwrite: false });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  });
}
