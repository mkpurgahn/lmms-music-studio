// Unit tests for blueprints. Run: npm test (no LMMS needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  blueprints, blueprintIds, getBlueprint, buildArrangement, checkArrangement, registerReport, parseProgression, romanToChord, chordSpans,
  voiceInLane, lengthCandidates, chooseLength, suggestPresets, volumeFor, leadOpNames, counterOps, bassFigures, harmonyStyles, textureStyles, scalePlan,
  semitoneClashes, phraseProblems, fitPlan, resolveClashes,
} from './blueprints.mjs';
import { parseKey, readMotif, totalSteps, inKey, chordTones } from './motif.mjs';
import { expandPattern, parseChord } from '../music.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../sound-catalogue.json', import.meta.url), 'utf8')).sounds;
const pitchedRoles = ['bass', 'harmony', 'counter', 'texture', 'lead'];

test('nine blueprints ship, including a victory stinger', () => {
  assert.deepEqual(blueprintIds, ['overworld', 'battle', 'boss', 'town', 'dungeon', 'title', 'puzzle', 'chiptune', 'victory']);
  assert.equal(getBlueprint('victory').kind, 'stinger');
  assert.throws(() => getBlueprint('jazz'), /Unknown blueprint/);
});

test('every blueprint is well formed', () => {
  for (const b of blueprints) {
    const key = parseKey(b.key);
    const names = b.tracks.map(t => t.name);
    assert.equal(new Set(names).size, names.length, `${b.id}: unique track names`);
    assert.ok(b.tracks.filter(t => t.role === 'lead').length === 1, `${b.id}: exactly one lead track`);
    assert.ok(b.tracks.filter(t => t.role === 'counter').length <= 1, `${b.id}: at most one counter track`);
    for (const role of ['harmony', 'counter', 'texture', 'bass']) {
      const [low, high] = b.lanes[role];
      assert.ok(high - low >= 12, `${b.id}: ${role} lane spans an octave`);
      if (role !== 'bass' || true) assert.ok(high < b.lanes.lead[0], `${b.id}: ${role} lane is under the lead lane`);
    }
    assert.ok(totalSteps(readMotif(b.motif, key)) <= b.phraseBars * 16, `${b.id}: motif fits a phrase`);
    for (const [name, text] of Object.entries(b.progressions)) {
      for (const { symbol } of parseProgression(text, key)) {
        const chord = parseChord(symbol);
        for (const i of chord.intervals) assert.ok(key.scale.includes((chord.root + i - key.tonic + 120) % 12), `${b.id} ${name}: ${symbol} is diatonic to ${b.key}`);
      }
    }
    for (const s of [...b.intro, ...b.body]) {
      assert.equal(s.bars % b.phraseBars, 0, `${b.id} ${s.name}: whole phrases`);
      for (const part of ['lead', 'counter']) {
        if (!Array.isArray(s[part])) continue;
        assert.equal(s[part].length, s.bars / b.phraseBars, `${b.id} ${s.name}: one ${part} op per phrase`);
        for (const op of s[part]) assert.ok((part === 'lead' ? leadOpNames : counterOps).includes(op), `${b.id} ${s.name}: ${op}`);
      }
      if (s.lead !== undefined && !Array.isArray(s.lead)) assert.equal(s.lead, 'rest');
      if (s.drums) assert.ok(b.drums[s.drums], `${b.id} ${s.name}: drum set ${s.drums}`);
      if (s.bass) assert.ok(bassFigures[s.bass], s.bass);
      if (s.harmony) assert.ok(harmonyStyles[s.harmony], s.harmony);
      if (s.texture) assert.ok(textureStyles[s.texture], s.texture);
      if (s.chords) assert.ok(b.progressions[s.chords], `${b.id} ${s.name}: progression ${s.chords}`);
    }
    for (const t of b.tracks.filter(t => t.role === 'drums')) assert.ok(Object.values(b.drums).some(set => set[t.drum]), `${b.id}: ${t.name} plays somewhere`);
  }
});

test('Roman numerals and chord symbols resolve in the key', () => {
  const eMinor = parseKey('E minor');
  assert.deepEqual(parseProgression('i VI III VII', eMinor).map(c => c.symbol), ['Em', 'C', 'G', 'D']);
  assert.deepEqual(parseProgression('Imaj7 vi7 ii7 V7', parseKey('C major')).map(c => c.symbol), ['Cmaj7', 'Am7', 'Dm7', 'G7']);
  assert.equal(romanToChord('vo', parseKey('C phrygian')), 'Gdim');
  assert.equal(romanToChord('II', parseKey('A phrygian')), 'Bb');
  assert.equal(romanToChord('bVII', parseKey('D major')), 'C');
  assert.equal(romanToChord('iv', parseKey('F# dorian'), { diatonic: true }), 'B', 'iv written for minor becomes IV in dorian');
  assert.equal(romanToChord('V7', parseKey('A minor'), { diatonic: true }), 'Em7');
  assert.equal(romanToChord('vii', parseKey('C major'), { diatonic: true }), 'Bdim');
  assert.deepEqual(parseProgression('Em:2 C D', eMinor), [{ symbol: 'Em', bars: 2 }, { symbol: 'C', bars: null }, { symbol: 'D', bars: null }]);
  assert.throws(() => parseProgression('i Q', eMinor), /Cannot read chord "Q"/);
  const spans = chordSpans(parseProgression('Em:2 C', eMinor), 5, 1);
  assert.deepEqual(spans.map(s => [s.symbol, s.tick, s.ticks]), [['Em', 0, 384], ['C', 384, 192], ['Em', 576, 384]]);
});

test('chords are voiced inside their lane with smooth movement', () => {
  const voiced = voiceInLane([7, 11, 2], [48, 64], 56);
  assert.ok(voiced.every(m => m >= 48 && m <= 64));
  assert.deepEqual(voiced.map(m => m % 12).sort(), [11, 2, 7].sort());
});

test('length: the nearest whole form is chosen and stingers do not repeat', () => {
  const overworld = getBlueprint('overworld');
  assert.equal(chooseLength(overworld).bars, 28);
  assert.equal(chooseLength(overworld, 52).bars, 52, 'intro plus two passes of the body');
  assert.equal(chooseLength(overworld, 14).bars, 14, 'sections halved');
  assert.deepEqual([chooseLength(getBlueprint('dungeon'), 14).bars, chooseLength(getBlueprint('dungeon'), 14).bodyCount], [12, 1], 'intro and the first body section');
  const victory = getBlueprint('victory');
  assert.ok(lengthCandidates(victory).every(c => c.passes === 1));
  assert.equal(chooseLength(victory, 100).bars, 8);
  assert.deepEqual(scalePlan(['state', 'repeat', 'sequence_up', 'cadence'], 0.5), ['state', 'cadence']);
  assert.deepEqual(scalePlan(['state', 'repeat'], 1, 1), ['state', 'rhythm']);
});

const motifs = [undefined, 'E5:2 G5:1 F#5:1 E5:2 B4:2 C5:4 r:4', '1:3 5:1 4:2 3:2 2:4 r:4', 'C#4:2 F4:2 G#4:4'];
const keys = [undefined, 'G', 'F# dorian', 'Bb major'];
const lengths = [{}, { lengthSeconds: 30 }, { lengthSeconds: 150 }, { lengthBars: 16 }];

test('every blueprint keeps one lead, at most one counter and support parts under the lead, in every bar', () => {
  let built = 0;
  for (const id of blueprintIds) {
    for (const [i, motif] of motifs.entries()) {
      for (const [j, key] of keys.entries()) {
        const length = lengths[(i + j) % lengths.length];
        const a = buildArrangement(id, { motif, key, bpm: [undefined, 90, 150, 200][j], ...length, catalogue, sounds: i % 2 ? 'suggested' : 'default' });
        const label = `${id} motif ${i} key ${key} ${JSON.stringify(length)}`;
        assert.deepEqual(checkArrangement(a), [], label);
        const report = registerReport(a.tracks, a.lengthBars);
        assert.ok(report.every(s => s.leads <= 1 && s.counters <= 1), label);
        assert.ok(report.every(s => s.leadLow === null || s.supportHigh === null || s.supportHigh < s.leadLow), label);
        const leadLow = a.lanes.lead[0];
        for (const t of a.tracks) {
          assert.ok(t.role, `${label}: ${t.name} has a role`);
          for (const p of t.patterns) {
            const notes = expandPattern(p);
            assert.equal(notes.length, p.notes.length, `${label}: ${t.name} ${p.name}`);
            if (supportRole(t.role)) assert.ok(notes.every(n => n.midi < leadLow), `${label}: ${t.name} stays under the lead lane`);
            if (t.role === 'lead') assert.ok(notes.every(n => n.midi >= leadLow), `${label}: lead stays in its lane`);
            if (t.role === 'lead' || t.role === 'counter') assert.ok(notes.every(n => inKey(n.midi, parseKey(a.key))), `${label}: ${t.name} stays in the key`);
          }
        }
        built++;
      }
    }
  }
  assert.equal(built, blueprintIds.length * motifs.length * keys.length);
});
const supportRole = role => ['bass', 'harmony', 'counter', 'texture'].includes(role);

test('the section map is contiguous, the length is exact and every section is audible', () => {
  for (const id of blueprintIds) {
    for (const bpm of [80, 133]) {
      const a = buildArrangement(id, { bpm, lengthSeconds: 60 });
      let at = 0;
      for (const s of a.sections) {
        assert.equal(s.startBar, at, `${id} ${s.name}`);
        assert.ok(s.roles.length > 0, `${id} ${s.name} plays something`);
        at += s.bars;
      }
      assert.equal(at, a.lengthBars);
      assert.equal(a.lengthSeconds, Number((a.lengthBars * 240 / bpm).toFixed(4)));
      const lastNoteEnd = Math.max(...a.tracks.flatMap(t => t.patterns.flatMap(p => p.notes.map(n => p.bar * 192 + n.tick + n.length))));
      assert.ok(lastNoteEnd <= a.lengthBars * 192, `${id}: nothing runs past the pinned length`);
      assert.equal(new Set(a.sections.map(s => s.name)).size, a.sections.length, `${id}: section names are unique`);
    }
  }
});

test('the lead states the motif, repeats it, varies it and rests', () => {
  for (const id of blueprintIds) {
    const a = buildArrangement(id, {});
    const played = a.leadPlan.filter(p => p.line);
    assert.equal(played[0].op, 'state', id);
    assert.ok(played[0].line.startsWith(a.motif.line.replace(/ r:[\d.]+$/, '')), `${id}: the first phrase is the motif`);
    if (a.blueprint.kind === 'loop') assert.ok(a.leadPlan.filter(p => p.op === 'state' || p.op === 'repeat').length >= 2, `${id}: stated more than once`);
    assert.ok(played.some(p => !['state', 'repeat'].includes(p.op)), `${id}: varied`);
    const leadBars = new Set(registerReport(a.tracks, a.lengthBars).filter(s => s.leads).map(s => s.bar));
    if (a.blueprint.kind === 'loop') assert.ok(leadBars.size < a.lengthBars, `${id}: the lead rests somewhere`);
  }
  const mine = buildArrangement('battle', { motif: 'A4:2 C5:2 E5:4 D5:4 r:4', key: 'A minor', progression: 'Am F C G' });
  assert.equal(mine.motif.source, 'yours');
  assert.equal(mine.progressions.main, 'Am F C G');
  assert.equal(mine.sections.find(s => s.name === 'A').chords[0], 'Am');
  assert.equal(buildArrangement('battle', { key: 'G' }).key, 'G minor', 'a bare tonic keeps the blueprint mode');
  assert.equal(buildArrangement('overworld', { motif: 'C#5:2 D5:2' , key: 'D major' }).motif.snappedToKey, undefined);
  assert.equal(buildArrangement('overworld', { motif: 'C5:2 D5:2', key: 'D major' }).motif.snappedToKey, 1);
});

test('sound suggestions come from the measured catalogue by role and level', () => {
  for (const role of pitchedRoles) {
    const picks = suggestPresets(catalogue, role);
    assert.ok(picks.length > 0 && picks.length <= 3, role);
    for (const p of picks) {
      const facts = catalogue[p.preset];
      assert.ok(facts.pitched && facts.peakDbfs >= -24 && facts.peakDbfs <= -3, p.preset);
      assert.ok(p.volume >= 3 && p.volume <= 150);
    }
  }
  assert.equal(volumeFor(-10, -10), 60);
  assert.equal(volumeFor(-4, -10), 30);
  const lead = suggestPresets(catalogue, 'lead')[0].preset;
  assert.ok(!suggestPresets(catalogue, 'lead', { exclude: [lead] }).some(p => p.preset === lead));
  const a = buildArrangement('overworld', { catalogue, sounds: 'suggested' });
  const presets = a.tracks.filter(t => t.voice === 'preset').map(t => t.preset);
  assert.equal(new Set(presets).size, presets.length, 'each track gets a different preset');
  assert.ok(a.tracks.filter(t => t.role === 'drums').every(t => ['kick', 'snare', 'hat', 'clap'].includes(t.voice)));
  assert.ok(blueprints.every(b => b.tracks.every(t => !t.factorySample)), 'no blueprint references stock factorySample');
});

// ---------- regressions from the PR 15 review ----------
test('review 1: a chord shorter than one step is rejected and chord spans always move on', () => {
  const eMinor = parseKey('E minor');
  assert.throws(() => parseProgression('Em:0.001', eMinor), /whole number of sixteenth-note steps/);
  assert.throws(() => parseProgression('Em:0.1', eMinor), /whole number of sixteenth-note steps/);
  assert.equal(parseProgression('Em:0.0625', eMinor)[0].bars, 0.0625);
  const spans = chordSpans([{ symbol: 'Em', bars: 0.001 }], 1, 1);
  assert.equal(spans.length, 16, 'a tiny length is clamped to one step instead of looping forever');
  assert.throws(() => buildArrangement('battle', { progression: 'Em:0.001' }), /sixteenth-note steps/);
});

test('review 2: a motif longer than a phrase keeps the plan endings and reports what changed', () => {
  assert.deepEqual(fitPlan(['state', 'repeat', 'sequence_up', 'half_cadence'], 2), ['state', 'half_cadence']);
  assert.deepEqual(fitPlan(['half_cadence', 'hold'], 1), ['hold']);
  assert.deepEqual(fitPlan(['state', 'fit'], 1), ['state']);
  const long = buildArrangement('overworld', { motif: 'D5:4 F#5:4 A5:8 B5:4 A5:4 F#5:8 E5:4 F#5:4 D5:8' });
  const ops = long.leadPlan.map(p => p.op);
  assert.ok(ops.includes('half_cadence') && ops.includes('cadence'), ops.join(' '));
  assert.ok(long.planAdjustments.length > 0);
  assert.equal(long.leadPlan.filter(p => p.section === 'A2').at(-1).op, 'cadence');
  const fanfare = buildArrangement('victory', { motif: 'F5:4 Bb5:4 D6:4 F6:12 D6:4 F6:4' });
  assert.equal(fanfare.leadPlan.at(-1).op, 'hold');
  const lead = fanfare.tracks.find(t => t.role === 'lead');
  const last = lead.patterns.at(-1).notes.at(-1);
  assert.equal((last.midi - parseKey('Bb major').tonic + 120) % 12, 0, 'the stinger ends on the tonic');
});

test('review 3: every drum track plays in its blueprint, including fill-only parts', () => {
  for (const id of blueprintIds) {
    const a = buildArrangement(id, {});
    for (const t of getBlueprint(id).tracks.filter(t => t.role === 'drums')) {
      const track = a.tracks.find(x => x.name === t.name);
      assert.ok(track && track.patterns.some(p => p.notes.length), `${id}: ${t.name} has notes`);
    }
  }
  const toms = buildArrangement('boss', {}).tracks.find(t => t.name === 'Toms');
  const inA = toms.patterns.find(p => p.name === 'A');
  assert.ok(inA && inA.notes.length && inA.notes.every(n => n.tick >= 7 * 192), 'the heavy set plays the tom fill in the last bar of A');
});

test('review 4: the lead and counter checks fail on a broken arrangement', () => {
  const good = buildArrangement('overworld', {});
  assert.deepEqual(checkArrangement(good), []);
  const lead = good.tracks.find(t => t.role === 'lead');
  const twoLeads = { ...good, tracks: [...good.tracks, { ...lead, name: 'Lead 2' }] };
  assert.ok(checkArrangement(twoLeads).some(p => /2 lead tracks/.test(p)));
  assert.ok(checkArrangement(twoLeads).some(p => /2 leads/.test(p)));
  const restWindow = good.phrases.find(w => w.part === 'lead' && w.op === 'rest');
  const intruder = { ...good, tracks: good.tracks.map(t => t.role !== 'lead' ? t : { ...t, patterns: [...t.patterns,
    { name: 'x', bar: 0, bars: 1, notes: [{ tick: restWindow.startTick, length: 24, midi: 76, velocity: 90 }] }] }) };
  assert.ok(phraseProblems(intruder).some(p => /where its plan says rest/.test(p)));
  const busy = good.phrases.find(w => w.part === 'lead' && w.op !== 'rest');
  const clash = { ...good, phrases: [...good.phrases, { section: 'x', part: 'counter', op: 'answer', startTick: busy.startTick, endTick: busy.endTick }],
    tracks: good.tracks.map(t => t.role !== 'counter' ? t : { ...t, patterns: [...t.patterns, { name: 'x', bar: 0, bars: 1, notes: [{ tick: busy.startTick, length: 24, midi: 60, velocity: 80 }] }] }) };
  assert.ok(phraseProblems(clash).some(p => /while the lead plays/.test(p)));
  for (const b of blueprints) {
    for (const s of b.body) {
      if (!Array.isArray(s.counter)) continue;
      s.counter.forEach((op, i) => { if (op === 'answer' || op === 'fragment') assert.equal(Array.isArray(s.lead) ? s.lead[i] : 'rest', 'rest', `${b.id} ${s.name}: the counter answers only where the lead rests`); });
    }
  }
});

test('review 5: no two pitched parts sound a semitone apart, in every blueprint and several keys', () => {
  assert.equal(semitoneClashes([{ name: 'A', role: 'harmony', patterns: [{ bar: 0, notes: [{ tick: 0, length: 192, midi: 56 }] }] },
    { name: 'B', role: 'texture', patterns: [{ bar: 0, notes: [{ tick: 96, length: 96, midi: 55 }] }] }]).length, 1, 'the check finds a planted clash');
  for (const id of blueprintIds) {
    for (const key of [undefined, 'C', 'F#', 'Bb', 'E dorian']) {
      const a = buildArrangement(id, { key });
      assert.deepEqual(semitoneClashes(a.tracks).slice(0, 3), [], `${id} in ${a.key}`);
    }
  }
  const local = { Bass: [{ tick: 0, length: 192, midi: 45, velocity: 90 }], Pad: [{ tick: 0, length: 192, midi: 46, velocity: 60 }, { tick: 0, length: 192, midi: 50, velocity: 60 }] };
  resolveClashes(local, [{ name: 'Bass', role: 'bass' }, { name: 'Pad', role: 'harmony' }], { bass: [33, 55], harmony: [44, 60] }, [{ tick: 0, ticks: 192, tones: [10, 2, 5] }], 0);
  assert.ok(local.Pad.length && local.Pad.every(n => Math.abs(n.midi - 45) !== 1), JSON.stringify(local.Pad));
});

test('review 6: cadences and held endings land on a tone of the chord under them', () => {
  for (const id of blueprintIds) {
    for (const key of [undefined, 'G', 'Eb']) {
      const a = buildArrangement(id, { key });
      const lead = a.tracks.find(t => t.role === 'lead');
      const notes = lead.patterns.flatMap(p => p.notes.map(n => ({ ...n, at: p.bar * 192 + n.tick })));
      for (const w of a.phrases.filter(w => w.part === 'lead' && ['cadence', 'half_cadence', 'hold'].includes(w.op))) {
        const last = notes.filter(n => n.at >= w.startTick && n.at < w.endTick).at(-1);
        const section = a.sections.find(s => s.name === w.section);
        const inSection = last.at - section.startBar * 192;
        const spans = chordSpans(parseProgression(section.chords.join(' '), parseKey(a.key)), section.bars, getBlueprint(id).harmonicRhythm);
        const span = spans.find(sp => sp.tick <= inSection && inSection < sp.tick + sp.ticks);
        assert.ok(chordTones(span.symbol).has(last.midi % 12), `${id} in ${a.key}, ${w.section} ${w.op}: MIDI ${last.midi} over ${span.symbol}`);
      }
    }
  }
});

test('review 7: b and # in Roman numerals are read against the major scale', () => {
  const eMinor = parseKey('E minor');
  assert.deepEqual(parseProgression('i bVII iv V7', eMinor).map(c => c.symbol), ['Em', 'D', 'Am', 'B7']);
  assert.deepEqual(parseProgression('I bIII bVI bVII', parseKey('C major')).map(c => c.symbol), ['C', 'Eb', 'Ab', 'Bb']);
  assert.equal(romanToChord('#iv', parseKey('C major')), 'F#m');
  assert.equal(romanToChord('bII', parseKey('C phrygian')), 'Db');
});

test('review extras: wide motifs, length warnings and the MIDI ceiling', () => {
  assert.throws(() => buildArrangement('overworld', { motif: 'C3:2 C6:2' }), /spans 36 semitones/);
  assert.match(buildArrangement('overworld', { lengthSeconds: 4 }).lengthWarning, /No form of this blueprint is near/);
  assert.equal(buildArrangement('overworld', { lengthSeconds: 50 }).lengthWarning, undefined);
  for (const id of blueprintIds) {
    const a = buildArrangement(id, { motif: 'C4:2 G5:2 C6:4' });
    assert.ok(a.tracks.every(t => t.patterns.every(p => p.notes.every(n => n.midi <= 108))), id);
  }
});

test('lint-facing rules: lead leaps stay within an octave and bars are not crowded', () => {
  for (const id of blueprintIds) {
    for (const key of [undefined, 'C', 'F#', 'Bb', 'G']) {
      const a = buildArrangement(id, { key });
      const lead = a.tracks.find(t => t.role === 'lead').patterns.flatMap(p => p.notes);
      const leaps = lead.slice(1).filter((n, i) => Math.abs(n.midi - lead[i].midi) > 12).length;
      // A fanfare may drop more than an octave between phrases; loops may not.
      assert.ok(leaps <= (a.blueprint.kind === 'stinger' ? 1 : 0), `${id} in ${a.key}: ${leaps} leaps over an octave`);
      const starts = new Array(a.lengthBars).fill(0);
      for (const t of a.tracks.filter(t => t.role !== 'drums')) for (const p of t.patterns) for (const n of p.notes) starts[p.bar + Math.floor(n.tick / 192)]++;
      assert.ok(Math.max(...starts) <= 40, `${id} in ${a.key}: ${Math.max(...starts)} pitched notes start in one bar`);
    }
  }
});
