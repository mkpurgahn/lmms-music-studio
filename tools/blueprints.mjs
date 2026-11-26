// Blueprints: tested plans for kinds of game music. create_from_blueprint turns one into a full editable project
// whose lead is built from a single motif. The plans are data in blueprints.json; see docs/blueprints.md.
import { readFileSync } from 'node:fs';
import { parseChord } from '../music.mjs';
import { isStrictCopyright } from './provenance.mjs';
import {
  parseKey, readMotif, fitKey, pitches, totalSteps, formatLine, toNotes, fitLength, fitRegister, pitchClassName, degreeOf, fromDegree,
  shift, fitToChord, invert, retrograde, augment, diminish, varyRhythm, fragment, sequence, repeat, callAndResponse, cadence, modes,
} from './motif.mjs';

const library = JSON.parse(readFileSync(new URL('./blueprints.json', import.meta.url), 'utf8'));
export const blueprints = library.blueprints.map(b => withDefaults(b));
export const blueprintIds = blueprints.map(b => b.id);
const mod = (a, n) => ((a % n) + n) % n;
const bar = 192;
const supportRoles = ['bass', 'harmony', 'counter', 'texture'];

function withDefaults(b) {
  const d = library.defaults;
  return { ...b, lanes: { ...d.lanes, ...(b.lanes ?? {}) }, phraseBars: b.phraseBars ?? d.phraseBars,
    harmonicRhythm: b.harmonicRhythm ?? d.harmonicRhythm, masterVolume: b.masterVolume ?? d.masterVolume, intro: b.intro ?? [], outro: b.outro ?? [] };
}
export function getBlueprint(id) {
  const found = blueprints.find(b => b.id === id);
  if (!found) throw new Error(`Unknown blueprint "${id}". Use one of: ${blueprintIds.join(', ')}`);
  return found;
}

// ---------- harmony ----------
const numerals = ['VII', 'III', 'VI', 'IV', 'II', 'V', 'I'];
const numeralDegree = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };
const minorSuffix = { '': 'm', 7: 'm7', maj7: 'mMaj7', 6: 'm6', 9: 'm9', add9: 'madd9' };
// Roman numerals count scale degrees of the key's own mode. Upper case is a major chord, lower case minor,
// "o" or "dim" diminished, then an optional quality such as 7, maj7, sus4 or add9. A b or # prefix is read against
// the major scale, as usual: bVII is a whole step under the tonic in any mode, and bIII a minor third above it.
// With diatonic, the chord quality comes from the key instead of the case, so a progression written for one mode
// stays inside the key when it is used in another.
export function romanToChord(token, key, { diatonic = false } = {}) {
  const match = /^([b#]?)([ivIV]+)(.*)$/.exec(token);
  if (!match) return null;
  const word = match[2].toUpperCase();
  if (!numerals.includes(word)) return null;
  const upper = match[2] === match[2].toUpperCase();
  if (!upper && match[2] !== match[2].toLowerCase()) return null;
  const degree = numeralDegree[word];
  const root = match[1] ? mod(key.tonic + modes.major[degree - 1] + (match[1] === '#' ? 1 : -1), 12) : mod(key.tonic + key.scale[degree - 1], 12);
  // A flat numeral is spelled with flats and a sharp one with sharps; otherwise the key decides.
  const spelling = match[1] === 'b' ? { flats: true } : match[1] === '#' ? { flats: false } : key;
  let suffix = match[3];
  let quality;
  if (diatonic && !match[1]) {
    const at = n => mod(key.scale[(degree - 1 + n) % 7] - key.scale[degree - 1], 12);
    const triad = at(2) === 4 ? (at(4) === 8 ? 'aug' : '') : (at(4) === 6 ? 'dim' : 'm');
    const seventh = at(6);
    if (/7/.test(suffix)) {
      quality = { '': seventh === 11 ? 'maj7' : '7', m: seventh === 11 ? 'mMaj7' : 'm7', dim: seventh === 10 ? 'm7b5' : 'dim7', aug: 'aug' }[triad];
    } else quality = /^sus[24]?$/.test(suffix) && triad !== 'dim' ? suffix : triad;
    const symbol = pitchClassName(root, spelling) + quality;
    parseChord(symbol);
    return symbol;
  }
  if (/^(o|dim)$/.test(suffix)) quality = 'dim';
  else if (/^(o7|dim7)$/.test(suffix)) quality = 'dim7';
  else if (/^(ø7?|m7b5)$/.test(suffix)) quality = 'm7b5';
  else if (upper) quality = suffix;
  else quality = minorSuffix[suffix] ?? suffix;
  const symbol = pitchClassName(root, spelling) + quality;
  parseChord(symbol);
  return symbol;
}
// Chord symbols ("Dm Bb F C") or Roman numerals ("i VI III VII"); ":2" makes a chord last two bars.
export function parseProgression(text, key, { diatonic = false } = {}) {
  const tokens = (Array.isArray(text) ? text : String(text).trim().split(/[\s|,]+/)).filter(Boolean);
  if (!tokens.length) throw new Error('The progression is empty');
  return tokens.map(token => {
    const [name, length] = token.split(':');
    let symbol = null;
    try { symbol = romanToChord(name, key, { diatonic }); } catch { symbol = null; }
    if (!symbol) {
      try { parseChord(name); symbol = name; } catch { throw new Error(`Cannot read chord "${name}". Use chord symbols such as Dm or Bb7, or Roman numerals such as i, IV or V7.`); }
    }
    const bars = length === undefined ? null : Number(length);
    if (bars !== null && !(bars >= 1 / 16 && Number.isInteger(bars * 16))) {
      throw new Error(`Chord "${token}" needs a length in bars that is a whole number of sixteenth-note steps, at least 0.0625 (one step)`);
    }
    return { symbol, bars };
  });
}
// The chord changes in one section: the progression restarts at the section start and loops.
export function chordSpans(progression, bars, harmonicRhythm) {
  const spans = [];
  let at = 0, i = 0;
  while (at < bars * bar) {
    const item = progression[i++ % progression.length];
    // At least one sixteenth-note step, so the loop always moves on.
    const ticks = Math.min(bars * bar - at, Math.max(12, Math.round((item.bars ?? harmonicRhythm) * 16) * 12));
    const chord = parseChord(item.symbol);
    spans.push({ symbol: item.symbol, tick: at, ticks, root: chord.bass ?? chord.root, tones: chordPitchClasses(chord) });
    at += ticks;
  }
  return spans;
}
function chordPitchClasses(chord) {
  let intervals = chord.intervals;
  if (intervals.length > 4) intervals = intervals.filter(i => i !== 7).slice(0, 4);
  return intervals.map(i => mod(chord.root + i, 12));
}
// Each pitch class placed inside [low, high], as near `centre` as it can be.
function placeNear(pc, low, high, centre) {
  let best = null;
  for (let midi = low; midi <= high; midi++) if (mod(midi, 12) === pc && (best === null || Math.abs(midi - centre) < Math.abs(best - centre))) best = midi;
  return best;
}
export function voiceInLane(tones, [low, high], centre = (low + high) / 2) {
  return [...new Set(tones.map(pc => placeNear(pc, low, high, centre)))].sort((a, b) => a - b);
}
const lowestIn = (pc, low) => low + mod(pc - low, 12);

// ---------- parts ----------
const energyScale = { 1: 0.8, 2: 0.9, 3: 1 };
const vel = (base, energy) => Math.max(1, Math.min(127, Math.round(base * (energyScale[energy] ?? 0.9))));
const gridVelocity = { X: 100, x: 82, o: 60, g: 34 };
function note(tick, midi, length, velocity) { return { tick: Math.round(tick), midi, length: Math.max(1, Math.round(length)), velocity }; }

export const bassFigures = {
  whole: (s, root) => [note(s.tick, root, s.ticks * 0.97, 96)],
  half: (s, root) => everyStep(s, 96, (t, i) => note(t, root, 90, i % 2 ? 84 : 96)),
  quarters: (s, root) => everyStep(s, 48, (t, i) => note(t, root, 42, i % 4 ? 82 : 96)),
  eighths: (s, root) => everyStep(s, 24, (t, i) => note(t, root, 20, i % 4 ? 80 : 96)),
  octaves: (s, root, lane) => {
    const up = root + 12 <= lane[1] ? root + 12 : root;
    return everyStep(s, 24, (t, i) => note(t, i % 2 ? up : root, 20, i % 2 ? 82 : 96));
  },
  syncopated: (s, root, lane) => {
    const up = root + 12 <= lane[1] ? root + 12 : root;
    const cells = [[0, 30, root, 96], [36, 18, root, 82], [72, 24, up, 84], [96, 30, root, 94], [132, 18, root, 80], [168, 24, up, 84]];
    const out = [];
    for (let b = 0; b * bar < s.ticks; b++) for (const [at, len, midi, v] of cells) if (b * bar + at < s.ticks) out.push(note(s.tick + b * bar + at, midi, len, v));
    return out;
  },
  pedal: (s, root, lane, key) => [note(s.tick, lowestIn(key.tonic, lane[0]), s.ticks * 0.97, 92)],
};
function everyStep(span, step, make) {
  const out = [];
  for (let t = 0, i = 0; t < span.ticks; t += step, i++) out.push(make(span.tick + t, i));
  return out;
}
export const harmonyStyles = {
  block: (s, chord) => chord.map(m => note(s.tick, m, s.ticks * 0.98, 66)),
  pulse: (s, chord) => everyStep(s, 48, (t, i) => chord.map(m => note(t, m, 40, i % 4 ? 56 : 66))).flat(),
  stabs: (s, chord) => everyStep(s, 48, t => chord.map(m => note(t + 24, m, 14, 64))).flat(),
  arp: (s, chord) => {
    const order = [...chord, ...chord.slice(1, -1).reverse()];
    return everyStep(s, 24, (t, i) => note(t, order[i % order.length], 22, i % 4 ? 58 : 70));
  },
  hits: (s, chord) => chord.map(m => note(s.tick, m, Math.min(s.ticks, 72), 76)),
};
export const textureStyles = {
  arp: (s, chord) => everyStep(s, 12, (t, i) => note(t, chord[i % chord.length], 10, i % 4 ? 46 : 58)),
  shimmer: (s, chord) => {
    const order = [0, 2, 1, 2, 3, 1, 2, 0].map(i => chord[i % chord.length]);
    return everyStep(s, 24, (t, i) => note(t, order[i % order.length], 20, 44));
  },
  drone: (s, chord, lane, key) => {
    const tonic = lowestIn(key.tonic, lane[0]), fifth = placeNear(mod(key.tonic + 7, 12), lane[0], lane[1], tonic + 7);
    return [note(s.tick, tonic, s.ticks * 0.98, 60), note(s.tick, fifth, s.ticks * 0.98, 52)];
  },
};

// ---------- the lead: one motif, stated, repeated, varied and rested ----------
// Every op returns events; the caller cuts or pads them to the phrase and keeps them in the lead lane.
export const leadOps = {
  state: m => m,
  repeat: m => m,
  sequence_up: (m, k) => shift(m, k, 1),
  sequence_down: (m, k) => shift(m, k, -1),
  fit: (m, k, c) => fitToChord(m, k, c.chord).events,
  invert: (m, k) => invert(m, k),
  retrograde: m => retrograde(m),
  rhythm: m => varyRhythm(m),
  augment: (m, k, c) => augment(totalSteps(m) * 2 > c.steps ? fragment(m, 'first') : m),
  diminish: m => repeat(diminish(m), 2),
  fragment: (m, k) => sequence(fragment(m, 'first'), k, { step: 1, count: 2 }),
  answer: (m, k) => callAndResponse(m, k).answer,
  cadence: (m, k, c) => endOn(m, k, 'authentic', c),
  half_cadence: (m, k, c) => endOn(m, k, 'half', c),
  // One held note per chord in the phrase: the tonic where the chord has it, otherwise its most stable tone.
  // Over V then I this plays the 5th then the tonic.
  hold: (m, k, c) => c.chordsIn().flatMap(({ steps, symbol }) => cadence([{ midi: c.tonicNear, steps }], k, 'authentic', { chord: symbol })),
  rest: () => [],
};
// A cadence whose last note lands on a tone of the chord sounding under that note.
function endOn(m, k, type, c) {
  const draft = cadence(m, k, type);
  const lastAt = draft.slice(0, draft.findLastIndex(e => e.midi !== null)).reduce((sum, e) => sum + e.steps, 0);
  return cadence(m, k, type, { chord: c.chordAt(Math.min(lastAt, c.steps - 1)) });
}
// Fit a plan to the phrases a section has room for (a long motif makes fewer, longer phrases).
// The first phrases keep their ops and the last phrase keeps the plan's last op, so endings are never lost.
export function fitPlan(plan, room) {
  if (!Array.isArray(plan) || plan.length <= room) return plan;
  const ending = ['cadence', 'half_cadence', 'hold'];
  if (room === 1) return [ending.includes(plan.at(-1)) ? plan.at(-1) : plan.find(op => op !== 'rest') ?? plan[0]];
  return [...plan.slice(0, room - 1), plan.at(-1)];
}
// A minor second or minor ninth between parts sounds harsh.
const harsh = (a, b) => Math.abs(a - b) === 1 || Math.abs(a - b) === 13;
// Move notes that would sound a minor second or minor ninth against another pitched part. The lead is fixed first;
// then parts are settled in order: bass, harmony, texture, counter. A clashing note tries the octave above and below, then the nearest tone of the
// chord in its lane; if nothing fits it is dropped. The lead sits in its own lane above all of them.
const settleOrder = ['bass', 'harmony', 'texture', 'counter'];
export function resolveClashes(local, tracks, lanes, spans, offset) {
  const fixed = tracks.filter(t => t.role === 'lead').flatMap(t => local[t.name] ?? []);
  const overlaps = (a, b) => a.tick < b.tick + b.length && b.tick < a.tick + a.length;
  for (const role of settleOrder) {
    for (const t of tracks.filter(t => t.role === role)) {
      const notes = local[t.name];
      if (!notes) continue;
      const lane = lanes[role], out = [];
      for (const n of notes) {
        const free = m => m >= lane[0] && m <= lane[1] && !fixed.some(f => overlaps(f, n) && harsh(f.midi, m)) && !out.some(o => overlaps(o, n) && o.midi === m);
        if (free(n.midi)) { out.push(n); continue; }
        const span = spans.find(sp => sp.tick + offset <= n.tick && n.tick < sp.tick + offset + sp.ticks) ?? spans.at(-1);
        const chordTones = [];
        for (let m = lane[0]; m <= lane[1]; m++) if (span.tones.includes(mod(m, 12))) chordTones.push(m);
        chordTones.sort((a, b) => Math.abs(a - n.midi) - Math.abs(b - n.midi));
        const choice = [n.midi + 12, n.midi - 12, ...chordTones].find(free);
        if (choice !== undefined) out.push({ ...n, midi: choice });
      }
      local[t.name] = out;
      fixed.push(...out);
    }
  }
}
export const leadOpNames = Object.keys(leadOps);
export const counterOps = ['answer', 'guide', 'fragment', 'rest'];
// Later passes and doubled sections vary the plan instead of repeating it note for note.
const varyOp = { repeat: 'rhythm', sequence_up: 'sequence_down', sequence_down: 'sequence_up', invert: 'retrograde', retrograde: 'invert' };
export function scalePlan(plan, factor, pass = 0) {
  if (!Array.isArray(plan)) return plan;
  let out = pass ? plan.map(op => varyOp[op] ?? op) : [...plan];
  if (factor === 0.5) out = out.filter((_, i) => i % 2 === 0).map((op, i, list) => i === list.length - 1 ? plan.at(-1) : op);
  if (factor === 2) out = [...out.map(op => op === 'cadence' ? 'half_cadence' : op), ...out.map(op => varyOp[op] ?? op)];
  return out;
}
// Keep a lead phrase in its lane. One or two stray notes (usually a cadence landing low) move by an octave on their own;
// otherwise the whole phrase moves so its shape is kept.
function keepInLane(events, [low, high], previous = null) {
  const p = pitches(events);
  if (!p.length) return events;
  const strays = p.filter(m => m < low).length;
  // A low stray or two: either move just those notes up an octave or move the whole phrase up (if it still fits),
  // whichever leaves the smaller largest leap, counting the step in from the previous phrase.
  if (strays && strays <= 2 && p.length > 3) {
    const folded = events.map(e => e.midi !== null && e.midi < low ? { ...e, midi: e.midi + 12 } : e);
    const lifted = events.map(e => e.midi === null ? e : { ...e, midi: e.midi + 12 });
    const cost = list => Math.max(largestLeap(list), previous === null ? 0 : Math.abs(pitches(list)[0] - previous));
    return Math.max(...p) + 12 <= high + 5 && cost(lifted) < cost(folded) ? lifted : folded;
  }
  let k = 0;
  while (Math.min(...p) + 12 * k < low) k++;
  while (Math.max(...p) + 12 * k > high && Math.min(...p) + 12 * (k - 1) >= low) k--;
  return events.map(e => e.midi === null ? e : { ...e, midi: e.midi + 12 * k });
}
// When a lead phrase would start more than an octave from the previous phrase's last note, move it an octave
// towards that note if it stays in the lane (with a little headroom).
const largestLeap = events => { const p = pitches(events); return Math.max(0, ...p.slice(1).map((m, i) => Math.abs(m - p[i]))); };
function nearPrevious(events, previous, [low, high]) {
  const p = pitches(events);
  if (!p.length || previous === null || Math.abs(p[0] - previous) <= 12) return events;
  let best = 0;
  for (const k of [-1, 1]) {
    if (Math.min(...p) + 12 * k < low || Math.max(...p) + 12 * k > high + 5) continue;
    if (Math.abs(p[0] + 12 * k - previous) + 2 < Math.abs(p[0] + 12 * best - previous)) best = k;
  }
  return best ? events.map(e => e.midi === null ? e : { ...e, midi: e.midi + 12 * best }) : events;
}
// Fold every note into [low, high] by octaves. Used for counter lines, which must stay under the lead.
function foldIntoLane(events, [low, high]) {
  return events.map(e => {
    if (e.midi === null) return e;
    let midi = e.midi;
    while (midi > high) midi -= 12;
    while (midi < low) midi += 12;
    return { ...e, midi };
  });
}

// ---------- candidates for the requested length ----------
function sectionList(b, factor, passes, bodyCount = b.body.length) {
  const out = [];
  const add = (s, pass) => out.push({ ...s, name: pass ? `${s.name} ${pass + 1}` : s.name, bars: s.bars * factor,
    lead: scalePlan(s.lead, factor, pass), counter: scalePlan(s.counter, factor, pass) });
  for (const s of b.intro) add(s, 0);
  for (let pass = 0; pass < passes; pass++) for (const s of b.body.slice(0, bodyCount)) add(s, pass);
  for (const s of b.outro) add(s, 0);
  return out;
}
export function lengthCandidates(b) {
  const base = [...b.intro, ...b.body, ...b.outro];
  const out = [];
  for (const factor of [0.5, 1, 2]) {
    if (!base.every(s => Number.isInteger(s.bars * factor / b.phraseBars) && s.bars * factor >= b.phraseBars)) continue;
    for (let passes = 1; passes <= (b.kind === 'stinger' ? 1 : 8); passes++) {
      const bars = sectionList(b, factor, passes).reduce((sum, s) => sum + s.bars, 0);
      if (bars <= 512) out.push({ factor, passes, bodyCount: b.body.length, bars });
    }
    // Short loops: the intro and only the first one or more body sections, played once.
    if (b.kind === 'loop') for (let count = 1; count < b.body.length; count++) {
      out.push({ factor, passes: 1, bodyCount: count, bars: sectionList(b, factor, 1, count).reduce((sum, s) => sum + s.bars, 0) });
    }
  }
  return out;
}
// The candidate nearest the target; ties prefer the whole body, the written section lengths, then fewer passes.
export function chooseLength(b, targetBars) {
  const all = lengthCandidates(b);
  if (targetBars === undefined) return all.find(c => c.factor === 1 && c.passes === 1 && c.bodyCount === b.body.length);
  return [...all].sort((x, y) => Math.abs(x.bars - targetBars) - Math.abs(y.bars - targetBars) || y.bodyCount - x.bodyCount
    || Math.abs(x.factor - 1) - Math.abs(y.factor - 1) || x.passes - y.passes)[0];
}

// ---------- sounds ----------
const catalogueRoles = { bass: ['bass'], harmony: ['pad', 'keys', 'organ', 'strings'], lead: ['lead', 'pluck', 'bell'], counter: ['lead', 'pluck', 'bell', 'pad'], texture: ['pad', 'pluck', 'bell'] };
const sustainedStyles = ['block', 'drone'];
// Does this track play anything short and rhythmic in the blueprint? Lead, counter and bass always count.
function playsRhythmic(b, track) {
  if (track.role !== 'harmony' && track.role !== 'texture') return true;
  return [...b.intro, ...b.body, ...b.outro].some(s => s[track.role] && !sustainedStyles.includes(s[track.role]));
}
// Does this track hold long notes somewhere? Then a decaying sound would fade out under them.
const heldFigures = ['whole', 'pedal', 'half', 'block', 'drone'];
function holdsNotes(b, track) {
  const key = track.role === 'bass' ? 'bass' : track.role;
  return [...b.intro, ...b.body, ...b.outro].some(s => heldFigures.includes(s[key]));
}
// Single-note parts (arpeggios) need a higher level per note than chords to sit at the same loudness.
function singleNotes(b, track) {
  if (track.role !== 'harmony') return track.role !== 'texture' || [...b.intro, ...b.body].every(s => !s.texture || s.texture !== 'drone');
  return [...b.intro, ...b.body, ...b.outro].filter(s => s.harmony).every(s => s.harmony === 'arp');
}
const peakTarget = { bass: -16, harmony: -22, lead: -15, counter: -21, texture: -26 };
// Track volume that brings a preset measured at volume 60 to `target` dBFS peak for one note.
export function volumeFor(peakAt60, target) {
  return Math.round(Math.max(3, Math.min(150, 60 * 10 ** ((target - peakAt60) / 20))));
}
// Native presets from the measured catalogue that suit a role: pitched, reliably tuned, not too quiet or loud.
// A track that plays short rhythmic parts avoids slow-attack sounds, which would barely speak.
export function suggestPresets(sounds, role, { prefer = [], exclude = [], limit = 3, rhythmic = true, single = false } = {}) {
  const wanted = role === 'harmony' && rhythmic ? [...catalogueRoles.harmony, 'pluck', 'bell'] : catalogueRoles[role];
  if (!wanted || !sounds) return [];
  const avoid = role === 'lead' || role === 'counter' || role === 'bass' || rhythmic ? ['slow-attack', 'quiet'] : ['quiet', 'percussive'];
  return Object.entries(sounds)
    .filter(([name, f]) => name.endsWith('.xpf') && !exclude.includes(name) && wanted.includes(f.role) && f.pitched && f.peakDbfs !== null
      && f.peakDbfs >= -24 && f.peakDbfs <= -3 && Math.abs(f.pitchOffset) <= 24 && f.pitchOffset % 12 === 0 && !avoid.some(t => f.tags?.includes(t)))
    .map(([name, f]) => ({ preset: name, score: prefer.filter(t => f.tags?.includes(t)).length * 3 - Math.abs(f.peakDbfs + 10) / 4 - (f.tags?.includes('long-release') && role !== 'harmony' && role !== 'texture' ? 2 : 0), f }))
    .sort((a, b) => b.score - a.score || a.preset.localeCompare(b.preset))
    .slice(0, limit)
    .map(({ preset, f }) => ({ preset, tags: f.tags, peakDbfsAtVolume60: f.peakDbfs, volume: volumeFor(f.peakDbfs, peakTarget[role] + (single && (role === 'harmony' || role === 'texture') ? 5 : 0)) }));
}

// ---------- the arrangement ----------
// Pure: blueprint + options -> create_project tracks, section map and a report. No file or LMMS access.
export function buildArrangement(blueprintOrId, { key: keyInput, bpm, lengthBars, lengthSeconds, motif: motifInput, progression, contrastProgression,
  sounds = 'default', catalogue } = {}) {
  const b = typeof blueprintOrId === 'string' ? getBlueprint(blueprintOrId) : withDefaults(blueprintOrId);
  const keyText = keyInput && /^\s*[A-Ga-g][#b]?\s*$/.test(keyInput) ? `${keyInput.trim()} ${b.key.split(/\s+/).slice(1).join(' ')}` : keyInput ?? b.key;
  const key = parseKey(keyText);
  const tempo = bpm ?? b.bpm;
  const secondsPerBar = 240 / tempo;
  const target = lengthBars ?? (lengthSeconds !== undefined ? lengthSeconds / secondsPerBar : undefined);
  const choice = chooseLength(b, target);
  const sections = sectionList(b, choice.factor, choice.passes, choice.bodyCount);
  const progressions = { ...b.progressions };
  if (progression) progressions.main = progression;
  if (contrastProgression) progressions.contrast = contrastProgression;
  // The blueprint's own progressions follow the key's chord qualities when you choose another mode; yours are read as written.
  const ownMode = parseKey(b.key).mode !== key.mode;
  const parsed = Object.fromEntries(Object.entries(progressions).map(([name, text]) => [name,
    parseProgression(text, key, { diatonic: ownMode && text === b.progressions[name] })]));

  // The motif: the agent's own, or the blueprint's scale-degree motif in this key. Placed in the lead lane.
  const read = fitKey(readMotif(motifInput ?? b.motif, key), key);
  const motifPitches = pitches(read.events);
  if (!motifPitches.length) throw new Error('The motif needs at least one note');
  const width = Math.max(...motifPitches) - Math.min(...motifPitches);
  if (width > 24) throw new Error(`The motif spans ${width} semitones. Keep it within two octaves so it fits the lead lane.`);
  const phraseSteps = Math.max(b.phraseBars, Math.ceil(totalSteps(read.events) / 16)) * 16;
  const lanes = b.lanes;
  const motif = fitRegister(read.events, lanes.lead[0], lanes.lead[1]);
  const tonicNear = fromDegree(Math.round(degreeOf(Math.round((lanes.lead[0] + lanes.lead[1]) / 2), key) / 7) * 7, key);
  const adjustments = [];
  const phrases = [];
  let lastLead = null;

  const parts = Object.fromEntries(b.tracks.map(t => [t.name, []]));
  const map = [];
  const leadPlan = [];
  let start = 0;
  for (const s of sections) {
    const spans = chordSpans(parsed[s.chords ?? 'main'] ?? parsed.main, s.bars, b.harmonicRhythm);
    const offset = start * bar;
    const sectionSteps = s.bars * 16;
    const chordAt = step => (spans.find(sp => sp.tick <= step * 12 && step * 12 < sp.tick + sp.ticks) ?? spans.at(-1)).symbol;
    const shiftSpan = sp => ({ ...sp, tick: sp.tick + offset });
    const room = Math.max(1, Math.floor(sectionSteps / phraseSteps));
    // Phrase windows: the last phrase takes any steps left over, so a section never ends with an unplanned gap.
    const windows = Array.from({ length: room }, (_, i) => ({ at: i * phraseSteps, steps: i === room - 1 ? sectionSteps - i * phraseSteps : phraseSteps }));
    const plans = {};
    for (const part of ['lead', 'counter']) {
      if (!Array.isArray(s[part])) continue;
      plans[part] = fitPlan(s[part], room);
      if (plans[part].length !== s[part].length || plans[part].some((op, i) => op !== s[part][i])) {
        adjustments.push({ section: s.name, part, planned: s[part], used: plans[part], reason: `the motif is ${phraseSteps / 16} bars long, so the ${s.bars}-bar section has room for ${room} phrase${room > 1 ? 's' : ''}` });
      }
      plans[part].forEach((op, i) => phrases.push({ section: s.name, part, op, startTick: offset + windows[i].at * 12, endTick: offset + (windows[i].at + windows[i].steps) * 12 }));
    }
    const local = {};
    for (const track of b.tracks) {
      const lane = lanes[track.role];
      const energy = s.energy ?? 2;
      let notes = [];
      if (track.role === 'drums') {
        const set = b.drums?.[s.drums];
        const grid = set?.[track.drum], fill = set?.fills?.[track.drum];
        if (!grid && !fill) continue;
        if (grid === 'start') notes.push(note(offset, 69, Math.min(track.length ?? 384, s.bars * bar), vel(100, energy)));
        else for (let i = 0; i < s.bars; i++) {
          // A fill replaces the grid in the last bar; a part with only a fill plays just that bar.
          const cells = (i === s.bars - 1 && (s.bars > 1 || !grid) && fill) || grid;
          if (!cells) continue;
          const step = bar / cells.length;
          [...cells].forEach((c, j) => { if (c in gridVelocity) notes.push(note(offset + i * bar + j * step, 69, Math.min(track.length ?? 48, (s.bars - i) * bar - j * step), vel(gridVelocity[c], energy))); });
        }
      } else if (track.role === 'bass' && s.bass) {
        const figure = bassFigures[s.bass];
        notes = spans.flatMap(sp => figure(shiftSpan(sp), lowestIn(sp.root, lane[0]), lane, key)).map(n => ({ ...n, velocity: vel(n.velocity, energy) }));
      } else if ((track.role === 'harmony' && s.harmony) || (track.role === 'texture' && s.texture)) {
        const styles = track.role === 'harmony' ? harmonyStyles : textureStyles;
        const style = styles[track.role === 'harmony' ? s.harmony : s.texture];
        let previous = (lane[0] + lane[1]) / 2;
        notes = spans.flatMap(sp => {
          const chord = voiceInLane(sp.tones, lane, previous);
          previous = chord.reduce((a, m) => a + m, 0) / chord.length;
          return style(shiftSpan(sp), chord, lane, key);
        }).map(n => ({ ...n, velocity: vel(n.velocity, energy) }));
      } else if (track.role === 'lead' && plans.lead) {
        plans.lead.forEach((op, i) => {
          const { at, steps } = windows[i];
          const chordsIn = () => spans.filter(sp => sp.tick + sp.ticks > at * 12 && sp.tick < (at + steps) * 12)
            .map(sp => ({ symbol: sp.symbol, steps: (Math.min(sp.tick + sp.ticks, (at + steps) * 12) - Math.max(sp.tick, at * 12)) / 12 }));
          const context = { chord: chordAt(at), chordAt: step => chordAt(at + step), chordsIn, steps, tonicNear };
          let events = op === 'rest' ? [] : keepInLane(fitLength(leadOps[op](motif, key, context), steps), lanes.lead, lastLead);
          events = nearPrevious(events, lastLead, lanes.lead);
          if (pitches(events).length) lastLead = pitches(events).at(-1);
          leadPlan.push({ section: s.name, bar: start + at / 16, op, ...(pitches(events).length ? { line: formatLine(events, key) } : {}) });
          if (pitches(events).length) notes.push(...toNotes(events, { offset: offset + at * 12, velocity: vel(92, energy) }));
        });
      } else if (track.role === 'counter' && plans.counter) {
        plans.counter.forEach((op, i) => {
          const { at, steps } = windows[i];
          if (op === 'rest') return;
          let events;
          if (op === 'guide') {
            let previous = (lane[0] + lane[1]) / 2;
            events = spans.filter(sp => sp.tick + sp.ticks > at * 12 && sp.tick < (at + steps) * 12).map(sp => {
              const third = [sp.tones[1], sp.tones[0], ...sp.tones].find(pc => pc !== undefined && key.scale.includes(mod(pc - key.tonic, 12))) ?? sp.tones[0];
              const midi = placeNear(third, lane[0], lane[1], previous);
              previous = midi;
              const from = Math.max(sp.tick, at * 12);
              return { midi, steps: (Math.min(sp.tick + sp.ticks, (at + steps) * 12) - from) / 12 };
            });
          } else if (op === 'fragment') events = augment(fragment(motif, 'last'));
          else events = callAndResponse(motif, key).answer;
          events = foldIntoLane(fitLength(events, steps), lane);
          notes.push(...toNotes(events, { offset: offset + at * 12, velocity: vel(op === 'guide' ? 70 : 80, energy), gate: op === 'guide' ? 0.97 : 0.9 }));
        });
      }
      if (notes.length) local[track.name] = notes;
    }
    resolveClashes(local, b.tracks, lanes, spans, offset);
    const plays = new Set();
    for (const track of b.tracks) {
      const notes = local[track.name];
      if (!notes?.length) continue;
      parts[track.name].push({ section: s.name, bar: start, bars: s.bars, notes: notes.map(n => ({ ...n, tick: n.tick - offset })) });
      plays.add(track.role);
    }
    map.push({ name: s.name, startBar: start, bars: s.bars, startSeconds: Number((start * secondsPerBar).toFixed(4)), endSeconds: Number(((start + s.bars) * secondsPerBar).toFixed(4)),
      energy: s.energy ?? 2, roles: ['drums', 'bass', 'harmony', 'lead', 'counter', 'texture'].filter(r => plays.has(r)), chords: spans.map(sp => sp.symbol) });
    start += s.bars;
  }

  const used = [];
  const tracks = [];
  const suggestions = {};
  for (const t of b.tracks) {
    if (!parts[t.name].length) continue;
    const prefer = [...(t.prefer ?? []), ...(holdsNotes(b, t) ? ['sustained'] : [])];
    const pick = catalogue && t.role !== 'drums' ? suggestPresets(catalogue, t.role, { prefer, exclude: used, rhythmic: playsRhythmic(b, t), single: singleNotes(b, t) }) : [];
    if (pick.length) suggestions[t.name] = pick;
    let voice = { voice: t.voice, ...(t.preset ? { preset: t.preset } : {}), ...(t.factorySample ? { factorySample: t.factorySample } : {}) };
    let volume = t.volume;
    if (t.voice === 'preset') volume = catalogue?.[t.preset] ? volumeFor(catalogue[t.preset].peakDbfs, t.level ?? peakTarget[t.role]) : (t.volume ?? 40);
    if (sounds === 'suggested' && pick.length) { voice = { voice: 'preset', preset: pick[0].preset }; volume = pick[0].volume; used.push(pick[0].preset); }
    else if (t.preset) used.push(t.preset);
    tracks.push({ name: t.name, role: t.role, ...voice, volume, pan: t.pan ?? 0,
      patterns: parts[t.name].map(p => ({ name: p.section, bar: p.bar, bars: p.bars, notes: p.notes })) });
  }
  return {
    blueprint: { id: b.id, name: b.name, kind: b.kind }, key: key.name, bpm: tempo, masterVolume: b.masterVolume,
    lengthBars: start, lengthSeconds: Number((start * secondsPerBar).toFixed(4)),
    ...(target !== undefined ? { requested: { bars: Number(target.toFixed(3)), ...(lengthSeconds !== undefined ? { seconds: lengthSeconds } : {}) } } : {}),
    form: { sectionScale: choice.factor, passes: choice.passes, bodySections: b.body.slice(0, choice.bodyCount).map(s => s.name) },
    motif: { source: motifInput ? 'yours' : 'blueprint', line: formatLine(motif, key), steps: totalSteps(motif), ...(read.snapped ? { snappedToKey: read.snapped } : {}) },
    progressions: Object.fromEntries(Object.entries(parsed).map(([name, list]) => [name, list.map(c => c.symbol + (c.bars ? ':' + c.bars : '')).join(' ')])),
    lanes: Object.fromEntries(Object.entries(lanes).filter(([role]) => b.tracks.some(t => t.role === role))),
    sections: map, leadPlan, phrases, tracks, suggestions,
    ...(adjustments.length ? { planAdjustments: adjustments } : {}),
    ...(target !== undefined && Math.abs(start - target) > Math.max(2, target * 0.25)
      ? { lengthWarning: `No form of this blueprint is near ${Number(target.toFixed(2))} bars; the nearest is ${start} bars (${Number((start * secondsPerBar).toFixed(2))} s). Lengths available at this tempo: ${[...new Set(lengthCandidates(b).map(c => c.bars))].sort((x, y) => x - y).slice(0, 8).join(', ')} bars.` }
      : {}),
  };
}

// ---------- checks used by the unit tests and by create_from_blueprint ----------
// Per bar: how many lead and counter tracks sound, and the pitch ranges of the lead and the support parts.
export function registerReport(tracks, lengthBars) {
  const bars = Array.from({ length: lengthBars }, () => ({ lead: new Set(), counter: new Set(), leadLow: Infinity, supportHigh: -Infinity }));
  for (const t of tracks) {
    for (const p of t.patterns) {
      for (const n of p.notes) {
        const from = Math.floor((p.bar * bar + n.tick) / bar), to = Math.floor((p.bar * bar + n.tick + n.length - 1) / bar);
        for (let i = from; i <= to && i < lengthBars; i++) {
          const slot = bars[i];
          if (t.role === 'lead') { slot.lead.add(t.name); slot.leadLow = Math.min(slot.leadLow, n.midi); }
          if (t.role === 'counter') slot.counter.add(t.name);
          if (supportRoles.includes(t.role)) slot.supportHigh = Math.max(slot.supportHigh, n.midi);
        }
      }
    }
  }
  return bars.map((s, i) => ({ bar: i, leads: s.lead.size, counters: s.counter.size, leadLow: s.leadLow === Infinity ? null : s.leadLow, supportHigh: s.supportHigh === -Infinity ? null : s.supportHigh }));
}
// Notes of different pitched tracks that sound together a minor second or minor ninth apart.
export function semitoneClashes(tracks) {
  const notes = tracks.filter(t => t.role !== 'drums' && t.role !== 'fx')
    .flatMap(t => t.patterns.flatMap(p => p.notes.map(n => ({ track: t.name, midi: n.midi, start: p.bar * bar + n.tick, end: p.bar * bar + n.tick + n.length }))))
    .sort((a, b) => a.start - b.start);
  const clashes = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length && notes[j].start < notes[i].end; j++) {
      const a = notes[i], b = notes[j];
      if (a.track !== b.track && harsh(a.midi, b.midi)) clashes.push({ bar: Math.floor(b.start / bar), tracks: [a.track, b.track], midi: [a.midi, b.midi] });
    }
  }
  return clashes;
}
// Lead and counter notes only sound inside phrases whose plan op is not a rest, and the counter's own lines
// (answer, fragment) only sound where the lead rests.
export function phraseProblems(arrangement) {
  const problems = [];
  const windows = arrangement.phrases ?? [];
  for (const t of arrangement.tracks.filter(t => t.role === 'lead' || t.role === 'counter')) {
    for (const p of t.patterns) {
      for (const n of p.notes) {
        const at = p.bar * bar + n.tick;
        const owner = windows.find(w => w.part === t.role && w.startTick <= at && at < w.endTick);
        if (!owner || owner.op === 'rest') problems.push(`${t.name} sounds at bar ${Math.floor(at / bar)} where its plan says rest`);
        if (t.role === 'counter' && owner && owner.op !== 'guide') {
          const lead = windows.find(w => w.part === 'lead' && w.startTick <= at && at < w.endTick);
          if (lead && lead.op !== 'rest') problems.push(`${t.name} plays its ${owner.op} at bar ${Math.floor(at / bar)} while the lead plays ${lead.op}`);
        }
      }
    }
  }
  return [...new Set(problems)];
}
export function checkArrangement(arrangement) {
  const problems = [];
  const leadTracks = arrangement.tracks.filter(t => t.role === 'lead').length, counterTracks = arrangement.tracks.filter(t => t.role === 'counter').length;
  if (leadTracks > 1) problems.push(`${leadTracks} lead tracks`);
  if (counterTracks > 1) problems.push(`${counterTracks} counter tracks`);
  for (const slot of registerReport(arrangement.tracks, arrangement.lengthBars)) {
    if (slot.leads > 1) problems.push(`bar ${slot.bar}: ${slot.leads} leads`);
    if (slot.counters > 1) problems.push(`bar ${slot.bar}: ${slot.counters} counter-melodies`);
    if (slot.leadLow !== null && slot.supportHigh !== null && slot.supportHigh >= slot.leadLow) problems.push(`bar ${slot.bar}: a support part reaches the lead register`);
  }
  for (const c of semitoneClashes(arrangement.tracks).slice(0, 5)) problems.push(`bar ${c.bar}: ${c.tracks.join(' and ')} sound a semitone apart (MIDI ${c.midi.join(' and ')})`);
  problems.push(...phraseProblems(arrangement));
  return problems;
}

function summary(b, sounds) {
  const base = chooseLength(b);
  return {
    id: b.id, name: b.name, kind: b.kind, use: b.use, key: b.key, bpm: b.bpm,
    bars: base.bars, seconds: Number((base.bars * 240 / b.bpm).toFixed(2)),
    otherLengthsInBars: [...new Set(lengthCandidates(b).map(c => c.bars))].sort((x, y) => x - y).slice(0, 12),
    motif: b.motif, progressions: b.progressions, phraseBars: b.phraseBars, harmonicRhythm: b.harmonicRhythm,
    sections: sectionList(b, 1, 1).map(s => ({ name: s.name, bars: s.bars, energy: s.energy ?? 2, drums: s.drums ?? null, bass: s.bass ?? null, harmony: s.harmony ?? null,
      texture: s.texture ?? null, lead: s.lead, ...(s.counter ? { counter: s.counter } : {}), chords: s.chords ?? 'main' })),
    repeatsWhenLonger: b.kind === 'stinger' ? [] : b.body.map(s => s.name),
    tracks: b.tracks.map(t => ({ name: t.name, role: t.role, voice: t.voice, ...(t.preset ? { preset: t.preset } : {}), ...(t.factorySample ? { factorySample: t.factorySample } : {}),
      ...(t.role !== 'drums' ? { lane: b.lanes[t.role], alternatives: suggestPresets(sounds, t.role, { prefer: [...(t.prefer ?? []), ...(holdsNotes(b, t) ? ['sustained'] : [])], rhythmic: playsRhythmic(b, t) }).map(s => s.preset) } : { drum: t.drum }) })),
  };
}

export function register({ tool, z, schemas, project, sounds, moduleGuidance, env = process.env }) {
  moduleGuidance.push('For a standard brief (overworld, battle, boss, town, dungeon, title, puzzle, chiptune or a victory stinger), start with list_blueprints and create_from_blueprint rather than a blank create_project, then edit the returned sections with replace_pattern and apply_edits.');
  moduleGuidance.push('Develop one motif rather than writing a new tune for each section: pass your own motif and progression to create_from_blueprint (required in strict copyright mode), and use develop_motif for sequences, inversions, fragments and cadences of it.');
  const soundsOrNothing = async () => { try { return await sounds.soundFacts(); } catch { return null; } };
  tool('list_blueprints', 'List tested plans for kinds of game music: overworld, battle, boss, calm town, dungeon tension, title or menu, puzzle or chill, chiptune, and a victory fanfare stinger. Each gives sections with bar counts and energy, which roles play where, register lanes, drum grids, bass figure, harmony style, where the lead states, varies and rests, starting sounds and catalogue alternatives.', {
    id: z.enum(blueprintIds).optional().describe('Return only this blueprint.'),
  }, async ({ id }) => {
    const facts = await soundsOrNothing();
    const list = (id ? [getBlueprint(id)] : blueprints).map(b => summary(b, facts));
    return { blueprints: list, leadOps: leadOpNames, counterOps, next: 'create_from_blueprint with your own key, bpm, length, motif and progression.' };
  });
  tool('create_from_blueprint', 'Write a full editable project from a blueprint. Give a key, bpm and a target length in seconds or bars (the nearest whole form is used and the exact duration reported), and supply your own motif and chord progression (required in strict copyright mode) so the music is original. The lead is built from the motif: stated, repeated, varied and rested. Every track gets a role, one lead and at most one counter sound at a time, support parts stay under the lead, and the song length is pinned. Returns the section map (name, start bar, bars) for replace_pattern, apply_edits and analyze_audio.', {
    blueprint: z.enum(blueprintIds), output: schemas.projectName,
    key: z.string().min(1).max(30).optional().describe('Such as "E minor", "F# dorian" or just "G" (keeps the blueprint mode). Default: the blueprint key.'),
    bpm: z.number().min(45).max(240).optional(),
    lengthSeconds: z.number().min(2).max(1200).optional(), lengthBars: z.number().int().min(1).max(512).optional(),
    motif: z.string().min(1).max(2000).optional().describe('Your motif as a melody line, "D5:2 F5:2 A5:4 r:4", or scale degrees, "1:2 3:2 5:4 r:4". Any octave: it is moved into the lead lane. Keep it to one or two bars. Required in strict copyright mode.'),
    progression: z.string().min(1).max(400).optional().describe('Main progression as chord symbols ("Em C G D") or Roman numerals ("i VI III VII"). ":2" holds a chord two bars. Required in strict copyright mode.'),
    contrastProgression: z.string().min(1).max(400).optional().describe('Progression for the contrasting sections. Default: the blueprint one in your key.'),
    sounds: z.enum(['default', 'suggested']).default('default').describe('default uses the blueprint voices; suggested swaps pitched tracks for the best measured factory preset for each role.'),
  }, async ({ blueprint, output, lengthSeconds, lengthBars, ...options }) => {
    if (lengthSeconds !== undefined && lengthBars !== undefined) throw new Error('Give lengthSeconds or lengthBars, not both');
    if (isStrictCopyright(env)) {
      if (!options.motif || !options.motif.trim()) {
        throw new Error('Strict copyright mode requires caller-supplied motif in create_from_blueprint rather than falling back to hardcoded blueprint melodies.');
      }
      if (!options.progression || !options.progression.trim()) {
        throw new Error('Strict copyright mode requires caller-supplied progression in create_from_blueprint.');
      }
    }
    const catalogue = await soundsOrNothing();
    const plan = buildArrangement(blueprint, { ...options, lengthSeconds, lengthBars, catalogue });
    const problems = checkArrangement(plan);
    if (problems.length) throw new Error(`The arrangement broke its own rules: ${problems.slice(0, 5).join('; ')}`);
    const items = plan.tracks.map(t => schemas.track.parse(t));
    for (const item of items) await project.checkTrack(item);
    const doc = project.createSong(plan.bpm, items, plan.masterVolume);
    const presets = {};
    for (const item of items.filter(i => i.preset)) presets[item.name] = await project.loadPreset(doc, project.instrumentOf(doc, item.name), item.preset, { tuning: 'concert' });
    project.setAnchor(doc, plan.lengthBars);
    const info = project.songInfo(doc);
    if (info.lengthBars !== plan.lengthBars) throw new Error(`Song reads as ${info.lengthBars} bars, expected ${plan.lengthBars}`);
    const saved = await project.save(doc, output);
    return {
      ...saved, ...plan, lengthSeconds: Number(info.lengthSeconds.toFixed(4)),
      tracks: plan.tracks.map(t => ({ name: t.name, role: t.role, voice: t.voice, ...(t.preset ? { preset: t.preset } : {}), ...(t.factorySample ? { factorySample: t.factorySample } : {}),
        volume: t.volume, pan: t.pan, lane: plan.lanes[t.role] ?? null, patterns: t.patterns.map(p => ({ name: p.name, bar: p.bar, bars: p.bars, notes: p.notes.length })) })),
      ...(Object.keys(presets).length ? { presets } : {}),
      next: [
        `render_mix the project, then analyze_audio with bpm ${plan.bpm} and sections set to the section map (startBar and bars) to check every section is audible and balanced.`,
        'Edit one section on one track with replace_pattern (bar = the section startBar). Use develop_motif to write new lead phrases from the motif.',
      ],
    };
  });
}
