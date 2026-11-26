import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import * as dsp from '../audio.mjs';
import { validateMeta, mergeMeta, metaText, safeRelative, baseOf, sidecarFor, facetValues, filterEntries, wavSeconds, oggSeconds, audioSeconds,
  scanWorkspace, workspaceMeta, applyMeta, register } from './sound-meta.mjs';
import { register as registerLibrary } from './library-browser.mjs';
import { writeProvenanceSidecar } from './provenance.mjs';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'lmms-meta-'));
const tone = seconds => dsp.encodeWav({ sampleRate: 8000, channels: [Float32Array.from({ length: 8000 * seconds }, (_, i) => Math.sin(i / 5) * 0.3)] });
// A minimal Ogg Vorbis shape: an identification header on the first page and a granule position on the last.
function fakeOgg(rate, granule) {
  const head = Buffer.alloc(64); head.write('OggS', 0, 'latin1'); head.write('\x01vorbis', 28, 'latin1'); head.writeUInt32LE(0, 35); head.writeUInt8(2, 39); head.writeUInt32LE(rate, 40);
  const tail = Buffer.alloc(40); tail.write('OggS', 4, 'latin1'); tail.writeBigInt64LE(BigInt(granule), 10);
  return Buffer.concat([head, Buffer.alloc(100), tail]);
}
const fakeTool = () => { const tools = {}; return { tools, tool: (name, description, shape, handler) => { tools[name] = { schema: z.object(shape), handler }; } }; };
const call = async (t, name, args) => t.tools[name].handler(t.tools[name].schema.parse(args));

test('metadata is checked and tidied, and unknown fields are refused', () => {
  const { meta, errors } = validateMeta({ title: '  Gymnopédie   No. 1 ', composer: 'Erik Satie', era: 'Impressionist', genre: 'Classical Piano', mood: ['Calm', 'calm', 'melancholy'],
    gameUse: ['menu', 'Puzzle'], arrangement: 'shaped', durationSeconds: '201.456', loop: false, source: 'https://www.mutopiaproject.org/x', licence: 'public domain', credits: 'Typeset by Evin Robertson', date: '2026-11-15' });
  assert.deepEqual(errors, []);
  assert.equal(meta.title, 'Gymnopédie No. 1');
  assert.equal(meta.era, 'impressionist');
  assert.deepEqual(meta.genre, ['classical piano']);
  assert.deepEqual(meta.mood, ['calm', 'melancholy']);
  assert.deepEqual(meta.gameUse, ['menu', 'puzzle']);
  assert.equal(meta.durationSeconds, 201.46);
  assert.deepEqual(meta.credits, ['Typeset by Evin Robertson']);
  const bad = validateMeta({ era: 'jurassic', gameUse: ['lobby'], source: 'ftp://x', date: '15/11/2026', loop: 'yes', durationSeconds: -1, colour: 'blue', sourceNote: '../secret.md' });
  assert.equal(bad.errors.length, 8);
  assert.ok(bad.errors.some(e => e.includes('unknown field "colour"')));
  assert.ok(bad.errors.some(e => e.startsWith('era must be one of')));
  assert.deepEqual(validateMeta(null).errors, ['metadata must be an object']);
});

test('merging keeps old fields, replaces given ones and removes nulls', () => {
  const patch = validateMeta({ mood: ['dreamy'], notes: null }, { allowNull: true });
  assert.deepEqual(patch.errors, []);
  const merged = mergeMeta({ composer: 'Erik Satie', notes: 'old', mood: ['calm'] }, patch.meta);
  assert.deepEqual(merged, { composer: 'Erik Satie', mood: ['dreamy'] });
  assert.equal(validateMeta({ notes: null }).errors.length, 1, 'null is refused outside a merge');
  const text = metaText({ title: 'T', composer: 'C' });
  assert.deepEqual(JSON.parse(text), { format: 'lmms-mcp-meta/1', title: 'T', composer: 'C' });
  assert.ok(text.indexOf('"title"') < text.indexOf('"composer"'), 'fields are written in a fixed order');
});

test('paths stay inside the workspace and formats share one sidecar', () => {
  assert.equal(safeRelative('classics\\satie.mid'), 'classics/satie.mid');
  for (const bad of ['../x.wav', 'a/../../x.wav', '.hidden.wav', 'a/b/c/d.wav', 'C:/x.wav', '', 'a//b.wav']) assert.equal(safeRelative(bad), null, bad);
  assert.equal(baseOf('satie-gymnopedie-1.ogg'), 'satie-gymnopedie-1');
  assert.equal(baseOf('song.v2.mmpz'), 'song.v2');
  assert.equal(sidecarFor('classics/satie.mid'), 'classics/satie.meta.json');
  assert.equal(sidecarFor('a.wav'), sidecarFor('a.ogg'));
});

test('entries filter by part of a composer, any of a list, a choice, a flag and free text', () => {
  const entries = [
    { name: 'satie', meta: { composer: 'Erik Satie', era: 'impressionist', genre: ['classical piano'], gameUse: ['menu', 'puzzle'], arrangement: 'shaped', loop: false, licence: 'public domain' } },
    { name: 'satie-chip', meta: { composer: 'Erik Satie', genre: ['chiptune'], gameUse: ['hub'], arrangement: 'chiptune', loop: true } },
    { name: 'bach', meta: { composer: 'J. S. Bach', era: 'baroque', genre: ['orchestral'], arrangement: 'orchestral', licence: 'CC-BY 3.0' } },
    { name: 'untagged', meta: {} },
  ];
  const names = f => filterEntries(entries, f).map(e => e.name);
  assert.deepEqual(names({ composer: 'satie' }), ['satie', 'satie-chip']);
  assert.deepEqual(names({ genre: 'Classical Piano' }), ['satie']);
  assert.deepEqual(names({ gameUse: ['hub', 'puzzle'] }), ['satie', 'satie-chip']);
  assert.deepEqual(names({ arrangement: 'orchestral' }), ['bach']);
  assert.deepEqual(names({ loop: true }), ['satie-chip']);
  assert.deepEqual(names({ licence: 'cc-by' }), ['bach']);
  assert.deepEqual(names({ text: 'bach baroque' }), ['bach']);
  assert.deepEqual(names({ composer: 'satie', genre: 'chiptune' }), ['satie-chip']);
  assert.deepEqual(names({}), ['satie', 'satie-chip', 'bach', 'untagged']);
  assert.deepEqual(facetValues(entries[0].meta), { composer: ['Erik Satie'], era: ['impressionist'], genre: ['classical piano'], gameUse: ['menu', 'puzzle'], arrangement: ['shaped'], licence: ['public domain'] });
});

test('lengths are read from WAV and OGG headers', async () => {
  const wav = tone(2);
  assert.equal(wavSeconds(wav), 2);
  assert.equal(wavSeconds(wav.subarray(0, 64), wav.length), 2, 'only the header is needed');
  assert.equal(wavSeconds(Buffer.from('not a wav at all')), null);
  const ogg = fakeOgg(44100, 44100 * 3.5);
  assert.equal(oggSeconds(ogg, ogg), 3.5);
  assert.equal(oggSeconds(Buffer.alloc(80), Buffer.alloc(80)), null);
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, 'a.wav'), wav);
    await writeFile(path.join(dir, 'b.ogg'), ogg);
    await writeFile(path.join(dir, 'c.mp3'), 'x');
    assert.equal(await audioSeconds(path.join(dir, 'a.wav')), 2);
    assert.equal(await audioSeconds(path.join(dir, 'b.ogg')), 3.5);
    assert.equal(await audioSeconds(path.join(dir, 'c.mp3')), null);
    assert.equal(await audioSeconds(path.join(dir, 'missing.wav')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tag_sound writes a checked sidecar and list_tagged finds it', async () => {
  const root = await tempDir(), t = fakeTool();
  try {
    await mkdir(path.join(root, 'classics'));
    await writeFile(path.join(root, 'piece.wav'), tone(3));
    await writeFile(path.join(root, 'piece.ogg'), fakeOgg(8000, 24000));
    await writeFile(path.join(root, 'other.ogg'), fakeOgg(8000, 8000));
    await writeFile(path.join(root, 'classics', 'piece-source.mid'), 'MThd');
    await writeFile(path.join(root, 'classics', 'piece-source.source.md'), '# Source\nPublic domain.');
    register({ tool: t.tool, z, root, moduleGuidance: [] });
    const first = await call(t, 'tag_sound', { file: 'piece.ogg', meta: { title: 'Piece', composer: 'Erik Satie', genre: 'classical piano', gameUse: ['menu'], sourceNote: 'classics/piece-source.source.md' } });
    assert.equal(first.sidecar, 'piece.meta.json');
    assert.deepEqual(first.files.sort(), ['piece.ogg', 'piece.wav']);
    assert.equal(first.meta.durationSeconds, 3, 'measured from the WAV');
    const saved = JSON.parse(await readFile(path.join(root, 'piece.meta.json'), 'utf8'));
    assert.equal(saved.format, 'lmms-mcp-meta/1');
    assert.deepEqual(saved.genre, ['classical piano']);
    const second = await call(t, 'tag_sound', { file: 'piece.wav', meta: { mood: ['calm'], gameUse: null } });
    assert.equal(second.meta.composer, 'Erik Satie', 'merge keeps old fields');
    assert.equal(second.meta.gameUse, undefined, 'null removes a field');
    await assert.rejects(call(t, 'tag_sound', { file: 'piece.wav', meta: { era: 'jurassic' } }), /era/);
    await assert.rejects(call(t, 'tag_sound', { file: 'piece.wav', meta: { licence: 'own-recording' } }), /own-recording.*forbidden/i);
    await assert.rejects(call(t, 'tag_sound', { file: 'piece.wav', meta: { source: 'not a url' } }), /source must be a full http/);
    await assert.rejects(call(t, 'tag_sound', { file: '../piece.wav', meta: { title: 'x' } }), /workspace/);
    await assert.rejects(call(t, 'tag_sound', { file: 'nothing.wav', meta: { title: 'x' } }), /No file named/);
    await assert.rejects(call(t, 'tag_sound', { file: 'other.ogg', meta: { sourceNote: 'missing.md' } }), /does not exist/);
    await call(t, 'tag_sound', { file: 'classics/piece-source.mid', meta: { composer: 'Erik Satie', kind: 'sound' } });
    const replaced = await call(t, 'tag_sound', { file: 'other.ogg', meta: { title: 'Other', composer: 'J. S. Bach' }, mode: 'replace', measure: false });
    assert.equal(replaced.meta.durationSeconds, undefined);
    const satie = await call(t, 'list_tagged', { composer: 'satie', includeNote: true });
    assert.equal(satie.count, 2);
    const piece = satie.results.find(r => r.name === 'piece');
    assert.equal(piece.sourceNote, 'classics/piece-source.source.md');
    assert.match(piece.note, /Public domain/);
    assert.equal(satie.results.find(r => r.name === 'classics/piece-source').sourceNote, 'classics/piece-source.source.md', 'a sibling source note is found');
    assert.deepEqual(satie.values.composer, ['Erik Satie', 'J. S. Bach']);
    assert.equal((await call(t, 'list_tagged', { file: 'other.ogg' })).results[0].meta.title, 'Other');
    await writeFile(path.join(root, 'loose.wav'), tone(1));
    assert.deepEqual((await call(t, 'list_tagged', { untagged: true })).results.map(r => r.name), ['loose']);
    await writeFile(path.join(root, 'loose.meta.json'), '{ broken');
    assert.equal((await call(t, 'list_tagged', {})).problems.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('applyMeta files a tagged top-level render as a finished piece and leaves the rest alone', () => {
  const base = () => ({ t: 'track', n: 'satie gymnopedie 1', p: 'satie-gymnopedie-1.wav', s: 'My tracks', c: '', r: 'track', g: ['wav'], u: 'satie-gymnopedie-1.wav' });
  const entry = { sidecar: 'satie-gymnopedie-1.meta.json', sourceNote: 'classics/s.source.md', note: '# Note',
    meta: { title: 'Gymnopédie No. 1', composer: 'Erik Satie', composed: '1888', era: 'impressionist', genre: ['classical piano'], arrangement: 'shaped', loop: false,
      licence: 'public domain', credits: ['Splendid Grand Piano'], source: 'https://example.org/score', durationSeconds: 200.6, tags: ['satie'] } };
  const item = applyMeta(base(), entry, { topLevel: true });
  assert.equal(item.t, 'piece');
  assert.equal(item.s, 'Finished pieces');
  assert.equal(item.r, 'shaped');
  assert.equal(item.n, 'Gymnopédie No. 1');
  assert.equal(item.c, 'Erik Satie · 1888');
  assert.equal(item.l, 201);
  assert.deepEqual(item.g, ['wav', 'satie']);
  assert.deepEqual(item.z.composer, ['Erik Satie']);
  assert.equal(item.sn, '# Note');
  assert.match(item.d, /Credit: Splendid Grand Piano/);
  const noteOnly = applyMeta(base(), { sidecar: null, sourceNote: 'x.source.md', note: 'text', meta: {} }, { topLevel: true });
  assert.equal(noteOnly.t, 'track', 'a source note alone does not make a piece');
  assert.equal(noteOnly.sn, 'text');
  assert.equal(applyMeta(base(), { ...entry, meta: { ...entry.meta, kind: 'stem' } }, { topLevel: true }).t, 'track');
});

test('the library page lists tagged pieces with filters and still builds with no metadata', async () => {
  const root = await tempDir();
  const build = async (output) => {
    const t = fakeTool();
    registerLibrary({ tool: t.tool, z, dsp, root, schemas: {}, project: {}, render: {}, sounds: {}, paths: {}, moduleGuidance: [] });
    const result = await call(t, 'build_library_page', { output, include: ['workspace'] });
    const html = await readFile(path.join(root, output), 'utf8');
    return { result, data: JSON.parse(/<script id="data" type="application\/json">(.*?)<\/script>/s.exec(html)[1].replace(/\\u003c/g, '<')), html };
  };
  try {
    await writeFile(path.join(root, 'piece.wav'), tone(2));
    await writeFile(path.join(root, 'piece.ogg'), fakeOgg(8000, 16000));
    await writeFile(path.join(root, 'piece-salamander.ogg'), fakeOgg(8000, 40000));
    for (const name of ['piece.wav', 'piece.ogg', 'piece-salamander.ogg']) {
      await writeProvenanceSidecar(path.join(root, name), {
        workspaceDir: root,
        classification: 'pure-synthesis',
        generatorTool: 'test-fixture',
        sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'test-synth', licence: 'MIT' }],
      });
    }
    const plain = await build('plain.html');
    assert.deepEqual(plain.data.items.map(i => i.t).sort(), ['track', 'track']);
    assert.ok(!plain.data.items.some(i => i.z));
    assert.ok(plain.html.includes('id="facets" hidden'));
    assert.ok(plain.html.includes('[hidden]{display:none!important}'), 'hidden rows stay hidden even with a display rule');
    await writeFile(path.join(root, 'piece.meta.json'), JSON.stringify({ title: 'Piece', composer: 'Erik Satie', genre: ['classical piano'], licence: 'public domain' }));
    await writeFile(path.join(root, 'piece-salamander.meta.json'), JSON.stringify({ title: 'Piece (Salamander)', composer: 'Erik Satie', licence: 'CC-BY 3.0', credits: ['Salamander Grand Piano by Alexander Holm, CC-BY 3.0'] }));
    await writeFile(path.join(root, 'piece-salamander.source.md'), '# Where it came from');
    const tagged = await build('tagged.html');
    assert.equal(tagged.result.counts.pieces, 2);
    const piece = tagged.data.items.find(i => i.p === 'piece.wav'), salamander = tagged.data.items.find(i => i.p === 'piece-salamander.ogg');
    assert.equal(piece.t, 'piece');
    assert.deepEqual(piece.g, ['wav', 'ogg'], 'the OGG twin is noted on the WAV');
    assert.equal(piece.u, 'piece.wav');
    assert.equal(salamander.u, 'piece-salamander.ogg', 'OGG renders play');
    assert.equal(salamander.l, 5, 'OGG length read from the file');
    assert.deepEqual(salamander.z.licence, ['CC-BY 3.0']);
    assert.match(salamander.d, /Alexander Holm/);
    assert.equal(salamander.sn, '# Where it came from');
    assert.deepEqual(tagged.data.facets.map(f => f[0]), ['composer', 'era', 'genre', 'mood', 'gameUse', 'arrangement', 'licence']);
    await writeFile(path.join(root, 'piece.meta.json'), '{ not json');
    const broken = await build('broken.html');
    assert.equal(broken.data.items.find(i => i.p === 'piece.wav').t, 'piece', 'a broken sidecar still marks a tagged render');
    assert.ok(broken.result.notes.some(n => n.includes('metadata files had problems')));
    assert.ok(existsSync(path.join(root, 'broken.html')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the workspace scan groups formats, sidecars and source notes by name', async () => {
  const root = await tempDir();
  try {
    await mkdir(path.join(root, 'classics'));
    for (const name of ['a.wav', 'a.ogg', 'a.mmp', 'a.meta.json', 'classics/a.mid', 'classics/a.source.md', 'notes.txt']) await writeFile(path.join(root, name), name.endsWith('.json') ? '{}' : 'x');
    const entries = await scanWorkspace(root);
    assert.deepEqual(entries.find(e => e.name === 'a'), { name: 'a', files: ['a.mmp', 'a.ogg', 'a.wav'], sidecar: 'a.meta.json', sourceNote: null });
    assert.deepEqual(entries.find(e => e.name === 'classics/a'), { name: 'classics/a', files: ['classics/a.mid'], sidecar: null, sourceNote: 'classics/a.source.md' });
    assert.ok(!entries.some(e => e.name.startsWith('notes')));
    const { byBase } = await workspaceMeta(root);
    assert.equal(byBase.get('classics/a').note, 'x');
  } finally { await rm(root, { recursive: true, force: true }); }
});
