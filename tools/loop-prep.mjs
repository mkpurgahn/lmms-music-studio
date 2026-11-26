// Loop preparation for any finished audio file, including music made outside LMMS.
// find_loop_points proposes loop regions; prepare_loop writes loop and intro files with a manifest.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as dsp from '../audio.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

const run = promisify(execFile);
const round = (value, places = 3) => Number(value.toFixed(places));
const lowSeamScore = 0.7, lowTempoConfidence = 0.3, refineCount = 12;

// ---------- decoding ----------
const ffmpegPath = () => process.env.LMMS_FFMPEG ?? 'ffmpeg';
export async function ffmpegWorks(ffmpeg = ffmpegPath()) {
  return run(ffmpeg, ['-version'], { windowsHide: true, timeout: 15000 }).then(() => true, () => false);
}
async function ffmpegDecode(file, ffmpeg, downmix, tempRoot) {
  const temp = await mkdtemp(path.join(tempRoot, '.decode-'));
  try {
    const out = path.join(temp, 'decoded.wav');
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-vn', ...(downmix ? ['-ac', '2'] : []), '-c:a', 'pcm_f32le', out],
      { windowsHide: true, timeout: 300000 });
    return dsp.decodeWav(await readFile(out));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
// Decode WAV directly; MP3, OGG, FLAC (and WAV formats audio.mjs cannot read) through ffmpeg. Keeps the source sample
// rate. ffmpeg writes into a dot folder under `tempRoot` (the workspace, from the tools), removed afterwards.
export async function decodeAudioFile(file, { ffmpeg = ffmpegPath(), available, tempRoot = path.dirname(file) } = {}) {
  if (!existsSync(file)) throw new Error(`File not found: ${path.basename(file)}`);
  const wav = file.toLowerCase().endsWith('.wav');
  let direct;
  if (wav) {
    try { return { audio: dsp.decodeWav(await readFile(file)), decoder: 'wav' }; } catch (error) { direct = error; }
  }
  if (!(available ?? await ffmpegWorks(ffmpeg))) {
    if (direct) throw new Error(`${direct.message}. ffmpeg could convert it, but it was not found. Install ffmpeg or set LMMS_FFMPEG to its path.`);
    throw new Error('Reading MP3, OGG and FLAC files needs ffmpeg. Install it or set LMMS_FFMPEG to its path, or convert the file to WAV.');
  }
  try {
    return { audio: await ffmpegDecode(file, ffmpeg, false, tempRoot), decoder: 'ffmpeg' };
  } catch (error) {
    if (/mono or stereo/.test(error.message)) return { audio: await ffmpegDecode(file, ffmpeg, true, tempRoot), decoder: 'ffmpeg (downmixed to stereo)' };
    throw new Error('ffmpeg could not decode the file: ' + (error.stderr?.toString().trim() || error.message));
  }
}

// ---------- analysis ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}
export function mixMono(audio) {
  if (audio.channels.length === 1) return audio.channels[0];
  const out = new Float32Array(audio.frames), scale = 1 / audio.channels.length;
  for (const ch of audio.channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] * scale;
  return out;
}
const bandCount = 16, silentDb = -70;
function bandBins(size, sampleRate) {
  const low = 40, high = Math.min(16000, sampleRate * 0.45), hz = sampleRate / size;
  return Array.from({ length: bandCount + 1 }, (_, i) => Math.max(1, Math.round(low * (high / low) ** (i / bandCount) / hz)));
}
const hannOf = size => Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));

// One short-time pass: an onset envelope (spectral flux, 10 ms hop) and band levels in dB (20 ms frames).
export function analyseFrames(audio) {
  const sampleRate = audio.sampleRate, signal = mixMono(audio);
  const hop = Math.max(1, Math.round(sampleRate / 100));
  let size = 256;
  while (size < sampleRate * 0.02) size <<= 1;
  const window = hannOf(size), edges = bandBins(size, sampleRate);
  const fluxTop = Math.min(size / 2, Math.round(8000 / (sampleRate / size)));
  const count = Math.max(1, Math.floor(signal.length / hop));
  const re = new Float64Array(size), im = new Float64Array(size);
  const previous = new Float64Array(size / 2), onset = new Float32Array(count);
  const power = new Float64Array(count * bandCount);
  for (let f = 0; f < count; f++) {
    const at = f * hop - size / 2; // frame f is centred on sample f * hop
    for (let i = 0; i < size; i++) { re[i] = (signal[at + i] ?? 0) * window[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < size / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k < fluxTop) {
        const level = Math.log1p(1000 * Math.sqrt(p) / size);
        if (level > previous[k]) flux += level - previous[k];
        previous[k] = level;
      }
    }
    onset[f] = flux;
    for (let b = 0; b < bandCount; b++) {
      let sum = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) sum += re[k] * re[k] + im[k] * im[k];
      power[f * bandCount + b] = sum;
    }
  }
  // Pairs of analysis frames make 20 ms feature frames.
  const featureCount = Math.max(1, Math.floor(count / 2));
  const scale = 4 / (window.reduce((s, v) => s + v * v, 0) * size);
  const bands = new Float32Array(featureCount * bandCount), level = new Float32Array(featureCount);
  for (let f = 0; f < featureCount; f++) {
    let total = 0;
    for (let b = 0; b < bandCount; b++) {
      const p = (power[2 * f * bandCount + b] + (power[(2 * f + 1) * bandCount + b] ?? 0)) / 2 * scale;
      total += p;
      bands[f * bandCount + b] = p > 1e-12 ? 10 * Math.log10(p) : -120;
    }
    level[f] = total > 1e-12 ? 10 * Math.log10(total) : -120;
  }
  return { sampleRate, hop, frameRate: sampleRate / hop, onset, featureHop: hop * 2, featureRate: sampleRate / (hop * 2), bands, level, featureCount };
}

// Similarity of two feature frames, 0 to 1. Silence carries no evidence, so two silent frames score 0.
function frameSimilarity(bands, level, a, b) {
  const top = Math.max(level[a], level[b]);
  if (top < silentDb) return 0;
  const floor = top - 60;
  let d = 0;
  for (let k = 0; k < bandCount; k++) d += Math.abs(Math.max(bands[a * bandCount + k], floor) - Math.max(bands[b * bandCount + k], floor));
  return Math.exp(-d / bandCount / 6);
}

function parabolic(values, i) {
  const l = values[i - 1], c = values[i], r = values[i + 1];
  if (l === undefined || r === undefined) return i;
  const denominator = l - 2 * c + r;
  return denominator ? i + 0.5 * (l - r) / denominator : i;
}
// Tempo and beat grid from an onset envelope. Returns bpm, the beat period and first beat in envelope frames, and a 0 to 1 confidence.
export function detectTempo(onset, frameRate, { minBpm = 60, maxBpm = 200, bpm: hint } = {}) {
  const n = onset.length, reach = Math.round(frameRate * 0.1);
  const novelty = new Float64Array(n);
  let running = 0;
  for (let i = 0; i < Math.min(n, reach); i++) running += onset[i];
  for (let i = 0, count = Math.min(n, reach); i < n; i++) {
    if (i + reach < n) { running += onset[i + reach]; count++; }
    if (i - reach - 1 >= 0) { running -= onset[i - reach - 1]; count--; }
    novelty[i] = Math.max(0, onset[i] - running / count);
  }
  const mean = novelty.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const centred = novelty.map(v => v - mean);
  const maxLag = Math.min(n - 1, Math.round(frameRate * 30));
  const r = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1 && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += centred[i] * centred[i + lag];
    r[lag] = sum / (n - lag);
  }
  const low = Math.max(2, Math.floor(60 * frameRate / maxBpm)), high = Math.min(maxLag, Math.ceil(60 * frameRate / minBpm));
  if (r[0] <= 0 || (!hint && high <= low)) {
    if (!hint) return { bpm: null, confidence: 0, source: 'none', periodFrames: null, firstBeatFrame: 0, alternatives: [] };
    const period = 60 * frameRate / hint;
    return { bpm: round(hint, 2), confidence: 0, source: 'hint', hintBpm: hint, periodFrames: period, firstBeatFrame: 0, alternatives: [] };
  }
  // The strongest autocorrelation peak near a lag (within `width` frames).
  const peakNear = (lag, width) => {
    let peak = Math.max(1, Math.round(lag) - width);
    for (let at = peak; at <= Math.min(maxLag, Math.round(lag) + width); at++) if (r[at] > r[peak]) peak = at;
    return peak;
  };
  // Refine a period against its later multiples: their positions pin the period far more precisely than one peak.
  const refine = start => {
    let sxy = start, sxx = 1;
    for (let k = 2; k * start < maxLag - 2; k++) {
      const guess = k * sxy / sxx, peak = peakNear(guess, Math.max(2, Math.ceil(guess * 0.01)));
      if (r[peak] <= 0 || peak <= 1 || peak >= maxLag) continue;
      const weight = r[peak] / r[0];
      sxy += k * parabolic(r, peak) * weight; sxx += k * k * weight;
    }
    return sxy / sxx;
  };
  const range = [];
  for (let lag = Math.max(2, Math.min(low, high)); lag <= Math.max(low, high); lag++) range.push(r[lag]);
  range.sort((a, b) => a - b);
  const median = range[range.length >> 1] ?? 0;
  const confidenceAt = lag => Math.max(0, Math.min(1, (r[lag] - median) / (r[0] - median)));
  let period, confidence, source, best;
  if (hint) {
    // A hint is a starting point: take the autocorrelation peak within 4% of it, if there is a real one.
    const guess = 60 * frameRate / hint;
    best = peakNear(guess, Math.max(2, Math.ceil(guess * 0.04)));
    if (confidenceAt(best) >= lowTempoConfidence && Math.abs(best - guess) < guess * 0.04) { period = refine(parabolic(r, best)); source = 'hint, refined'; }
    else { period = guess; source = 'hint'; best = Math.round(guess); }
    confidence = confidenceAt(Math.round(period));
  } else {
    let bestScore = -Infinity;
    best = low;
    for (let lag = low; lag <= high; lag++) {
      const prior = Math.exp(-0.5 * Math.log2(60 * frameRate / lag / 120) ** 2);
      if (r[lag] * prior > bestScore && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestScore = r[lag] * prior; best = lag; }
    }
    confidence = confidenceAt(best);
    period = refine(parabolic(r, best));
    source = 'detected';
  }
  // Half and double tempo. Autocorrelation cannot tell a beat from a half-time feel, so say when the other reading is
  // plausible: a slow reading with strong onsets halfway between beats, or a fast reading whose every other beat is as
  // strong as the beat itself.
  const bpm = 60 * frameRate / period, alternatives = [];
  const half = r[peakNear(period / 2, 2)] / r[best], double = r[peakNear(period * 2, 2)] / r[best];
  if (bpm < 105 && bpm * 2 <= 260 && half >= 0.5) alternatives.push({ bpm: round(bpm * 2, 2), relation: 'double', strength: round(Math.min(1, half), 2) });
  if (bpm > 130 && bpm / 2 >= 40 && double >= 0.5) alternatives.push({ bpm: round(bpm / 2, 2), relation: 'half', strength: round(Math.min(1, double), 2) });
  // Beat phase: the offset whose grid collects the most onset energy.
  let firstBeatFrame = 0, phaseScore = -1;
  for (let offset = 0; offset < Math.ceil(period); offset++) {
    let sum = 0;
    for (let t = offset; t < n; t += period) sum += novelty[Math.round(t)] ?? 0;
    if (sum > phaseScore) { phaseScore = sum; firstBeatFrame = offset; }
  }
  return { bpm: round(bpm, 2), confidence: round(confidence, 2), source, ...(hint ? { hintBpm: hint } : {}), periodFrames: period, firstBeatFrame, alternatives };
}

// Bar counts worth trying: every length to 16 bars, then multiples of four.
export function barCounts(minBars = 1, maxBars = 64) {
  const counts = [];
  for (let n = Math.max(1, minBars); n <= maxBars; n++) if (n <= 16 || n % 4 === 0) counts.push(n);
  return counts;
}

// Mean feature similarity over one bar on the side of the seam that exists: after the start against after the end,
// or (when the loop ends at the end of the file) before the start against before the end.
function continuation(features, start, lag, window) {
  const { bands, level, featureCount: count } = features;
  let from, side;
  if (start + lag + window <= count) { from = start; side = 'after'; }
  else if (start - window >= 0 && start + lag <= count) { from = start - window; side = 'before'; }
  else return null;
  let sum = 0;
  for (let t = from; t < from + window; t++) sum += frameSimilarity(bands, level, t, t + lag);
  return { score: sum / window, side };
}

function correlation(signal, a, b, length) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < length; i++) { const x = signal[a + i], y = signal[b + i]; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
// First difference: tilts the signal towards transients, so matching locks onto drum hits rather than the phase of a
// low tone, which can line up equally well a few milliseconds either side.
export function highPass(signal) {
  const out = new Float32Array(signal.length);
  for (let i = 1; i < signal.length; i++) out[i] = signal[i] - signal[i - 1];
  return out;
}
// Find the loop length, near a first guess, at which the audio repeats most exactly. Coarse search on a decimated
// signal, then sample-accurate at full rate. Below `floor` the repeat is too loose to trust the match, so the guess is
// returned unchanged with `refined: false`.
export function refineLength(mono, sampleRate, start, length, { reachSeconds = 0.045, floor = 0.5 } = {}) {
  const total = mono.length, reach = Math.ceil(reachSeconds * sampleRate);
  let span = Math.min(length, Math.round(2 * sampleRate));
  let side;
  if (start + length + reach + span <= total) side = 'after';
  else {
    span = Math.min(span, start, length - reach);
    if (span >= sampleRate * 0.25 && start + length + reach <= total) side = 'before';
    else {
      span = Math.min(Math.round(2 * sampleRate), total - start - length - reach);
      if (span < sampleRate * 0.25) return { length, correlation: null, refined: false, side: null };
      side = 'after';
    }
  }
  const a = side === 'after' ? start : start - span, b = a + length;
  const factor = Math.max(1, Math.round(sampleRate / 6000));
  const decimated = new Float32Array(Math.floor(total / factor));
  for (let i = 0; i < decimated.length; i++) { let s = 0; for (let j = 0; j < factor; j++) s += mono[i * factor + j]; decimated[i] = s / factor; }
  const da = Math.floor(a / factor), db = Math.floor(b / factor), dspan = Math.floor(span / factor), dreach = Math.ceil(reach / factor);
  let coarse = 0, coarseScore = -Infinity;
  for (let off = -dreach; off <= dreach; off++) {
    if (db + off < 0 || db + off + dspan > decimated.length) continue;
    const c = correlation(decimated, da, db + off, dspan);
    if (c > coarseScore) { coarseScore = c; coarse = off; }
  }
  const fineSpan = Math.min(span, Math.round(sampleRate));
  let best = coarse * factor, bestScore = -Infinity;
  for (let off = coarse * factor - 2 * factor; off <= coarse * factor + 2 * factor; off++) {
    if (b + off < 0 || b + off + fineSpan > total || Math.abs(off) > reach + 2 * factor) continue;
    const c = correlation(mono, a, b + off, fineSpan);
    if (c > bestScore) { bestScore = c; best = off; }
  }
  if (!(bestScore >= floor)) return { length, correlation: Number.isFinite(bestScore) ? round(bestScore, 4) : null, refined: false, side };
  return { length: length + best, correlation: round(bestScore, 4), refined: true, side };
}

function bandVector(signal, start, length, sampleRate) {
  let size = 256;
  while (size < length) size <<= 1;
  const re = new Float64Array(size), im = new Float64Array(size), window = hannOf(length), edges = bandBins(size, sampleRate);
  for (let i = 0; i < length; i++) re[i] = (signal[start + i] ?? 0) * window[i];
  fft(re, im);
  const bands = new Float32Array(bandCount);
  let total = 0;
  for (let b = 0; b < bandCount; b++) {
    let sum = 0;
    for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) sum += re[k] * re[k] + im[k] * im[k];
    sum *= 4 / (length * length);
    total += sum;
    bands[b] = sum > 1e-12 ? 10 * Math.log10(sum) : -120;
  }
  return { bands, level: total > 1e-12 ? 10 * Math.log10(total) : -120 };
}
// Score a loop region [start, end) of the source. Playing the loop, the listener hears the loop end and then the loop
// start; in the original, the loop end ran on into what follows it. So the 50 ms just after the seam (the loop start) are
// compared, in spectrum and waveform, with the 50 ms that follow the loop end in the original. When the loop ends at the
// end of the file, the 50 ms before the loop end are compared with the 50 ms before the loop start instead. One bar of
// continuation, measured the same way on 20 ms band levels, carries the most weight.
export function scoreSeam(audio, features, mono, start, end) {
  const sampleRate = audio.sampleRate, window = Math.round(sampleRate * 0.05);
  let pair = null, judgedFrom = 'nothing';
  if (end + window <= audio.frames) { pair = [start, end]; judgedFrom = 'after the seam'; }
  else if (start - window >= 0) { pair = [start - window, end - window]; judgedFrom = 'before the seam'; }
  let spectrum = null, waveform = null;
  if (pair) {
    const [a, b] = pair;
    const x = bandVector(mono, a, window, sampleRate), y = bandVector(mono, b, window, sampleRate);
    spectrum = frameSimilarity(new Float32Array([...x.bands, ...y.bands]), new Float32Array([x.level, y.level]), 0, 1);
    waveform = Math.max(0, correlation(mono, a, b, window));
  }
  const lag = Math.round((end - start) / features.featureHop), from = Math.round(start / features.featureHop);
  const bar = features.barFeatureFrames ?? Math.round(features.featureRate * 2);
  const cont = continuation(features, from, lag, Math.max(1, Math.min(bar, lag)));
  const parts = [[cont?.score, 0.5], [spectrum, 0.3], [waveform, 0.2]].filter(([v]) => v !== null && v !== undefined);
  const weight = parts.reduce((s, [, w]) => s + w, 0);
  const score = weight ? parts.reduce((s, [v, w]) => s + v * w, 0) / weight : 0;
  return { seamScore: round(score), scores: { continuation: cont ? round(cont.score) : null, spectrum: spectrum === null ? null : round(spectrum),
    waveform: waveform === null ? null : round(waveform) }, judgedFrom };
}

// Propose loop regions at whole numbers of bars. Pure: takes decoded audio, returns tempo and ranked candidates.
export function findLoops(audio, { bpm, beatsPerBar = 4, minBars = 1, maxBars = 64, count = 5 } = {}) {
  const features = analyseFrames(audio);
  const tempo = detectTempo(features.onset, features.frameRate, { bpm });
  const sampleRate = audio.sampleRate, duration = audio.frames / sampleRate;
  const result = { durationSeconds: round(duration, 4), sampleRate, channels: audio.channels.length,
    tempo: { bpm: tempo.bpm, confidence: tempo.confidence, source: tempo.source, beatsPerBar,
      firstBeatSeconds: tempo.periodFrames ? round(tempo.firstBeatFrame / features.frameRate, 4) : null } };
  result.tempo.alternatives = tempo.alternatives ?? [];
  if (tempo.hintBpm) result.tempo.hintBpm = tempo.hintBpm;
  if (!tempo.periodFrames) return { ...result, candidates: [], needsHumanChoice: true, advice: 'No beat was found. Pass bpm, or give prepare_loop explicit startSeconds and endSeconds.' };
  const total = features.featureCount, mono = mixMono(audio), hop = features.featureHop;
  // Search the main tempo and any plausible half or double tempo, so bar counts are offered at both readings.
  const grids = [{ bpm: tempo.bpm, period: tempo.periodFrames, first: tempo.firstBeatFrame },
    ...result.tempo.alternatives.map(alt => {
      const period = tempo.periodFrames * tempo.bpm / alt.bpm;
      return { bpm: alt.bpm, period, first: tempo.firstBeatFrame % period };
    })];
  const coarse = [];
  for (const [gridIndex, grid] of grids.entries()) {
    const beat = grid.period / 2, bar = beat * beatsPerBar; // in 20 ms feature frames
    const starts = [];
    for (let t = grid.first / 2; t < total; t += beat) starts.push(Math.round(t));
    const window = Math.max(1, Math.round(bar));
    for (const n of barCounts(minBars, maxBars)) {
      const nominal = n * bar;
      if (nominal + window * 0.5 > total) break;
      const spread = Math.ceil(nominal * 0.004) + 1;
      let best = null;
      for (let lag = Math.round(nominal) - spread; lag <= Math.round(nominal) + spread; lag++) {
        if (lag < 1 || lag >= total) continue;
        const similar = new Float64Array(total - lag + 1);
        for (let t = 0; t < total - lag; t++) similar[t + 1] = similar[t] + frameSimilarity(features.bands, features.level, t, t + lag);
        const mean = (from, to) => (similar[to] - similar[from]) / (to - from);
        let top = -1, choice = null;
        const scored = [];
        for (const s of starts) {
          if (s + lag > total) break;
          let score;
          if (s + lag + window <= total) score = mean(s, s + window);
          else if (s - window >= 0) score = mean(s - window, s);
          else continue;
          scored.push([s, score]);
          if (score > top) top = score;
        }
        // Earliest start that is as good as the best, so a repeated section begins where the repetition does.
        for (const [s, score] of scored) if (score >= top - 0.02) { choice = s; break; }
        if (choice !== null && (!best || top > best.score)) best = { n, lag, start: choice, score: top, gridIndex, barFrames: Math.round(bar) };
      }
      if (best) coarse.push(best);
    }
  }
  coarse.sort((a, b) => b.score - a.score || a.gridIndex - b.gridIndex);
  const matchSignal = highPass(mono);
  const refined = [];
  // Always refine the same number, whatever `count` is, so ranks agree between find_loop_points and prepare_loop.
  for (const c of coarse.slice(0, refineCount)) {
    const grid = grids[c.gridIndex];
    const start = Math.min(audio.frames - 1, Math.round(c.start * hop));
    const gridLength = Math.round(c.n * beatsPerBar * grid.period * features.hop);
    // Start from the lag the search measured; the beat grid is the fallback when the repeat is too loose to match.
    const fit = refineLength(matchSignal, sampleRate, start, Math.min(Math.round(c.lag * hop), audio.frames - start));
    const length = fit.refined ? fit.length : Math.min(gridLength, audio.frames - start);
    const end = Math.min(audio.frames, start + length);
    if (refined.some(r => Math.abs(r.startFrame - start) < sampleRate * 0.03 && Math.abs(r.endFrame - end) < sampleRate * 0.03)) continue;
    features.barFeatureFrames = c.barFrames;
    const seam = scoreSeam(audio, features, mono, start, end);
    refined.push({ bars: c.n, gridIndex: c.gridIndex, startFrame: start, endFrame: end, repeatCorrelation: fit.correlation,
      lengthFrom: fit.refined ? 'repeat match' : 'beat grid', ...seam });
  }
  features.barFeatureFrames = Math.round(tempo.periodFrames / 2 * beatsPerBar);
  // Best seam first; among near ties, the longer loop (less repetition in game).
  const seconds = c => (c.endFrame - c.startFrame) / sampleRate;
  refined.sort((a, b) => Math.abs(a.seamScore - b.seamScore) <= 0.02 ? seconds(b) - seconds(a) || a.gridIndex - b.gridIndex : b.seamScore - a.seamScore);
  const candidates = refined.slice(0, count).map((c, index) => {
    const grid = grids[c.gridIndex], beatSeconds = grid.period / features.frameRate, firstBeat = grid.first / features.frameRate;
    const start = c.startFrame / sampleRate, end = c.endFrame / sampleRate, length = c.endFrame - c.startFrame;
    return { rank: index + 1, startSeconds: round(start, 4), endSeconds: round(end, 4), lengthSeconds: round(length / sampleRate, 4),
      startFrame: c.startFrame, endFrame: c.endFrame, lengthFrames: length, bars: c.bars, barsAtBpm: grid.bpm,
      ...(c.gridIndex ? { tempoReading: grid.bpm > tempo.bpm ? 'double' : 'half' } : {}),
      startBar: round((start - firstBeat) / (beatSeconds * beatsPerBar), 2), endBar: round((end - firstBeat) / (beatSeconds * beatsPerBar), 2),
      bpmFromLength: round(c.bars * beatsPerBar * 60 / (length / sampleRate), 2),
      seamScore: c.seamScore, scores: c.scores, judgedFrom: c.judgedFrom, repeatCorrelation: c.repeatCorrelation, lengthFrom: c.lengthFrom,
      intro: start >= 0.1, introSeconds: round(start, 4), afterLoopSeconds: round((audio.frames - c.endFrame) / sampleRate, 4) };
  });
  const reasons = [];
  if (tempo.source === 'detected' && tempo.confidence < lowTempoConfidence) reasons.push(`the beat is unclear (tempo confidence ${tempo.confidence})`);
  if (!candidates.length) reasons.push('no whole-bar loop fits in the file');
  else if (candidates[0].seamScore < lowSeamScore) reasons.push(`the best seam score is only ${candidates[0].seamScore}`);
  const notes = [];
  if (candidates[0]?.lengthFrom === 'beat grid') notes.push('The repeats are not close enough to match sample by sample, so the best loop length comes from the beat grid: listen to the seam.');
  if (result.tempo.alternatives.length) {
    notes.push(`The tempo may be ${result.tempo.alternatives.map(a => `${a.bpm} bpm (${a.relation})`).join(' or ')} rather than ${tempo.bpm} bpm; candidates are offered at both readings, and bar counts follow barsAtBpm. Loop lengths in seconds do not depend on this.`);
  }
  // Equally good shorter lengths mean the music repeats more often than the chosen loop.
  const ties = refined.filter(c => c.seamScore >= (refined[0]?.seamScore ?? 1) - 0.02 && c.gridIndex === refined[0].gridIndex);
  const shortest = ties.length ? Math.min(...ties.map(c => c.bars)) : null;
  if (candidates.length && shortest < candidates[0].bars) notes.push(`The music also repeats every ${shortest} bars; pass maxBars: ${shortest} for a shorter loop file.`);
  return { ...result, candidates, needsHumanChoice: reasons.length > 0,
    advice: [reasons.length
      ? `Confidence is low: ${reasons.join(' and ')}. A person should listen and pick: audition each candidate, then pass its rank as candidate, or explicit startSeconds and endSeconds, to prepare_loop. Passing bpm or a different bar range can help.`
      : 'The first candidate has the best seam. Pass its rank (or another) to prepare_loop.', ...notes].join(' ') };
}

// ---------- loop building ----------
// Equal-power gains at step i of n: [fade in, fade out], with in² + out² = 1.
export function equalPowerGains(i, n) {
  const angle = Math.PI / 2 * Math.min(1, Math.max(0, i / n));
  return [Math.sin(angle), Math.cos(angle)];
}
// Linear gains at step i of n: [fade in, fade out], with in + out = 1. Right for two signals that are nearly the same,
// where equal-power gains would add up to 3 dB in the middle of the fade.
export function linearGains(i, n) {
  const t = Math.min(1, Math.max(0, i / n));
  return [t, 1 - t];
}
// Above this correlation between the two signals being faded, the fade is linear; below it, equal-power.
export const linearFadeCorrelation = 0.5;
// Cut [start, end) as a loop with a crossfade. With audio before the start, the loop's last frames fade into the audio
// that leads up to the start, so the wrap and the intro-to-loop join are both continuous. Without it, the loop's first
// frames fade in from the audio that follows the end. The two signals are measured first: a loop found by repetition
// is nearly the same on both sides of the fade, so a linear fade keeps the level; unrelated audio gets equal power.
export function crossfadeLoop(audio, start, end, fadeFrames, { shape = 'auto' } = {}) {
  const length = end - start;
  let fade = Math.min(fadeFrames, length >> 1);
  if (!(fade > 0 && (start >= fade || end + fade <= audio.frames))) fade = Math.min(length >> 1, Math.max(start, audio.frames - end));
  if (fade <= 0) return { audio: dsp.slice(audio, start, end), mode: 'cut', fadeFrames: 0, shape: null, correlation: null };
  // Frames fading out and frames fading in, as offsets into each channel, for each direction that has the audio.
  const correlate = (outgoing, incoming) => {
    let ab = 0, aa = 0, bb = 0;
    for (const ch of audio.channels) for (let i = 0; i < fade; i++) { const a = ch[outgoing + i], b = ch[incoming + i]; ab += a * b; aa += a * a; bb += b * b; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  };
  const before = start >= fade ? correlate(end - fade, start - fade) : null;
  const after = end + fade <= audio.frames ? correlate(end, start) : null;
  // Fade where the two sides are most alike. Before is preferred on a near tie because it leaves the loop's first
  // sample, and so the intro-to-loop join, untouched; after the end is better when what precedes the loop (an intro,
  // say) is different music from what precedes the loop end.
  const mode = after === null ? 'before' : before === null ? 'after' : before >= after - 0.05 ? 'before' : 'after';
  const correlation = mode === 'before' ? before : after;
  const chosen = shape === 'auto' ? (correlation >= linearFadeCorrelation ? 'linear' : 'equal-power') : shape;
  const gains = chosen === 'linear' ? linearGains : equalPowerGains;
  const channels = audio.channels.map(ch => {
    const out = ch.slice(start, end);
    if (mode === 'before') {
      for (let i = 0; i < fade; i++) {
        const [fadeIn, fadeOut] = gains(i + 1, fade), k = length - fade + i;
        out[k] = ch[start + k] * fadeOut + ch[start - fade + i] * fadeIn;
      }
    } else {
      for (let i = 0; i < fade; i++) {
        const [fadeIn, fadeOut] = gains(i, fade);
        out[i] = ch[start + i] * fadeIn + ch[end + i] * fadeOut;
      }
    }
    return out;
  });
  return { audio: { sampleRate: audio.sampleRate, frames: length, channels }, mode, fadeFrames: fade, shape: chosen, correlation: round(correlation, 3) };
}
// Shift a loop region by a few frames, keeping its length, to where the signal is near zero and flat at both ends.
// Before the first sample is silence, so a region that starts at frame 0 can stay there.
export function quietestShift(audio, start, end, reach, { minStart = 0, maxEnd = audio.frames } = {}) {
  let best = 0, bestCost = Infinity;
  for (let shift = -reach; shift <= reach; shift++) {
    const s = start + shift, e = end + shift;
    if (s < Math.max(0, minStart) || e > maxEnd || e >= audio.frames || e < 1) continue;
    let cost = 0;
    for (const ch of audio.channels) cost += Math.abs(ch[s] - (s > 0 ? ch[s - 1] : 0)) + Math.abs(ch[e] - ch[e - 1]) + 0.5 * (Math.abs(ch[s]) + Math.abs(ch[e]));
    if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) <= 1e-12 && Math.abs(shift) < Math.abs(best))) { bestCost = cost; best = shift; }
  }
  return best;
}

// ---------- tools ----------
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
export function register({ tool, z, root, schemas, render, moduleGuidance }) {
  const sourceAudio = z.string().regex(/^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][\w ().,'&-]{0,149}\.(wav|mp3|ogg|flac)$/i)
    .describe('A workspace audio file: WAV at any common sample rate, or MP3, OGG or FLAC (these need ffmpeg). It may sit one folder down.');
  const search = {
    bpm: z.number().min(30).max(300).optional().describe('Tempo hint. Overrides detection; use it when you know the tempo or detection is unsure.'),
    beatsPerBar: z.number().int().min(2).max(12).default(4),
    minBars: z.number().int().min(1).max(256).default(1), maxBars: z.number().int().min(1).max(256).default(64),
  };
  const load = file => decodeAudioFile(path.join(root, file), { tempRoot: root });
  moduleGuidance.push('For audio made outside LMMS (for example a song from Suno or another DAW), use find_loop_points to find tempo and loop regions, then prepare_loop to write game-ready loop and intro files with a manifest. They work on any WAV, and on MP3, OGG and FLAC when ffmpeg is installed.');

  tool('find_loop_points', 'Read-only. Find the tempo, beat grid and best loop regions of any audio file, including music made outside LMMS. Candidates are whole numbers of bars, scored by how closely the audio after the loop end matches the loop start and by spectrum and waveform on both sides of the seam. Says plainly when a person should pick.', {
    audio: sourceAudio, ...search, count: z.number().int().min(1).max(10).default(5),
  }, async ({ audio: file, bpm, beatsPerBar, minBars, maxBars, count }) => {
    if (minBars > maxBars) throw new Error('minBars must not exceed maxBars');
    const { audio, decoder } = await load(file);
    return { audio: file, decoder, ...findLoops(audio, { bpm, beatsPerBar, minBars, maxBars, count }) };
  });

  tool('prepare_loop', 'Turn any audio file into game-ready loop files: a seamless loop (crossfaded or with the tail folded in), an optional separate intro one-shot, WAV and optionally OGG at the source sample rate, loudness and peak control, and a manifest like export_game_audio writes, plus the source file, tempo, confidence and seam score. Choose a candidate from find_loop_points, give startSeconds and endSeconds, or let it take the best candidate.', {
    audio: sourceAudio, outputDirectory: schemas.folderName, name: schemas.folderName.optional().describe('Base file name. Default: from the source file name.'),
    candidate: z.number().int().min(1).max(10).optional().describe('Rank from find_loop_points (run with the same bpm, beatsPerBar, minBars and maxBars).'),
    startSeconds: z.number().min(0).optional(), endSeconds: z.number().min(0).optional(),
    ...search,
    intro: z.boolean().default(true).describe('Write the audio before the loop as a separate one-shot intro.'),
    seam: z.enum(['crossfade', 'fold']).default('crossfade').describe('crossfade: fade at the seam, placed at a quiet point; linear when both sides are alike, equal-power when they are not. fold: add the audio after the loop end onto the loop start, for files that ring out.'),
    crossfadeMs: z.number().min(0).max(2000).default(50),
    targetLufs: schemas.loudnessTarget, ceilingDb: schemas.ceilingTarget,
    ogg: z.boolean().default(false).describe('Also write OGG Vorbis files (needs ffmpeg).'),
    acceptLowConfidence: z.boolean().default(false).describe('Use the best candidate even when find_loop_points says a person should pick.'),
  }, async args => {
    const { audio: file, outputDirectory, candidate, startSeconds, endSeconds, bpm, beatsPerBar, minBars, maxBars, intro, seam, crossfadeMs,
      targetLufs, ceilingDb, ogg, acceptLowConfidence } = args;
    const name = args.name ?? (path.basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'loop');
    if ((startSeconds === undefined) !== (endSeconds === undefined)) throw new Error('Give both startSeconds and endSeconds, or neither');
    if (startSeconds !== undefined && candidate !== undefined) throw new Error('Give a candidate or explicit times, not both');
    if (ogg && !(await render.hasFfmpeg())) throw new Error('OGG output needs ffmpeg. Install it or set LMMS_FFMPEG.');
    const destination = path.join(root, outputDirectory);
    if (existsSync(destination)) throw new Error('Output directory already exists');
    const inputCheck = await verifyAudioFileProvenance(path.join(root, file), {
      workspaceDir: root,
      env: process.env,
    });
    const { audio: source } = await load(file);
    const sampleRate = source.sampleRate;
    const notes = [];
    let start, end, bars, chosen, tempo, unsure = false;
    if (startSeconds !== undefined) {
      start = Math.round(startSeconds * sampleRate); end = Math.min(source.frames, Math.round(endSeconds * sampleRate));
      if (end - start < sampleRate * 0.25) throw new Error('The loop must be at least 0.25 seconds long and inside the file');
      const features = analyseFrames(source);
      const t = detectTempo(features.onset, features.frameRate, { bpm });
      tempo = { bpm: t.bpm, confidence: t.confidence, source: t.source, alternatives: t.alternatives ?? [] };
      if (t.periodFrames) features.barFeatureFrames = Math.round(t.periodFrames / 2 * beatsPerBar);
      chosen = scoreSeam(source, features, mixMono(source), start, end);
      bars = t.bpm ? round((end - start) / sampleRate / (240 / t.bpm * beatsPerBar / 4), 2) : null;
      if (chosen.seamScore < lowSeamScore) notes.push(`The chosen region has a low seam score (${chosen.seamScore}); listen to the seam.`);
    } else {
      if (minBars > maxBars) throw new Error('minBars must not exceed maxBars');
      const found = findLoops(source, { bpm, beatsPerBar, minBars, maxBars, count: 10 });
      tempo = { bpm: found.tempo.bpm, confidence: found.tempo.confidence, source: found.tempo.source, alternatives: found.tempo.alternatives };
      if (!found.candidates.length) throw new Error('No loop candidate was found. ' + found.advice);
      if (candidate === undefined && found.needsHumanChoice && !acceptLowConfidence) {
        const list = found.candidates.slice(0, 5).map(c => `#${c.rank}: ${c.startSeconds}-${c.endSeconds} s, ${c.bars} bars, seam ${c.seamScore}`).join('; ');
        throw new Error(`${found.advice} Candidates: ${list}. Nothing was written. Pass candidate, explicit times, or acceptLowConfidence.`);
      }
      chosen = found.candidates[(candidate ?? 1) - 1];
      if (!chosen) throw new Error(`There are only ${found.candidates.length} candidates`);
      if (found.needsHumanChoice) { unsure = true; notes.push('find_loop_points was not confident about this file: ' + found.advice); }
      if (chosen.lengthFrom === 'beat grid') notes.push('The repeats did not match sample by sample, so the loop length comes from the beat grid.');
      ({ startFrame: start, endFrame: end, bars } = chosen);
    }
    if (tempo.alternatives.length) notes.push(`The tempo may be ${tempo.alternatives.map(a => `${a.bpm} bpm (${a.relation})`).join(' or ')} rather than ${tempo.bpm} bpm. The loop length in frames does not depend on this, but bar counts do.`);
    const length = end - start;
    // Build the loop.
    let loop, seamInfo, shift = 0;
    if (seam === 'crossfade') {
      const fade = Math.round(crossfadeMs / 1000 * sampleRate);
      // Keep whichever fade directions the region allows available after the shift.
      const room = Math.min(fade, length >> 1);
      shift = quietestShift(source, start, end, Math.round(sampleRate * 0.004), {
        minStart: start >= room ? room : 0, maxEnd: end + room <= source.frames ? source.frames - room : source.frames });
      start += shift; end += shift;
      const built = crossfadeLoop(source, start, end, fade);
      loop = built.audio;
      seamInfo = { method: built.mode === 'cut' ? 'cut' : 'crossfade', crossfadeMs: round(built.fadeFrames / sampleRate * 1000, 1), crossfadeFrames: built.fadeFrames,
        fadeInto: built.mode === 'before' ? 'audio before the loop start' : built.mode === 'after' ? 'audio after the loop end' : 'none',
        ...(built.shape ? { fadeShape: built.shape, fadeCorrelation: built.correlation } : {}) };
      if (built.mode === 'cut') notes.push('There is no audio outside the loop to crossfade with, so the seam is a plain cut. Check the boundary jump.');
      else if (built.fadeFrames < fade) notes.push(`The crossfade was shortened to ${seamInfo.crossfadeMs} ms to fit the audio available.`);
    } else {
      shift = quietestShift(source, start, end, Math.round(sampleRate * 0.004));
      start += shift; end += shift;
      const remainder = source.frames - end;
      loop = dsp.foldTail(dsp.slice(source, start, source.frames), length);
      seamInfo = { method: 'fold', foldedSeconds: round(remainder / sampleRate, 3) };
      if (!remainder) notes.push('Nothing follows the loop end, so fold is a plain cut. Check the boundary jump, or use crossfade.');
      if (remainder > Math.max(length * 0.25, sampleRate * 4)) notes.push(`${round(remainder / sampleRate, 2)} s of audio follow the loop end and were all folded onto the loop. Fold suits a ring-out, not more music; crossfade is usually better here.`);
    }
    seamInfo.score = chosen.seamScore; seamInfo.scores = chosen.scores; seamInfo.shiftFrames = shift;
    let introAudio = null;
    if (intro && start >= sampleRate * 0.1) introAudio = dsp.slice(source, 0, start);
    else if (intro && start > 0) notes.push(`${round(start / sampleRate * 1000, 1)} ms before the loop start were too short for an intro and were dropped.`);
    if (seam === 'fold' && introAudio && seamInfo.foldedSeconds > 0) notes.push('With fold, the loop start carries the folded tail, so the intro-to-loop join adds that tail. Listen to it, or use crossfade.');
    // Loudness: one gain for every file, worked out on the loop.
    const ceiling = ceilingDb ?? (targetLufs !== undefined ? -1 : undefined);
    const mastering = render.masterAudio(loop, { targetLufs, ceilingDb, wrap: true });
    const gainDb = mastering?.gainDb ?? 0;
    if (mastering?.warning) notes.push(mastering.warning);
    let introLimit = null;
    if (introAudio) {
      dsp.applyGain(introAudio, 10 ** (gainDb / 20));
      if (ceiling !== undefined) introLimit = dsp.limit(introAudio, ceiling);
    }
    await mkdir(destination);
    try {
      const files = [];
      const emit = async (base, audio, role, extra, limited) => {
        const wav = dsp.encodeWav(audio);
        const wavPath = path.join(destination, base + '.wav');
        await writeFileAtomic(wavPath, wav, { overwrite: false });
        await writeDerivedAudioProvenance(wavPath, [inputCheck], {
          workspaceDir: root,
          generatorTool: 'prepare_loop',
        });
        if (ogg) {
          const oggPath = path.join(destination, base + '.ogg');
          await render.writeAudio(oggPath, wav);
          await writeDerivedAudioProvenance(oggPath, [inputCheck], {
            workspaceDir: root,
            generatorTool: 'prepare_loop',
          });
        }
        const report = dsp.analyze(audio);
        files.push({ file: base + '.wav', ...(ogg ? { ogg: base + '.ogg' } : {}), role, ...extra, frames: audio.frames,
          durationSeconds: report.durationSeconds, integratedLufs: report.integratedLufs, truePeakDbfs: report.truePeakDbfs,
          peakDbfs: report.peakDbfs, clippedSamples: report.clippedSamples,
          ...(limited?.maxReductionDb ? { limiterMaxReductionDb: limited.maxReductionDb } : {}), sha256: sha256(wav) });
        return report;
      };
      const loopReport = await emit(`${name}-loop`, loop, 'loop', { loopStartFrame: 0, loopEndFrame: loop.frames, bars },
        mastering?.limiter);
      if (introAudio) await emit(`${name}-intro`, introAudio, 'intro', { next: `${name}-loop.wav` }, introLimit);
      const warnings = dsp.advise(loopReport, { loop: true, targetLufs });
      // Seamless only when a seam was actually built, it scored well, the samples meet, and nobody overrode a doubt.
      const jump = loopReport.loop.boundaryJumpDbfs;
      const seamIssues = [
        ...(seamInfo.method === 'cut' ? ['the seam is a plain cut'] : []),
        ...(seamInfo.method === 'fold' && !seamInfo.foldedSeconds ? ['nothing was folded, so the seam is a plain cut'] : []),
        ...(chosen.seamScore < lowSeamScore ? [`the seam score is ${chosen.seamScore}, under ${lowSeamScore}`] : []),
        ...(dsp.loopJoinClicks(loopReport.loop) ? [`the first and last samples differ by ${jump} dBFS`] : []),
        ...(unsure ? ['find_loop_points asked for a person to pick and acceptLowConfidence overrode it'] : []),
      ];
      const manifest = { name, source: file, sampleRate, channels: loop.channels.length,
        bpm: chosen.bpmFromLength ?? tempo.bpm, detectedBpm: tempo.bpm, bpmConfidence: tempo.confidence, bpmSource: tempo.source,
        ...(tempo.alternatives.length ? { tempoAlternatives: tempo.alternatives } : {}),
        timeSignature: `${beatsPerBar}/4`, bars,
        gainDb: round(gainDb, 2), ...(targetLufs !== undefined ? { targetLufs } : {}), ...(ceiling !== undefined ? { ceilingDb: ceiling } : {}),
        seam: seamInfo,
        loop: { file: `${name}-loop.wav`, startFrame: 0, endFrame: loop.frames, seamless: seamIssues.length === 0, seamScore: chosen.seamScore,
          ...(seamIssues.length ? { seamIssues } : {}),
          sourceStartFrame: start, sourceEndFrame: end, sourceStartSeconds: round(start / sampleRate, 4), sourceEndSeconds: round(end / sampleRate, 4) },
        ...(introAudio ? { intro: { file: `${name}-intro.wav`, frames: introAudio.frames, then: `${name}-loop.wav` } } : {}),
        files, ...(notes.length ? { notes } : {}) };
      await writeFileAtomic(path.join(destination, `${name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { overwrite: false });
      return { directory: outputDirectory, manifest: `${name}.manifest.json`, ...manifest,
        measured: { integratedLufs: loopReport.integratedLufs, truePeakDbfs: loopReport.truePeakDbfs, boundaryJumpDbfs: loopReport.loop.boundaryJumpDbfs,
          startRmsDbfs: loopReport.loop.startRmsDbfs, endRmsDbfs: loopReport.loop.endRmsDbfs, ...(mastering ? { mastering } : {}) },
        warnings, rights: 'Check that you have the rights to use and change any audio you did not make.' };
    } catch (error) {
      await rm(destination, { recursive: true, force: true }); // created by this call
      throw error;
    }
  });
}
