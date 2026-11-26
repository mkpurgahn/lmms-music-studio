// Metadata for workspace sounds and finished pieces: title, composer, era, genre, mood, game use, arrangement,
// licence, credits and the rest, kept in a small JSON file next to the sound. The library page reads it to file and
// filter pieces; tag_sound writes it and list_tagged searches it.
//
// One sidecar per name: "satie-gymnopedie-1.meta.json" describes satie-gymnopedie-1.wav, .ogg, .mmp and .mid together,
// because they are the same piece in different formats. A sidecar travels with its sound when the files are copied into
// a game, two agents tagging different sounds never edit the same file, and a sound with no sidecar is simply untagged.
import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';
import { isStrictCopyright } from './provenance.mjs';

export const metaFormat = 'lmms-mcp-meta/1';
export const metaSuffix = '.meta.json';
export const sourceSuffix = '.source.md';
export const mediaFile = /\.(wav|ogg|flac|mp3|mmpz?|midi?)$/i;
const audioFile = /\.(wav|ogg|flac|mp3)$/i;

export const eras = ['medieval', 'renaissance', 'baroque', 'classical', 'romantic', 'impressionist', 'modern', 'traditional', 'original'];
export const gameUses = ['menu', 'hub', 'puzzle', 'exploration', 'ambient', 'battle', 'boss', 'victory', 'defeat', 'cutscene', 'credits', 'stinger'];
export const arrangements = ['straight', 'shaped', 'chiptune', 'dance', 'orchestral', 'ambient', 'jazz', 'original'];
export const kinds = ['piece', 'sound', 'stem', 'take', 'mix'];
// Genres and moods are open lists. These are the words to reach for first, so filters stay tidy.
export const suggestedGenres = ['classical piano', 'orchestral', 'chiptune', 'dance', 'ambient', 'jazz', 'game cue', 'lo-fi', 'folk', 'rock'];
export const suggestedMoods = ['calm', 'gentle', 'melancholy', 'dreamy', 'playful', 'bright', 'tense', 'dark', 'heroic', 'triumphant', 'mysterious', 'energetic'];

// Every field a sidecar can hold. `lower` lists are stored in lower case so filters match however they were typed.
export const fields = {
  title: { type: 'text', max: 120, doc: 'Display title, for example "Gymnopédie No. 1".' },
  composer: { type: 'text', max: 80, doc: 'Composer as people search for them, for example "Erik Satie". Use "original" work\'s author for new music.' },
  composed: { type: 'text', max: 40, doc: 'When the music was written: a year such as "1888" or a range such as "1720-1722".' },
  era: { type: 'enum', values: eras },
  genre: { type: 'list', lower: true, max: 8, doc: 'Open list. Common: ' + suggestedGenres.join(', ') + '.' },
  mood: { type: 'list', lower: true, max: 8, doc: 'Open list. Common: ' + suggestedMoods.join(', ') + '.' },
  gameUse: { type: 'list', values: gameUses, max: 12, doc: 'Where in a game it fits.' },
  arrangement: { type: 'enum', values: arrangements, doc: 'How this version treats the music: straight (as written), shaped (performed), or a restyle.' },
  instrumentation: { type: 'list', max: 16, doc: 'Instruments or sound sources, for example "Splendid Grand Piano".' },
  durationSeconds: { type: 'number', min: 0, max: 36000, doc: 'Filled in from the audio when left out.' },
  loop: { type: 'boolean', doc: 'True when the file loops cleanly in a game.' },
  source: { type: 'url', doc: 'Where the score, MIDI or recording came from.' },
  licence: { type: 'text', max: 80, doc: 'Use one spelling per licence: "public domain", "CC0", "CC-BY 3.0", "CC-BY 4.0", "CC-BY-SA 4.0", "MIT", "all rights reserved".' },
  credits: { type: 'list', max: 12, itemMax: 300, doc: 'Attribution lines to show wherever the sound is used.' },
  date: { type: 'date', doc: 'The day this file was made, YYYY-MM-DD.' },
  kind: { type: 'enum', values: kinds, doc: 'piece (finished music), sound (a sample or one-shot) , stem, desk take or desk mix. A tagged file at the top of the workspace is a piece unless this says otherwise.' },
  tags: { type: 'list', lower: true, max: 24, doc: 'Free tags; they join the tag filter on the library page.' },
  notes: { type: 'text', max: 2000 },
  sourceNote: { type: 'path', doc: 'A workspace .md file about where the music came from, when it is not next to the sound as <name>.source.md.' },
};
// The fields the library page offers as filters, with the label for "any".
export const facets = [['composer', 'All composers'], ['era', 'All eras'], ['genre', 'All genres'], ['mood', 'All moods'], ['gameUse', 'All game uses'], ['arrangement', 'All arrangements'], ['licence', 'All licences']];

const tidy = text => String(text).replace(/\s+/g, ' ').trim();
// Check one value against its field. Returns [value] or throws a message a person can act on.
function checkField(name, spec, raw) {
  if (spec.type === 'text') {
    if (typeof raw !== 'string' && typeof raw !== 'number') throw `${name} must be text`;
    const value = name === 'notes' ? String(raw).trim() : tidy(raw);
    if (!value) throw `${name} is empty`;
    if (value.length > spec.max) throw `${name} is longer than ${spec.max} characters`;
    return value;
  }
  if (spec.type === 'enum') {
    const value = typeof raw === 'string' ? tidy(raw).toLowerCase() : raw;
    if (!spec.values.includes(value)) throw `${name} must be one of: ${spec.values.join(', ')}`;
    return value;
  }
  if (spec.type === 'list') {
    const list = (Array.isArray(raw) ? raw : [raw]).map(v => {
      if (typeof v !== 'string') throw `${name} must be a list of text`;
      let value = tidy(v);
      if (spec.lower || spec.values) value = value.toLowerCase();
      if (!value) throw `${name} has an empty entry`;
      if (value.length > (spec.itemMax ?? 60)) throw `an entry in ${name} is longer than ${spec.itemMax ?? 60} characters`;
      if (spec.values && !spec.values.includes(value)) throw `${name} entries must be from: ${spec.values.join(', ')}`;
      return value;
    });
    const unique = [...new Set(list)];
    if (unique.length > spec.max) throw `${name} has more than ${spec.max} entries`;
    return unique;
  }
  if (spec.type === 'number') {
    const value = Number(raw);
    if (typeof raw === 'boolean' || raw === '' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw `${name} must be a number from ${spec.min} to ${spec.max}`;
    return Math.round(value * 100) / 100;
  }
  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') throw `${name} must be true or false`;
    return raw;
  }
  if (spec.type === 'url') {
    const value = tidy(raw);
    let url;
    try { url = new URL(value); } catch { throw `${name} must be a full http or https address`; }
    if (!/^https?:$/.test(url.protocol)) throw `${name} must be a full http or https address`;
    return value;
  }
  if (spec.type === 'date') {
    const value = tidy(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) throw `${name} must be a date as YYYY-MM-DD`;
    return value;
  }
  if (spec.type === 'path') {
    const value = safeRelative(raw);
    if (!value || !/\.md$/i.test(value)) throw `${name} must be a workspace .md file such as classics/piece.source.md`;
    return value;
  }
  throw `${name} has an unknown type`;
}
// Check and tidy a whole metadata object. Unknown fields are errors, so a typo is caught rather than saved.
// `allowNull` lets null mean "remove this field", for merging.
export function validateMeta(input, { allowNull = false } = {}) {
  const meta = {}, errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { meta, errors: ['metadata must be an object'] };
  for (const [name, raw] of Object.entries(input)) {
    if (name === 'format') continue;
    const spec = fields[name];
    if (!spec) { errors.push(`unknown field "${name}". Fields: ${Object.keys(fields).join(', ')}`); continue; }
    if (raw === null || raw === undefined) { if (allowNull) meta[name] = null; else errors.push(`${name} is empty`); continue; }
    try { meta[name] = checkField(name, spec, raw); } catch (message) { errors.push(String(message)); }
  }
  return { meta, errors };
}
// Merge a checked patch into existing metadata. null removes a field. Keys come out in the order of `fields`.
export function mergeMeta(existing, patch) {
  const out = { ...existing };
  for (const [name, value] of Object.entries(patch)) { if (value === null) delete out[name]; else out[name] = value; }
  return ordered(out);
}
const ordered = meta => Object.fromEntries(Object.keys(fields).filter(name => meta[name] !== undefined).map(name => [name, meta[name]]));
export const metaText = meta => JSON.stringify({ format: metaFormat, ...ordered(meta) }, null, 2) + '\n';

// A workspace-relative path, at most three folders deep, with no way out of the workspace. Returns null when unsafe.
export function safeRelative(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().replaceAll('\\', '/').split('/');
  if (parts.length > 3 || parts.some(p => !p || p.startsWith('.') || /[<>:"|?*\0]/.test(p) || p.length > 120)) return null;
  return parts.join('/');
}
// "classics/piece.wav" -> "classics/piece". Only media and project extensions are cut, so "piece.v2" keeps its dot.
export const baseOf = relative => relative.replace(mediaFile, '');
export const sidecarFor = relative => baseOf(relative) + metaSuffix;

// The facet values the library page filters on, as lists.
export function facetValues(meta) {
  const out = {};
  for (const [name] of facets) {
    const value = meta[name];
    if (value === undefined) continue;
    const list = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
    if (list.length) out[name] = list;
  }
  return out;
}
// Filter entries ({ meta }) by any field. Text fields match a part of the value ("satie" finds "Erik Satie"); lists and
// choices match any of the values asked for; `text` searches every field.
export function filterEntries(entries, filters = {}) {
  const want = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));
  return entries.filter(entry => want.every(([name, asked]) => {
    const meta = entry.meta ?? {};
    if (name === 'text') {
      const hay = [entry.name, ...Object.values(meta).flat()].join(' ').toLowerCase();
      return String(asked).toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word));
    }
    if (name === 'tagged') return Boolean(entry.sidecar) === asked;
    const spec = fields[name], value = meta[name];
    if (!spec) return true;
    if (spec.type === 'boolean') return value === asked;
    if (value === undefined) return false;
    if (spec.type === 'number') return value === asked;
    const have = (Array.isArray(value) ? value : [value]).map(v => String(v).toLowerCase());
    const options = (Array.isArray(asked) ? asked : [asked]).map(v => String(v).toLowerCase());
    return spec.type === 'text' ? options.some(o => have.some(h => h.includes(o))) : options.some(o => have.includes(o));
  }));
}

// Length of a WAV from its header, or null.
export function wavSeconds(head, fileSize = head.length) {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= head.length;) {
    const id = head.toString('ascii', at, at + 4), size = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= head.length) byteRate = head.readUInt32LE(at + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const bytes = Math.min(size, Math.max(0, fileSize - at - 8));
      return Math.round(bytes / byteRate * 100) / 100;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
// Length of an Ogg Vorbis or Opus file from its first and last pages, or null.
export function oggSeconds(head, tail) {
  let rate = 0, skip = 0;
  const vorbis = head.indexOf('\x01vorbis', 0, 'latin1'), opus = head.indexOf('OpusHead', 0, 'latin1');
  if (vorbis >= 0 && vorbis + 16 <= head.length) rate = head.readUInt32LE(vorbis + 12);
  else if (opus >= 0 && opus + 12 <= head.length) { rate = 48000; skip = head.readUInt16LE(opus + 10); }
  const last = tail.lastIndexOf('OggS', tail.length - 14, 'latin1');
  if (!rate || last < 0) return null;
  const granule = Number(tail.readBigInt64LE(last + 6));
  if (granule <= 0) return null;
  return Math.round((granule - skip) / rate * 100) / 100;
}
// Length in seconds of a WAV or OGG on disk, reading only its ends. Null for other formats or a file it cannot read.
export async function audioSeconds(file) {
  if (!/\.(wav|ogg)$/i.test(file)) return null;
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat(), span = Math.min(size, 65536);
    const head = Buffer.alloc(span), tail = Buffer.alloc(span);
    await handle.read(head, 0, span, 0);
    await handle.read(tail, 0, span, size - span);
    return /\.wav$/i.test(file) ? wavSeconds(head, size) : oggSeconds(head, tail);
  } catch { return null; } finally { await handle?.close(); }
}

async function walkAll(directory, depth, base = directory, out = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || out.length >= 20000) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (depth > 0) await walkAll(full, depth - 1, base, out); }
    else if (entry.isFile()) out.push(path.relative(base, full).replaceAll('\\', '/'));
  }
  return out;
}
// Every name in the workspace that has media, a sidecar or a source note, two folders down. Each entry lists its files,
// its sidecar and its source note (the sibling <name>.source.md).
export async function scanWorkspace(root) {
  const byBase = new Map(), get = base => byBase.get(base) ?? byBase.set(base, { name: base, files: [], sidecar: null, sourceNote: null }).get(base);
  for (const relative of await walkAll(root, 2)) {
    if (relative.endsWith(metaSuffix)) get(relative.slice(0, -metaSuffix.length)).sidecar = relative;
    else if (relative.endsWith(sourceSuffix)) get(relative.slice(0, -sourceSuffix.length)).sourceNote = relative;
    else if (mediaFile.test(relative)) get(baseOf(relative)).files.push(relative);
  }
  return [...byBase.values()];
}
// Read and check one sidecar. Returns { meta, problem }: a broken file gives an empty meta and a reason, never a throw.
export async function readSidecar(root, relative) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
    const { meta, errors } = validateMeta(parsed);
    return { meta, problem: errors.length ? `${relative}: ${errors.join('; ')}` : null };
  } catch (error) { return { meta: {}, problem: `${relative}: ${error.message}` }; }
}
// A source note's text for showing on the page, cut to a readable length.
export async function readNote(root, relative, max = 6000) {
  if (!relative) return null;
  const text = await readFile(path.join(root, relative), 'utf8').catch(() => null);
  if (text === null) return null;
  return text.length > max ? text.slice(0, max) + '\n…' : text;
}
// Everything the library page needs, keyed by base name: checked metadata, the source note text and any problems.
export async function workspaceMeta(root) {
  const out = new Map(), problems = [];
  let entries;
  try { entries = await scanWorkspace(root); } catch { return { byBase: out, problems }; }
  for (const entry of entries) {
    if (!entry.sidecar && !entry.sourceNote) continue;
    const { meta, problem } = entry.sidecar ? await readSidecar(root, entry.sidecar) : { meta: {}, problem: null };
    if (problem) problems.push(problem);
    const notePath = entry.sourceNote ?? meta.sourceNote ?? null;
    out.set(entry.name, { meta, sidecar: entry.sidecar, sourceNote: notePath, note: await readNote(root, notePath) });
  }
  return { byBase: out, problems };
}

// Turn a library-page item for a workspace file into a tagged one: title, facets, credits, source note and source link.
// `topLevel` decides the default kind: a tagged render at the top of the workspace is a finished piece.
export function applyMeta(item, entry, { topLevel = false } = {}) {
  const meta = entry.meta ?? {};
  const kind = meta.kind ?? (topLevel && entry.sidecar ? 'piece' : null);
  if (kind === 'piece') { item.t = 'piece'; item.s = 'Finished pieces'; item.r = meta.arrangement ?? 'piece'; }
  if (meta.title) item.n = meta.title;
  const z = facetValues(meta);
  if (Object.keys(z).length) item.z = z;
  item.g = [...new Set([...(item.g ?? []), ...(meta.tags ?? []), ...(meta.loop ? ['loop'] : [])])];
  const line = [meta.composer, meta.composed, meta.instrumentation?.join(', ')].filter(Boolean).join(' · ');
  if (line) item.c = line;
  const desc = [meta.notes, ...(meta.credits ?? []).map(c => 'Credit: ' + c)].filter(Boolean).join(' ');
  if (desc) item.d = desc;
  if (meta.durationSeconds && !item.l) item.l = Math.round(meta.durationSeconds);
  if (meta.source) item.su = meta.source;
  if (entry.note) { item.sn = entry.note; item.sp = entry.sourceNote; }
  return item;
}

export function register({ tool, z, root, moduleGuidance, env = process.env }) {
  moduleGuidance.push('When a render is finished, call tag_sound with its title, composer, era, genre, mood, game use, arrangement, licence and credits, so it can be found and filtered on the library page and with list_tagged. Note that .meta.json is descriptive metadata only and never proves copyright provenance.');
  const fieldSchema = (name, spec) => {
    let schema = spec.type === 'enum' ? z.enum(spec.values)
      : spec.type === 'list' ? z.union([z.string(), z.array(z.string())])
      : spec.type === 'number' ? z.number() : spec.type === 'boolean' ? z.boolean() : z.string();
    schema = schema.nullable().optional();
    return spec.doc ? schema.describe(spec.doc) : schema;
  };
  const metaShape = Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, fieldSchema(name, spec)]));
  const fileArg = z.string().min(1).max(300).describe('A workspace file, up to two folders down, for example "satie-gymnopedie-1.ogg" or "classics/satie-gymnopedie-1.mid". All formats with the same name share one sidecar.');
  const locate = async relative => {
    const safe = safeRelative(relative);
    if (!safe || !mediaFile.test(safe)) throw new Error('file must be a workspace audio, project or MIDI file (wav, ogg, flac, mp3, mmp, mmpz, mid), up to two folders down.');
    if (!path.resolve(root, safe).startsWith(path.resolve(root) + path.sep)) throw new Error('file must be inside the workspace.');
    return safe;
  };

  tool('tag_sound', 'Write or update the metadata sidecar (<name>.meta.json) for a workspace sound, render or project: title, composer, composed, era, genre, mood, gameUse, arrangement, instrumentation, durationSeconds, loop, source, licence, credits, date, kind, tags, notes and sourceNote. merge (default) keeps fields you do not pass and removes a field passed as null; replace writes only what you pass. Values are checked and tidied; an unknown field is an error. The length is measured from the WAV or OGG when not given. The library page shows tagged pieces with filters for composer, era, genre, mood, game use, arrangement and licence.', {
    file: fileArg,
    meta: z.object(metaShape).strict(),
    mode: z.enum(['merge', 'replace']).default('merge'),
    measure: z.boolean().default(true).describe('Fill in durationSeconds from the audio when it is not set.'),
  }, async ({ file, meta: input, mode, measure }) => {
    const safe = await locate(file);
    const siblings = (await scanWorkspace(root)).find(e => e.name === baseOf(safe));
    if (!siblings?.files.length) throw new Error(`No file named ${safe} in the workspace.`);
    const { meta: patch, errors } = validateMeta(input, { allowNull: mode === 'merge' });
    if (errors.length) throw new Error('Metadata not saved: ' + errors.join('; '));
    if (isStrictCopyright(env) && patch.licence !== undefined && patch.licence !== null && /^own[-_\s]*recording$/i.test(String(patch.licence).trim())) {
      throw new Error('Metadata not saved: setting licence to "own-recording" via tag_sound is forbidden in strict copyright mode; only live microphone takes recorded through Mix Desk receive user-attested-mic-take provenance.');
    }
    const sidecar = sidecarFor(safe), target = path.join(root, sidecar);
    let existing = {}, warning = null;
    if (mode === 'merge' && siblings.sidecar) {
      const read = await readSidecar(root, siblings.sidecar);
      existing = read.meta;
      if (read.problem) warning = 'The old sidecar had problems; only its valid fields were kept: ' + read.problem;
    }
    const meta = mergeMeta(mode === 'merge' ? existing : {}, patch);
    if (measure && meta.durationSeconds === undefined) {
      for (const f of siblings.files.filter(f => audioFile.test(f)).sort((a, b) => Number(/\.wav$/i.test(b)) - Number(/\.wav$/i.test(a)))) {
        const seconds = await audioSeconds(path.join(root, f));
        if (seconds) { meta.durationSeconds = seconds; break; }
      }
    }
    if (meta.sourceNote) {
      const noteFull = path.resolve(root, meta.sourceNote);
      if (!(await readFile(noteFull, 'utf8').then(() => true, () => false))) throw new Error(`sourceNote ${meta.sourceNote} does not exist in the workspace.`);
    }
    await writeFileAtomic(target, metaText(meta), { overwrite: true });
    return { sidecar, files: siblings.files, meta: ordered(meta), sourceNote: siblings.sourceNote ?? meta.sourceNote ?? null, ...(warning ? { warning } : {}),
      next: 'Rebuild the library page with build_library_page (overwrite: true) to see it filed.' };
  });

  const filterShape = {
    composer: z.string().optional(), era: z.union([z.enum(eras), z.array(z.enum(eras))]).optional(),
    genre: z.union([z.string(), z.array(z.string())]).optional(), mood: z.union([z.string(), z.array(z.string())]).optional(),
    gameUse: z.union([z.enum(gameUses), z.array(z.enum(gameUses))]).optional(), arrangement: z.union([z.enum(arrangements), z.array(z.enum(arrangements))]).optional(),
    licence: z.string().optional(), kind: z.union([z.enum(kinds), z.array(z.enum(kinds))]).optional(), loop: z.boolean().optional(),
    instrumentation: z.string().optional(), title: z.string().optional(), text: z.string().optional().describe('Words to find in any field.'),
  };
  tool('list_tagged', 'List workspace sounds and pieces by their metadata sidecars, filtered by any field: composer, era, genre, mood, gameUse, arrangement, licence, kind, loop, instrumentation, title or free text. Text fields match part of a value ("satie" finds "Erik Satie"); list filters match any value given. Each result gives its files, metadata and source note. Pass untagged: true to list workspace audio that has no sidecar yet. Read-only.', {
    ...filterShape,
    file: fileArg.optional().describe('Return just this file\'s entry.'),
    untagged: z.boolean().default(false),
    includeNote: z.boolean().default(false).describe('Include the source note text.'),
    limit: z.number().int().min(1).max(500).default(100),
  }, async ({ file, untagged, includeNote, limit, ...filters }) => {
    const entries = [], problems = [];
    for (const entry of await scanWorkspace(root)) {
      if (!entry.files.length && !entry.sidecar) continue;
      if (untagged ? entry.sidecar || !entry.files.some(f => audioFile.test(f)) : !entry.sidecar) continue;
      const read = entry.sidecar ? await readSidecar(root, entry.sidecar) : { meta: {}, problem: null };
      if (read.problem) problems.push(read.problem);
      entries.push({ ...entry, meta: read.meta, sourceNote: entry.sourceNote ?? read.meta.sourceNote ?? null });
    }
    let found = filterEntries(entries, filters);
    if (file) { const want = baseOf(safeRelative(file) ?? ''); found = found.filter(e => e.name === want); }
    const results = [];
    for (const entry of found.slice(0, limit)) {
      results.push({ name: entry.name, files: entry.files, sidecar: entry.sidecar, meta: entry.meta, sourceNote: entry.sourceNote,
        ...(includeNote && entry.sourceNote ? { note: await readNote(root, entry.sourceNote) } : {}) });
    }
    const values = {};
    for (const [name] of facets) values[name] = [...new Set(entries.flatMap(e => [].concat(e.meta[name] ?? [])))].sort();
    return { count: found.length, shown: results.length, results, values, ...(problems.length ? { problems } : {}) };
  });
}
