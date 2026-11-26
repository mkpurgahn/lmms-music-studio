import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { arrangementPlan } from './arrangement.mjs';
import { applyGroove } from './groove.mjs';
import { loadPersonas } from './personas.mjs';
import { rankCandidates } from './taste.mjs';
import { db, decodeWav, truePeak } from '../audio.mjs';

test('extended dance plan keeps contiguous phrases and the outro', () => {
  const plan = arrangementPlan('house', 128);
  assert.equal(plan.totalBars, 128);
  assert.equal(plan.sections.at(-1).name, 'outro');
  let bar = 0;
  for (const section of plan.sections) {
    assert.equal(section.startBar, bar);
    assert.equal(section.bars % 8, 0);
    bar += section.bars;
  }
  assert.equal(bar, 128);
});

test('clave accents 3:2 across two bars', () => {
  const notes = Array.from({ length: 32 }, (_, index) => ({ tick: index * 12, midi: 42, velocity: 80 }));
  const accented = applyGroove(notes, 'afro-clave');
  assert.deepEqual(accented.filter(note => note.velocity > 80).map(note => note.tick), [0, 72, 144, 240, 288]);
  assert.deepEqual(applyGroove(notes, 'afro-clave', 0), notes);
});

test('half-time moves the backbeat without shortening the timeline', () => {
  const notes = [0, 48, 144, 192, 240, 336].map(tick => ({ tick, midi: tick % 192 ? 38 : 36 }));
  assert.deepEqual(applyGroove(notes, 'half-time').map(note => note.tick), [0, 96, 144, 192, 288, 336]);
});

test('ranking with partial weights normalises only the metrics supplied', () => {
  const [candidate] = rankCandidates([{ tune: 72 }], { tune: 15 });
  assert.equal(candidate.tasteScore, 72);
  assert.equal(rankCandidates([{}], {})[0].tasteScore, 48);
});

test('all three DJ packs load through the runtime persona schema', () => {
  const knownPatterns = new Set(['rock', 'four', 'halftime', 'ballad', 'onedrop', 'rockers', 'steppers', 'dubstep', 'chip', 'swing', 'none']);
  const personas = loadPersonas().filter(persona => persona.kind === 'dj');
  assert.ok(personas.length >= 14);
  for (const { drums, id, tempo } of personas) {
    assert.ok(knownPatterns.has(drums.patterns), id);
    assert.ok(tempo.min <= tempo.default && tempo.default <= tempo.max, id);
  }
});

test('WAV tools and stock drum provenance work through MCP', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-grok-fixes-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const samples = path.join(workspace, 'samples');
  await mkdir(path.join(samples, 'drums'), { recursive: true });
  for (const sample of ['kick01', 'snare_electro01', 'hihat_closed01', 'clap01', 'bassdrum_acoustic01', 'snare_acoustic01', 'hihat_opened01']) {
    await writeFile(path.join(samples, 'drums', sample + '.ogg'), '');
  }

  const client = new Client({ name: 'grok-fixes-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_SAMPLES: samples },
  });
  await client.connect(transport);
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(result.isError), false, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  }
  try {
    await call('render_vocal_syllable', { output: 'a.wav', duration: 0.12 });
    await call('chop_vocal', { input: 'a.wav', output: 'chop.wav', chops: 3 });
    await call('fatten', { input: 'a.wav', output: 'fat.wav' });
    for (const name of ['a.wav', 'chop.wav', 'fat.wav']) {
      const audio = decodeWav(await readFile(path.join(workspace, name)));
      assert.ok(audio.frames > 0 && db(truePeak(audio)) <= -1);
    }
    for (const [name, args] of [
      ['render_vocal_syllable', { output: '../a.wav' }],
      ['chop_vocal', { input: '../a.wav', output: 'chop.wav' }],
      ['fatten', { input: '../a.wav', output: 'fat.wav' }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid|pattern/i);
    }
    const listing = await call('list_drum_kits');
    assert.equal(listing.kits.electronic.kick, 'drums/kick01.ogg');
    assert.equal(listing.kits.electronic.snare, 'drums/snare_electro01.ogg');
    assert.equal(listing.kits.acoustic.kick, 'drums/bassdrum_acoustic01.ogg');
    assert.equal(listing.kits.acoustic.hat, 'drums/hihat_opened01.ogg');
    for (const name of ['house', 'techno', 'trance', 'breaks']) {
      assert.equal(listing.kits[name].openhat, 'drums/hihat_opened01.ogg');
    }
    const kit = await call('create_drum_kit', { output: 'kit.mmp', kit: 'acoustic' });
    assert.equal(kit.publishable, false);
    assert.equal(kit.tracks.length, 4);
    const record = await call('show_generation', { id: kit.generationIds[0] });
    assert.equal(record.publishable, false);
    assert.deepEqual(record.sampleLibraries.map(item => item.id), ['lmms-factory-drums']);
  } finally {
    await client.close();
  }
});
