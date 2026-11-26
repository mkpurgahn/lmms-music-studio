// Vocal chops and simple TTS-style syllable rendering.
// Offline, deterministic. Generates short vocal-like chops from phoneme hints
// or slices an existing vocal WAV into rhythmic chops.

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance, writeProvenanceSidecar } from './provenance.mjs';

const vowels = { a: 440, e: 330, i: 550, o: 220, u: 180 };

function renderSyllable(vowel = 'a', duration = 0.25, sampleRate = 48000, formant = 1) {
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  const f0 = vowels[vowel] ?? 440;
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const env = Math.sin(Math.PI * i / frames); // simple envelope
    phase += 2 * Math.PI * f0 * formant / sampleRate;
    out[i] = Math.sin(phase) * env * 0.5 + Math.sin(phase * 2.2) * env * 0.15;
  }
  return out;
}

export function chopVocal(audio, { chops = 8, seed = 1 } = {}) {
  const frames = audio.frames;
  const slice = Math.floor(frames / chops);
  const random = (() => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  const out = [new Float32Array(frames), new Float32Array(frames)];
  for (let c = 0; c < chops; c++) {
    const src = Math.floor(random() * (frames - slice));
    const dest = c * slice;
    for (let ch = 0; ch < Math.min(2, audio.channels.length); ch++) {
      for (let i = 0; i < slice && dest + i < frames; i++) {
        out[ch][dest + i] = audio.channels[ch][src + i] ?? 0;
      }
    }
  }
  return { ...audio, channels: out };
}

export function register({ tool, z, root, dsp, moduleGuidance, schemas }) {
  moduleGuidance.push('render_vocal_chops generates short vocal-like syllables or chops an existing WAV into rhythmic slices. Deterministic.');

  tool('render_vocal_syllable', 'Render a short vocal-like syllable (a/e/i/o/u) to a WAV. Simple formant synthesis.', {
    output: schemas.workspaceWav,
    vowel: z.enum(['a', 'e', 'i', 'o', 'u']).default('a'),
    duration: z.number().min(0.05).max(2).default(0.3),
  }, async ({ output, vowel, duration }) => {
    const samples = renderSyllable(vowel, duration);
    const audio = { sampleRate: 48000, channels: [samples, samples.slice()], frames: samples.length };
    dsp.limitTruePeak(audio, -1.01);
    const outPath = path.join(root, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, dsp.encodeWav(audio), { overwrite: false });
    await writeProvenanceSidecar(outPath, {
      workspaceDir: root,
      classification: 'pure-synthesis',
      generatorTool: 'render_vocal_syllable',
      sources: [{
        kind: 'pure-synthesis',
        pluginOrLibrary: 'vocal-formant-synth',
        licence: 'MIT',
      }],
    });
    return { output, vowel, duration, frames: samples.length };
  });

  tool('chop_vocal', 'Slice a workspace vocal WAV into rhythmic chops. Seeded. Writes a new WAV.', {
    input: schemas.workspaceWav,
    output: schemas.workspaceWav,
    chops: z.number().int().min(2).max(32).default(8),
    seed: z.number().int().default(1),
  }, async ({ input, output, chops, seed }) => {
    const inputPath = path.join(root, input);
    const inputCheck = await verifyAudioFileProvenance(inputPath, { workspaceDir: root, env: process.env });
    const audio = dsp.decodeWav(await readFile(inputPath));
    const chopped = chopVocal(audio, { chops, seed });
    dsp.limitTruePeak(chopped, -1.01);
    const outPath = path.join(root, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, dsp.encodeWav(chopped), { overwrite: false });
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool: 'chop_vocal',
    });
    return { output, chops, seed };
  });
}
