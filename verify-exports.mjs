import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import midiPackage from '@tonejs/midi';

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-export-check-'));
console.log(workspace);
const fixture = process.argv[2];
if (fixture) await copyFile(fixture, path.join(workspace, 'source.mmp'));
const client = new Client({ name: 'lmms-export-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_NO_GUI_LAUNCH: '1' },
}));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 200000 });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  if (!fixture) {
    const notes = [0, 48, 96, 144].map((tick, i) => ({ tick, length: 24, midi: 60 + i, velocity: 75 }));
    await call('create_project', { output: 'source.mmp', bpm: 120, tracks: [
      { name: 'Lead', voice: 'pluck', volume: 45, patterns: [{ name: 'Hook', bar: 0, bars: 1, notes }] },
      { name: 'Bass', voice: 'bass', volume: 45, patterns: [{ name: 'Root', bar: 0, bars: 1, notes: notes.map(n => ({ ...n, midi: 36 })) }] },
    ] });
  }
  const source = await call('inspect_arrangement', { project: 'source.mmp' });
  assert.match(client.getInstructions(), /get_started/);
  const start = await call('get_started', {});
  const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
  assert.ok(Object.values(start.workflows).flat().every(name => tools.has(name)));
  const trackName = source.tracks[0].name;
  await call('render_mix', { project: 'source.mmp', output: 'reference.wav' });
  const editSample = (project, output, operation, tick, extra = {}) =>
    call('edit_sample_clip', { project, output, trackName: 'Audio fixture', operation, tick, ...extra });
  await editSample('source.mmp', 'placed.mmp', 'place', 192, { length: 192, file: 'reference.wav' });
  await editSample('placed.mmp', 'moved.mmpz', 'move', 192, { destinationTick: 384 });
  await editSample('moved.mmpz', 'duplicated.mmp', 'duplicate', 384, { destinationTick: 192 });
  await editSample('duplicated.mmp', 'muted.mmp', 'mute', 384, { muted: true });
  await editSample('muted.mmp', 'resized.mmp', 'resize', 192, { length: 96 });
  await editSample('resized.mmp', 'relinked.mmp', 'relink', 192, { file: 'reference.wav' });
  const changed = await call('inspect_arrangement', { project: 'relinked.mmp' });
  const audio = changed.tracks.find(track => track.name === 'Audio fixture').clips;
  assert.deepEqual(audio.map(clip => [clip.tick, clip.length, clip.muted]), [[384, 192, true], [192, 96, false]]);
  assert.ok(audio.every(clip => clip.source.endsWith('/reference.wav')));
  await editSample('relinked.mmp', 'removed.mmp', 'remove', 384);
  const removed = await call('inspect_arrangement', { project: 'removed.mmp' });
  assert.equal(removed.tracks.find(track => track.name === 'Audio fixture').clips.length, 1);
  const sampleMix = await call('render_mix', { project: 'placed.mmp', output: 'sample-mix.wav' });
  assert.ok(sampleMix.durationSeconds >= 4 && Number.isFinite(sampleMix.peakDbfs));
  const inventory = await call('list_instruments', {});
  const darkArps = await call('search_sounds', { query: 'dark arp', engine: 'fathom' });
  assert.equal(darkArps.sounds[0].patchId, 'fuse-pluck');
  assert.equal((await call('search_sounds', { query: 'no matching patch' })).total, 0);
  const nativeSounds = await call('search_sounds', { query: 'analogbell', engine: 'lmms' });
  if (nativeSounds.sounds.length) {
    const preview = await call('preview_sound', { preset: nativeSounds.sounds[0].preset, output: 'native-preview.wav' });
    assert.equal(preview.durationSeconds, 2);
    assert.ok(Number.isFinite(preview.peakDbfs));
    console.log(preview);
  }
  if (process.env.LMMS_FATHOM_WORKLET) {
    const catalogue = await call('search_sounds', { engine: 'fathom' });
    for (const { patchId } of catalogue.sounds) {
      const preview = await call('preview_sound', { patchId, output: patchId + '.wav' });
      assert.equal(preview.durationSeconds, 2);
      assert.ok(Number.isFinite(preview.peakDbfs) && preview.peakDbfs < 0);
      console.log(preview);
    }
    const catalogueRender = await call('render_fathom_track', {
      project: 'source.mmp', trackName, patchId: darkArps.sounds[0].patchId, bars: 1,
      cutoff: [{ tick: 0, hz: 340 }, { tick: 180, hz: 4200 }], output: 'catalogue.mmp', audio: 'catalogue.wav',
    });
    assert.ok(catalogueRender.notes > 0);
  }
  if (inventory.nativePlugins.some(plugin => plugin.id === 'lb302')) {
    await call('set_native_instrument', { project: 'source.mmp', output: 'acid.mmp', trackName, instrument: 'lb302' });
    const acid = await call('inspect_arrangement', { project: 'acid.mmp' });
    assert.equal(acid.tracks[0].instrument, 'lb302');
    assert.deepEqual(
      await call('read_pattern', { project: 'acid.mmp', trackName, bar: 0 }),
      await call('read_pattern', { project: 'source.mmp', trackName, bar: 0 }),
    );
    const sound = await call('render_mix', { project: 'acid.mmp', output: 'acid.wav' });
    assert.ok(sound.peakDbfs < 0);
  }
  if (process.env.LMMS_FATHOM_WORKLET && process.env.LMMS_FATHOM_TEST_PATCH) {
    await copyFile(process.env.LMMS_FATHOM_TEST_PATCH, path.join(workspace, 'fathom.json'));
    const args = { project: 'source.mmp', trackName, patchFile: 'fathom.json', bars: 1 };
    const dark = await call('render_fathom_track', { ...args, output: 'dark.mmp', audio: 'dark.wav',
      cutoff: [{ tick: 0, hz: 220 }] });
    const sweep = await call('render_fathom_track', { ...args, project: dark.project, output: 'sweep.mmp', audio: 'sweep.wav',
      cutoff: [{ tick: 0, hz: 220 }, { tick: 180, hz: 4800 }] });
    assert.equal(sweep.notes, dark.notes);
    assert.equal(sweep.durationSeconds, dark.durationSeconds);
    assert.ok(!((await readFile(path.join(workspace, dark.audio))).equals(await readFile(path.join(workspace, sweep.audio)))));
    const rendered = await call('inspect_project', { project: sweep.project });
    assert.equal(rendered.filter(track => track.name.endsWith(' [Fathom audio]')).length, 1);
  }
  const clip = { trackName, tick: 0 };
  await call('edit_clip', { project: 'source.mmp', output: 'duplicate.mmp', ...clip, operation: 'duplicate', destinationTick: 3072 });
  await call('edit_clip', { project: 'duplicate.mmp', output: 'moved.mmp', trackName, tick: 3072, operation: 'move', destinationTick: 3264 });
  await call('edit_clip', { project: 'moved.mmp', output: 'renamed.mmp', trackName, tick: 3264, operation: 'rename', name: 'Renamed' });
  const edited = await call('inspect_arrangement', { project: 'renamed.mmp' });
  assert.ok(edited.tracks[0].clips.some(c => c.name === 'Renamed' && c.tick === 3264));
  await call('edit_clip', { project: 'renamed.mmp', output: 'trimmed.mmp', trackName, tick: 3264, operation: 'remove' });
  assert.deepEqual(await call('inspect_arrangement', { project: 'trimmed.mmp' }), source);
  await call('edit_effect', { project: 'trimmed.mmp', output: 'effect.mmp', trackName, operation: 'add', plugin: 'delay', wet: .25 });
  await call('edit_effect', { project: 'effect.mmp', output: 'bypass.mmp', trackName, operation: 'update', index: 0, enabled: false });
  assert.deepEqual(await call('inspect_effects', { project: 'bypass.mmp', trackName }),
    [{ index: 0, plugin: 'delay', enabled: false, wet: .25, params: { time: '1/8d', feedback: .35, outputGainDb: 0 } }]);
  await call('edit_effect', { project: 'bypass.mmp', output: 'no-effect.mmp', trackName, operation: 'remove', index: 0 });
  assert.deepEqual(await call('inspect_effects', { project: 'no-effect.mmp', trackName }), []);
  const result = await call('export_midi', { project: 'source.mmp', output: 'song.mid' });
  const midi = new midiPackage.Midi(await readFile(path.join(workspace, result.file)));
  assert.equal(midi.header.tempos[0].bpm, source.tempo);
  assert.deepEqual(midi.tracks.map(t => ({ name: t.name, notes: t.notes.length })), result.tracks);
  const notes = (await call('read_pattern', { project: 'source.mmp', trackName, bar: 0 })).notes;
  assert.deepEqual(midi.tracks[0].notes.slice(0, notes.length).map(n => ({ midi: n.midi, tick: n.ticks / (midi.header.ppq / 48) })), notes.map(n => ({ midi: n.midi, tick: n.tick })));
  const wet = await call('render_mix', { project: 'effect.mmp', output: 'effect.wav' });
  const dry = await call('render_mix', { project: 'bypass.mmp', output: 'dry.wav' });
  assert.equal(wet.durationSeconds, dry.durationSeconds);
  assert.notDeepEqual(await readFile(path.join(workspace, 'effect.wav')), await readFile(path.join(workspace, 'dry.wav')));
  const stems = await call('render_stems', { project: 'source.mmp', outputDirectory: 'stems' });
  assert.equal(stems.stems.length, result.tracks.length);
  assert.ok(stems.stems.every(stem => stem.durationSeconds === dry.durationSeconds && stem.peakDbfs !== null));
  console.log(JSON.stringify({ midi: result, wet, dry, stems }, null, 2));
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
