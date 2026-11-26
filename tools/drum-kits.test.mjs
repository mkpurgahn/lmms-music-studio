import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import midiPackage from '@tonejs/midi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decodeWav, db, truePeak } from '../audio.mjs';

test('clean drum tools produce WAV, map GM keys and preserve provenance through the MCP surface', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-drum-test-'));
  const client = new Client({ name: 'drum-kit-test', version: '0.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
      env: { ...process.env, LMMS_WORKSPACE: workspace },
    }));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'fetch_kit' && tool.inputSchema.properties.kit));
    const rejected = await client.callTool({ name: 'fetch_kit', arguments: { kit: 'unverified-free-kit' } });
    assert.ok(rejected.isError);
    const strictBlockedFetch = await client.callTool({ name: 'fetch_kit', arguments: {} });
    assert.ok(strictBlockedFetch.isError);
    assert.match(strictBlockedFetch.content[0].text, /strict copyright mode/i);
    const roles = ['kick','snare','clap','closedHat','openHat','rim','tom','crash','ride','sub808','hardstyle'];
    const hits = roles.map(role => ({ role, midi: 36, click: .65, drive: .8, decayMs: 120, seed: 17 }));
    const result = await call('synth_drums', { outputDirectory: 'drums', hits });
    const again = await call('synth_drums', { outputDirectory: 'again', hits });
    const manifest = JSON.parse(await readFile(path.join(workspace, result.manifest)));
    assert.equal(manifest.files.length, roles.length);
    assert.equal(new Set(manifest.files.map(entry => entry.sha256)).size, roles.length);
    for (const [i, entry] of manifest.files.entries()) {
      const bytes = await readFile(path.join(workspace, entry.file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      const prov = JSON.parse(await readFile(path.join(workspace, entry.file + '.provenance.json'), 'utf8'));
      assert.equal(prov.sha256, entry.sha256);
      assert.equal(prov.classification, 'pure-synthesis');
      assert.equal(entry.sha256, again.files[i].sha256);
      assert.equal(entry.licence, 'MIT');
      const audio = decodeWav(bytes);
      assert.equal(audio.sampleRate, 48000);
      assert.equal(audio.frames, 5760);
      assert.ok(db(truePeak(audio)) <= -1 && db(truePeak(audio)) > -20);
    }
    const record = await call('show_generation', { id: result.generationIds[0] });
    assert.equal(record.publishable, true);
    const { file: kick } = result.files[0];
    const { file: snare } = result.files[1];
    const mapped = await call('build_kit', { output: 'kit.mmp', samples: [{ file: kick, role: 'kick' }, { file: snare, role: 'snare' }] });
    assert.equal(mapped.preset, undefined);
    const mmp = await readFile(path.join(workspace, mapped.project), 'utf8');
    assert.match(mmp, /basenote="24"/);
    assert.match(mmp, /key="26"[^>]*pos="48"/);
    const kitProv = JSON.parse(await readFile(path.join(workspace, mapped.project + '.provenance.json'), 'utf8'));
    assert.equal(kitProv.strictCompliant, true);
    assert.equal(kitProv.classification, 'pure-synthesis');
    const mid = new midiPackage.Midi(await readFile(path.join(workspace, mapped.midi)));
    assert.equal(mid.tracks[0].channel, 9);
    assert.deepEqual(mid.tracks[0].notes.map(note => note.midi), [36, 38]);
    const layers = await call('layer_drum', { output: 'layer.wav', layers: [
      { file: kick, gainDb: 12 }, { file: snare, offsetMs: 80, gainDb: 12 },
    ] });
    assert.equal(decodeWav(await readFile(path.join(workspace, layers.file))).frames, 9600);
    assert.ok(layers.truePeakDb <= -1);
    const tuned = await call('tune_drum', { input: kick, output: 'tuned.wav', fromMidi: 36, toMidi: 48 });
    assert.equal(decodeWav(await readFile(path.join(workspace, tuned.file))).frames, 2880);
    assert.ok(tuned.truePeakDb <= -1);
    await writeFile(path.join(workspace, 'existing.wav'), 'unchanged');
    const blocked = await client.callTool({ name: 'tune_drum', arguments: { input: kick, output: 'existing.wav', fromMidi: 36, toMidi: 48 } });
    assert.ok(blocked.isError);
    assert.equal(await readFile(path.join(workspace, 'existing.wav'), 'utf8'), 'unchanged');
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
