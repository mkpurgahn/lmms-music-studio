// End-to-end check of find_loop_points and prepare_loop through a real stdio connection and the installed LMMS.
// Run: node verify-loop-prep.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decodeWav, encodeWav } from './audio.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance, writeProvenanceSidecar } from './tools/provenance.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.LMMS_FFMPEG ?? 'ffmpeg';
const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-loop-prep-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-loop-prep-check', version: '1' });
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
const hasFfmpeg = await run(ffmpeg, ['-version'], { windowsHide: true }).then(() => true, () => false);

try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['find_loop_points', 'prepare_loop']) assert.ok(tools.includes(name), name);
  const started = await call('get_started');
  assert.ok(JSON.stringify(started).includes('find_loop_points'), 'get_started carries the module guidance');
  step('tools listed and guidance in get_started');

  // A two-bar intro, a four-bar section played twice, and a one-bar ending, rendered with its tail.
  const bpm = 125, barSeconds = 240 / bpm, sectionSeconds = 4 * barSeconds;
  await call('create_project', { output: 'song.mmp', bpm, lengthBars: 11, tracks: [
    { name: 'Kick', voice: 'sf2', soundfont: 'virtuosity-drums.sf2', bank: 128, patch: 0, role: 'drums', volume: 85, patterns: [{ name: 'Beat', bar: 2, bars: 4, steps: { grid: 'X---x---X-x-x---', midi: 36 } }] },
    { name: 'Snare', voice: 'sf2', soundfont: 'virtuosity-drums.sf2', bank: 128, patch: 0, role: 'drums', volume: 75, patterns: [{ name: 'Beat', bar: 2, bars: 4, steps: { grid: '----X-------X--g', midi: 38 } }] },
    { name: 'Bass', voice: 'bass', volume: 80, patterns: [{ name: 'Line', bar: 2, bars: 4, chords: { progression: 'C G Am F', style: 'bass', figure: 'octaves' } }] },
    { name: 'Keys', voice: 'pad', volume: 45, patterns: [
      { name: 'Intro', bar: 0, bars: 2, chords: { progression: 'Dm Em' } },
      { name: 'Chords', bar: 2, bars: 4, chords: { progression: 'C G Am F' } },
      { name: 'End', bar: 10, bars: 1, chords: { progression: 'C' } }] },
    { name: 'Lead', voice: 'pluck', volume: 50, patterns: [
      { name: 'Intro', bar: 0, bars: 2, melody: { line: 'A4:4 C5:4 D5:8 | E5:4 D5:4 C5:8' } },
      { name: 'Tune', bar: 2, bars: 4, melody: { line: 'E5:3 G5:3 C6:6 B5:2 G5:2 | D5:3 G5:3 B5:6 A5:4 | C5:3 E5:3 A5:6 G5:2 E5:2 | F5:4 A5:4 C6:8' } }] },
  ] });
  await call('copy_bars', { project: 'song.mmp', output: 'twice.mmp', fromBar: 2, bars: 4, toBar: 6 });
  const rendered = await call('render_mix', { project: 'twice.mmp', output: 'twice.wav', tail: 'keep' });
  near(rendered.durationSeconds, 12 * barSeconds, 0.05, 'render length');
  step(`rendered ${rendered.durationSeconds} s: intro, section twice, ending and tail`);

  // 1. Loop points from the WAV.
  const found = await call('find_loop_points', { audio: 'twice.wav' });
  console.log('  tempo', JSON.stringify(found.tempo), 'best', JSON.stringify(found.candidates[0]));
  near(found.tempo.bpm, bpm, 1, 'detected bpm');
  const best = found.candidates[0];
  assert.equal(best.bars, 4);
  near(best.lengthSeconds, sectionSeconds, 0.003, 'loop length');
  near(best.startSeconds, 2 * barSeconds, 0.05, 'loop start');
  assert.equal(best.intro, true);
  near(best.bpmFromLength, bpm, 0.05, 'bpm from loop length');
  assert.equal(found.needsHumanChoice, false, found.advice);
  step(`find_loop_points recovers the 4-bar section: ${best.lengthSeconds} s against ${sectionSeconds} s, seam score ${best.seamScore}`);

  // 2. Prepare the loop with an intro, a loudness target and OGG copies.
  const prepared = await call('prepare_loop', { audio: 'twice.wav', outputDirectory: 'game', name: 'level-1', targetLufs: -16, ogg: hasFfmpeg });
  const loopFile = prepared.files.find(f => f.role === 'loop'), introFile = prepared.files.find(f => f.role === 'intro');
  assert.ok(introFile, 'intro written');
  near(loopFile.frames / prepared.sampleRate, sectionSeconds, 0.003, 'loop file length');
  assert.equal(prepared.loop.endFrame, loopFile.frames);
  assert.equal(introFile.frames, prepared.loop.sourceStartFrame);
  assert.ok(prepared.measured.boundaryJumpDbfs === null || prepared.measured.boundaryJumpDbfs < -40, `boundary jump ${prepared.measured.boundaryJumpDbfs}`);
  near(prepared.measured.integratedLufs, -16, 0.5, 'loop loudness');
  assert.equal(prepared.seam.method, 'crossfade');
  assert.equal(prepared.seam.fadeInto, 'audio after the loop end', 'the intro differs from the section end, the second pass matches the first');
  assert.equal(prepared.seam.fadeShape, 'linear', 'a repeated section is alike on both sides of the fade');
  assert.equal(prepared.loop.seamless, true, JSON.stringify(prepared.loop.seamIssues));
  assert.equal(prepared.loop.seamScore, best.seamScore);
  for (const key of ['source', 'detectedBpm', 'bpmConfidence', 'bars']) assert.ok(prepared[key] !== undefined, key);
  assert.equal(prepared.source, 'twice.wav');
  const manifest = JSON.parse(await readFile(path.join(workspace, 'game', 'level-1.manifest.json'), 'utf8'));
  assert.equal(manifest.seam.score, best.seamScore);
  for (const file of manifest.files) {
    assert.equal(createHash('sha256').update(await readFile(path.join(workspace, 'game', file.file))).digest('hex'), file.sha256, file.file);
    if (hasFfmpeg) assert.ok(existsSync(path.join(workspace, 'game', file.ogg)), file.ogg);
  }
  const check = await call('analyze_audio', { audio: 'game/level-1-loop.wav', loop: true, targetLufs: -16 });
  near(check.integratedLufs, -16, 0.5, 'analyze_audio loudness');
  assert.ok(check.loop.boundaryJumpDbfs === null || check.loop.boundaryJumpDbfs < -40);
  assert.equal(check.sampleRate, 48000);
  // Intro then loop: the join is the source audio unchanged.
  const intro = decodeWav(await readFile(path.join(workspace, 'game', 'level-1-intro.wav')));
  const loop = decodeWav(await readFile(path.join(workspace, 'game', 'level-1-loop.wav')));
  const joinJump = Math.max(...intro.channels.map((ch, c) => Math.abs(ch[ch.length - 1] - loop.channels[c][0])));
  assert.ok(20 * Math.log10(joinJump || 1e-9) < -30, `intro-to-loop jump ${joinJump}`);
  step(`prepare_loop: ${loopFile.frames} frames, boundary jump ${prepared.measured.boundaryJumpDbfs} dBFS, ${prepared.measured.integratedLufs} LUFS, intro of ${introFile.durationSeconds} s, checksums match${hasFfmpeg ? ', OGG written' : ''}`);

  // 2b. Repeats that are not identical: the second pass of the keys is about 1.5 dB quieter, and the lead has a reverb,
  // so each pass carries a different tail from what came before it.
  await call('apply_edits', { project: 'twice.mmp', output: 'uneven.mmp', edits: [
    { op: 'automate_track', args: { trackName: 'Keys', name: 'First pass', control: 'volume', startTick: 2 * 192, length: 4 * 192, curve: 'step', points: [{ tick: 0, value: 45 }, { tick: 767, value: 45 }] } },
    { op: 'automate_track', args: { trackName: 'Keys', name: 'Second pass', control: 'volume', startTick: 6 * 192, length: 4 * 192, curve: 'step', points: [{ tick: 0, value: 38 }, { tick: 767, value: 38 }] } },
    { op: 'edit_effect', args: { trackName: 'Lead', operation: 'add', plugin: 'reverb', wet: 0.4, params: { size: 0.9 } } },
  ] });
  await call('render_mix', { project: 'uneven.mmp', output: 'uneven.wav', tail: 'keep' });
  const uneven = await call('find_loop_points', { audio: 'uneven.wav' });
  const unevenBest = uneven.candidates[0];
  console.log('  uneven best', JSON.stringify(unevenBest));
  assert.equal(unevenBest.bars, 4);
  near(unevenBest.lengthSeconds, sectionSeconds, 0.003, 'uneven loop length');
  near(unevenBest.startSeconds, 2 * barSeconds, 0.05, 'uneven loop start');
  assert.ok(unevenBest.seamScore < best.seamScore, 'inexact repeats score lower than identical ones');
  const unevenLoop = await call('prepare_loop', { audio: 'uneven.wav', outputDirectory: 'uneven', candidate: 1, targetLufs: -16 });
  assert.ok(unevenLoop.measured.boundaryJumpDbfs === null || unevenLoop.measured.boundaryJumpDbfs < -40, `uneven boundary jump ${unevenLoop.measured.boundaryJumpDbfs}`);
  step(`inexact repeats (quieter second pass, reverb tails): ${unevenBest.lengthSeconds} s from ${unevenBest.lengthFrom}, repeat correlation ${unevenBest.repeatCorrelation}, seam score ${unevenBest.seamScore}, fade ${unevenLoop.seam.fadeShape}, boundary jump ${unevenLoop.measured.boundaryJumpDbfs} dBFS`);

  // 3. Explicit times and fold: one pass of the section with its ring-out folded onto the start.
  await call('create_project', { output: 'once.mmp', bpm, lengthBars: 4, tracks: [
    { name: 'Keys', voice: 'pad', volume: 45, patterns: [{ name: 'Chords', bar: 0, bars: 4, chords: { progression: 'C G Am F' } }] },
    { name: 'Lead', voice: 'pluck', volume: 50, patterns: [{ name: 'Tune', bar: 0, bars: 4, melody: { line: 'E5:3 G5:3 C6:6 B5:2 G5:2 | D5:3 G5:3 B5:6 A5:4 | C5:3 E5:3 A5:6 G5:2 E5:2 | F5:4 A5:4 C6:8' } }] },
  ] });
  await call('render_mix', { project: 'once.mmp', output: 'once.wav', tail: 'keep' });
  const folded = await call('prepare_loop', { audio: 'once.wav', outputDirectory: 'folded', startSeconds: 0, endSeconds: sectionSeconds, seam: 'fold', bpm });
  assert.equal(folded.seam.method, 'fold');
  near(folded.loop.endFrame / 48000, sectionSeconds, 0.005, 'folded loop length');
  assert.ok(!folded.files.some(f => f.role === 'intro'));
  assert.match(folded.bpmSource, /^hint/);
  console.log('  fold boundary jump', folded.measured.boundaryJumpDbfs);
  assert.ok(folded.measured.boundaryJumpDbfs === null || folded.measured.boundaryJumpDbfs < -30, `fold boundary jump ${folded.measured.boundaryJumpDbfs}`);
  step(`fold seam with explicit times: boundary jump ${folded.measured.boundaryJumpDbfs} dBFS`);
  // The whole file as the loop leaves nothing to fade with: a plain cut, and the manifest says it is not seamless.
  const whole = await call('prepare_loop', { audio: 'once.wav', outputDirectory: 'whole', startSeconds: 0, endSeconds: 600 });
  assert.equal(whole.seam.method, 'cut');
  assert.equal(whole.loop.seamless, false);
  assert.ok(whole.loop.seamIssues.some(issue => /plain cut/.test(issue)), JSON.stringify(whole.loop.seamIssues));
  const wholeManifest = JSON.parse(await readFile(path.join(workspace, 'whole', 'once.manifest.json'), 'utf8'));
  assert.equal(wholeManifest.loop.seamless, false);
  step('a plain cut is reported as not seamless, in the result and the manifest');

  // 4. Other sample rates and formats through ffmpeg.
  if (hasFfmpeg) {
    await run(ffmpeg, ['-v', 'error', '-i', path.join(workspace, 'twice.wav'), '-ar', '44100', path.join(workspace, 'twice-44k.wav')], { windowsHide: true });
    const at44 = await call('find_loop_points', { audio: 'twice-44k.wav' });
    assert.equal(at44.sampleRate, 44100);
    near(at44.candidates[0].lengthSeconds, sectionSeconds, 0.003, '44.1 kHz loop length');
    await run(ffmpeg, ['-v', 'error', '-i', path.join(workspace, 'twice.wav'), '-c:a', 'libmp3lame', '-b:a', '192k', path.join(workspace, 'twice.mp3')], { windowsHide: true });
    const fromMp3 = await call('find_loop_points', { audio: 'twice.mp3' });
    assert.equal(fromMp3.decoder, 'ffmpeg');
    near(fromMp3.candidates[0].lengthSeconds, sectionSeconds, 0.003, 'MP3 loop length');
    await fails('prepare_loop', { audio: 'twice.mp3', outputDirectory: 'blocked-mp3', targetLufs: -18 }, /provenance/i);
    assert.ok(!existsSync(path.join(workspace, 'blocked-mp3')));
    const twiceCheck = await verifyAudioFileProvenance(path.join(workspace, 'twice.wav'), { workspaceDir: workspace });
    await writeDerivedAudioProvenance(path.join(workspace, 'twice.mp3'), [twiceCheck], {
      workspaceDir: workspace,
      generatorTool: 'ffmpeg-transcode',
    });
    const mp3Loop = await call('prepare_loop', { audio: 'twice.mp3', outputDirectory: 'from-mp3', targetLufs: -18 });
    assert.equal(mp3Loop.name, 'twice');
    near(mp3Loop.measured.integratedLufs, -18, 0.5, 'MP3 loop loudness');
    assert.ok(mp3Loop.measured.boundaryJumpDbfs === null || mp3Loop.measured.boundaryJumpDbfs < -40, `MP3 boundary jump ${mp3Loop.measured.boundaryJumpDbfs}`);
    assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.decode-')), [], 'decode folders are removed');
    step(`44.1 kHz WAV and MP3 sources: loop lengths ${at44.candidates[0].lengthSeconds} s and ${fromMp3.candidates[0].lengthSeconds} s, MP3 loop boundary jump ${mp3Loop.measured.boundaryJumpDbfs} dBFS`);
  } else step('ffmpeg not found: skipped the 44.1 kHz and MP3 checks');

  // 5. Honesty and safety: un-provenanced WAVs are blocked, no beat means a person picks, and nothing is overwritten.
  let state = 1;
  const hiss = Float32Array.from({ length: 48000 * 10 }, () => { state = (state * 1664525 + 1013904223) >>> 0; return 0.1 * (state / 2 ** 31 - 1); });
  await writeFile(path.join(workspace, 'hiss.wav'), encodeWav({ sampleRate: 48000, channels: [hiss] }));
  await fails('prepare_loop', { audio: 'hiss.wav', outputDirectory: 'hiss-unprovenanced' }, /provenance/i);
  assert.ok(!existsSync(path.join(workspace, 'hiss-unprovenanced')));
  await writeProvenanceSidecar(path.join(workspace, 'hiss.wav'), {
    workspaceDir: workspace,
    classification: 'pure-synthesis',
    generatorTool: 'verify-loop-prep-prng',
    sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'lcg-noise-generator', licence: 'unrestricted-synthesis' }],
  });
  const unsure = await call('find_loop_points', { audio: 'hiss.wav' });
  assert.equal(unsure.needsHumanChoice, true);
  await fails('prepare_loop', { audio: 'hiss.wav', outputDirectory: 'hiss-out' }, /person should listen and pick.*Nothing was written/s);
  assert.ok(!existsSync(path.join(workspace, 'hiss-out')));
  const forced = await call('prepare_loop', { audio: 'hiss.wav', outputDirectory: 'hiss-forced', acceptLowConfidence: true });
  assert.equal(forced.loop.seamless, false);
  assert.ok(forced.loop.seamIssues.some(issue => /acceptLowConfidence/.test(issue)), JSON.stringify(forced.loop.seamIssues));
  await fails('find_loop_points', { audio: 'missing.wav' }, /File not found: missing\.wav/);
  await fails('prepare_loop', { audio: 'twice.wav', outputDirectory: 'game' }, /already exists/);
  await fails('find_loop_points', { audio: '../outside.wav' }, /Invalid|match/i);
  step('provenance gate enforced, low confidence refuses to guess, existing output is kept, paths stay in the workspace');
  console.log('All loop-prep checks passed. Audio was checked by measurement, not by ear.');
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
