import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const text = z.string().trim().min(1);
const texts = z.array(text);
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const personaKind = z.enum(['film', 'dj']);
const bpm = z.number().min(10).max(999);
const slot = z.enum(['lead', 'harmony', 'pad', 'bass', 'kick', 'snare', 'hat', 'crash']);
const voice = z.strictObject({
  voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat']),
  volume: z.number().int().min(0).max(200).optional(),
  pan: z.number().int().min(-100).max(100).optional(),
});

export const personaSchema = z.strictObject({
  id,
  name: text,
  kind: personaKind,
  tags: texts,
  brief: text,
  neverDo: texts.min(1),
  tempo: z.strictObject({
    min: bpm, max: bpm, default: bpm,
    timeSignature: z.string().regex(/^[1-9][0-9]*\/(?:1|2|4|8|16|32)$/),
  }),
  swing: z.strictObject({ template: id, amount: z.number().min(0).max(1) }),
  groove: z.strictObject({
    template: id,
    humanizeMs: z.number().nonnegative().optional(),
    ghostNoteDensity: z.number().min(0).max(1).optional(),
    fillInterval: z.number().int().positive().optional(),
  }),
  drums: z.strictObject({ kit: id, patterns: id, subfeel: id.optional() }),
  bass: z.strictObject({ approach: text, archetype: id }),
  harmony: z.strictObject({
    keys: texts.min(1).optional(),
    scales: texts.min(1), modes: texts,
    progressions: z.array(texts.min(1)), voicings: texts,
  }),
  signatureSounds: z.array(z.strictObject({
    role: slot, engine: z.enum(['surge', 'atelier', 'theremin', 'soundfont', 'sfz', 'native']),
    preset: id, fallback: voice,
  })).min(1),
  articulations: z.array(z.strictObject({
    instrument: text, library: id, keyswitches: z.record(id, z.number().int().min(0).max(127)),
  })).optional(),
  arrangement: z.strictObject({
    habits: texts, phraseBars: z.number().int().positive(),
    energyCurve: id, variants: z.array(id),
  }),
  mix: z.strictObject({
    targets: z.strictObject({
      lufs: z.number().min(-36).max(-6),
      truePeakDb: z.number().min(-12).max(0),
      monoBelowHz: z.number().nonnegative().optional(),
      width: z.number().nonnegative().optional(),
    }),
    fx: z.array(id), platformPreset: id,
  }),
  recipe: text,
  testRender: z.strictObject({
    seconds: z.number().min(30).max(60), seed: z.number().int().positive(), listeningNotes: texts.min(1),
  }),
});

const folder = fileURLToPath(new URL('../personas/', import.meta.url));
const normalise = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const deniedArtistReferences = [
  'Edvard Grieg', 'Grieg',
  'Erik Satie', 'Satie',
  'Nikolai Rimsky-Korsakov', 'Rimsky-Korsakov',
  'George Frideric Handel', 'Handel',
  'Claude Debussy', 'Debussy',
  'Johann Sebastian Bach', 'Bach',
  'Ludwig van Beethoven', 'Beethoven',
  'Wolfgang Amadeus Mozart', 'Mozart',
  'Nobuo Uematsu',
  'Philip Glass',
  'Gustav Holst', 'Holst',
];
const denied = deniedArtistReferences.map(normalise);

function checkText(value, field) {
  if (typeof value === 'string') {
    const words = ` ${normalise(value)} `;
    if (denied.some(artist => words.includes(` ${artist} `))) throw new Error(`Artist reference in ${field}`);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) checkText(child, `${field}.${key}`);
  }
}

export function validatePersona(data) {
  const persona = personaSchema.parse(data);
  const { min, max, default: tempo } = persona.tempo;
  if (min > tempo || tempo > max) throw new Error('tempo must satisfy min <= default <= max');
  if (persona.kind === 'dj' && persona.articulations) throw new Error('Articulations are available for film personas');
  const roles = persona.signatureSounds.map(sound => sound.role);
  if (new Set(roles).size !== roles.length) throw new Error('Duplicate signature sound role');
  checkText(persona, 'persona');
  return persona;
}

export function loadPersonas(directory = folder) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'persona.schema.json')
    .map(entry => entry.name).sort();
  return files.map(file => {
    try {
      const persona = validatePersona(JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
      if (file !== `${persona.id}.json`) throw new Error(`Filename must match id "${persona.id}"`);
      return persona;
    } catch (error) {
      throw new Error(`Invalid persona ${file}: ${error.message}`, { cause: error });
    }
  });
}

export function getPersona(id, directory) {
  const persona = loadPersonas(directory).find(persona => persona.id === id);
  if (!persona) throw new Error(`Unknown persona "${id}". Use list_personas to find available ids.`);
  return persona;
}

export function listPersonas({ kind, tags = [], minBpm, maxBpm, query } = {}, directory) {
  if (minBpm > maxBpm) throw new Error('minBpm must be less than or equal to maxBpm');
  const queryText = query?.trim().toLowerCase() ?? '';
  const requestedTags = tags.map(tag => tag.toLowerCase());
  return loadPersonas(directory)
    .filter(persona => !kind || persona.kind === kind)
    .filter(({ tags }) => requestedTags.every(tag => tags.some(candidate => candidate.toLowerCase() === tag)))
    .filter(({ tempo }) => tempo.max >= (minBpm ?? -Infinity) && tempo.min <= (maxBpm ?? Infinity))
    .filter(({ id, name, brief, tags }) => [id, name, brief, ...tags].some(value => value.toLowerCase().includes(queryText)))
    .map(({ id, name, kind, tags, brief, tempo }) => ({ id, name, kind, tags, brief, tempo }));
}

export function register({ tool, personasDirectory }) {
  tool('list_personas', 'Find composer and DJ personas by kind, tags, tempo range, or text.', {
    kind: personaKind.optional(), tags: z.array(z.string().min(1)).optional(),
    minBpm: z.number().positive().optional(), maxBpm: z.number().positive().optional(), query: z.string().optional(),
  }, filters => ({ personas: listPersonas(filters, personasDirectory) }));
  tool('describe_persona', 'Read a persona brief, musical defaults, sound fallbacks and recipe references.', {
    id: z.string().min(1).describe("Persona id from list_personas."),
  }, ({ id }) => getPersona(id, personasDirectory));
}
