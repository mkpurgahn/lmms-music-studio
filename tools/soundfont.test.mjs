import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decodeWav, detectPitch, samplePeak } from '../audio.mjs';
import { buildSf2Buffer } from './sf2-builder.mjs';
import { fluidsynthArgs } from './soundfont.mjs';
import { resolveLmmsExecutable, resolveSoundfontsDir } from './workspace-config.mjs';

test('fluidsynthArgs builds a non-interactive file render command', () => {
  const args = fluidsynthArgs({
    midi: '/tmp/song.mid',
    soundfont: '/sounds/piano.sf2',
    output: '/out/song.wav',
    gain: 0.7,
    sampleRate: 44100,
    reverb: true,
    chorus: false,
  });
  assert.ok(args.includes('-ni'));
  assert.ok(args.includes('-F'));
  assert.equal(args.at(-2), '/sounds/piano.sf2');
  assert.equal(args.at(-1), '/tmp/song.mid');
  assert.ok(args.includes('44100'));
  assert.ok(args.includes('synth.reverb.active=1'));
  assert.ok(args.includes('synth.chorus.active=0'));
});

test('fluidsynthArgs defaults to 48 kHz and no effects', () => {
  const args = fluidsynthArgs({
    midi: 'a.mid',
    soundfont: 'b.sf2',
    output: 'c.wav',
  });
  assert.ok(args.includes('48000'));
  assert.ok(args.includes('synth.reverb.active=0'));
  assert.ok(args.includes('0.8'));
});

const lmmsExe = resolveLmmsExecutable();
const hasLmms = path.isAbsolute(lmmsExe) ? existsSync(lmmsExe) : false;
const sfDir = resolveSoundfontsDir();
const hasCorePack = existsSync(path.join(sfDir, 'upright-piano-kw.sf2')) &&
  existsSync(path.join(sfDir, 'virtuosity-drums.sf2'));

test('native sf2player C4 pitch, Bank 128 drums, pure-synth drums, silent-SF2 guard, and tail: "ring" stem alignment', {
  skip: !hasLmms ? 'LMMS executable not installed' : false,
  timeout: 240000,
}, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-sf2-phase2-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  // Build deterministic self-contained SF2 fixtures in workspace so test works even if LMMS_SOUNDFONTS is empty,
  // and also exercises the real Core Pack when installed.
  const sr = 48000;
  const c4Frames = Math.round(sr * 1.5);
  const c4Wave = Int16Array.from({ length: c4Frames }, (_, i) =>
    Math.round(18000 * Math.sin(2 * Math.PI * 261.6256 * i / sr) * Math.exp(-i / (sr * 0.6))));
  const kickWave = Int16Array.from({ length: Math.round(sr * 0.25) }, (_, i) =>
    Math.round(22000 * Math.sin(2 * Math.PI * 95 * i / sr) * Math.exp(-i / (sr * 0.05))));
  const snareWave = Int16Array.from({ length: Math.round(sr * 0.25) }, (_, i) =>
    Math.round(18000 * Math.sin(2 * Math.PI * 210 * i / sr) * Math.exp(-i / (sr * 0.06))));
  const hatWave = Int16Array.from({ length: Math.round(sr * 0.12) }, (_, i) =>
    Math.round(14000 * Math.sin(2 * Math.PI * 6200 * i / sr) * Math.exp(-i / (sr * 0.03))));

  const localSf2 = buildSf2Buffer({
    bankName: 'Fixture Acoustic Bank',
    presets: [
      {
        name: 'Concert C4 Probe',
        bank: 0,
        preset: 0,
        zones: [{
          sampleName: 'c4_tone',
          sampleRate: sr,
          channels: [c4Wave],
          lokey: 48,
          hikey: 72,
          rootKey: 60,
          releaseSeconds: 1.4,
        }],
      },
      {
        name: 'Fixture GM Drums',
        bank: 128,
        preset: 0,
        zones: [
          { sampleName: 'kick36', sampleRate: sr, channels: [kickWave], lokey: 36, hikey: 36, rootKey: 36, releaseSeconds: 0.4 },
          { sampleName: 'snare38', sampleRate: sr, channels: [snareWave], lokey: 38, hikey: 38, rootKey: 38, releaseSeconds: 0.4 },
          { sampleName: 'hat42', sampleRate: sr, channels: [hatWave], lokey: 42, hikey: 42, rootKey: 42, exclusiveClass: 1, releaseSeconds: 0.3 },
        ],
      },
    ],
  });
  await writeFile(path.join(workspace, 'fixture-bank.sf2'), localSf2);

  const client = new Client({ name: 'phase2-sf2-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_STRICT_COPYRIGHT: '0' },
  }));
  t.after(() => client.close().catch(() => {}));

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.equal(Boolean(res.isError), false, `${name} failed: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };

  // 1. list_sf2_presets discovers workspace + Core Pack SoundFonts and Bank 128 drum flag.
  const presetsList = await call('list_sf2_presets');
  const fixtureEntry = presetsList.soundfonts.find(s => s.sf2 === 'fixture-bank.sf2');
  assert.ok(fixtureEntry, 'fixture-bank.sf2 should be listed');
  assert.deepEqual(fixtureEntry.presets, [
    { bank: 0, patch: 0, name: 'Concert C4 Probe', isDrumBank: false },
    { bank: 128, patch: 0, name: 'Fixture GM Drums', isDrumBank: true },
  ]);
  const singleSf2Alias = await call('list_sf2_presets', { soundfont: 'fixture-bank.sf2' });
  assert.equal(singleSf2Alias.count, 1);

  const pianoSf2 = hasCorePack ? 'upright-piano-kw.sf2' : 'fixture-bank.sf2';
  const drumSf2 = hasCorePack ? 'virtuosity-drums.sf2' : 'fixture-bank.sf2';

  // 2. Concert C4 fundamental check on sf2player (MIDI 60 -> ~261.63 Hz, exercising soundfont alias).
  await call('create_project', {
    output: 'piano-c4.mmp',
    bpm: 120,
    tracks: [{
      name: 'Piano',
      voice: 'sf2',
      soundfont: pianoSf2,
      bank: 0,
      patch: 0,
      role: 'harmony',
      volume: 100,
      patterns: [{ name: 'C4', bar: 0, bars: 2, notes: [{ tick: 0, midi: 60, length: 96, velocity: 100 }] }],
    }],
  });
  await call('render_mix', { project: 'piano-c4.mmp', output: 'piano-c4.wav', tail: 'cut' });
  const pianoAudio = decodeWav(await readFile(path.join(workspace, 'piano-c4.wav')));
  const monoPiano = Float32Array.from({ length: pianoAudio.frames }, (_, i) =>
    (pianoAudio.channels[0][i] + pianoAudio.channels[1][i]) * 0.5);
  const detectedC4 = detectPitch(monoPiano, pianoAudio.sampleRate, Math.round(sr * 0.08), Math.round(sr * 0.35));
  assert.ok(detectedC4, 'Expected pitched C4 signal from sf2player');
  assert.ok(Math.abs(detectedC4.hz - 261.63) < 2.5, `Expected ~261.63 Hz C4, got ${detectedC4.hz} Hz`);

  // 3. Bank 128 drum SoundFont + pure-synth drum voices + tail: "ring" sample-exact stem alignment.
  await call('create_project', {
    output: 'ensemble.mmp',
    bpm: 120,
    lengthBars: 1,
    tracks: [
      {
        name: 'Keys',
        voice: 'sf2',
        sf2: pianoSf2,
        bank: 0,
        patch: 0,
        role: 'harmony',
        volume: 95,
        patterns: [{ name: 'EndChord', bar: 0, bars: 1, notes: [{ tick: 144, midi: 60, length: 48, velocity: 110 }] }],
      },
      {
        name: 'AcousticKit',
        voice: 'sf2',
        sf2: drumSf2,
        bank: 128,
        patch: 0,
        role: 'drums',
        volume: 95,
        patterns: [{
          name: 'Groove',
          bar: 0,
          bars: 1,
          notes: [
            { tick: 0, midi: 36, length: 24, velocity: 105 },
            { tick: 48, midi: 38, length: 24, velocity: 100 },
            { tick: 96, midi: 42, length: 24, velocity: 95 },
          ],
        }],
      },
      {
        name: 'SynthKick',
        voice: 'kick',
        role: 'drums',
        volume: 75,
        patterns: [{ name: 'K', bar: 0, bars: 1, steps: { grid: 'X-------X-------' } }],
      },
      {
        name: 'SynthSnare',
        voice: 'snare',
        role: 'drums',
        volume: 70,
        patterns: [{ name: 'S', bar: 0, bars: 1, steps: { grid: '----X-------X---' } }],
      },
      {
        name: 'SynthHat',
        voice: 'hat',
        role: 'drums',
        volume: 60,
        patterns: [{ name: 'H', bar: 0, bars: 1, steps: { grid: 'x-x-x-x-x-x-x-x-' } }],
      },
      {
        name: 'SynthClap',
        voice: 'clap',
        role: 'drums',
        volume: 65,
        patterns: [{ name: 'C', bar: 0, bars: 1, steps: { grid: '------------X---' } }],
      },
    ],
  });

  // Verify zero drums/*.ogg or audiofileprocessor in saved XML.
  const ensembleXml = await readFile(path.join(workspace, 'ensemble.mmp'), 'utf8');
  assert.doesNotMatch(ensembleXml, /audiofileprocessor/);
  assert.doesNotMatch(ensembleXml, /drums\/.*\.ogg/i);

  // Add reverb on Keys so tail: "ring" clearly extends beyond 1 bar (96,000 frames at 120 BPM).
  await call('edit_effect', {
    project: 'ensemble.mmp',
    output: 'ensemble-ring.mmp',
    trackName: 'Keys',
    operation: 'add',
    plugin: 'reverb',
    wet: 0.4,
    params: { size: 0.85 },
  });

  const ringMix = await call('render_mix', {
    project: 'ensemble-ring.mmp',
    output: 'ensemble-ring.wav',
    tail: 'ring',
    ringSeconds: 4,
  });
  const ringStems = await call('render_stems', {
    project: 'ensemble-ring.mmp',
    outputDirectory: 'ensemble-stems',
    tail: 'ring',
    ringSeconds: 4,
  });

  const mixDecoded = decodeWav(await readFile(path.join(workspace, 'ensemble-ring.wav')));
  assert.ok(mixDecoded.frames > 96000, `Expected tail: "ring" to extend beyond 1 bar (96000 frames), got ${mixDecoded.frames}`);
  assert.equal(ringMix.frames, mixDecoded.frames);
  assert.equal(ringStems.frames, mixDecoded.frames);
  assert.equal(ringStems.stems.length, 6);

  let stemEnergy = 0;
  for (const stem of ringStems.stems) {
    const stemDecoded = decodeWav(await readFile(path.join(workspace, 'ensemble-stems', stem.file)));
    assert.equal(stemDecoded.frames, mixDecoded.frames, `Stem ${stem.file} frame mismatch`);
    assert.ok(samplePeak(stemDecoded) > 0.005, `Expected non-zero audio on stem ${stem.track}`);
    for (let i = 0; i < mixDecoded.frames; i++) stemEnergy += stemDecoded.channels[0][i] ** 2;
  }
  let mixEnergy = 0;
  for (let i = 0; i < mixDecoded.frames; i++) mixEnergy += mixDecoded.channels[0][i] ** 2;
  const energyDeltaDb = Math.abs(10 * Math.log10(stemEnergy / Math.max(1e-12, mixEnergy)));
  assert.ok(energyDeltaDb < 0.75, `Expected stem power sum to match mix power within 0.75 dB, delta was ${energyDeltaDb.toFixed(2)} dB`);

  // Sample-by-sample stem sum check on deterministic SF2 tracks (no unseeded C++ rand() noise oscillators):
  const sf2OnlyMix = await call('render_mix', {
    project: 'ensemble-ring.mmp',
    output: 'sf2-check-probe.wav',
    tail: 'cut',
  });
  assert.equal(sf2OnlyMix.frames, 96000);
  await call('create_project', {
    output: 'sf2-ring-pair.mmp',
    bpm: 120,
    lengthBars: 1,
    tracks: [
      {
        name: 'Keys',
        voice: 'sf2',
        sf2: pianoSf2,
        bank: 0,
        patch: 0,
        volume: 95,
        patterns: [{ name: 'EndChord', bar: 0, bars: 1, notes: [{ tick: 144, midi: 60, length: 48, velocity: 110 }] }],
      },
      {
        name: 'Drums',
        voice: 'sf2',
        sf2: drumSf2,
        bank: 128,
        patch: 0,
        volume: 95,
        patterns: [{ name: 'Groove', bar: 0, bars: 1, notes: [{ tick: 0, midi: 36, length: 24, velocity: 105 }, { tick: 96, midi: 38, length: 24, velocity: 100 }] }],
      },
    ],
  });
  const pairMix = await call('render_mix', { project: 'sf2-ring-pair.mmp', output: 'sf2-ring-pair.wav', tail: 'ring', ringSeconds: 4 });
  const pairStems = await call('render_stems', { project: 'sf2-ring-pair.mmp', outputDirectory: 'sf2-pair-stems', tail: 'ring', ringSeconds: 4 });
  assert.equal(pairMix.frames, pairStems.frames);
  assert.ok(pairMix.frames > 96000, `Expected SF2 ring-out > 96000 frames, got ${pairMix.frames}`);
  const pairMixDec = decodeWav(await readFile(path.join(workspace, 'sf2-ring-pair.wav')));
  const summedSf2 = new Float64Array(pairMixDec.frames);
  for (const stem of pairStems.stems) {
    const stemDec = decodeWav(await readFile(path.join(workspace, 'sf2-pair-stems', stem.file)));
    assert.equal(stemDec.frames, pairMixDec.frames);
    for (let i = 0; i < pairMixDec.frames; i++) summedSf2[i] += stemDec.channels[0][i];
  }
  let errPower = 0;
  let refPower = 0;
  for (let i = 0; i < pairMixDec.frames; i++) {
    const diff = summedSf2[i] - pairMixDec.channels[0][i];
    errPower += diff * diff;
    refPower += pairMixDec.channels[0][i] ** 2;
  }
  const residualDb = 10 * Math.log10(errPower / Math.max(1e-12, refPower));
  assert.ok(residualDb < -60, `Expected deterministic SF2 stem sum to match master mix sample-for-sample, residual was ${residualDb.toFixed(2)} dB`);

  // 4. set_sf2_instrument edit tool + Silent-SF2 Render Guard (isolated SF2 track playing out-of-range silent note).
  await call('create_project', {
    output: 'silent-guard.mmp',
    bpm: 120,
    tracks: [
      {
        name: 'LoudKick',
        voice: 'kick',
        volume: 90,
        patterns: [{ name: 'K', bar: 0, bars: 1, steps: { grid: 'X---X---X---X---' } }],
      },
      {
        name: 'SilentSf2',
        voice: 'pluck',
        volume: 90,
        patterns: [{ name: 'OutOfRange', bar: 0, bars: 1, notes: [{ tick: 0, midi: 24, length: 48, velocity: 100 }] }],
      },
    ],
  });
  // fixture-bank.sf2 bank 0 patch 0 only maps keys 48..72, so MIDI 24 renders 0 energy on SilentSf2!
  await call('set_sf2_instrument', {
    project: 'silent-guard.mmp',
    output: 'silent-guard-sf2.mmp',
    trackName: 'SilentSf2',
    sf2: 'fixture-bank.sf2',
    bank: 0,
    patch: 0,
  });
  const guardFailure = await client.callTool({
    name: 'render_mix',
    arguments: { project: 'silent-guard-sf2.mmp', output: 'should-fail.wav' },
  }, undefined, { timeout: 120000 });
  assert.equal(guardFailure.isError, true, 'Silent SF2 render guard should reject silent SF2 track even when LoudKick is audible');
  assert.match(guardFailure.content[0].text, /Silent SF2 render guard/i);

  // Also test acoustic-cc0 create_drum_kit when Core Pack is installed.
  if (hasCorePack) {
    const acousticKit = await call('create_drum_kit', { output: 'acoustic-cc0.mmp', kit: 'acoustic-cc0', lengthBars: 2 });
    assert.equal(acousticKit.publishable, true);
    assert.equal(acousticKit.licence, 'CC0-1.0');
    assert.equal(acousticKit.bank, 128);
  }
});

