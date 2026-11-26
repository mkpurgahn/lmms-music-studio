const envelope = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const oscillator = (wave, range, level, detune = 0) => ({
  wave, range, level, detune, fine: 0, pulseWidth: .4, kbTrack: true,
});
const base = {
  model: 'fathom',
  mode: 'poly',
  osc: [oscillator('saw', '8', .7), oscillator('pulse', '8', .3, .06), oscillator('sine', '16', .15)],
  osc2Sync: false, noise: 0, noiseColor: 'white', drive: 1.15, drift: 0, tune: 0, volume: .7,
  glide: 0, unisonVoices: 2, unisonSpread: .18, bendRange: 2,
  filter: { mode: 'lp', cutoff: 640, resonance: .28, contour: .32, tracking: .2, env: envelope(.002, .2, .18, .12) },
  loudness: envelope(.004, .24, .32, .12),
  lfo1: { wave: 'sine', rate: .3, depth: 0, dest: 'filter' },
  lfo2: { wave: 'triangle', rate: .4, depth: 0, dest: 'pwm' },
  fm: { algo: 0, feedback: 0, ops: [{ ratio: 1, level: .8 }, { ratio: 2, level: .34 },
    { ratio: 3, level: .22 }, { ratio: 1.5, level: .1 }] },
  halo: { partials: [1, .44, .26, .12, .18, .08, .03, .02], brightness: .65 },
  arp: { on: false, division: '16', octaves: 1, mode: 'up', gate: .5 },
  seq: { on: false, root: 48, velocity: .8, steps: Array.from({ length: 16 }, () => ({ on: false, semi: 0 })) },
  tempo: 120, swing: 0, delay: { time: .25, feedback: 0, mix: 0 },
  chorus: { rate: .4, depth: 0, mix: 0 }, reverb: { size: .5, mix: 0 },
};
const arp = [[0, 0, 15, .91], [35, 7, 9, .68], [71, 3, 13, .83], [95, 12, 8, .62], [131, 7, 15, .88], [166, 1, 8, .68]];
const entries = [
  ['fuse-pluck', 'Fuse Pluck', ['dark', 'syncopated', 'arp', 'pluck', 'game'], 50, arp,
    { filter: { cutoff: 340, resonance: .47, contour: .5 }, loudness: envelope(.003, .18, .26, .085) }],
  ['sub-pressure', 'Sub Pressure', ['sub', 'bass', 'mono', 'edm'], 38,
    [[0, 0, 39, .92], [49, 0, 23, .8], [84, 7, 24, .84], [122, 0, 35, .92]],
    { mode: 'mono', drive: 1.45, glide: .025, filter: { cutoff: 520 }, osc: [
      oscillator('triangle', '8', .84), oscillator('saw', '8', .27), oscillator('sine', '16', .12),
    ] }],
  ['relay-bell', 'Relay Bell', ['bright', 'metallic', 'fm', 'bell', 'lead'], 60, arp,
    { model: 'vesper', filter: { cutoff: 6700, resonance: .16 }, loudness: envelope(.003, .28, .18, .16) }],
  ['ember-organ', 'Ember Organ', ['warm', 'additive', 'organ', 'pad', 'chord'], 53,
    [[0, 0, 129, .82], [12, 3, 117, .72], [24, 7, 105, .72], [43, 14, 86, .63]],
    { model: 'halo', filter: { cutoff: 3100, resonance: .12 }, loudness: envelope(.07, .3, .76, .18) }],
];
export const fathomPatches = Object.fromEntries(entries.map(([id, name, tags, root, phrase, overrides]) => [
  id, { name, tags, root, phrase, patch: { ...base, ...overrides, filter: { ...base.filter, ...overrides.filter } } },
]));

const roleWords = [
  ['drum', /kick|snare|hihat|hat|clap|drum|shaker|rim|tom|cymbal|perc/], ['bass', /bass|sub|reese|303|acid/],
  ['bell', /bell|xylo|vibra|glock|chime|marimba|mallet|ping|kalimba/], ['organ', /organ|harmonium|accord/],
  ['keys', /piano|rhodes|epiano|e-piano|keys|harpsi|clav|wurli/], ['brass', /brass|trumpet|horn|sax|trombone|tuba/],
  ['strings', /string|violin|cello|viola|orchestra/], ['pad', /pad|choir|voice|atmo|ambient|dream|drone|sweep|halo/],
  ['pluck', /pluck|arp|harp|guitar|koto|banjo|sitar|pizz/], ['lead', /lead|saw|square|sync|whistle|oboe|flute|clarinet|reed|wind|synth/],
  ['fx', /fx|noise|effect|bubble|laser|zap|alien|space|weapon|engine/],
];
// Role and search words taken from a preset's folder and file name.
export function nameTags(group, file) {
  const name = file.replace(/\.(xpf|xiz)$/i, '').replace(/^\d+-/, '');
  const text = (group + ' ' + file).toLowerCase();
  const nameRole = roleWords.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  return { name, group, nameRole };
}
// Describe a rendered test note: one written note held for holdSeconds from time zero.
export function measureInstrument(audio, { writtenMidi, holdSeconds }, dsp) {
  const { sampleRate, frames } = audio;
  const left = audio.channels[0], right = audio.channels[1] ?? left;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (left[i] + right[i]) / 2;
  const window = Math.round(sampleRate * 0.01);
  const envelope = [];
  for (let start = 0; start + window <= frames; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i++) sum += mono[i] * mono[i];
    envelope.push(Math.sqrt(sum / window));
  }
  const top = Math.max(...envelope);
  const peakDbfs = dsp.db(dsp.samplePeak(audio));
  if (!(top > 1e-5)) return { silent: true, pitched: false, pitchOffset: 0, peakDbfs: null, role: 'fx', tags: ['silent'] };
  const hold = Math.round(holdSeconds * 100);
  const attackMs = envelope.findIndex(v => v >= top * 0.7) * 10;
  const lateLevel = Math.max(...envelope.slice(Math.max(0, hold - 15), hold - 3));
  const sustainDb = Number((20 * Math.log10(Math.max(lateLevel, 1e-6) / top)).toFixed(1));
  let releaseMs = 0;
  for (let i = hold; i < envelope.length && envelope[i] > top * 0.01; i++) releaseMs += 10;
  const first = dsp.detectPitch(mono, sampleRate, Math.round(sampleRate * 0.12), Math.round(sampleRate * 0.25));
  const second = dsp.detectPitch(mono, sampleRate, Math.round(sampleRate * 0.5), Math.round(sampleRate * 0.25));
  const steady = first && (second ? Math.abs(first.midi - second.midi) < 0.6 : first.confidence > 0.85);
  const offset = steady ? first.midi - writtenMidi : 0;
  const pitched = Boolean(steady) && Math.abs(offset - Math.round(offset)) < 0.35;
  const { centroidHz } = dsp.spectrum(audio, 0, Math.min(frames, Math.round(holdSeconds * sampleRate)));
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < frames; i++) { lr += left[i] * right[i]; ll += left[i] * left[i]; rr += right[i] * right[i]; }
  const correlation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  const pitchOffset = pitched ? Math.round(offset) : 0;
  return describeSound({ pitched, pitchOffset, peakDbfs, attackMs, sustainDb, releaseMs, centroidHz, stereoCorrelation: Number(correlation.toFixed(2)) });
}
// Tags and a likely role from the measured numbers alone.
export function describeSound(facts) {
  const { pitched, pitchOffset, peakDbfs, attackMs, sustainDb, releaseMs, centroidHz, stereoCorrelation } = facts;
  const tags = [sustainDb > -6 ? 'sustained' : sustainDb < -20 ? 'percussive' : 'decaying',
    centroidHz > 1800 ? 'bright' : centroidHz < 600 ? 'dark' : 'warm'];
  if (attackMs > 60) tags.push('slow-attack');
  if (releaseMs > 400) tags.push('long-release');
  if (stereoCorrelation < 0.6) tags.push('wide');
  if (peakDbfs < -30) tags.push('quiet');
  if (peakDbfs > -6) tags.push('loud');
  const role = !pitched ? (tags.includes('percussive') ? 'drum' : 'fx') : pitchOffset <= -24 ? 'bass' :
    attackMs > 60 && sustainDb > -12 ? 'pad' : tags.includes('percussive') ? (centroidHz > 1800 ? 'bell' : 'pluck') : 'lead';
  return { pitched, pitchOffset, peakDbfs, attackMs, sustainDb, releaseMs, centroidHz, stereoCorrelation, role, tags };
}

export function searchSounds({ query, engine, role, limit, fathomAvailable }, native, zyn = [], facts = {}) {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const sounds = [];
  // Fathom patches are listed only when the bridge can render them, or when asked for by engine.
  if (engine === 'fathom' || (!engine && fathomAvailable)) {
    for (const [patchId, { name, tags, patch }] of Object.entries(fathomPatches)) {
      const guess = roleWords.find(([, pattern]) => tags.some(tag => pattern.test(tag)))?.[0] ?? 'lead';
      sounds.push({ name, tags, role: guess, engine: 'fathom', model: patch.model, patchId, preview: 'preview_sound' });
    }
  }
  for (const [list, label] of [[native, 'lmms'], [zyn, 'zyn']]) {
    if (engine && engine !== label) continue;
    for (const preset of list) {
      if (label === 'lmms' && /^audiofileprocessor\//i.test(preset) && !(process.env.LMMS_STRICT_COPYRIGHT === '0' || process.env.LMMS_STRICT_COPYRIGHT === 'false')) continue;
      const [group, ...rest] = preset.split('/');
      const fact = facts[preset];
      const named = nameTags(label === 'zyn' ? rest[0] : group, rest.at(-1));
      const sound = { name: named.name, tags: [label === 'zyn' ? rest[0] : group, ...(fact?.tags ?? [])],
        role: named.nameRole ?? fact?.role ?? null, engine: label, preset, preview: 'preview_sound' };
      if (fact && !fact.silent) {
        sound.measured = { peakDbfsAtVolume60: fact.peakDbfs, presetPitchOffsetSemitones: fact.pitchOffset,
          pitched: fact.pitched, attackMs: fact.attackMs, sustainDb: fact.sustainDb, centroidHz: fact.centroidHz };
      }
      sounds.push(sound);
    }
  }
  const ranked = sounds.filter(sound => !role || sound.role === role).map(sound => {
    const name = sound.name.toLowerCase();
    const searchable = [name, sound.engine, sound.model, sound.role, ...sound.tags].join(' ').toLowerCase();
    const score = tokens.every(token => searchable.includes(token))
      ? tokens.reduce((sum, token) => sum + (name.includes(token) ? 2 : 1), 0) + (sound.measured ? 0.5 : 0) : -1;
    return { sound, score };
  }).filter(({ score }) => score >= 0).sort((a, b) => b.score - a.score);
  return { total: ranked.length, sounds: ranked.slice(0, limit).map(({ sound }) => sound) };
}
