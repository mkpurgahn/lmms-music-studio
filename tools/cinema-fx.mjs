// Physical-modeled cinema horror sound-design generators (48 kHz stereo WAV + strict provenance).
// Provides four pure-DSP synthesis engines:
//   - waterphone     : 24-36 high-Q inharmonic bowed stainless-steel modes (190-4800 Hz), water-slosh bend, cavern FDN
//   - heartbeat_arc  : physical skin-membrane lub-dub (42-58 Hz + valve click) accelerating from startBpm to endBpm
//   - dread_riser    : organic orchestral-friction + torsional sub-growl riser with razor-clean cutoff at durationSeconds
//   - seismic_impact : concert Gran-Cassa + Tam-Tam bloom + 34 Hz seismic sub boom with natural dark hall decay
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze, encodeWav } from '../audio.mjs';
import { sampleTrack } from './atelier-workshop.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { writeProvenanceSidecar } from './provenance.mjs';
import { resolveWorkspaceDir } from './workspace-config.mjs';

export const CINEMA_FX_SAMPLE_RATE = 48000;
export const CINEMA_FX_KINDS = Object.freeze([
  'waterphone',
  'heartbeat_arc',
  'dread_riser',
  'seismic_impact',
]);

const TWO_PI = 2 * Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createRng(seed = 1337) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createPinkNoise(rng) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const white = rng() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    return (b0 + b1 + b2 + white * 0.1848) * 0.22;
  };
}

// Unconditionally stable Topology-Preserving Transform (TPT) 2-pole State Variable Filter.
function createTptSvf(sampleRate, cutoffHz, q) {
  let ic1eq = 0;
  let ic2eq = 0;
  let g = Math.tan(Math.PI * clamp(cutoffHz, 16, sampleRate * 0.46) / sampleRate);
  let k = 1 / Math.max(0.5, q);
  let a1 = 1 / (1 + g * (g + k));
  let a2 = g * a1;
  let a3 = g * a2;

  return {
    set(newCutoffHz, newQ) {
      g = Math.tan(Math.PI * clamp(newCutoffHz, 16, sampleRate * 0.46) / sampleRate);
      k = 1 / Math.max(0.5, newQ);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    },
    processBpNorm(v0) {
      const v3 = v0 - ic2eq;
      const v1 = a1 * ic1eq + a2 * v3;
      const v2 = ic2eq + a2 * ic1eq + a3 * v3;
      ic1eq = 2 * v1 - ic1eq;
      ic2eq = 2 * v2 - ic2eq;
      // Normalized bandpass (unity peak gain at resonance): k * v1
      return k * v1;
    },
    processLp(v0) {
      const v3 = v0 - ic2eq;
      const v1 = a1 * ic1eq + a2 * v3;
      const v2 = ic2eq + a2 * ic1eq + a3 * v3;
      ic1eq = 2 * v1 - ic1eq;
      ic2eq = 2 * v2 - ic2eq;
      return v2;
    },
  };
}

// Stereo 4-line Householder Feedback Delay Network for dark stone cavern / concert hall diffusion.
function applyCavernFdn(left, right, sampleRate, {
  mix = 0.38,
  feedback = 0.78,
  dampHz = 3200,
  highpassHz = 55,
  delayMs = [31.7, 47.3, 68.9, 93.1],
  earlyMs = [17.3, 26.9],
  monoLowHz = 0,
} = {}) {
  if (mix <= 0.001) return;
  const frames = left.length;
  const delays = delayMs.map(ms => Math.max(16, Math.round((ms * sampleRate) / 1000)));
  const buffers = delays.map(len => new Float64Array(len));
  const indices = [0, 0, 0, 0];
  const lpStates = [0, 0, 0, 0];
  const lpAlpha = 1 - Math.exp((-TWO_PI * clamp(dampHz, 200, sampleRate * 0.45)) / sampleRate);
  const hpAlpha = 1 - Math.exp((-TWO_PI * clamp(highpassHz, 15, 600)) / sampleRate);
  let hpStateL = 0;
  let hpStateR = 0;

  const earlyLenL = Math.max(8, Math.round((earlyMs[0] * sampleRate) / 1000));
  const earlyLenR = Math.max(8, Math.round((earlyMs[1] * sampleRate) / 1000));
  const earlyBufL = new Float64Array(earlyLenL);
  const earlyBufR = new Float64Array(earlyLenR);
  let earlyIdxL = 0;
  let earlyIdxR = 0;

  const dryGain = 1 - mix * 0.32;
  const wetGain = mix;
  const fb = clamp(feedback, 0, 0.94);

  let sideLp = 0;
  const sideAlpha = monoLowHz > 0 ? (1 - Math.exp((-TWO_PI * monoLowHz) / sampleRate)) : 0;

  for (let i = 0; i < frames; i++) {
    const inL = left[i];
    const inR = right[i];

    hpStateL += hpAlpha * (inL - hpStateL);
    hpStateR += hpAlpha * (inR - hpStateR);
    const sendL = inL - hpStateL;
    const sendR = inR - hpStateR;

    const erL = earlyBufL[earlyIdxL];
    const erR = earlyBufR[earlyIdxR];
    earlyBufL[earlyIdxL] = sendL;
    earlyBufR[earlyIdxR] = sendR;
    earlyIdxL = (earlyIdxL + 1) % earlyLenL;
    earlyIdxR = (earlyIdxR + 1) % earlyLenR;

    const d0 = buffers[0][indices[0]];
    const d1 = buffers[1][indices[1]];
    const d2 = buffers[2][indices[2]];
    const d3 = buffers[3][indices[3]];

    // Householder reflection matrix H = I - 0.5 * 1 * 1^T
    const sumHalf = 0.5 * (d0 + d1 + d2 + d3);
    const m0 = d0 - sumHalf;
    const m1 = d1 - sumHalf;
    const m2 = d2 - sumHalf;
    const m3 = d3 - sumHalf;

    lpStates[0] += lpAlpha * (m0 - lpStates[0]);
    lpStates[1] += lpAlpha * (m1 - lpStates[1]);
    lpStates[2] += lpAlpha * (m2 - lpStates[2]);
    lpStates[3] += lpAlpha * (m3 - lpStates[3]);

    buffers[0][indices[0]] = sendL * 0.5 + erR * 0.25 + lpStates[0] * fb;
    buffers[1][indices[1]] = sendR * 0.5 + erL * 0.25 + lpStates[1] * fb;
    buffers[2][indices[2]] = (sendL - sendR) * 0.35 + lpStates[2] * fb;
    buffers[3][indices[3]] = (sendL + sendR) * 0.35 + lpStates[3] * fb;

    indices[0] = (indices[0] + 1) % delays[0];
    indices[1] = (indices[1] + 1) % delays[1];
    indices[2] = (indices[2] + 1) % delays[2];
    indices[3] = (indices[3] + 1) % delays[3];

    const wetL = erL * 0.28 + (d0 + d2 * 0.7 - d3 * 0.45) * 0.48;
    const wetR = erR * 0.28 + (d1 - d2 * 0.7 + d3 * 0.45) * 0.48;

    let outL = inL * dryGain + wetL * wetGain;
    let outR = inR * dryGain + wetR * wetGain;

    if (sideAlpha > 0) {
      const mid = 0.5 * (outL + outR);
      const side = 0.5 * (outL - outR);
      sideLp += sideAlpha * (side - sideLp);
      const highSide = side - sideLp;
      outL = mid + highSide;
      outR = mid - highSide;
    }

    left[i] = outL;
    right[i] = outR;
  }
}

// Remove DC offset, apply click-free boundary fades, normalize to peakDb, and zero-balance 16-bit PCM sum.
function finalizeStereoBuffer(left, right, sampleRate, {
  peakDb = -1.5,
  fadeInMs = 3,
  fadeOutMs = 18,
  hardZeroTailFrames = 0,
} = {}) {
  const frames = left.length;
  const channels = [left, right];

  // 1. High-pass DC blocker at ~11 Hz (forward pass).
  const pole = 1 - (TWO_PI * 11) / sampleRate;
  for (const ch of channels) {
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < frames; i++) {
      const x = ch[i];
      const y = x - prevX + pole * prevY;
      prevX = x;
      prevY = y;
      ch[i] = y;
    }
  }

  // 2. Remove residual mean across active span before boundary windowing.
  const zeroTail = clamp(Math.round(hardZeroTailFrames), 0, Math.floor(frames * 0.25));
  const activeEndFrame = Math.max(2, frames - zeroTail);
  for (const ch of channels) {
    if (activeEndFrame > 8) {
      let sum = 0;
      for (let i = 0; i < activeEndFrame; i++) sum += ch[i];
      const mean = sum / activeEndFrame;
      for (let i = 0; i < activeEndFrame; i++) ch[i] -= mean;
    }
  }

  // 3. Smooth raised-cosine boundary fades (and hard-zero post-cutoff frames when requested).
  const fadeInFrames = Math.min(Math.floor(activeEndFrame / 4), Math.max(2, Math.round((fadeInMs * sampleRate) / 1000)));
  const fadeOutFrames = Math.min(Math.floor(activeEndFrame / 2), Math.max(4, Math.round((fadeOutMs * sampleRate) / 1000)));
  for (const ch of channels) {
    for (let i = 0; i < fadeInFrames; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeInFrames);
      ch[i] *= w;
    }
    for (let i = 0; i < fadeOutFrames; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOutFrames);
      ch[activeEndFrame - 1 - i] *= w;
    }
    for (let i = activeEndFrame; i < frames; i++) {
      ch[i] = 0;
    }
    ch[0] = 0;
    ch[frames - 1] = 0;
  }

  // 4. Peak-normalize strictly below 0 dBFS ceiling.
  const targetPeak = 10 ** (clamp(peakDb, -30, -0.5) / 20);
  let maxAbs = 0;
  for (const ch of channels) {
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(ch[i]);
      if (a > maxAbs) maxAbs = a;
    }
  }
  if (maxAbs > 1e-9) {
    const scale = targetPeak / maxAbs;
    for (const ch of channels) {
      for (let i = 0; i < frames; i++) {
        ch[i] *= scale;
      }
    }
  }

  // 5. Quantize to exact 16-bit PCM grid and distribute any integer rounding sum across active interior samples
  // (|q[i]| > 24) so silent/cutoff tails stay exact 0 while decoded 16-bit WAV has exact 0.00000 DC offset.
  for (const ch of channels) {
    const q = new Int32Array(frames);
    let intSum = 0;
    for (let i = 0; i < frames; i++) {
      const v = clamp(Math.round(ch[i] * 32768), -32760, 32760);
      q[i] = v;
      intSum += v;
    }
    intSum -= q[0];
    q[0] = 0;
    if (frames > 1) {
      intSum -= q[frames - 1];
      q[frames - 1] = 0;
    }
    if (intSum !== 0 && activeEndFrame > 16) {
      const stepSign = intSum > 0 ? -1 : 1;
      let remaining = Math.abs(intSum);
      const candidates = [];
      for (let i = 4; i < activeEndFrame - 4; i++) {
        if (Math.abs(q[i]) > 24 && Math.abs(q[i] + stepSign) < 32760) {
          candidates.push(i);
        }
      }
      if (candidates.length > 0) {
        let cursor = 0;
        const stride = Math.max(1, Math.floor(candidates.length / Math.min(remaining, candidates.length)));
        let guard = 0;
        const maxPasses = remaining + candidates.length * 2;
        while (remaining > 0 && guard < maxPasses) {
          const idx = candidates[cursor % candidates.length];
          if (Math.abs(q[idx] + stepSign) < 32760) {
            q[idx] += stepSign;
            remaining--;
          }
          cursor += stride;
          guard++;
        }
      }
    }
    for (let i = 0; i < frames; i++) {
      ch[i] = q[i] / 32768;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Waterphone: 24-36 high-Q stainless-steel/bronze modes (190-4800 Hz)
// ---------------------------------------------------------------------------
function synthesizeWaterphone({
  sampleRate,
  durationSeconds = 8,
  seed = 1337,
  modeCount = 30,
  baseHz = 218,
  sloshDepthCents = 68,
  sloshRateHz = 0.41,
  bowPressure = 0.68,
  cavernMix = 0.42,
  intensity = 0.85,
}) {
  const frames = Math.max(Math.round(sampleRate * 1.5), Math.round(sampleRate * durationSeconds));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rng = createRng(seed);
  const pink = createPinkNoise(rng);

  const count = Math.round(clamp(modeCount, 24, 36));
  const lowAnchor = clamp(baseHz, 190, 420);
  const highAnchor = 4720;

  // Build inharmonic cantilever rod + steel bowl eigenfrequencies strictly within [190, 4800] Hz,
  // with close microtonal rod pairs for characteristic waterphone shimmer beating.
  const modes = [];
  for (let m = 0; m < count; m++) {
    const frac = m / (count - 1);
    const logBase = lowAnchor * ((highAnchor / lowAnchor) ** (frac ** 0.92));
    // Alternate irrational rod offsets and tight 16-34 cent beating pairs
    const pairDetuneCents = (m % 3 === 1)
      ? (16 + rng() * 18) * (m % 2 === 0 ? 1 : -1)
      : (rng() - 0.5) * 44;
    const centerHz = clamp(logBase * (2 ** (pairDetuneCents / 1200)), 190, 4800);
    const q = 210 + frac * 470 + rng() * 45;
    // Lower bowl/long-rod modes couple strongly to asymmetric water slosh; short upper rods shimmer subtly.
    const sloshWeight = (1 - 0.68 * (frac ** 0.75)) * (0.82 + 0.36 * rng());
    const rimAngle = (TWO_PI * m) / count + (rng() - 0.5) * 0.25;
    const pan = 0.78 * Math.sin(rimAngle);
    const gainL = Math.sqrt(0.5 * (1 - pan));
    const gainR = Math.sqrt(0.5 * (1 + pan));
    const modalWeight = (frac < 0.22 ? 0.65 : frac < 0.72 ? 1.0 : 0.62) / Math.sqrt(count / 10);

    modes.push({
      centerHz,
      currentHz: centerHz,
      q,
      sloshWeight,
      rimPhase: rimAngle,
      gainL: gainL * modalWeight,
      gainR: gainR * modalWeight,
      svf: createTptSvf(sampleRate, centerHz, q),
      bowPhase: rng() * TWO_PI,
    });
  }

  // Pick 4 primary rods bowed sequentially/overlapping across the gesture (mid-to-high screech + eerie low rod).
  const focalIndices = [
    Math.floor(count * (0.28 + 0.08 * rng())),
    Math.floor(count * (0.52 + 0.08 * rng())),
    Math.floor(count * (0.74 + 0.08 * rng())),
    Math.floor(count * (0.41 + 0.08 * rng())),
  ].map(idx => clamp(idx, 2, count - 2));

  const activeEnd = Math.max(0.6, durationSeconds - Math.min(1.6, durationSeconds * 0.24));
  const sloshOmega = TWO_PI * clamp(sloshRateHz, 0.12, 1.5);
  const pressure = clamp(bowPressure, 0.15, 1);
  const driveScale = 0.55 + 0.65 * clamp(intensity, 0.1, 1);

  let slipPhase = rng() * TWO_PI;
  let rosinLp = 0;
  const controlStride = 32;

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;

    // Update modal water-slosh pitch bend every 32 samples (1500 Hz control rate)
    if ((i & (controlStride - 1)) === 0) {
      // Asymmetric gravity wave inside tilted steel resonator bowl
      const sloshWave = Math.sin(sloshOmega * t + 0.38 * Math.sin(sloshOmega * t + 0.7));
      const secondaryRipple = 0.28 * Math.sin(sloshOmega * 2.37 * t + 1.4);
      for (let m = 0; m < count; m++) {
        const mode = modes[m];
        const spatialSlosh = sloshWave * Math.cos(mode.rimPhase * 0.5 + 0.25 * Math.sin(sloshOmega * 0.61 * t)) + secondaryRipple;
        const bendCents = sloshDepthCents * mode.sloshWeight * spatialSlosh;
        const instHz = clamp(mode.centerHz * (2 ** (bendCents / 1200)), 190, 4800);
        mode.currentHz = instHz;
        mode.svf.set(instHz, mode.q);
      }
    }

    // Bow stroke envelope: rises smoothly, executes stick-slip pressure surges, releases into cavern shimmer
    let bowEnv = 0;
    if (t < activeEnd) {
      const u = t / activeEnd;
      const attack = t < 0.28 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.28) : 1;
      const release = u > 0.82 ? 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.82)) / 0.18) : 1;
      const strokeMod = 0.68 + 0.32 * Math.sin(TWO_PI * (1.35 / Math.max(2, activeEnd)) * t * 2.2 - 0.6);
      const stickJitter = 1 - (0.18 * pressure) * (0.5 + 0.5 * Math.sin(TWO_PI * 13.7 * t + 1.9 * Math.sin(TWO_PI * 3.1 * t)));
      bowEnv = attack * release * strokeMod * stickJitter * driveScale;
    }

    // Continuous focal rod morphing across the 4 bowed rods
    const strokePos = clamp(t / activeEnd, 0, 0.9999) * (focalIndices.length - 1);
    const segIdx = Math.min(focalIndices.length - 2, Math.floor(strokePos));
    const segFrac = strokePos - segIdx;
    const smoothFrac = segFrac * segFrac * (3 - 2 * segFrac);
    const focalA = modes[focalIndices[segIdx]];
    const focalB = modes[focalIndices[segIdx + 1]];
    const focalHz = focalA.currentHz * (1 - smoothFrac) + focalB.currentHz * smoothFrac;

    // Helmholtz stick-slip bow friction excitation + band-limited rosin micro-impulse
    slipPhase += (TWO_PI * focalHz) / sampleRate;
    if (slipPhase >= TWO_PI) slipPhase -= TWO_PI;
    const saw = (slipPhase / Math.PI) - 1;
    const helmholtzSlip = Math.tanh((saw + 0.32 * Math.sin(slipPhase * 2)) * (2.2 + 3.4 * pressure));
    const rawRosin = pink();
    rosinLp += 0.24 * (rawRosin - rosinLp);
    const rosinScratch = (rawRosin - rosinLp) * (0.28 + 0.55 * pressure);
    const bowExciter = bowEnv * (0.045 * helmholtzSlip + 0.055 * rosinScratch);

    let sumL = 0;
    let sumR = 0;

    // Direct singing bowed harmonics on the two active focal rods
    focalA.bowPhase += (TWO_PI * focalA.currentHz) / sampleRate;
    if (focalA.bowPhase >= TWO_PI) focalA.bowPhase -= TWO_PI;
    focalB.bowPhase += (TWO_PI * focalB.currentHz) / sampleRate;
    if (focalB.bowPhase >= TWO_PI) focalB.bowPhase -= TWO_PI;

    const directA = (Math.sin(focalA.bowPhase) + 0.28 * pressure * Math.sin(focalA.bowPhase * 2.756)) * (1 - smoothFrac) * bowEnv * 0.24;
    const directB = (Math.sin(focalB.bowPhase) + 0.28 * pressure * Math.sin(focalB.bowPhase * 2.756)) * smoothFrac * bowEnv * 0.24;
    sumL += directA * focalA.gainL + directB * focalB.gainL;
    sumR += directA * focalA.gainR + directB * focalB.gainR;

    // Sympathetic 24-36 high-Q stainless-steel modal resonator bank
    for (let m = 0; m < count; m++) {
      const mode = modes[m];
      const y = mode.svf.processBpNorm(bowExciter);
      sumL += y * mode.gainL * 3.4;
      sumR += y * mode.gainR * 3.4;
    }

    left[i] = sumL;
    right[i] = sumR;
  }

  applyCavernFdn(left, right, sampleRate, {
    mix: clamp(cavernMix, 0, 0.85),
    feedback: 0.82,
    dampHz: 3900,
    highpassHz: 130,
    delayMs: [33.7, 49.1, 71.3, 97.9],
    earlyMs: [19.1, 28.7],
  });

  return { left, right, modeCount: count, modeRangeHz: [190, 4800] };
}

// ---------------------------------------------------------------------------
// 2. Heartbeat Arc: physical skin-membrane lub-dub (42-58 Hz + valve click)
// ---------------------------------------------------------------------------
function synthesizeHeartbeatArc({
  sampleRate,
  durationSeconds = 12,
  seed = 1337,
  startBpm = 66,
  endBpm = 162,
  curve = 'exponential',
  intensityCurve = 1.35,
  membraneHz = 48,
  valveClick = 0.22,
  intensity = 0.9,
}) {
  const frames = Math.max(Math.round(sampleRate * 2), Math.round(sampleRate * durationSeconds));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rng = createRng(seed);

  const bpm0 = clamp(startBpm, 30, 220);
  const bpm1 = clamp(endBpm, 30, 240);
  const coreHz = clamp(membraneHz, 42, 58);
  const clickAmt = clamp(valveClick, 0, 0.7);
  const expPower = clamp(intensityCurve, 0.3, 4);
  const baseDrive = clamp(intensity, 0.2, 1);

  const activeDuration = Math.max(0.9, durationSeconds - 0.42);
  const bpmAt = u => {
    const clampedU = clamp(u, 0, 1);
    if (curve === 'linear') return bpm0 + (bpm1 - bpm0) * clampedU;
    if (curve === 'panic') return bpm0 + (bpm1 - bpm0) * (clampedU ** 2.15);
    return bpm0 * ((bpm1 / bpm0) ** clampedU);
  };

  // Precompute continuous cardiac cycle trigger times by integrating instantaneous BPM.
  const beats = [];
  const firstBeatSec = 0.06;
  let phase = 1;
  const activeFrames = Math.min(frames, Math.round(activeDuration * sampleRate));
  for (let i = Math.round(firstBeatSec * sampleRate); i < activeFrames; i++) {
    const t = i / sampleRate;
    const u = clamp((t - firstBeatSec) / Math.max(0.2, activeDuration - firstBeatSec), 0, 1);
    const currentBpm = bpmAt(u);
    if (phase >= 1) {
      phase -= 1;
      beats.push({ timeSec: t, progress: u, bpm: currentBpm });
    }
    phase += currentBpm / (60 * sampleRate);
  }

  // Render physical circular skin-membrane strike (Bessel drumhead modes + subtle flesh valve snap)
  const addStrike = (startSec, baseFreqHz, amp, decayTauSec, clickScale, panTiny) => {
    const startFrame = Math.round(startSec * sampleRate);
    if (startFrame >= frames - 16) return;
    const maxLen = Math.min(frames - startFrame, Math.round(decayTauSec * 7.5 * sampleRate));
    const attackFrames = Math.max(12, Math.round(0.0045 * sampleRate));

    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    let c1 = 0;
    let c2 = 0;

    const gainL = 1 - panTiny;
    const gainR = 1 + panTiny;

    for (let k = 0; k < maxLen; k++) {
      const dt = k / sampleRate;
      const attack = k < attackFrames ? 0.5 - 0.5 * Math.cos((Math.PI * k) / attackFrames) : 1;
      // Tensioned skin pitch sag from transient deflection down into 42-58 Hz steady membrane resonance
      const instF0 = baseFreqHz * (1 + 0.32 * Math.exp(-dt / 0.018));
      p1 += (TWO_PI * instF0) / sampleRate;
      p2 += (TWO_PI * instF0 * 1.593) / sampleRate;
      p3 += (TWO_PI * instF0 * 2.136) / sampleRate;

      const env1 = Math.exp(-dt / decayTauSec);
      const env2 = Math.exp(-dt / (decayTauSec * 0.42));
      const env3 = Math.exp(-dt / (decayTauSec * 0.21));

      const membrane = (
        Math.sin(p1) * env1 * 0.86 +
        Math.sin(p2) * env2 * 0.19 +
        Math.sin(p3) * env3 * 0.07
      ) * attack;

      // Subtle biological valve closure click (195 Hz + 330 Hz heavily damped flesh transient, zero DC)
      c1 += (TWO_PI * 198) / sampleRate;
      c2 += (TWO_PI * 334) / sampleRate;
      const valveEnv = dt < 0.028 ? Math.sin((Math.PI * Math.min(dt, 0.004)) / 0.004 || 1) * Math.exp(-dt / 0.0052) : 0;
      const click = clickScale * valveEnv * (0.68 * Math.sin(c1) + 0.32 * Math.sin(c2));

      const sample = amp * Math.tanh((membrane + click) * 1.28);
      left[startFrame + k] += sample * gainL;
      right[startFrame + k] += sample * gainR;
    }
  };

  for (const beat of beats) {
    const arcGain = (0.38 + 0.62 * (beat.progress ** expPower)) * baseDrive;
    const jitter = (rng() - 0.5) * 0.004;
    const lubSec = Math.max(0.01, beat.timeSec + jitter);
    const beatPeriod = 60 / beat.bpm;
    // Systole interval scales physiologically with heart rate while keeping clear lub-dub pairing
    const systoleSec = Math.min(beatPeriod * 0.40, clamp(0.275 * ((66 / beat.bpm) ** 0.58), 0.105, 0.32));
    const dubSec = lubSec + systoleSec;
    const tauLub = clamp(0.112 * ((70 / beat.bpm) ** 0.34), 0.052, 0.13);
    const tauDub = tauLub * 0.82;

    const lubHz = clamp(coreHz * 0.96, 42, 56);
    const dubHz = clamp(coreHz * 1.10, 45, 58);

    addStrike(lubSec, lubHz, arcGain * 0.92, tauLub, clickAmt * 0.16 * (0.7 + 0.5 * beat.progress), 0.012);
    if (dubSec < durationSeconds - 0.18) {
      addStrike(dubSec, dubHz, arcGain * 0.74, tauDub, clickAmt * 0.22 * (0.7 + 0.5 * beat.progress), -0.012);
    }
  }

  // Subtle dark chest-cavity ambience keeping all sub/bass (< 110 Hz) strictly mono-centered.
  applyCavernFdn(left, right, sampleRate, {
    mix: 0.14,
    feedback: 0.42,
    dampHz: 320,
    highpassHz: 95,
    delayMs: [13.7, 19.3, 27.1, 34.9],
    earlyMs: [8.3, 12.1],
    monoLowHz: 110,
  });

  return { left, right, heartbeatCount: beats.length, startBpm: bpm0, endBpm: bpm1 };
}

// ---------------------------------------------------------------------------
// 3. Dread Riser: orchestral friction + sub-growl terror swell -> razor cutoff
// ---------------------------------------------------------------------------
function synthesizeDreadRiser({
  sampleRate,
  durationSeconds = 8,
  seed = 1337,
  baseHz = 46.25,
  riseSemitones = 13,
  growlAmount = 0.72,
  cutoffTailMs = 16,
  intensity = 0.92,
}) {
  const frames = Math.max(Math.round(sampleRate * 1.5), Math.round(sampleRate * durationSeconds));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rng = createRng(seed);
  const pink = createPinkNoise(rng);

  const subRootHz = clamp(baseHz, 28, 110);
  const climbSemis = clamp(riseSemitones, 3, 36);
  const growl = clamp(growlAmount, 0, 1);
  const driveScale = clamp(intensity, 0.2, 1);

  const cutoffFrames = clamp(Math.round((clamp(cutoffTailMs, 5, 60) * sampleRate) / 1000), 64, Math.floor(frames * 0.2));
  const peakFrame = Math.max(128, frames - cutoffFrames);

  // 16 bowed-metal & sul-ponticello voices in dissonant horror intervals (root, b2, tritone, b9)
  const clusterSemis = [0, 1, 6, 13];
  const voices = [];
  for (let v = 0; v < 16; v++) {
    const interval = clusterSemis[v % clusterSemis.length];
    const octave = 2 + Math.floor(v / 4);
    const detuneCents = (rng() - 0.5) * 38;
    const startHz = clamp(subRootHz * (2 ** (octave + (interval + detuneCents / 100) / 12)), 140, 2200);
    const climbScale = 0.78 + 0.44 * (v / 15);
    const climbCurve = 1.55 + 0.55 * rng();
    const jitterRate = 3.8 + rng() * 6.4;
    const jitterPhase = rng() * TWO_PI;
    const pan = ((v % 2 === 0 ? -1 : 1) * (0.22 + 0.68 * ((v % 8) / 7)));
    voices.push({
      startHz,
      climbScale,
      climbCurve,
      jitterRate,
      jitterPhase,
      phase: rng() * TWO_PI,
      gainL: Math.sqrt(0.5 * (1 - pan)) / 4.2,
      gainR: Math.sqrt(0.5 * (1 + pan)) / 4.2,
    });
  }

  // 3 resonant acoustic pipe/cavern breath formants (zero white-noise EDM sweep)
  const breathSvf1 = createTptSvf(sampleRate, 310, 6.5);
  const breathSvf2 = createTptSvf(sampleRate, 690, 7.2);
  const breathSvf3 = createTptSvf(sampleRate, 1380, 8.0);
  const growlLp = createTptSvf(sampleRate, 160, 0.85);

  let subPhaseA = rng() * TWO_PI;
  let subPhaseB = rng() * TWO_PI;
  let airSmooth = 0;
  const controlStride = 32;

  for (let i = 0; i < frames; i++) {
    const u = clamp(i / peakFrame, 0, 1);
    const expRise = (Math.exp(3.25 * u) - 1) / (Math.exp(3.25) - 1);
    const openEnv = (0.04 + 0.96 * expRise) * driveScale;

    if ((i & (controlStride - 1)) === 0) {
      breathSvf1.set(310 + 720 * (u ** 1.7), 6.5);
      breathSvf2.set(690 + 1780 * (u ** 1.85), 7.2);
      breathSvf3.set(1380 + 2850 * (u ** 2.0), 8.0);
      growlLp.set(135 + 460 * expRise, 0.9);
    }

    const t = i / sampleRate;

    // Layer A: Torsional bowed sub-growl
    const subClimbSemis = climbSemis * 0.5 * (u ** 1.9);
    const instSubHz = subRootHz * (2 ** (subClimbSemis / 12));
    subPhaseA += (TWO_PI * instSubHz) / sampleRate;
    subPhaseB += (TWO_PI * instSubHz * 1.007) / sampleRate;
    if (subPhaseA >= TWO_PI) subPhaseA -= TWO_PI;
    if (subPhaseB >= TWO_PI) subPhaseB -= TWO_PI;

    const rawGrowl =
      Math.sin(subPhaseA) * 0.62 +
      Math.sin(subPhaseB) * 0.38 +
      0.34 * Math.sin(subPhaseA * 2 + 0.4 * Math.sin(TWO_PI * 2.3 * t)) +
      0.22 * expRise * Math.sin(subPhaseB * 3.01);
    const saturatedGrowl = growlLp.processLp(Math.tanh(rawGrowl * (1.35 + 2.6 * expRise))) * growl * (0.18 + 0.58 * (u ** 1.35));

    // Layer B: 16-voice detuned bowed-metal & sul-ponticello swarm
    let swarmL = 0;
    let swarmR = 0;
    const upperHarmWeight = 0.12 + 0.88 * (expRise ** 0.85);
    for (let v = 0; v < 16; v++) {
      const voice = voices[v];
      const jitter = 1 + 0.0045 * Math.sin(TWO_PI * voice.jitterRate * t + voice.jitterPhase);
      const semis = climbSemis * voice.climbScale * (u ** voice.climbCurve);
      const hz = clamp(voice.startHz * (2 ** (semis / 12)) * jitter, 120, 9200);
      voice.phase += (TWO_PI * hz) / sampleRate;
      if (voice.phase >= TWO_PI) voice.phase -= TWO_PI;

      const p = voice.phase;
      // Bowed stick-slip & glassy sul-ponticello partials
      const bowed =
        Math.sin(p) * 0.48 +
        upperHarmWeight * (
          0.34 * Math.sin(p * 2.012) +
          0.26 * Math.sin(p * 3.037) +
          0.19 * Math.sin(p * 4.185) +
          0.13 * Math.sin(p * 5.46)
        );
      const bowTrem = 0.72 + 0.28 * Math.sin(TWO_PI * (voice.jitterRate * 0.83) * t + voice.jitterPhase * 1.7);
      const sig = Math.tanh(bowed * (1.15 + 1.9 * expRise)) * bowTrem;
      swarmL += sig * voice.gainL;
      swarmR += sig * voice.gainR;
    }

    // Layer C: Filtered dark pipe/cavern breath rush (no raw broadband white noise)
    const pinkSample = pink();
    airSmooth += 0.35 * (pinkSample - airSmooth);
    const breathFlutter = 0.74 + 0.26 * Math.sin(TWO_PI * 5.6 * t + 0.9 * Math.sin(TWO_PI * 1.3 * t));
    const f1 = breathSvf1.processBpNorm(airSmooth);
    const f2 = breathSvf2.processBpNorm(pinkSample);
    const f3 = breathSvf3.processBpNorm(pinkSample);
    const breathL = (f1 * 0.55 + f2 * 0.38 + f3 * 0.22) * breathFlutter * (0.15 + 0.85 * expRise) * 0.42;
    const breathR = (f1 * 0.55 - f2 * 0.28 + f3 * 0.30) * breathFlutter * (0.15 + 0.85 * expRise) * 0.42;

    left[i] = saturatedGrowl + (swarmL + breathL) * openEnv;
    right[i] = saturatedGrowl + (swarmR + breathR) * openEnv;
  }

  // Apply cavern space BEFORE the razor guillotine cutoff so the cutoff slices dry + hall cleanly to dead zero.
  applyCavernFdn(left, right, sampleRate, {
    mix: 0.30,
    feedback: 0.72,
    dampHz: 3100,
    highpassHz: 110,
    delayMs: [27.9, 41.3, 58.7, 79.1],
    earlyMs: [14.3, 21.7],
    monoLowHz: 95,
  });

  // Apply smooth opening fade-in (25 ms) and razor-clean guillotine cutoff over final cutoffFrames.
  const openFade = Math.min(Math.floor(peakFrame / 3), Math.round(0.025 * sampleRate));
  for (let i = 0; i < openFade; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / openFade);
    left[i] *= w;
    right[i] *= w;
  }
  const activeCutSpan = Math.max(32, Math.floor(cutoffFrames * 0.65));
  for (let i = peakFrame; i < frames; i++) {
    const k = i - peakFrame;
    const w = k >= activeCutSpan ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * k) / activeCutSpan);
    left[i] *= w;
    right[i] *= w;
  }

  return { left, right, baseHz: subRootHz, riseSemitones: climbSemis, cutoffTailMs: clamp(cutoffTailMs, 5, 60) };
}

// ---------------------------------------------------------------------------
// 4. Seismic Impact: Concert Gran-Cassa + Tam-Tam bloom + 34 Hz seismic sub
// ---------------------------------------------------------------------------
function synthesizeSeismicImpact({
  sampleRate,
  durationSeconds = 6,
  seed = 1337,
  subHz = 34,
  tamTamLevel = 0.68,
  hallDecay = 0.78,
  intensity = 0.95,
}) {
  const frames = Math.max(Math.round(sampleRate * 1.5), Math.round(sampleRate * durationSeconds));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rng = createRng(seed);
  const pink = createPinkNoise(rng);

  const seismicHz = clamp(subHz, 26, 52);
  const gongAmt = clamp(tamTamLevel, 0, 1);
  const hallAmt = clamp(hallDecay, 0.2, 0.95);
  const drive = clamp(intensity, 0.2, 1);

  // Concert Gran Cassa circular membrane Bessel modes around 43 Hz
  const cassaRatios = [1.0, 1.594, 2.136, 2.296, 2.653, 2.918];
  const cassaAmps = [0.72, 0.36, 0.22, 0.15, 0.10, 0.07];
  const cassaTaus = [1.25, 0.68, 0.42, 0.31, 0.24, 0.18].map(tau => tau * (0.7 + 0.55 * hallAmt));
  const cassaPhases = cassaRatios.map(() => 0);

  // 24 inharmonic circular bronze Tam-Tam modes (96 Hz..4500 Hz) with delayed nonlinear shimmer bloom
  const gongModes = [];
  for (let g = 0; g < 24; g++) {
    const frac = g / 23;
    const hz = clamp(96 * ((4500 / 96) ** (frac ** 0.88)) * (1 + (rng() - 0.5) * 0.045), 92, 4600);
    // Upper bronze modes bloom 140-360 ms AFTER mallet strike due to nonlinear plate wave dispersion
    const bloomPeakSec = 0.008 + (frac ** 1.35) * 0.31;
    const decaySec = (3.4 - 1.9 * frac) * (0.65 + 0.55 * hallAmt) * (0.88 + 0.24 * rng());
    const pan = (g % 2 === 0 ? -1 : 1) * (0.18 + 0.65 * frac);
    const weight = (frac < 0.3 ? 0.85 : 0.62) / 5.4;
    gongModes.push({
      hz,
      beatHz: hz * (1 + (0.0018 + 0.0028 * rng()) * (g % 2 === 0 ? 1 : -1)),
      bloomPeakSec,
      decaySec,
      phaseA: rng() * TWO_PI,
      phaseB: rng() * TWO_PI,
      gainL: Math.sqrt(0.5 * (1 - pan)) * weight,
      gainR: Math.sqrt(0.5 * (1 + pan)) * weight,
    });
  }

  const malletLp = createTptSvf(sampleRate, 310, 0.9);
  const gongWashBp = createTptSvf(sampleRate, 1650, 2.2);

  let subPhase1 = 0;
  let subPhase2 = 0;
  let shellPhase = 0;

  const subTau = Math.min(durationSeconds * 0.42, 1.95 * (0.7 + 0.5 * hallAmt));
  const endTailSec = Math.min(1.1, durationSeconds * 0.22);

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const strikeAttack = i < 160 ? 0.5 - 0.5 * Math.cos((Math.PI * i) / 160) : 1;

    // Layer A: 34 Hz Seismic Sub Boom (mono-centered)
    const instSubHz = seismicHz * (1 + 1.05 * Math.exp(-t / 0.046));
    subPhase1 += (TWO_PI * instSubHz) / sampleRate;
    subPhase2 += (TWO_PI * instSubHz * 2) / sampleRate;
    const subSig = strikeAttack * (
      0.86 * Math.sin(subPhase1) * Math.exp(-t / subTau) +
      0.24 * Math.sin(subPhase2) * Math.exp(-t / (subTau * 0.28))
    );

    // Layer B: Concert Gran Cassa (felt beater impact + 6 Bessel skin modes + 86 Hz shell cavity)
    const n = pink();
    const beaterBody = t < 0.055 ? malletLp.processLp(n * 2.4) * Math.exp(-t / 0.014) : 0;
    const cassaPitchDrop = 1 + 0.42 * Math.exp(-t / 0.028);
    let cassaSum = beaterBody * 0.65;
    for (let m = 0; m < cassaRatios.length; m++) {
      cassaPhases[m] += (TWO_PI * 43.0 * cassaRatios[m] * cassaPitchDrop) / sampleRate;
      cassaSum += Math.sin(cassaPhases[m]) * cassaAmps[m] * Math.exp(-t / cassaTaus[m]);
    }
    shellPhase += (TWO_PI * 86.5) / sampleRate;
    cassaSum += 0.18 * Math.sin(shellPhase) * Math.exp(-t / 0.34);
    cassaSum *= strikeAttack * 0.56;

    // Layer C: Concert Tam-Tam bronze plate modes + delayed dispersive shimmer bloom
    let gongL = 0;
    let gongR = 0;
    if (gongAmt > 0.001) {
      for (let g = 0; g < gongModes.length; g++) {
        const gm = gongModes[g];
        gm.phaseA += (TWO_PI * gm.hz) / sampleRate;
        gm.phaseB += (TWO_PI * gm.beatHz) / sampleRate;
        if (gm.phaseA >= TWO_PI) gm.phaseA -= TWO_PI;
        if (gm.phaseB >= TWO_PI) gm.phaseB -= TWO_PI;

        const rise = 1 - Math.exp(-t / gm.bloomPeakSec);
        const env = rise * Math.exp(-t / gm.decaySec);
        const modalPair = (Math.sin(gm.phaseA) + 0.62 * Math.sin(gm.phaseB)) * env;
        gongL += modalPair * gm.gainL;
        gongR += modalPair * gm.gainR;
      }
      // Subtle dispersive bronze wash peaking around 240 ms
      const washEnv = (1 - Math.exp(-t / 0.22)) * Math.exp(-t / (1.35 * (0.7 + 0.5 * hallAmt)));
      const wash = gongWashBp.processBpNorm(n) * washEnv * 0.16;
      gongL = (gongL + wash) * gongAmt;
      gongR = (gongR - wash * 0.75) * gongAmt;
    }

    const monoCore = (subSig * 0.78 + cassaSum) * drive;
    let outL = monoCore + gongL * drive;
    let outR = monoCore + gongR * drive;

    // Natural hall fade before file end so zero tail truncation occurs
    if (t > durationSeconds - endTailSec) {
      const rem = clamp((t - (durationSeconds - endTailSec)) / endTailSec, 0, 1);
      const tailFade = 0.5 + 0.5 * Math.cos(Math.PI * rem);
      outL *= tailFade;
      outR *= tailFade;
    }

    left[i] = outL;
    right[i] = outR;
  }

  // Dark concert hall decay (highs damped at 1950 Hz, sub < 95 Hz locked strictly mono)
  applyCavernFdn(left, right, sampleRate, {
    mix: 0.36 * hallAmt,
    feedback: 0.62 + 0.24 * hallAmt,
    dampHz: 1950,
    highpassHz: 85,
    delayMs: [29.3, 43.1, 61.7, 83.9],
    earlyMs: [17.9, 26.3],
    monoLowHz: 95,
  });

  return { left, right, subHz: seismicHz };
}

/**
 * Pure in-memory 48 kHz stereo synthesis for all four cinema horror sound-design generators.
 */
export function synthesizeCinemaFx(options = {}) {
  const {
    kind,
    durationSeconds,
    seed = 1337,
    peakDb = -1.5,
  } = options;

  if (!CINEMA_FX_KINDS.includes(kind)) {
    throw new Error(`Unsupported cinema FX kind "${kind}". Expected one of: ${CINEMA_FX_KINDS.join(', ')}`);
  }

  const sampleRate = CINEMA_FX_SAMPLE_RATE;
  let rendered;
  let fadeInMs = 3;
  let fadeOutMs = 18;
  let hardZeroTailFrames = 0;

  if (kind === 'waterphone') {
    rendered = synthesizeWaterphone({ ...options, sampleRate, durationSeconds: durationSeconds ?? 8, seed });
    fadeInMs = 8;
    fadeOutMs = 35;
  } else if (kind === 'heartbeat_arc') {
    rendered = synthesizeHeartbeatArc({ ...options, sampleRate, durationSeconds: durationSeconds ?? 12, seed });
    fadeInMs = 4;
    fadeOutMs = 25;
  } else if (kind === 'dread_riser') {
    rendered = synthesizeDreadRiser({ ...options, sampleRate, durationSeconds: durationSeconds ?? 8, seed });
    fadeInMs = 12;
    const cutMs = clamp(options.cutoffTailMs ?? 16, 5, 60);
    fadeOutMs = cutMs * 0.65;
    hardZeroTailFrames = Math.max(16, Math.round((cutMs * 0.35 * sampleRate) / 1000));
  } else {
    rendered = synthesizeSeismicImpact({ ...options, sampleRate, durationSeconds: durationSeconds ?? 6, seed });
    fadeInMs = 2;
    fadeOutMs = 40;
  }

  finalizeStereoBuffer(rendered.left, rendered.right, sampleRate, {
    peakDb,
    fadeInMs,
    fadeOutMs,
    hardZeroTailFrames,
  });

  const audio = {
    sampleRate,
    frames: rendered.left.length,
    channels: [rendered.left, rendered.right],
  };
  const wav = encodeWav(audio);
  const { left: _l, right: _r, ...details } = rendered;

  return {
    kind,
    sampleRate,
    channels: 2,
    frames: audio.frames,
    durationSeconds: Number((audio.frames / sampleRate).toFixed(4)),
    audio,
    wav,
    details,
  };
}

/**
 * Render a cinema horror sound-design WAV atomically into workspaceDir and write its strict pure-synthesis provenance sidecar.
 */
export async function renderCinemaFxToWorkspace({
  workspaceDir = resolveWorkspaceDir(process.env),
  output,
  overwrite = false,
  ...fxOptions
} = {}) {
  if (!output || typeof output !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i.test(output)) {
    throw new Error('output must be a plain workspace WAV filename matching /^[a-z0-9][a-z0-9_-]{0,79}\\.wav$/i');
  }
  const resolvedWs = path.resolve(workspaceDir);
  await mkdir(resolvedWs, { recursive: true });
  const outPath = path.join(resolvedWs, output);
  if (!overwrite && existsSync(outPath)) {
    throw new Error(`Output already exists: ${output}`);
  }

  const synth = synthesizeCinemaFx(fxOptions);
  await writeFileAtomic(outPath, synth.wav, { overwrite });
  const provenance = await writeProvenanceSidecar(outPath, {
    workspaceDir: resolvedWs,
    classification: 'pure-synthesis',
    generatorTool: 'render_cinema_fx',
    sources: [{
      kind: 'pure-synthesis',
      pluginOrLibrary: `cinema-fx:${synth.kind}`,
      licence: 'unrestricted-synthesis',
    }],
  });

  const metrics = analyze(synth.audio);
  return {
    file: output,
    kind: synth.kind,
    sampleRate: synth.sampleRate,
    channels: synth.channels,
    frames: synth.frames,
    durationSeconds: synth.durationSeconds,
    peakDbfs: metrics.peakDbfs,
    truePeakDbfs: metrics.truePeakDbfs,
    rmsDbfs: metrics.rmsDbfs,
    integratedLufs: metrics.integratedLufs,
    dcOffset: metrics.dcOffset,
    clippedSamples: metrics.clippedSamples,
    sha256: provenance.sha256,
    provenanceClassification: provenance.classification,
    details: synth.details,
  };
}

export function register({ tool, z, root, schemas, project, moduleGuidance }) {
  moduleGuidance?.push(
    'For physical-modeled theatrical horror and suspense sound design, call render_cinema_fx (waterphone bowed steel resonator, heartbeat_arc accelerating skin-membrane lub-dub, dread_riser bowed-metal/sub-growl terror swell with razor cutoff, and seismic_impact Gran-Cassa + Tam-Tam + 34 Hz sub boom).',
  );

  const place = z.strictObject({
    project: schemas.projectName.describe('Existing LMMS project to add the rendered cinema FX WAV to.'),
    output: schemas.projectName.describe('New LMMS project file to write.'),
    bar: z.number().int().min(0).max(999).describe('0-based bar where the FX sample starts.'),
    trackName: z.string().min(1).max(100).optional(),
    role: z.enum(['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx']).default('fx'),
    volume: schemas.volume.optional(),
    pan: z.number().int().min(-100).max(100).optional(),
  }).optional().describe('Optionally place the rendered WAV directly onto a new project revision at a bar.');

  tool('render_cinema_fx', 'Synthesize physical-modeled 48 kHz stereo cinema horror sound design (waterphone, heartbeat_arc, dread_riser, seismic_impact) to a workspace WAV with strict pure-synthesis provenance, optionally placing it onto an LMMS project.', {
    kind: z.enum(CINEMA_FX_KINDS).describe('Physical model: waterphone, heartbeat_arc, dread_riser, or seismic_impact.'),
    output: schemas.wavName.describe('Output WAV filename in workspace (e.g. "act1-waterphone-v1.wav").'),
    durationSeconds: z.number().min(1.5).max(120).optional().describe('Duration in seconds (defaults: waterphone 8, heartbeat_arc 12, dread_riser 8, seismic_impact 6).'),
    seed: z.number().int().min(0).max(4294967295).default(1337).describe('Deterministic PRNG seed.'),
    intensity: z.number().min(0.1).max(1).default(0.9).describe('Overall physical excitation intensity (0.1-1).'),
    peakDb: z.number().min(-24).max(-0.5).default(-1.5).describe('Target peak normalization in dBFS (-24 to -0.5).'),
    modeCount: z.number().int().min(24).max(36).optional().describe('waterphone: number of stainless-steel resonator modes (24-36, default 30).'),
    baseHz: z.number().min(28).max(420).optional().describe('waterphone (190-420 Hz) or dread_riser (28-110 Hz) fundamental anchor in Hz.'),
    sloshDepthCents: z.number().min(10).max(160).optional().describe('waterphone: asymmetric water-slosh pitch bend depth in cents (default 68).'),
    sloshRateHz: z.number().min(0.12).max(1.5).optional().describe('waterphone: water-slosh rate in Hz (default 0.41).'),
    bowPressure: z.number().min(0.15).max(1).optional().describe('waterphone: stick-slip bow friction pressure (default 0.68).'),
    cavernMix: z.number().min(0).max(0.85).optional().describe('waterphone: stereo cavern FDN diffusion mix (default 0.42).'),
    startBpm: z.number().min(30).max(220).optional().describe('heartbeat_arc: starting pulse BPM (default 66).'),
    endBpm: z.number().min(30).max(240).optional().describe('heartbeat_arc: ending pulse BPM (default 162).'),
    curve: z.enum(['exponential', 'linear', 'panic']).optional().describe('heartbeat_arc: acceleration curve from startBpm to endBpm (default "exponential").'),
    intensityCurve: z.number().min(0.3).max(4).optional().describe('heartbeat_arc: dynamic swell exponent across durationSeconds (default 1.35).'),
    membraneHz: z.number().min(42).max(58).optional().describe('heartbeat_arc: skin-membrane core frequency in Hz (42-58, default 48).'),
    valveClick: z.number().min(0).max(0.7).optional().describe('heartbeat_arc: subtle valve closure click level (default 0.22).'),
    riseSemitones: z.number().min(3).max(36).optional().describe('dread_riser: total upward pitch climb in semitones (default 13).'),
    growlAmount: z.number().min(0).max(1).optional().describe('dread_riser: low torsional sub-growl weight (default 0.72).'),
    cutoffTailMs: z.number().min(5).max(60).optional().describe('dread_riser: razor-clean guillotine cutoff fade at durationSeconds in ms (default 16).'),
    subHz: z.number().min(26).max(52).optional().describe('seismic_impact: seismic sub-boom fundamental in Hz (default 34).'),
    tamTamLevel: z.number().min(0).max(1).optional().describe('seismic_impact: concert Tam-Tam metallic shimmer bloom level (default 0.68).'),
    hallDecay: z.number().min(0.2).max(0.95).optional().describe('seismic_impact: natural dark hall decay factor (default 0.78).'),
    overwrite: z.boolean().default(false).describe('Allow replacing an existing WAV file when true.'),
    place,
  }, async ({ place: placeSpec, ...fxArgs }) => {
    const result = await renderCinemaFxToWorkspace({
      workspaceDir: root,
      ...fxArgs,
    });

    if (placeSpec && project) {
      const doc = await project.load(placeSpec.project);
      const info = project.songInfo(doc);
      const trackName = placeSpec.trackName ?? `${fxArgs.kind} ${fxArgs.output.replace(/\.wav$/i, '')}`;
      if (project.tracks(doc).some(t => t.getAttribute('name') === trackName)) {
        throw new Error(`Track name "${trackName}" is already in use. Pass place.trackName.`);
      }
      const item = sampleTrack({
        name: trackName,
        sample: fxArgs.output,
        bar: placeSpec.bar,
        seconds: result.durationSeconds,
        bpm: info.bpm,
        ticksPerBar: info.ticksPerBar,
        role: placeSpec.role ?? 'fx',
        volume: placeSpec.volume,
        pan: placeSpec.pan,
      });
      await project.checkTrack(item);
      const parent = project.container(doc);
      const anchor = project.tracks(doc).find(project.isAnchor);
      project.addTrack(parent, item);
      if (anchor) parent.appendChild(anchor);
      const saved = await project.save(doc, placeSpec.output);
      result.placed = {
        ...saved,
        track: trackName,
        bar: placeSpec.bar,
        bars: item.patterns[0].bars,
        bpm: info.bpm,
      };
    }

    return result;
  });
}

function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1).toLowerCase() === path.resolve(fileURLToPath(metaUrl)).toLowerCase();
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      output: { type: 'string' },
      workspace: { type: 'string' },
      duration: { type: 'string' },
      durationSeconds: { type: 'string' },
      seed: { type: 'string' },
      intensity: { type: 'string' },
      peakDb: { type: 'string' },
      modeCount: { type: 'string' },
      baseHz: { type: 'string' },
      sloshDepthCents: { type: 'string' },
      sloshRateHz: { type: 'string' },
      bowPressure: { type: 'string' },
      cavernMix: { type: 'string' },
      startBpm: { type: 'string' },
      endBpm: { type: 'string' },
      curve: { type: 'string' },
      intensityCurve: { type: 'string' },
      membraneHz: { type: 'string' },
      valveClick: { type: 'string' },
      riseSemitones: { type: 'string' },
      growlAmount: { type: 'string' },
      cutoffTailMs: { type: 'string' },
      subHz: { type: 'string' },
      tamTamLevel: { type: 'string' },
      hallDecay: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
    },
  });

  const num = v => (v === undefined ? undefined : Number(v));
  const durationVal = num(values.durationSeconds ?? values.duration);
  const wsDir = values.workspace ? path.resolve(values.workspace) : resolveWorkspaceDir(process.env);

  const report = await renderCinemaFxToWorkspace({
    workspaceDir: wsDir,
    kind: values.kind,
    output: values.output,
    overwrite: values.overwrite,
    ...(durationVal !== undefined ? { durationSeconds: durationVal } : {}),
    ...(values.seed !== undefined ? { seed: Math.round(Number(values.seed)) } : {}),
    ...(values.intensity !== undefined ? { intensity: num(values.intensity) } : {}),
    ...(values.peakDb !== undefined ? { peakDb: num(values.peakDb) } : {}),
    ...(values.modeCount !== undefined ? { modeCount: Math.round(Number(values.modeCount)) } : {}),
    ...(values.baseHz !== undefined ? { baseHz: num(values.baseHz) } : {}),
    ...(values.sloshDepthCents !== undefined ? { sloshDepthCents: num(values.sloshDepthCents) } : {}),
    ...(values.sloshRateHz !== undefined ? { sloshRateHz: num(values.sloshRateHz) } : {}),
    ...(values.bowPressure !== undefined ? { bowPressure: num(values.bowPressure) } : {}),
    ...(values.cavernMix !== undefined ? { cavernMix: num(values.cavernMix) } : {}),
    ...(values.startBpm !== undefined ? { startBpm: num(values.startBpm) } : {}),
    ...(values.endBpm !== undefined ? { endBpm: num(values.endBpm) } : {}),
    ...(values.curve !== undefined ? { curve: values.curve } : {}),
    ...(values.intensityCurve !== undefined ? { intensityCurve: num(values.intensityCurve) } : {}),
    ...(values.membraneHz !== undefined ? { membraneHz: num(values.membraneHz) } : {}),
    ...(values.valveClick !== undefined ? { valveClick: num(values.valveClick) } : {}),
    ...(values.riseSemitones !== undefined ? { riseSemitones: num(values.riseSemitones) } : {}),
    ...(values.growlAmount !== undefined ? { growlAmount: num(values.growlAmount) } : {}),
    ...(values.cutoffTailMs !== undefined ? { cutoffTailMs: num(values.cutoffTailMs) } : {}),
    ...(values.subHz !== undefined ? { subHz: num(values.subHz) } : {}),
    ...(values.tamTamLevel !== undefined ? { tamTamLevel: num(values.tamTamLevel) } : {}),
    ...(values.hallDecay !== undefined ? { hallDecay: num(values.hallDecay) } : {}),
  });

  process.stdout.write(JSON.stringify({ ...report, workspaceDir: wsDir }, null, 2) + '\n');
}
