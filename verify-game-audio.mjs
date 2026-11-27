// End-to-end check of the game-audio tools through a real stdio connection and the installed LMMS.
// Run: node verify-game-audio.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decodeWav } from './audio.mjs';

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-game-audio-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-game-audio-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_NO_GUI_LAUNCH: '1' },
}));
async function raw(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
}
async function call(name, args = {}) {
  const result = await raw(name, args);
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}
async function fails(name, args, pattern) {
  const result = await raw(name, args);
  assert.ok(result.isError, `${name} should have failed`);
  assert.match(result.content[0].text, pattern);
}
const step = label => console.log('ok', label);
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['analyze_audio', 'apply_edits', 'export_game_audio', 'list_samples', 'build_sound_catalogue', 'add_track', 'copy_bars']) assert.ok(tools.includes(name), name);
  step(`${tools.length} tools listed`);

  // 1. High-level composing input, pure-synth drums, a preset voice, pinned song length, and strict stock-sample gate.
  await fails('create_project', { output: 'blocked-stock.mmp', bpm: 120, tracks: [
    { name: 'Kick', voice: 'sample', factorySample: 'drums/kick01.ogg', volume: 50, patterns: [{ name: 'Beat', bar: 0, bars: 1, steps: { grid: 'X---' } }] },
  ] }, /strict copyright mode/i);
  assert.ok(!existsSync(path.join(workspace, 'blocked-stock.mmp')));

  await fails('create_project', { output: 'blocked-preset.mmp', bpm: 120, tracks: [
    { name: 'Lead', voice: 'preset', preset: 'TripleOscillator/PowerStrings.xpf', volume: 20, patterns: [{ name: 'Tune', bar: 0, bars: 1, notes: [{ tick: 0, midi: 69, length: 96, velocity: 90 }] }] },
  ] }, /strict copyright/i);
  assert.ok(!existsSync(path.join(workspace, 'blocked-preset.mmp')));

  const song = await call('create_project', { output: 'song.mmp', bpm: 120, lengthBars: 8, tracks: [
    { name: 'Kick', voice: 'kick', role: 'drums', volume: 70, patterns: [{ name: 'Beat', bar: 0, bars: 6, steps: { grid: 'X---x---X-x-x---' } }] },
    { name: 'Snare', voice: 'snare', role: 'drums', volume: 58, patterns: [{ name: 'Beat', bar: 0, bars: 6, steps: { grid: '----X-------X--g' } }] },
    { name: 'Bass', voice: 'bass', volume: 80, patterns: [{ name: 'Line', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C', style: 'bass', figure: 'octaves' } }] },
    { name: 'Keys', voice: 'pad', volume: 45, patterns: [{ name: 'Chords', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C' } }] },
    { name: 'Lead', voice: 'preset', preset: 'TripleOscillator/CryingPads.xpf', volume: 22, patterns: [{ name: 'Tune', bar: 0, bars: 4, melody: { line: 'D5:3 F5:3 A5:6 G5:2 F5:2 | G5:3 F5:3 D5:6 r:4' } }] },
  ] });
  assert.equal(song.lengthBars, 8);
  assert.equal(song.lengthSeconds, 16);
  assert.equal(song.lengthPinned, true);
  assert.equal(song.presets.Lead.corrected, true);
  assert.equal(song.presets.Lead.presetPitchOffsetSemitones, -12);
  const bass = await call('read_pattern', { project: 'song.mmp', trackName: 'Bass', bar: 0 });
  assert.deepEqual(bass.notes.slice(0, 2).map(n => n.midi), [38, 50]);
  assert.equal(bass.notes.length, 48);
  const keys = await call('read_pattern', { project: 'song.mmp', trackName: 'Keys', bar: 0 });
  assert.ok(keys.notes.every(n => n.midi >= 53 && n.midi <= 72), 'voice-led chords stay in one register');
  step('create_project accepts step grids, melody lines, chord progressions, pure-synth drums and presets while blocking stock samples');

  const cut = await call('render_mix', { project: 'song.mmp', output: 'cut.wav' });
  assert.equal(cut.durationSeconds, 16);
  assert.equal(cut.fullScaleSamples, 0);
  step('pinned length renders all 8 bars although bars 7 and 8 are empty');

  // 2. Preset tuning: a written A4 sounds as A4 after concert correction, and 12 semitones low without it.
  const probe = { bpm: 120, tracks: [{ name: 'P', voice: 'preset', preset: 'TripleOscillator/CryingPads.xpf', volume: 25,
    patterns: [{ name: 'A', bar: 0, bars: 1, notes: [{ tick: 0, midi: 69, length: 180, velocity: 90 }] }] }] };
  await call('create_project', { ...probe, output: 'concert.mmp' });
  await call('create_project', { ...probe, output: 'as-saved.mmp', tuning: 'preset' });
  await call('render_mix', { project: 'concert.mmp', output: 'concert.wav' });
  await call('render_mix', { project: 'as-saved.mmp', output: 'as-saved.wav' });
  near((await call('analyze_audio', { audio: 'concert.wav', pitch: true })).pitch.midi, 69, 0.3, 'concert tuning');
  near((await call('analyze_audio', { audio: 'as-saved.wav', pitch: true })).pitch.midi, 57, 0.3, 'preset tuning');
  step('apply_preset corrects preset transposition and reports it');

  // 3. Older preset formats and ZynAddSubFX patches load and make sound; stock sample previews fail closed in strict mode.
  for (const [index, preset] of ['TripleOscillator/TranceLead.xpf', 'Organic/pad_rich.xpf', 'BitInvader/bell.xpf', 'ZynAddSubFX/Pads/0001-Sine Pad.xiz'].entries()) {
    const preview = await call('preview_sound', { preset, output: `preview-${index}.wav`, midi: 60 });
    assert.ok(preview.peakDbfs > -60, preset + ' is audible');
  }
  await fails('preview_sound', { factorySample: 'drums/kick01.ogg', output: 'preview-kick.wav' }, /strict copyright mode/i);
  assert.ok(!existsSync(path.join(workspace, 'preview-kick.wav')));
  step('old-format presets and ZynAddSubFX patches audition while stock samples stay blocked');

  // 4. Batch edits: one file for a whole pass, and nothing written when a step fails.
  const before = (await readdir(workspace)).filter(name => name.endsWith('.mmp')).length;
  const pass = await call('apply_edits', { project: 'song.mmp', output: 'mixed.mmp', edits: [
    { op: 'set_track_mix', args: { trackName: 'Keys', volume: 38.5, pan: -20 } },
    { op: 'set_track_mix', args: { trackName: 'Lead', pan: 15 } },
    { op: 'edit_effect', args: { trackName: 'Lead', operation: 'add', plugin: 'delay', wet: 0.3, params: { time: '1/8', feedback: 0.5 } } },
    { op: 'edit_effect', args: { trackName: 'Keys', operation: 'add', plugin: 'reverb', wet: 0.35, params: { size: 0.9 } } },
    { op: 'edit_effect', args: { bus: 'Master', operation: 'add', plugin: 'limiter', params: { ceilingDb: -1 } } },
    { op: 'automate_track', args: { trackName: 'Keys', name: 'Keys swell', control: 'volume', startTick: 0, length: 768, points: [{ tick: 0, value: 10 }, { tick: 767, value: 38.5 }] } },
    { op: 'set_master', args: { volume: 90 } },
  ] });
  assert.equal(pass.applied, 7);
  assert.equal((await readdir(workspace)).filter(name => name.endsWith('.mmp')).length, before + 1);
  await fails('apply_edits', { project: 'song.mmp', output: 'broken.mmp', edits: [
    { op: 'set_master', args: { volume: 50 } }, { op: 'set_track_mix', args: { trackName: 'Nope', volume: 10 } },
  ] }, /Edit 2 of 2 \(set_track_mix\) failed.*Nothing was written/s);
  assert.ok(!existsSync(path.join(workspace, 'broken.mmp')));
  await call('apply_edits', { project: 'mixed.mmp', output: 'mixed.mmp', overwrite: true, edits: [{ op: 'set_track_mix', args: { trackName: 'Bass', volume: 110.5 } }] });
  const arrangement = await call('inspect_arrangement', { project: 'mixed.mmp' });
  assert.equal(arrangement.tracks.find(t => t.name === 'Bass').volume, 110.5);
  assert.equal(arrangement.masterVolume, 90);
  assert.equal(arrangement.lengthBars, 8);
  const leadFx = await call('inspect_effects', { project: 'mixed.mmp', trackName: 'Lead' });
  assert.deepEqual(leadFx[0].params, { time: '1/8', feedback: 0.5, outputGainDb: 0 });
  assert.equal((await call('inspect_effects', { project: 'mixed.mmp', bus: 'Master' }))[0].plugin, 'limiter');
  await fails('edit_effect', { project: 'mixed.mmp', output: 'x.mmp', trackName: 'Lead', operation: 'add', plugin: 'reverb', params: { size: 3 } }, /between 0 and 0.99/);
  step('apply_edits saves once, is all-or-nothing, and can overwrite; effects carry real parameters');

  // 5. Effect tails: a wrapped render carries the reverb and delay tail across the loop point.
  await call('create_project', { output: 'tail.mmp', bpm: 120, tracks: [{ name: 'Pluck', voice: 'pluck', volume: 60,
    patterns: [{ name: 'Run', bar: 0, bars: 2, melody: { line: 'D5:2 F5:2 A5:2 D6:2' } }] }] });
  await call('edit_effect', { project: 'tail.mmp', output: 'tail-fx.mmp', trackName: 'Pluck', operation: 'add', plugin: 'delay', wet: 0.4, params: { time: '1/4', feedback: 0.6 } });
  const cutLoop = await call('render_mix', { project: 'tail-fx.mmp', output: 'loop-cut.wav' });
  const wrapped = await call('render_mix', { project: 'tail-fx.mmp', output: 'loop-wrap.wav', tail: 'wrap' });
  const kept = await call('render_mix', { project: 'tail-fx.mmp', output: 'loop-keep.wav', tail: 'keep' });
  assert.equal(wrapped.durationSeconds, cutLoop.durationSeconds);
  assert.equal(kept.durationSeconds, cutLoop.durationSeconds + 2);
  const dry = await call('render_mix', { project: 'mixed.mmp', output: 'mixed.wav' });
  const a = decodeWav(await readFile(path.join(workspace, 'loop-cut.wav'))), b = decodeWav(await readFile(path.join(workspace, 'loop-wrap.wav')));
  const tail = decodeWav(await readFile(path.join(workspace, 'loop-keep.wav')));
  let difference = 0, tailEnergy = 0;
  for (let i = 0; i < 96000; i++) { difference += (a.channels[0][i] - b.channels[0][i]) ** 2; tailEnergy += tail.channels[0][a.frames + i] ** 2; }
  assert.ok(tailEnergy > 1e-4, 'the song has an audible tail');
  near(difference / tailEnergy, 1, 0.05, 'the wrapped start contains exactly the tail');
  step('tail wrap folds the effect tail onto the loop start');

  // 6. Solo is honoured, and stems for every track line up with the mix.
  await call('set_track_mix', { project: 'mixed.mmp', output: 'solo.mmp', trackName: 'Bass', solo: true });
  const solo = await call('render_mix', { project: 'solo.mmp', output: 'solo.wav' });
  assert.ok(solo.rmsDbfs < dry.rmsDbfs - 1, 'solo render is quieter than the mix');
  const stems = await call('render_stems', { project: 'mixed.mmp', outputDirectory: 'stems' });
  assert.equal(stems.stems.length, 5);
  assert.ok(stems.stems.every(stem => stem.durationSeconds === dry.durationSeconds && stem.peakDbfs !== null));
  near(stems.stems.find(stem => stem.track === 'Bass').rmsDbfs, solo.rmsDbfs, 0.6, 'solo render matches the bass stem');
  step('solo works in headless renders and stems align');

  // 7. Loudness mastering and analysis.
  const mastered = await call('render_mix', { project: 'mixed.mmp', output: 'mastered.wav', tail: 'wrap', targetLufs: -16 });
  near(mastered.integratedLufs, -16, 0.6, 'mastered loudness');
  assert.ok(mastered.truePeakDbfs <= -0.5 && mastered.fullScaleSamples === 0);
  const analysis = await raw('analyze_audio', { audio: 'mastered.wav', bpm: 120, loop: true, targetLufs: -16, pitch: true, spectrogram: 'mastered.png',
    sections: [{ name: 'Groove', startBar: 0, bars: 4 }, { name: 'Tail', startBar: 6, bars: 2 }] });
  assert.ok(!analysis.isError, analysis.content[0].text);
  const report = JSON.parse(analysis.content[0].text);
  assert.equal(analysis.content[1].type, 'image');
  assert.ok(Buffer.from(analysis.content[1].data, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(report.sections.length, 2);
  assert.ok(report.sections[0].rmsDbfs > report.sections[1].rmsDbfs + 6, 'the empty closing bars are much quieter');
  for (const key of ['integratedLufs', 'truePeakDbfs', 'crestDb', 'stereoCorrelation', 'centroidHz']) assert.equal(typeof report[key], 'number', key);
  assert.deepEqual(Object.keys(report.bandsDbfs), ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air']);
  step('render_mix hits a loudness target; analyze_audio returns numbers, warnings and a spectrogram image');

  // 8. Arrangement edits.
  await call('apply_edits', { project: 'song.mmp', output: 'arranged.mmp', edits: [
    { op: 'add_track', args: { track: { name: 'Hat', voice: 'hat', volume: 30, patterns: [{ name: 'Hats', bar: 0, bars: 2, steps: { grid: 'x-o-', swing: 0.2 } }] } } },
    { op: 'add_pattern', args: { trackName: 'Lead', pattern: { name: 'Answer', bar: 4, bars: 2, melody: { line: 'A5:8 G5:8 F5:16' } } } },
    { op: 'copy_bars', args: { fromBar: 0, bars: 2, toBar: 2, tracks: ['Hat'] } },
    { op: 'set_song_length', args: { bars: 12 } },
    { op: 'remove_track', args: { trackName: 'Snare' } },
    { op: 'route_mixer_bus', args: { bus: 'Drums', tracks: ['Kick', 'Hat'], gain: 0.9 } },
    { op: 'set_bus', args: { bus: 'Drums', gain: 0.8 } },
  ] });
  const arranged = await call('inspect_arrangement', { project: 'arranged.mmp' });
  assert.equal(arranged.lengthBars, 12);
  assert.ok(!arranged.tracks.some(t => t.name === 'Snare'));
  assert.equal(arranged.tracks.find(t => t.name === 'Hat').clips.length, 2);
  assert.equal(arranged.mixer.find(bus => bus.name === 'Drums').gain, 0.8);
  assert.equal(arranged.tracks.at(-1).role, 'length pin');
  await call('apply_edits', { project: 'arranged.mmp', output: 'roles.mmp', edits: [
    { op: 'set_track_role', args: { trackName: 'Lead', role: 'lead' } },
    { op: 'add_track', args: { track: { name: 'Shaker', voice: 'hat', role: 'drums', volume: 20, patterns: [{ name: 'S', bar: 0, bars: 1, steps: { grid: 'x-x-' } }] } } },
  ] });
  const roles = Object.fromEntries((await call('inspect_arrangement', { project: 'roles.mmp' })).tracks.map(t => [t.name, t.role]));
  assert.equal(roles.Lead, 'lead');
  assert.equal(roles.Shaker, 'drums');
  assert.ok(Array.isArray((await call('get_started')).moduleGuidance));
  step('add_track, add_pattern, copy_bars, remove_track, set_song_length and mixer edits');

  // 9. Game export: intro, loop, layers that sum to the mix, a stinger and a manifest.
  await call('create_project', { output: 'layers.mmp', bpm: 120, tracks: song.presets ? [
    { name: 'Kick', voice: 'kick', volume: 70, patterns: [{ name: 'Beat', bar: 0, bars: 6, steps: { grid: 'X---x---X-x-x---' } }] },
    { name: 'Bass', voice: 'bass', volume: 110, patterns: [{ name: 'Line', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C', style: 'bass' } }] },
    { name: 'Keys', voice: 'pad', volume: 45, patterns: [{ name: 'Chords', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C' } }] },
    { name: 'Lead', voice: 'pluck', volume: 50, patterns: [{ name: 'Tune', bar: 2, bars: 4, melody: { line: 'D5:3 F5:3 A5:6 G5:2 F5:2' } }] },
  ] : [] });
  await call('edit_effect', { project: 'layers.mmp', output: 'layers-fx.mmp', trackName: 'Lead', operation: 'add', plugin: 'delay', wet: 0.3, params: { time: '1/4', feedback: 0.4 } });
  const game = await call('export_game_audio', { project: 'layers-fx.mmp', outputDirectory: 'game', name: 'theme', introBars: 2, targetLufs: -18,
    layers: [{ name: 'rhythm', tracks: ['Kick', 'Bass'] }, { name: 'harmony', tracks: ['Keys'] }, { name: 'melody', tracks: ['Lead'] }],
    stingers: [{ name: 'win', startBar: 2, bars: 1 }] });
  const manifest = JSON.parse(await readFile(path.join(workspace, 'game', 'theme.manifest.json'), 'utf8'));
  assert.equal(manifest.loop.endFrame, 4 * 96000);
  assert.equal(manifest.intro.frames, 2 * 96000);
  assert.deepEqual(manifest.files.map(file => file.role), ['loop', 'intro', 'layer', 'layer', 'layer', 'stinger']);
  assert.ok(manifest.layersSumResidualDb < -40, `layers sum to the mix (residual ${manifest.layersSumResidualDb} dB)`);
  assert.ok(manifest.files.every(file => file.clippedSamples === 0 && /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.ok(manifest.files.every(file => existsSync(path.join(workspace, 'game', file.file))));
  assert.equal(game.manifest, 'theme.manifest.json');
  const single = await call('export_game_audio', { project: 'layers-fx.mmp', outputDirectory: 'game-single', name: 'theme', targetLufs: -16 });
  near(single.files[0].integratedLufs, -16, 0.6, 'single-file game export loudness');
  if ((await call('list_instruments')).oggOutput) {
    const ogg = await call('export_game_audio', { project: 'layers-fx.mmp', outputDirectory: 'game-ogg', name: 'theme', ogg: true });
    assert.ok(existsSync(path.join(workspace, 'game-ogg', ogg.files[0].ogg)));
    step('OGG files written');
  }
  step('export_game_audio writes loop, intro, layers, stinger and manifest');

  // 10. Sound discovery in V3 strict copyright mode.
  const drums = await call('list_samples', { group: 'drums', query: 'snare' });
  assert.equal(drums.strictMode, true);
  assert.equal(drums.total, 0);
  assert.deepEqual(drums.samples, []);
  const drumKits = await call('list_drum_kits', {});
  for (const kitName of ['tight-synth', 'house-synth', 'electro-synth', '808-synth', 'acoustic-cc0']) {
    assert.ok(drumKits.kits[kitName], `missing drum kit ${kitName}`);
  }
  const loopAudit = await call('audit_copyright', { audio: 'game/theme-loop.wav' });
  assert.equal(loopAudit.compliant, true);
  const built = await call('build_sound_catalogue', { limit: 3, refresh: true });
  assert.deepEqual(built.failed, [], `Sound catalogue preset failures: ${JSON.stringify(built.failed)}`);
  assert.equal(built.measured, 3);
  const basses = await call('search_sounds', { role: 'bass', engine: 'lmms' });
  assert.ok(basses.total > 5 && basses.sounds.every(sound => sound.role === 'bass'));
  assert.ok((await call('search_sounds', { query: 'pad', engine: 'zyn' })).total > 20);
  assert.equal((await call('search_sounds', { query: 'bright bell' })).sounds.some(sound => sound.engine === 'fathom'), Boolean(process.env.LMMS_FATHOM_WORKLET));
  const chords = await call('resolve_chords', { progression: 'Dm7 G7 Cmaj7' });
  assert.deepEqual(chords.chords[0].names.slice().sort(), ['A4', 'C5', 'D4', 'F4'].sort());
  assert.ok(Object.keys(await call('list_effects')).includes('reverb'));
  step('strict sample blocking, synth/CC0 drum kits, catalogue, role search and chord resolution');
  console.log('All game-audio checks passed.');
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
