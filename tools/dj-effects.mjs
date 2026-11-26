// DJ effects on rendered audio, timed in bars: filter sweeps, phaser, flanger, beat repeat, gate, tape stop, spinback,
// echo out, scratch, reverse, noise riser, pump and cut, plus rearranging a track by bar ranges.
// Everything is offline DSP on a workspace WAV, so it works on a full mix or on one stem.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
// "1/8" is an eighth note, "1/8t" a triplet eighth, "1/8d" a dotted eighth, "1" a bar. Returns beats.
export function divisionBeats(text) {
  const match = /^(\d+)(?:\/(\d+))?([td]?)$/.exec(String(text));
  if (!match || !Number(match[1]) || match[2] === '0') throw new Error(`Unknown division "${text}". Use 1, 1/2, 1/4, 1/8, 1/16 or 1/32, with t for triplet or d for dotted.`);
  const beats = 4 * Number(match[1]) / Number(match[2] ?? 1);
  return beats * (match[3] === 't' ? 2 / 3 : match[3] === 'd' ? 1.5 : 1);
}
const beatFrames = (audio, bpm) => audio.sampleRate * 60 / bpm;
export function regionOf(audio, bpm, effect, offsetSeconds = 0) {
  const bar = beatFrames(audio, bpm) * 4, origin = Math.round(offsetSeconds * audio.sampleRate);
  const start = clamp(origin + Math.round(effect.startBar * bar), 0, audio.frames);
  const end = clamp(origin + Math.round((effect.startBar + effect.bars) * bar), 0, audio.frames);
  if (end - start < 64) throw new Error(`Effect "${effect.type}" at bar ${effect.startBar} lies outside the audio or is too short`);
  return { start, end, length: end - start };
}
// Blend processed audio into the track over a region, with short ramps at both ends so nothing clicks.
function blend(channel, wet, start, mix, sampleRate, fadeMs = 4) {
  const fade = Math.min(Math.round(sampleRate * fadeMs / 1000), wet.length >> 1);
  for (let i = 0; i < wet.length; i++) {
    const edge = Math.min(1, (i + 1) / fade, (wet.length - i) / fade), w = mix * edge;
    channel[start + i] = channel[start + i] * (1 - w) + wet[i] * w;
  }
}
const expo = (from, to, t) => from * (to / from) ** t;

// ---------- effects ----------
// Each takes (audio, region, effect, context) and changes audio.channels in place.
const effects = {
  filter_sweep: {
    summary: 'Low-pass, high-pass or band-pass filter whose cutoff glides from fromHz to toHz. The DJ filter knob.',
    params: 'filter lowpass|highpass|bandpass (lowpass), fromHz (200), toHz (18000), resonance 0.5-12 (1.4), mix 0-1 (1)',
    apply(audio, { start, length }, e) {
      const kind = e.filter ?? 'lowpass', from = clamp(e.fromHz ?? 200, 20, 20000), to = clamp(e.toHz ?? 18000, 20, 20000), k = 1 / clamp(e.resonance ?? 1.4, 0.5, 12);
      for (const ch of audio.channels) {
        const wet = new Float32Array(length);
        let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let i = 0; i < length; i++) {
          if (i % 32 === 0) {
            const g = Math.tan(Math.PI * Math.min(expo(from, to, i / length), audio.sampleRate * 0.45) / audio.sampleRate);
            a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
          }
          const x = ch[start + i], v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
          wet[i] = kind === 'lowpass' ? v2 : kind === 'bandpass' ? v1 * k * 1.4 : x - k * v1 - v2;
        }
        blend(ch, wet, start, e.mix ?? 1, audio.sampleRate);
      }
    },
  },
  phaser: {
    summary: 'Sweeping notches that move up and down the spectrum. The slow whoosh of a phaser knob.',
    params: 'cycleBars (2), stages 2-12 (6), minHz (300), maxHz (4000), feedback 0-0.9 (0.5), mix 0-1 (0.5)',
    apply(audio, { start, length }, e, { bpm }) {
      const stages = clamp(Math.round(e.stages ?? 6), 2, 12), low = e.minHz ?? 300, high = e.maxHz ?? 4000, fb = clamp(e.feedback ?? 0.5, 0, 0.9);
      const cycle = (e.cycleBars ?? 2) * 4 * beatFrames(audio, bpm);
      audio.channels.forEach((ch, index) => {
        const wet = new Float32Array(length), x1 = new Float32Array(stages), y1 = new Float32Array(stages);
        let last = 0, a = 0;
        for (let i = 0; i < length; i++) {
          if (i % 16 === 0) {
            const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / cycle + index * Math.PI / 2), t = Math.tan(Math.PI * expo(low, high, lfo) / audio.sampleRate);
            a = (t - 1) / (t + 1);
          }
          let s = ch[start + i] + last * fb;
          for (let n = 0; n < stages; n++) { const y = a * s + x1[n] - a * y1[n]; x1[n] = s; y1[n] = y; s = y; }
          last = s;
          wet[i] = s;
        }
        blend(ch, wet, start, e.mix ?? 0.5, audio.sampleRate);
      });
    },
  },
  flanger: {
    summary: 'A very short delay swept back and forth: the jet-plane sound.',
    params: 'cycleBars (4), baseMs (1), depthMs (4), feedback 0-0.9 (0.6), mix 0-1 (0.5)',
    apply(audio, { start, length }, e, { bpm }) {
      const base = (e.baseMs ?? 1) / 1000 * audio.sampleRate, depth = (e.depthMs ?? 4) / 1000 * audio.sampleRate, fb = clamp(e.feedback ?? 0.6, 0, 0.9);
      const cycle = (e.cycleBars ?? 4) * 4 * beatFrames(audio, bpm), size = Math.ceil(base + depth) + 4;
      audio.channels.forEach((ch, index) => {
        const wet = new Float32Array(length), line = new Float32Array(size);
        let write = 0;
        for (let i = 0; i < length; i++) {
          const delay = base + depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / cycle + index * Math.PI / 3));
          const read = (write - delay + size * 2) % size, at = Math.floor(read), frac = read - at;
          const delayed = line[at % size] * (1 - frac) + line[(at + 1) % size] * frac;
          line[write] = ch[start + i] + delayed * fb;
          write = (write + 1) % size;
          wet[i] = delayed;
        }
        blend(ch, wet, start, e.mix ?? 0.5, audio.sampleRate);
      });
    },
  },
  beat_repeat: {
    summary: 'Grabs a slice at the start of the region and repeats it: the loop roll before a drop. accelerate halves the slice every quarter of the region.',
    params: 'division (1/8), accelerate true|false (false), decay 0-1 per repeat (1), mix 0-1 (1)',
    apply(audio, { start, length }, e, { bpm }) {
      const first = Math.max(32, Math.round(divisionBeats(e.division ?? '1/8') * beatFrames(audio, bpm))), decay = clamp(e.decay ?? 1, 0, 1);
      const fade = Math.round(audio.sampleRate * 0.002);
      for (const ch of audio.channels) {
        const source = ch.slice(start, Math.min(audio.frames, start + first)), wet = new Float32Array(length);
        let at = 0, slice = first, gain = 1;
        for (let i = 0; i < length; i++) {
          if (at >= slice) { at = 0; gain *= decay; if (e.accelerate) slice = Math.max(64, Math.round(first / 2 ** Math.floor(4 * i / length))); }
          const edge = Math.min(1, (at + 1) / fade, (slice - at) / fade);
          wet[i] = (source[at] ?? 0) * edge * gain;
          at++;
        }
        blend(ch, wet, start, e.mix ?? 1, audio.sampleRate);
      }
    },
  },
  gate: {
    summary: 'Chops the sound on and off in rhythm (a trance gate). pattern picks which steps sound.',
    params: 'division (1/16), pattern such as "x-xx" cycled per step (every step), duty 0.1-1 (0.5), depth 0-1 (1)',
    apply(audio, { start, length }, e, { bpm }) {
      const step = divisionBeats(e.division ?? '1/16') * beatFrames(audio, bpm), duty = clamp(e.duty ?? 0.5, 0.1, 1), depth = clamp(e.depth ?? 1, 0, 1);
      const pattern = (e.pattern ?? 'x').replace(/[\s|]/g, ''), smooth = Math.exp(-1 / (audio.sampleRate * 0.0015));
      if (!/^[xX\-.]+$/.test(pattern) || !/[xX]/.test(pattern)) throw new Error('Gate patterns use x for a sounding step and - for a silent one');
      for (const ch of audio.channels) {
        let gain = 1;
        for (let i = 0; i < length; i++) {
          const index = Math.floor(i / step), open = /[xX]/.test(pattern[index % pattern.length]) && (i - index * step) / step < duty;
          gain = gain * smooth + (open ? 1 : 1 - depth) * (1 - smooth);
          ch[start + i] *= gain;
        }
      }
    },
  },
  tape_stop: {
    summary: 'The music slows to a stop like a turntable being switched off, then stays silent to the end of the region.',
    params: 'stopBeats: how long the slow-down lasts (the whole region)',
    apply(audio, { start, length }, e, { bpm }) {
      const stop = Math.min(length, Math.round((e.stopBeats ?? Infinity) * beatFrames(audio, bpm)));
      for (const ch of audio.channels) {
        const source = ch.slice(start, start + length), wet = new Float32Array(length);
        let position = 0;
        for (let i = 0; i < stop; i++) {
          const speed = (1 - i / stop) ** 1.3, at = Math.floor(position), frac = position - at;
          wet[i] = ((source[at] ?? 0) * (1 - frac) + (source[at + 1] ?? 0) * frac) * Math.min(1, speed * 6);
          position += speed;
        }
        blend(ch, wet, start, 1, audio.sampleRate);
      }
    },
  },
  spinback: {
    summary: 'The record is spun backwards fast and dies away: the classic exit from a section.',
    params: 'speed: peak reverse speed 1-8 (4)',
    apply(audio, { start, length }, e) {
      const peak = clamp(e.speed ?? 4, 1, 8);
      for (const ch of audio.channels) {
        const wet = new Float32Array(length);
        let position = start;
        for (let i = 0; i < length; i++) {
          const t = i / length, speed = t < 0.35 ? 0.6 + (peak - 0.6) * (t / 0.35) : peak * (1 - (t - 0.35) / 0.65) ** 1.5;
          position -= speed;
          const at = Math.floor(position), frac = position - at;
          wet[i] = at > 0 ? (ch[at] * (1 - frac) + ch[at + 1] * frac) * Math.min(1, (1 - t) * 3) : 0;
        }
        blend(ch, wet, start, 1, audio.sampleRate);
      }
    },
  },
  echo_out: {
    summary: 'Cuts the music and lets a repeating echo of the last moment ring through the region (a dub echo throw).',
    params: 'division: time between repeats (1/4), feedback 0-0.95 (0.7), feedBeats: how much music goes into the echo (one division), dampHz: each repeat gets duller (3500)',
    apply(audio, { start, length }, e, { bpm }) {
      const beats = divisionBeats(e.division ?? '1/4'), delay = Math.max(64, Math.round(beats * beatFrames(audio, bpm))), fb = clamp(e.feedback ?? 0.7, 0, 0.95);
      const feed = Math.round((e.feedBeats ?? beats) * beatFrames(audio, bpm)), damp = 1 - Math.exp(-2 * Math.PI * clamp(e.dampHz ?? 3500, 200, 18000) / audio.sampleRate);
      const fade = Math.round(audio.sampleRate * 0.004);
      for (const ch of audio.channels) {
        const wet = new Float32Array(length), line = new Float32Array(delay);
        let low = 0;
        for (let i = 0; i < length; i++) {
          const input = i < feed ? ch[start + i] * Math.min(1, (feed - i) / fade) : 0;
          low += damp * (line[i % delay] - low);
          const out = input + low * fb;
          line[i % delay] = out;
          wet[i] = out;
        }
        blend(ch, wet, start, 1, audio.sampleRate);
      }
    },
  },
  scratch: {
    summary: 'Turntable scratch: a short slice dragged forwards and backwards by hand. baby is the plain back-and-forth, chirp cuts the sound at each turn, transform chops one slow drag.',
    params: 'pattern baby|chirp|transform (baby), division: length of one hand movement (1/8), sliceBeats: how much record passes under the needle (0.5), sourceBar: where the slice is taken from (the region start), over: keep the music underneath true|false (false), mix 0-1 (1)',
    apply(audio, { start, length }, e, { bpm, origin }) {
      const beat = beatFrames(audio, bpm), stroke = Math.max(64, Math.round(divisionBeats(e.division ?? '1/8') * beat)), span = Math.max(64, Math.round((e.sliceBeats ?? 0.5) * beat));
      const from = e.sourceBar === undefined ? start : clamp(origin + Math.round(e.sourceBar * 4 * beat), 0, audio.frames - 2), kind = e.pattern ?? 'baby';
      if (!['baby', 'chirp', 'transform'].includes(kind)) throw new Error('Scratch pattern is baby, chirp or transform');
      const chop = Math.round(beat / 8);
      for (const ch of audio.channels) {
        const source = ch.slice(from, Math.min(audio.frames, from + span + 2)), wet = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const index = Math.floor(i / stroke), u = (i - index * stroke) / stroke, eased = 0.5 - 0.5 * Math.cos(Math.PI * u);
          let position, gain = 1;
          if (kind === 'transform') {
            const slow = (i % (stroke * 4)) / (stroke * 4);
            position = slow * span;
            gain = (i % chop) / chop < 0.55 ? 1 : 0;
          } else {
            position = (index % 2 ? 1 - eased : eased) * span;
            // The hand is still at each turn, so the sound dips there; a chirp closes the fader at the turn.
            gain = kind === 'chirp' ? Math.sin(Math.PI * u) ** 0.5 * (u < 0.92 ? 1 : 0) : Math.min(1, Math.sin(Math.PI * u) * 4);
          }
          const at = Math.floor(position), frac = position - at;
          wet[i] = ((source[at] ?? 0) * (1 - frac) + (source[at + 1] ?? 0) * frac) * gain;
        }
        if (e.over) { const mix = e.mix ?? 1; for (let i = 0; i < length; i++) ch[start + i] = ch[start + i] * 0.7 + wet[i] * mix; } else blend(ch, wet, start, e.mix ?? 1, audio.sampleRate);
      }
    },
  },
  reverse: {
    summary: 'Plays the region backwards. One beat of it before a drop is a common lead-in.',
    params: 'mix 0-1 (1)',
    apply(audio, { start, length }, e) {
      for (const ch of audio.channels) blend(ch, ch.slice(start, start + length).reverse(), start, e.mix ?? 1, audio.sampleRate);
    },
  },
  noise_riser: {
    summary: 'Adds a rising hiss that builds tension into a drop. direction down gives a falling sweep after one.',
    params: 'levelDb: loudest point (-14), direction up|down (up), fromHz (400), toHz (9000), seed',
    apply(audio, { start, length }, e) {
      const next = random(e.seed ?? 7), down = e.direction === 'down', level = 10 ** ((e.levelDb ?? -14) / 20), from = e.fromHz ?? 400, to = e.toHz ?? 9000;
      for (const ch of audio.channels) {
        let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
        const fade = Math.round(audio.sampleRate * 0.01);
        for (let i = 0; i < length; i++) {
          const t = down ? 1 - i / length : i / length;
          if (i % 32 === 0) { const g = Math.tan(Math.PI * expo(from, to, t) / audio.sampleRate); a1 = 1 / (1 + g * (g + 0.5)); a2 = g * a1; a3 = g * a2; }
          const x = next() * 2 - 1, v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
          ch[start + i] += v1 * level * t ** 2 * Math.min(1, (i + 1) / fade, (length - i) / fade);
        }
      }
    },
  },
  pump: {
    summary: 'Ducks the level on every beat and lets it swell back: the breathing sound of sidechained house.',
    params: 'division (1/4), depth 0-1 (0.6), release: share of the step the swell takes 0.1-1 (0.6)',
    apply(audio, { start, length }, e, { bpm }) {
      const step = divisionBeats(e.division ?? '1/4') * beatFrames(audio, bpm), depth = clamp(e.depth ?? 0.6, 0, 1), release = clamp(e.release ?? 0.6, 0.1, 1);
      const attack = audio.sampleRate * 0.003;
      for (const ch of audio.channels) {
        for (let i = 0; i < length; i++) {
          const since = i - Math.floor(i / step) * step, down = Math.min(1, since / attack), up = Math.min(1, since / (step * release));
          ch[start + i] *= 1 - depth * down * (1 - up) ** 2;
        }
      }
    },
  },
  cut: {
    summary: 'Silence for the region: the one-beat gap before a drop.',
    params: 'none',
    apply(audio, { start, length }) {
      for (const ch of audio.channels) blend(ch, new Float32Array(length), start, 1, audio.sampleRate);
    },
  },
};
export const effectNames = Object.keys(effects);
export function describeEffects() {
  return effectNames.map(name => ({ type: name, summary: effects[name].summary, params: effects[name].params }));
}
// Apply effects in order. Each is { type, startBar, bars, ...params }. Returns the regions in seconds.
export function applyEffects(audio, bpm, list, { offsetSeconds = 0 } = {}) {
  if (!(bpm > 0)) throw new Error('Give the bpm of the audio');
  const origin = Math.round(offsetSeconds * audio.sampleRate), applied = [];
  list.forEach((effect, index) => {
    const definition = effects[effect.type];
    if (!definition) throw new Error(`Effect ${index + 1}: unknown type "${effect.type}". Use one of: ${effectNames.join(', ')}`);
    const region = regionOf(audio, bpm, effect, offsetSeconds);
    try { definition.apply(audio, region, effect, { bpm, origin }); } catch (error) { throw new Error(`Effect ${index + 1} (${effect.type}): ${error.message}`); }
    applied.push({ type: effect.type, startSeconds: Number((region.start / audio.sampleRate).toFixed(3)), seconds: Number((region.length / audio.sampleRate).toFixed(3)) });
  });
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) throw new Error('An effect produced invalid audio. Lower its feedback or resonance.');
  return applied;
}
// Build a new track from bar ranges of an old one: [{ fromBar, bars, repeat?, gainDb? }], joined with short crossfades.
export function rearrange(audio, bpm, segments, { offsetSeconds = 0, crossfadeMs = 6 } = {}) {
  const bar = beatFrames(audio, bpm) * 4, origin = Math.round(offsetSeconds * audio.sampleRate), fade = Math.round(audio.sampleRate * crossfadeMs / 1000);
  const pieces = [];
  segments.forEach((segment, index) => {
    const start = origin + Math.round(segment.fromBar * bar), length = Math.round(segment.bars * bar);
    if (start < 0 || start + length > audio.frames + 2 || length <= fade * 2) throw new Error(`Segment ${index + 1} (bars ${segment.fromBar} to ${segment.fromBar + segment.bars}) is outside the audio or too short`);
    for (let n = 0; n < (segment.repeat ?? 1); n++) pieces.push({ start, length, gain: 10 ** ((segment.gainDb ?? 0) / 20) });
  });
  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  if (total > audio.sampleRate * 1200) throw new Error('The rearranged track would be longer than 20 minutes');
  const channels = audio.channels.map(ch => {
    const out = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i++) {
        // Fade each piece in from the audio just before it and out into the audio just after it, so joins are smooth.
        const edge = Math.min(1, (i + 1) / fade, (piece.length - i) / fade);
        out[at + i] = (ch[piece.start + i] ?? 0) * piece.gain * edge;
      }
      at += piece.length;
    }
    return out;
  });
  return { sampleRate: audio.sampleRate, channels, frames: total, pieces: pieces.length };
}

export function register({ tool, z, dsp, root, schemas, render, moduleGuidance }) {
  moduleGuidance.push('For DJ-style movement on a finished render (filter sweeps into a drop, a loop roll, an echo throw at a break, a tape stop, a scratch, a riser, a house pump), call list_dj_effects and then dj_effects on the rendered WAV with bar positions. Use rearrange_audio to cut a render into a new order by bars.');
  const read = async name => {
    const file = path.join(root, name);
    if (!existsSync(file)) throw new Error(`"${name}" was not found in the workspace`);
    const inputCheck = await verifyAudioFileProvenance(file, { workspaceDir: root, env: process.env });
    return { audio: dsp.decodeWav(await readFile(file)), inputCheck };
  };
  const finish = async (audio, output, { targetLufs, ceilingDb, inputCheck, generatorTool }) => {
    const outPath = path.join(root, output);
    if (existsSync(outPath)) throw new Error('Output already exists');
    const mastering = render.masterAudio(audio, { targetLufs, ceilingDb });
    const wav = dsp.encodeWav(audio);
    await render.writeAudio(outPath, wav);
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool,
    });
    return { audio: output, ...render.measureWav(wav), integratedLufs: dsp.loudness(audio).integratedLufs, ...(mastering ? { mastering } : {}) };
  };
  const common = { audio: schemas.workspaceWav.describe('Workspace WAV: a mix or one stem.'), output: schemas.audioOut, bpm: z.number().min(40).max(260),
    offsetSeconds: z.number().min(0).max(600).default(0).describe('Where bar 0 starts in the file. 0 for anything rendered by this server.'),
    targetLufs: schemas.loudnessTarget, ceilingDb: schemas.ceilingTarget };

  tool('list_dj_effects', 'List the DJ effects dj_effects can apply, with what each sounds like and its parameters.', {}, async () => ({
    effects: describeEffects(), timing: 'Every effect takes startBar and bars (fractions allowed: 0.25 is one beat). Bars count from zero.',
    recipes: {
      'build into a drop': 'filter_sweep highpass 40 to 900 Hz over 4 bars, noise_riser over the same 4 bars, beat_repeat 1/8 with accelerate over the last bar, cut for the last quarter beat',
      'break': 'echo_out over the first bar of the break, filter_sweep lowpass 18000 to 500 Hz across the section before it',
      'exit': 'spinback or tape_stop over the last bar',
      'energy': 'pump over the main sections, phaser on a stem over 8 bars',
    },
  }));

  tool('dj_effects', 'Apply DJ effects to a rendered WAV at bar positions: filter_sweep, phaser, flanger, beat_repeat, gate, tape_stop, spinback, echo_out, scratch, reverse, noise_riser, pump and cut. Effects run in order, so a later one hears the earlier ones. Optionally masters the result to a loudness target. See list_dj_effects for parameters.', {
    ...common,
    effects: z.array(z.object({ type: z.enum(effectNames), startBar: z.number().min(0).max(4000), bars: z.number().min(1 / 64).max(512) }).passthrough()).min(1).max(200),
  }, async ({ audio: name, output, bpm, offsetSeconds, effects: list, targetLufs, ceilingDb }) => {
    const { audio, inputCheck } = await read(name);
    const applied = applyEffects(audio, bpm, list, { offsetSeconds });
    return { ...(await finish(audio, output, { targetLufs, ceilingDb, inputCheck, generatorTool: 'dj_effects' })), applied };
  });

  tool('rearrange_audio', 'Cut a rendered WAV into a new order by bar ranges, as a DJ edit: repeat a section, drop the intro, jump to the break. Segments are joined with short fades.', {
    ...common,
    segments: z.array(z.object({ fromBar: z.number().min(0).max(4000), bars: z.number().min(0.25).max(512), repeat: z.number().int().min(1).max(64).optional(), gainDb: z.number().min(-60).max(12).optional() })).min(1).max(200),
  }, async ({ audio: name, output, bpm, offsetSeconds, segments, targetLufs, ceilingDb }) => {
    const { audio, inputCheck } = await read(name);
    const out = rearrange(audio, bpm, segments, { offsetSeconds });
    return { ...(await finish(out, output, { targetLufs, ceilingDb, inputCheck, generatorTool: 'rearrange_audio' })), pieces: out.pieces, bars: Number((out.frames / (out.sampleRate * 240 / bpm)).toFixed(3)) };
  });
}
