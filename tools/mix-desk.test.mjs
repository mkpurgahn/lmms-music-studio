import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { encodeWav } from '../audio.mjs';
import { resolveRequest, startServer } from '../library-server.mjs';
import { browserHtml } from './library-browser.mjs';
import { createSession, nextBar, normalizeSession, samplePath } from './mix-desk/state.mjs';
import { ampCurve, detectPitch, decodeMidi, latencyProbe, measureProbeOffset, shiftRecorded } from './mix-desk/live.mjs';
import { createDeskDsp } from './mix-desk/processor.mjs';

test('desk session keeps eight channels and round-trips complete rack and master settings', () => {
  const session = createSession();
  session.channels[3].source = { type: 'sample', url: '/_lib/loop.wav', name: 'Loop' };
  session.channels[3].inserts = [{ type: 'eq', eq: [25, 1, 3, 0, 8000], wet: 0.3, amount: 0.5, bypass: false }];
  session.channels[3].reverse = true;
  session.master.width = 1.4;
  session.channels[3].input = 2;
  session.channels[3].inputGain = 2.5;
  session.io.latencyMs = 36.4;
  session.midi = [{type:'cc',channel:1,number:21,control:'channels/2'}];
  assert.deepEqual(normalizeSession(JSON.parse(JSON.stringify(session))), session);
  assert.equal(nextBar(1.99, 0, 120), 2);
  assert.throws(() => normalizeSession({ ...session, channels: [] }), /eight-channel/);
  assert.equal(samplePath('/folder/../sample.wav'), null);
});

test('local DSP chain handles finite stereo input and applies the output ceiling', () => {
  const left = Float32Array.from({ length: 256 }, (_, i) => 3 * Math.sin(i * 0.31));
  const right = left.map(x => x * -0.4);
  left[0] = NaN;
  const out = [new Float32Array(256), new Float32Array(256)];
  createDeskDsp('bitcrush', { amount: 0.7 })(left, right, ...out);
  createDeskDsp('gate', { amount: 0.4 })(...out, ...out);
  createDeskDsp('width', { width: 1.8, ceiling: -3 })(...out, ...out);
  assert.ok(out.every(channel => channel.every(v => Number.isFinite(v) && Math.abs(v) <= 0.708)));
  assert.ok(out[0].some(v => Math.abs(v) > 0.1));
});

test('the built library HTML offers a desk link for playable rows', () => {
  const html = browserHtml({ title: 'Fixture', items: [{ u: 'file:///sample.wav', w: '/sample.wav', n: 'Loop' }], generated: '2026-11-15' });
  assert.match(html, /Add to desk/);
  assert.match(html, /\/mix-desk\/\?sample=/);
});

test('loopback server protects mounted roots and persists sessions, tagged takes and mixes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mix-desk-workspace-'));
  const external = await mkdtemp(path.join(tmpdir(), 'mix-desk-other-'));
  const folders = { workspace: root, stock: root, library: null };
  const server = startServer({ port: 0, folders });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(url + route, options);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(resolveRequest('/%2e%2e/outside.wav', folders), null);
    assert.equal((await request('/%2e%2e%2foutside.wav')).status, 404);
    await writeFile(path.join(external, 'other.wav'), Buffer.from('other'));
    try {
      await symlink(path.join(external, 'other.wav'), path.join(root, 'redirect.wav'), 'file');
      assert.equal((await request('/redirect.wav')).status, 404);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
    assert.equal((await request('/mix-desk')).status, 200);
    const session = createSession();
    const sessionPost = { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(session) };
    assert.equal((await request('/api/mix-desk/session?name=outside%2Fname', sessionPost)).status, 400);
    assert.equal((await request('/api/mix-desk/session?name=test', { ...sessionPost, headers: { ...sessionPost.headers, origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await request('/api/mix-desk/session?name=test', sessionPost)).status, 201);
    assert.deepEqual(await (await request('/api/mix-desk/session?name=test')).json(), session);
    assert.equal((await request('/api/mix-desk/session?name=test', sessionPost)).status, 409);
    const samples = Float32Array.from({ length: 1200 }, (_, i) => 0.3 * Math.sin(i * 0.32));
    const wav = encodeWav({ sampleRate: 24000, channels: [samples, samples] });
    for (const kind of ['take', 'mix']) {
      const response = await request(`/api/mix-desk/take?name=${kind}-one&kind=${kind}&tags=glow,loop`, {
        method: 'POST', headers: { 'content-type': 'audio/wav', origin: url }, body: wav,
      });
      assert.equal(response.status, 201);
      const meta = JSON.parse(await readFile(path.join(root, `${kind}-one.meta.json`), 'utf8'));
      assert.deepEqual([meta.format, meta.kind, meta.licence, meta.tags], ['lmms-mcp-meta/1', kind, 'own-recording', ['glow', 'loop']]);
      if (kind === 'take') {
        const prov = JSON.parse(await readFile(path.join(root, 'take-one.wav.provenance.json'), 'utf8'));
        assert.equal(prov.schema, 'lmms-music-studio/provenance');
        assert.equal(prov.classification, 'user-attested-mic-take');
        assert.equal(prov.strictCompliant, true);
      }
    }
    const { rows } = await (await request('/api/mix-desk/library')).json();
    assert.ok(rows.some(row => row.url === '/take-one.wav' && row.tags.includes('glow')));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('live tuner recognises three sine tones and ignores silence', () => {
  const rate = 48000;
  for (const [expected, note] of [[110,'A2'],[220,'A3'],[440,'A4']]) {
    const signal = Float32Array.from({length:2048},(_,i)=>.35*Math.sin(2*Math.PI*i*expected/rate));
    const pitch=detectPitch(signal,rate);
    assert.equal(pitch.note,note);
    assert.ok(Math.abs(pitch.hz-expected)<1);
  }
  assert.equal(detectPitch(new Float32Array(1024),rate),null);
});

test('amplifier curves stay finite and preserve full scale across all voicings', () => {
  const keys=['amp-clean','amp-crunch','amp-lead'];
  for(const key of keys) for(const amount of [0,.5,1]) {
    const values = ampCurve(key,amount);
    assert.equal(values[0],-1);
    assert.equal(values.at(-1),1);
    assert.ok(values.every(value=>Number.isFinite(value)&&Math.abs(value)<=1));
  }
  assert.notDeepEqual(ampCurve(keys[0],.5),ampCurve(keys[1],.5));
});

test('loopback timing and input compensation align a delayed capture', () => {
  const probe=latencyProbe(24000);
  const input=new Float32Array(probe.length+1500);
  input.set(probe,371);
  assert.equal(measureProbeOffset(probe,input),371);
  assert.deepEqual(shiftRecorded(input,371).slice(0,probe.length),probe);
  assert.equal(shiftRecorded(probe,-5).slice(0,5).every(value=>value===0),true);
  assert.equal(measureProbeOffset(probe,new Float32Array(input.length)),null);
  assert.deepEqual(decodeMidi([0xb3,22,127]),{type:'cc',channel:3,number:22,value:1});
  assert.deepEqual(decodeMidi([0x81,59,90]),{type:'note',channel:1,number:59,value:0});
});
