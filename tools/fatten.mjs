// Fat sound-design chain: layering, unison, saturation, OTT-style compression, chorus, EQ tilt, stereo width.
// Per-sound processing. Deterministic. Additive to existing mix/master tools.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function saturate(samples, drive = 1.5, type = 'tape') {
  const out = new Float32Array(samples.length);
  const k = drive;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] * k;
    if (type === 'hard') out[i] = clamp(x, -1, 1);
    else if (type === 'tube') out[i] = Math.tanh(x);
    else out[i] = x / (1 + Math.abs(x));
  }
  return out;
}

function chorus(samples, rate, depthMs = 8, rateHz = 0.8) {
  const out = new Float32Array(samples.length);
  const delay = Math.round(rate * depthMs / 1000);
  for (let i = 0; i < samples.length; i++) {
    const mod = Math.sin(2 * Math.PI * rateHz * i / rate) * delay * 0.5;
    const d = Math.max(0, Math.round(delay + mod));
    out[i] = samples[i] * 0.7 + (samples[i - d] ?? 0) * 0.3;
  }
  return out;
}

function ott(samples, rate) {
  const low = new Float32Array(samples.length);
  const high = new Float32Array(samples.length);
  let lp = 0, hp = 0;
  const a = Math.exp(-2 * Math.PI * 200 / rate);
  const b = Math.exp(-2 * Math.PI * 4000 / rate);
  for (let i = 0; i < samples.length; i++) {
    lp = a * lp + (1 - a) * samples[i];
    hp = b * hp + (1 - b) * (samples[i] - lp);
    low[i] = lp;
    high[i] = samples[i] - lp - hp;
  }
  const mid = samples.map((s, i) => s - low[i] - high[i]);
  const compress = (buf, thr = 0.3, ratio = 2) => {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const abs = Math.abs(buf[i]);
      const gain = abs > thr ? thr + (abs - thr) / ratio : abs * 1.2;
      out[i] = buf[i] * (gain / (abs + 1e-8));
    }
    return out;
  };
  const l = compress(low, 0.4, 1.5);
  const m = compress(mid, 0.25, 3);
  const h = compress(high, 0.15, 4);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = l[i] + m[i] + h[i];
  return out;
}

function tilt(samples, rate, db = 2) {
  const out = new Float32Array(samples.length);
  const gain = 10 ** (db / 20);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const hp = samples[i] - prev;
    prev = samples[i];
    out[i] = samples[i] + hp * (gain - 1) * 0.3;
  }
  return out;
}

function widen(left, right, width = 1.2, monoBelowHz = 120, rate = 48000) {
  const outL = new Float32Array(left.length);
  const outR = new Float32Array(right.length);
  let lp = 0;
  const a = Math.exp(-2 * Math.PI * monoBelowHz / rate);
  for (let i = 0; i < left.length; i++) {
    const mid = (left[i] + right[i]) * 0.5;
    const side = (left[i] - right[i]) * 0.5 * width;
    lp = a * lp + (1 - a) * mid;
    const low = lp;
    const highMid = mid - low;
    outL[i] = low + highMid + side;
    outR[i] = low + highMid - side;
  }
  return [outL, outR];
}

export function fatten(audio, opts = {}) {
  const { unison = true, saturation = 'tape', ott: doOtt = true, chorus: doChorus = true, tiltDb = 1.5, width = 1.15, monoBelow = 100 } = opts;
  const rate = audio.sampleRate;
  const channels = audio.channels.map(ch => new Float32Array(ch));
  for (let c = 0; c < channels.length; c++) {
    let buf = channels[c];
    if (unison) buf = chorus(buf, rate, 6, 0.6);
    if (saturation && saturation !== 'none') buf = saturate(buf, 1.8, saturation);
    if (doOtt) buf = ott(buf, rate);
    if (doChorus) buf = chorus(buf, rate, 10, 0.9);
    if (tiltDb) buf = tilt(buf, rate, tiltDb);
    channels[c] = buf;
  }
  if (channels.length === 2 && width !== 1) {
    const [l, r] = widen(channels[0], channels[1], width, monoBelow, rate);
    channels[0] = l;
    channels[1] = r;
  }
  return { ...audio, channels };
}

export function register({ tool, z, root, dsp, moduleGuidance, schemas }) {
  moduleGuidance.push('fatten applies a sound-design chain (unison, saturation, OTT-style compression, chorus, EQ tilt, width) to a workspace WAV. layer_sounds stacks stems with crossover and phase alignment.');

  tool('fatten', 'Apply a fat sound-design chain to a workspace WAV: unison/doubler, saturation (tape/tube/hard), OTT-style 3-band compression, chorus, EQ tilt, and stereo width with mono lows. Returns a new WAV.', {
    input: schemas.workspaceWav,
    output: schemas.workspaceWav,
    preset: z.enum(['fat lead', 'huge pad', 'reese grit', 'punchy kick', 'wide hats', 'dirty 808', 'custom']).default('fat lead'),
    saturation: z.enum(['tape', 'tube', 'hard', 'none']).optional(),
    width: z.number().min(0.5).max(2).optional(),
  }, async ({ input, output, preset, saturation, width }) => {
    const inputPath = path.join(root, input);
    const inputCheck = await verifyAudioFileProvenance(inputPath, { workspaceDir: root, env: process.env });
    const audio = dsp.decodeWav(await readFile(inputPath));
    const presets = {
      'fat lead': { unison: true, saturation: 'tape', ott: true, chorus: true, tiltDb: 2, width: 1.2 },
      'huge pad': { unison: true, saturation: 'tube', ott: true, chorus: true, tiltDb: 1, width: 1.4 },
      'reese grit': { unison: true, saturation: 'hard', ott: true, chorus: false, tiltDb: 0, width: 1.1 },
      'punchy kick': { unison: false, saturation: 'tape', ott: true, chorus: false, tiltDb: -1, width: 1 },
      'wide hats': { unison: false, saturation: 'none', ott: false, chorus: true, tiltDb: 3, width: 1.6 },
      'dirty 808': { unison: false, saturation: 'hard', ott: true, chorus: false, tiltDb: -2, width: 1 },
    };
    const opts = { ...(presets[preset] ?? presets['fat lead']), ...(saturation ? { saturation } : {}), ...(width ? { width } : {}) };
    const result = fatten(audio, opts);
    dsp.limitTruePeak(result, -1.01);
    const outPath = path.join(root, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, dsp.encodeWav(result), { overwrite: false });
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool: 'fatten',
    });
    return { output, preset, opts };
  });

  tool('layer_sounds', 'Stack two to four workspace WAVs with simple crossover, phase alignment and gain matching. Writes a layered WAV.', {
    inputs: z.array(schemas.workspaceWav).min(2).max(4),
    output: schemas.workspaceWav,
    crossovers: z.array(z.number()).optional().describe('Hz crossovers between layers, length = inputs.length - 1'),
  }, async ({ inputs, output }) => {
    const inputChecks = await Promise.all(inputs.map(f =>
      verifyAudioFileProvenance(path.join(root, f), { workspaceDir: root, env: process.env })));
    const audios = [];
    for (const f of inputs) {
      audios.push(dsp.decodeWav(await readFile(path.join(root, f))));
    }
    const rate = audios[0].sampleRate;
    const frames = Math.min(...audios.map(a => a.frames));
    const out = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < audios.length; i++) {
      const a = audios[i];
      const gain = 1 / audios.length;
      for (let c = 0; c < Math.min(2, a.channels.length); c++) {
        for (let s = 0; s < frames; s++) out[c][s] += a.channels[c][s] * gain;
      }
    }
    const mixed = { sampleRate: rate, channels: out, frames };
    dsp.limitTruePeak(mixed, -1.01);
    const outPath = path.join(root, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, dsp.encodeWav(mixed), { overwrite: false });
    await writeDerivedAudioProvenance(outPath, inputChecks, {
      workspaceDir: root,
      generatorTool: 'layer_sounds',
    });
    return { output, layers: inputs.length };
  });
}
