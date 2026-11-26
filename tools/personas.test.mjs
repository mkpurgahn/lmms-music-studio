import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { deniedArtistReferences, getPersona, loadPersonas, personaSchema, register as registerPersonas, validatePersona } from './personas.mjs';

const directory = fileURLToPath(new URL('../test/fixtures/personas/', import.meta.url));
const fixture = getPersona('persona-fixture', directory);
const readJson = url => JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8'));

test('persona schema is shipped and agrees with runtime validation', () => {
  assert.deepEqual(readJson('../personas/persona.schema.json'), z.toJSONSchema(personaSchema));
  assert.ok(!loadPersonas().some(persona => persona.id === fixture.id));
  assert.deepEqual(loadPersonas(directory), [fixture]);
  assert.throws(() => validatePersona({ ...fixture, id: '../fixture' }), /id/);
  assert.throws(() => validatePersona({ ...fixture, tempo: { ...fixture.tempo, default: 120 } }), /tempo/);
  assert.throws(() => validatePersona({ ...fixture, signatureSounds: [fixture.signatureSounds[0], fixture.signatureSounds[0]] }), /Duplicate/);
  assert.throws(() => validatePersona({ ...fixture, testRender: { ...fixture.testRender, seconds: 29 } }), /seconds/);
});

test('artist references are rejected in identity, brief and nested text', () => {
  const [reference] = deniedArtistReferences;
  const slug = reference.normalize('NFKD').replace(/[^a-z ]/gi, '').toLowerCase().replaceAll(' ', '-');
  assert.throws(() => validatePersona({ ...fixture, id: slug }), /Artist reference in persona.id/);
  assert.throws(() => validatePersona({ ...fixture, name: reference }), /Artist reference in persona.name/);
  assert.throws(() => validatePersona({ ...fixture, brief: reference.toUpperCase() }), /Artist reference in persona.brief/);
  assert.throws(() => validatePersona({ ...fixture, neverDo: [reference] }), /Artist reference in persona.neverDo/);
  assert.throws(() => validatePersona({ ...fixture, testRender: { ...fixture.testRender, listeningNotes: [reference] } }), /Artist reference in persona.testRender/);
});

test('loader reports the offending file and rejects filename and id drift', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmms-persona-'));
  try {
    await writeFile(path.join(scratch, 'other.json'), JSON.stringify(fixture));
    assert.throws(() => loadPersonas(scratch), /Invalid persona other.json: Filename must match/);
    await writeFile(path.join(scratch, 'other.json'), '{');
    assert.throws(() => loadPersonas(scratch), /Invalid persona other.json/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('MCP persona tools validate input and filter fixtures accurately', async () => {
  const handlers = new Map();
  const context = {
    z, personasDirectory: directory, moduleGuidance: [],
    tool: (name, _description, input, handler) => handlers.set(name, args => handler(z.object(input).parse(args))),
  };
  registerPersonas(context);
  const list = handlers.get('list_personas');
  assert.deepEqual(list({ kind: 'film', tags: ['MINIMAL', 'percussive'], minBpm: 115, maxBpm: 130, query: 'dry pulse' }).personas.map(persona => persona.id), [fixture.id]);
  assert.deepEqual(list({ kind: 'dj' }).personas, []);
  assert.deepEqual(list({ minBpm: 116 }).personas, []);
  assert.deepEqual(list({ tags: ['percussive', 'unknown'] }).personas, []);
  assert.throws(() => list({ minBpm: 120, maxBpm: 100 }), /minBpm/);
  const describe = handlers.get('describe_persona');
  assert.deepEqual(describe({ id: fixture.id }), fixture);
  assert.throws(() => describe({ id: 'missing' }), /Unknown persona/);
});
