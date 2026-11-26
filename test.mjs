// Unit tests for the pure modules. Run: node --test test.mjs  (no LMMS needed)
import assert from 'node:assert/strict';
import test from 'node:test';
import * as dsp from './audio.mjs';
import { expandPattern, noteNumber, parseChord, voiceChord } from './music.mjs';
import { delaySeconds, resolveParams } from './effects.mjs';
import { measureInstrument, nameTags, searchSounds } from './catalogue.mjs';

const sampleRate = 48000;
function tone(hz, seconds, level = 0.5, channels = 2) {
  const frames = Math.round(seconds * sampleRate);
  const data = Float32Array.from({ length: frames }, (_, i) => level * Math.sin(2 * Math.PI * hz * i / sampleRate));
  return { sampleRate, frames, channels: Array.from({ length: channels }, () => data.slice()) };
}

test('analyze reports loudness range and mono cancellation', () => {
  const high = 10 ** (-20 / 20);
  const low = 10 ** (-30 / 20);
  const frames = sampleRate * 40;
  const left = Float32Array.from({ length: frames }, (_, i) =>
    (i < sampleRate * 20 ? high : low) * Math.sin(2 * Math.PI * 997 * i / sampleRate));
  const right = left.map(sample => -sample);
  const report = dsp.analyze({ sampleRate, frames, channels: [left, right] });
  assert.ok(Math.abs(report.lraLu - 10) <= 1, `Expected 10 LU, got ${report.lraLu}`);
  assert.equal(report.stereoCorrelation, -1);
  assert.equal(report.stereo.monoCancels, true);
  const warnings = dsp.advise(report);
  assert.ok(warnings.some(warning => warning.includes('folded to mono')));
  assert.ok(warnings.some(warning => warning.includes('opposing left and right phase')));
});

test('WAV round trip keeps length and level', () => {
  const audio = tone(440, 0.5);
  const decoded = dsp.decodeWav(dsp.encodeWav(audio));
  assert.equal(decoded.frames, audio.frames);
  assert.equal(decoded.channels.length, 2);
  assert.ok(Math.abs(dsp.samplePeak(decoded) - 0.5) < 1e-3);
});

test('loudness follows BS.1770: a full-scale 997 Hz sine reads -3.01 LUFS in one channel and 0 in two', () => {
  const loud = dsp.loudness(tone(997, 3, 1)).integratedLufs;
  assert.ok(Math.abs(loud) < 0.1, String(loud));
  assert.ok(Math.abs(dsp.loudness(tone(997, 3, 1, 1)).integratedLufs - -3.01) < 0.1);
  const quiet = dsp.loudness(tone(997, 3, 0.1)).integratedLufs;
  assert.ok(Math.abs(loud - quiet - 20) < 0.1);
  assert.equal(dsp.loudness({ sampleRate, frames: sampleRate, channels: [new Float32Array(sampleRate)] }).integratedLufs, null);
});

test('analysis reports pitch, bands, correlation and clipping', () => {
  const report = dsp.analyze(tone(220, 2, 0.25), { pitch: true, sections: [{ name: 'half', startSeconds: 0, endSeconds: 1 }] });
  assert.equal(report.pitch.note, 'A3');
  assert.ok(Math.abs(report.rmsDbfs - -15.05) < 0.1);
  assert.equal(report.stereoCorrelation, 1);
  assert.equal(report.clippedSamples, 0);
  assert.ok(report.bandsDbfs.lowMid > report.bandsDbfs.mid + 30, 'energy sits in the 150-500 Hz band');
  assert.equal(report.sections[0].name, 'half');
  const clipped = tone(220, 0.5, 1.2);
  for (const ch of clipped.channels) for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-1, Math.min(1, ch[i]));
  assert.ok(dsp.analyze(clipped).clippedSamples > 100);
  assert.ok(dsp.advise(dsp.analyze(clipped)).some(line => line.includes('full scale')));
});

test('limiter holds the ceiling without touching quiet audio', () => {
  const quiet = tone(330, 1, 0.3);
  assert.equal(dsp.limit(quiet, -1).limitedSamples, 0);
  const hot = tone(330, 1, 1.4);
  const result = dsp.limit(hot, -1, { wrap: true });
  assert.ok(dsp.db(dsp.samplePeak(hot)) <= -0.99);
  assert.ok(result.maxReductionDb < -3);
});

test('folding a tail keeps the loop length and adds the overhang to the start', () => {
  const audio = { sampleRate, frames: 6, channels: [Float32Array.from([1, 2, 3, 4, 0.5, 0.25])] };
  const folded = dsp.foldTail(audio, 4);
  assert.deepEqual(Array.from(folded.channels[0]), [1.5, 2.25, 3, 4]);
});

test('spectrogram is a valid PNG of the requested size', () => {
  const png = dsp.spectrogramPng(tone(1000, 1), { width: 64, height: 32 });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 32);
});

test('note names and chords', () => {
  assert.equal(noteNumber('C4'), 60);
  assert.equal(noteNumber('F#3'), 54);
  assert.equal(noteNumber('Bb4'), 70);
  assert.equal(noteNumber(72), 72);
  assert.throws(() => noteNumber('H2'));
  assert.deepEqual(voiceChord(parseChord('Dm7')), [62, 65, 69, 72]);
  assert.deepEqual(parseChord('C/E').bass, 4);
  assert.throws(() => parseChord('Dxyz'), /Unknown chord/);
  const second = voiceChord(parseChord('G'), { previous: voiceChord(parseChord('C')) });
  assert.ok(Math.abs(second.reduce((a, b) => a + b) / 3 - 64) < 3, 'voice leading keeps the register');
});

test('step grids tile across the pattern', () => {
  const notes = expandPattern({ name: 'k', bars: 2, steps: { grid: 'X---x---' } });
  assert.deepEqual(notes.map(n => n.tick), [0, 48, 96, 144, 192, 240, 288, 336]);
  assert.deepEqual(notes.slice(0, 2).map(n => n.velocity), [100, 82]);
  assert.throws(() => expandPattern({ name: 'k', bars: 1, steps: { grid: 'x?x' } }), /Step grids/);
});

test('melody lines read notes, rests, chords and velocities', () => {
  const notes = expandPattern({ name: 'm', bars: 1, melody: { line: 'D5:4 r:4 [C4,E4]:4:60 G4:4', repeat: false } });
  assert.deepEqual(notes.map(n => [n.tick, n.midi, n.velocity]), [[0, 74, 88], [96, 60, 60], [96, 64, 60], [144, 67, 88]]);
  assert.ok(notes.every(n => n.tick + n.length <= 192));
});

test('chord progressions make block chords, arps and bass lines', () => {
  const block = expandPattern({ name: 'c', bars: 2, chords: { progression: 'Dm C' } });
  assert.equal(block.filter(n => n.tick === 0).length, 3);
  assert.equal(block.filter(n => n.tick === 192).length, 3);
  const arp = expandPattern({ name: 'a', bars: 1, chords: { progression: 'Am', style: 'arp', order: 'updown', rate: 2 } });
  assert.equal(arp.length, 8);
  const bass = expandPattern({ name: 'b', bars: 1, chords: { progression: 'F', style: 'bass', figure: 'octaves' } });
  assert.deepEqual(bass.slice(0, 2).map(n => n.midi), [41, 53]);
  assert.throws(() => expandPattern({ name: 'x', bars: 1 }), /exactly one/);
});

test('delay times follow the tempo', () => {
  assert.equal(delaySeconds('1/4', 120), 0.5);
  assert.equal(delaySeconds('1/8d', 120), 0.375);
  assert.equal(delaySeconds(0.2, 90), 0.2);
  assert.throws(() => delaySeconds('1/5', 120));
  assert.deepEqual(resolveParams('reverb', { size: 0.5 }), { size: 0.5, dampingHz: 9000, inputGainDb: 0, outputGainDb: 0 });
  assert.throws(() => resolveParams('reverb', { room: 1 }), /no parameter "room"/);
});

test('sound measurement classifies a sustained tone and a transposed one', () => {
  const held = tone(261.63, 2, 0.4);
  for (const ch of held.channels) ch.fill(0, sampleRate);
  const facts = measureInstrument(held, { writtenMidi: 60, holdSeconds: 1 }, dsp);
  assert.equal(facts.pitched, true);
  assert.equal(facts.pitchOffset, 0);
  assert.equal(facts.role, 'lead');
  assert.ok(facts.tags.includes('sustained'));
  const low = tone(130.81, 2, 0.4);
  assert.equal(measureInstrument(low, { writtenMidi: 60, holdSeconds: 1 }, dsp).pitchOffset, -12);
  assert.equal(nameTags('TripleOscillator', 'ResoBass.xpf').nameRole, 'bass');
  assert.equal(nameTags('Pads', '0001-Sine Pad.xiz').nameRole, 'pad');
  assert.equal(nameTags('Pads', '0001-Sine Pad.xiz').name, 'Sine Pad');
});

test('search filters by role and hides Fathom patches when the bridge is absent', () => {
  const found = searchSounds({ query: '', role: 'bass', limit: 10, fathomAvailable: false }, ['TripleOscillator/ResoBass.xpf', 'TripleOscillator/Bell.xpf'], ['ZynAddSubFX/Bass/0001-Bass 1.xiz']);
  assert.deepEqual(found.sounds.map(s => s.name), ['ResoBass', 'Bass 1']);
  assert.equal(searchSounds({ query: 'bell', limit: 10, fathomAvailable: false }, []).total, 0);
  assert.equal(searchSounds({ query: 'bell', limit: 10, fathomAvailable: true }, []).sounds[0].engine, 'fathom');
});

test('the true-peak limiter holds inter-sample peaks under the ceiling where a sample-peak limiter does not', () => {
  const make = () => {
    const audio = tone(12000, 1, 1.4);
    for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] = 1.4 * Math.sin(2 * Math.PI * 12000 * i / 48000 + Math.PI / 4);
    return audio;
  };
  const sampleOnly = make();
  dsp.limit(sampleOnly, -1);
  const sampleOnlyTruePeak = dsp.db(dsp.truePeak(sampleOnly));
  assert.ok(sampleOnlyTruePeak > -0.9, `expected sample-peak limiter to overshoot, got ${sampleOnlyTruePeak}`);
  const audio = make();
  const result = dsp.limitTruePeak(audio, -1);
  const truePeak = dsp.db(dsp.truePeak(audio));
  assert.ok(truePeak <= -0.99, `true peak ${truePeak} dBTP`);
  assert.ok(truePeak >= -1.3, `true peak ${truePeak} dBTP is far below the ceiling`);
  assert.equal(result.truePeakDb, truePeak);
  assert.ok(result.sampleCeilingDb < -1);
});

test('the true-peak limiter leaves quiet audio alone', () => {
  const audio = tone(440, 0.5, 0.3);
  const before = Float32Array.from(audio.channels[0]);
  const result = dsp.limitTruePeak(audio, -1);
  assert.equal(result.limitedSamples, 0);
  assert.deepEqual(Array.from(audio.channels[0].slice(0, 50)), Array.from(before.slice(0, 50)));
});
