import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const registry = JSON.parse(await readFile(new URL('../schema/generation-licences.json', import.meta.url), 'utf8'));
const unknown = { id: 'unverified-input', licence: 'unknown', credit: null, source: null };
const sha = value => createHash('sha256').update(value).digest('hex');
const finite = value => Number.isFinite(value) ? value : null;
const allowed = new Set(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'MIT']);
const factoryDrums = 'lmms-factory-drums';

async function regularFile(root, filename) {
  const full = await realpath(path.resolve(root, filename));
  const relative = path.relative(root, full);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error('Catalogue file is outside the workspace');
  }
  if (!(await stat(full)).isFile()) throw new Error('Catalogue requires a regular file');
  return { full, path: relative.split(path.sep).join('/') };
}

async function fingerprint(root, filename) {
  const file = await regularFile(root, filename);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file.full)) hash.update(chunk);
  return { path: file.path, sha256: hash.digest('hex') };
}

function outputs(tool, args, result) {
  const entry = (files, facts = result, options = args) => ({ files, facts, options });
  const inFolder = filename => path.join(result.directory ?? args.outputDirectory, filename);
  switch (tool) {
    case 'synth_drums': return [entry([...result.files.map(file => file.file), result.manifest])];
    case 'layer_drum':
    case 'tune_drum': return [entry([result.file])];
    case 'create_drum_kit': return [entry([result.project])];
    case 'master_audio':
    case 'export_midi': return [entry([result.file])];
    case 'render_mix': return [entry([result.audio])];
    case 'render_fathom_track': return [entry([args.audio, args.output])];
    case 'render_stems': return [entry(result.stems.map(stem => inFolder(stem.file)))];
    case 'export_game_audio':
      return [entry([...result.files.flatMap(file => [inFolder(file.file), ...(file.ogg ? [inFolder(file.ogg)] : [])]), inFolder(result.manifest)])];
    case 'export_one_shots':
      return [entry([...result.files.map(file => inFolder(file.file)), inFolder('manifest.json')])];
    default: return [];
  }
}

export function generationStore(workspace, { measure, describeProject } = {}) {
  const catalog = path.join(workspace, 'catalog', 'catalog.jsonl');
  let pending = Promise.resolve();
  const serial = task => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };

  async function checkIndex() {
    for (const [target, method] of [[path.dirname(catalog), 'isDirectory'], [catalog, 'isFile']]) {
      const info = await lstat(target).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info && !info[method]()) throw new Error('Catalogue requires a regular index inside the workspace');
    }
  }

  async function records() {
    await checkIndex();
    const data = await readFile(catalog, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const index = new Map();
    for (const line of data.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.event === 'rating') {
        const previous = index.get(record.id);
        if (previous) index.set(record.id, { ...previous, rating: record.rating, feedback: record.feedback });
      } else if (record.event === 'location') {
        const previous = index.get(record.id);
        if (previous) index.set(record.id, { ...previous, locations: { ...previous.locations, [record.target]: record.location } });
      } else if (!index.has(record.id)) {
        index.set(record.id, record);
      }
    }
    return index;
  }

  async function append(record) {
    await mkdir(path.dirname(catalog), { recursive: true });
    await checkIndex();
    await appendFile(catalog, JSON.stringify(record) + '\n');
  }

  async function save(root, tool, args, facts, names, sources) {
    const files = await Promise.all(names.map(name => fingerprint(root, name)));
    const inputNames = [tool === 'tune_drum' ? args.input : null,
      ...(tool === 'layer_drum' ? args.layers.map(layer => layer.file) : []), args.project, args.midi, tool === 'master_audio' ? args.audio : null,
      ...(args.sounds ?? []).map(sound => sound.input)].filter(Boolean);
    const inputs = await Promise.all([...new Set(inputNames)].map(async name => {
      try {
        return await fingerprint(root, name);
      } catch {
        return { path: name, sha256: null };
      }
    }));
    const index = await records();
    const project = facts.project ?? args.project ?? names.find(name => /\.mmpz?$/i.test(name));
    const details = project && describeProject ? await describeProject(project).catch(() => ({})) : {};
    const hashes = new Set([...files, ...inputs].map(file => file.sha256).filter(Boolean));
    const inheritsDrums = [...index.values()].some(record =>
      record.sampleLibraries.some(library => library.id === factoryDrums)
      && record.files.some(file => hashes.has(file.sha256)));
    if (details.usesFactoryDrums || inheritsDrums) sources = [...new Set([...(sources ?? []), factoryDrums])];
    const id = sha(JSON.stringify({ tool, args, files, inputs, sources }));
    const existing = index.get(id);
    if (existing) return existing;
    const wav = files.find(file => file.path.endsWith('/mix.wav')) ?? files.find(file => /\.wav$/i.test(file.path));
    const analysis = wav && measure ? await measure(path.join(root, wav.path)).catch(() => ({})) : {};
    const sampleLibraries = sources?.map(source => ({ id: source, ...registry[source] })) ?? [unknown];
    const primary = files[0].path;
    const sidecar = `${primary}.generation-${id}.json`;
    const manifest = {
      version: 1, id, created: new Date().toISOString(), tool, args,
      game: facts.game ?? args.game ?? null, seed: facts.seed ?? args.seed ?? null,
      style: facts.style ?? args.style ?? null, key: facts.key ?? args.key ?? null,
      bpm: facts.bpm ?? args.bpm ?? details.bpm ?? null,
      instruments: [...new Set([...(details.instruments ?? []), ...(args.tracks ?? []).flatMap(track => track.instrument ?? [])])],
      plugins: [...new Set([...(details.plugins ?? []), ...(args.tracks ?? []).flatMap(track => track.instrument ?? [])])],
      sampleLibraries,
      durationSeconds: finite(facts.durationSeconds ?? facts.lengthSeconds ?? analysis.durationSeconds),
      integratedLufs: finite(facts.integratedLufs ?? facts.after?.lufs ?? analysis.integratedLufs),
      truePeakDbfs: finite(facts.truePeakDbfs ?? facts.after?.truePeakDb ?? analysis.truePeakDbfs),
      files, inputs, rating: null, feedback: null,
      locations: { local: sidecar, r2: null, hf: null },
      publishable: sampleLibraries.length > 0 && sampleLibraries.every(s => (allowed.has(s.licence) || s.outputLicence === 'unrestricted-synthesis') && s.credit),
    };
    try {
      await writeFile(path.join(root, sidecar), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const saved = JSON.parse(await readFile((await regularFile(root, sidecar)).full, 'utf8'));
      if (saved.id !== id) throw error;
      await append(saved);
      return saved;
    }
    await append(manifest);
    return manifest;
  }

  return {
    async record(tool, args, result) {
      const items = outputs(tool, args, result);
      if (!items.length) return [];
      const root = await realpath(workspace);
      return serial(async () => {
        const ids = [];
        for (const item of items) {
          const sources = tool === 'synth_drums'
            ? ['lmms-mcp-drum-synthesis']
            : (tool === 'create_drum_kit' && result?.licenceId ? [result.licenceId] : undefined);
          ids.push((await save(root, tool, item.options, item.facts, item.files, sources)).id);
        }
        return ids;
      });
    },
    async list(filters) {
      const matches = [...(await records()).values()].filter(entry =>
        (filters.style === undefined || filters.style === entry.style)
        && (filters.game === undefined || filters.game === entry.game)
        && (filters.rating === undefined || filters.rating === entry.rating)
        && (filters.licence === undefined || entry.sampleLibraries.some(s => s.licence === filters.licence))
        && (filters.since === undefined || entry.created.slice(0, 10) >= filters.since)
        && (filters.until === undefined || entry.created.slice(0, 10) <= filters.until));
      return matches.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    },
    async show(id) {
      const entry = (await records()).get(id);
      if (!entry) throw new Error('Unknown generation ID');
      return entry;
    },
    async rate(id, rating, feedback) {
      return serial(async () => {
        const entry = await this.show(id);
        const note = feedback === undefined ? entry.feedback : feedback;
        await append({ event: 'rating', id, rating, feedback: note, created: new Date().toISOString() });
        return { ...entry, rating, feedback: note };
      });
    },
    async setLocation(id, target, location) {
      if (!['r2', 'hf'].includes(target)) throw new Error('Unknown location target');
      return serial(async () => {
        const entry = await this.show(id);
        await append({ event: 'location', id, target, location, created: new Date().toISOString() });
        return { ...entry, locations: { ...entry.locations, [target]: location } };
      });
    },
    async backfill(directory, sources, game) {
      const root = await realpath(workspace);
      const folder = await realpath(path.join(root, directory));
      const relative = path.relative(root, folder);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
        throw new Error('Catalogue folder is outside the workspace');
      }
      if (sources?.some(source => !Object.hasOwn(registry, source))) throw new Error('Unknown licence registry ID');
      return serial(async () => {
        const files = await readdir(folder, { withFileTypes: true });
        const known = new Set([...(await records()).values()].flatMap(entry => entry.files.map(file => `${file.path}:${file.sha256}`)));
        const ids = [];
        for (const file of files) {
          if (!file.isFile() || !/\.(wav|ogg|mp3|mid|midi|mmp|mmpz)$/i.test(file.name)) continue;
          const name = path.join(relative, file.name);
          const info = await fingerprint(root, name);
          if (!sources && known.has(`${info.path}:${info.sha256}`)) continue;
          ids.push((await save(root, 'backfill_catalog', { file: info.path, game: game ?? null }, {}, [name], sources)).id);
        }
        return ids;
      });
    },
  };
}

export function register({ tool, z, generations, schemas }) {
  const id = z.string().regex(/^[a-f0-9]{64}$/);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  tool('list_generations', 'List catalogue records. Filters combine and dates are inclusive UTC dates.', {
    style: z.string().optional(), game: z.string().optional(), rating: z.number().int().min(1).max(5).optional(),
    licence: z.string().optional(), since: date.optional(), until: date.optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50),
  }, async ({ offset, limit, ...filters }) => {
    const matches = await generations.list(filters);
    return { total: matches.length, generations: matches.slice(offset, offset + limit) };
  });
  tool('show_generation', 'Read a generation manifest with its latest catalogue rating.', { id },
    async ({ id }) => generations.show(id));
  tool('rate_generation', 'Set a 1–5 catalogue rating. Optionally include a note or an audition feedback reference after read_feedback.', {
    id, rating: z.number().int().min(1).max(5), feedback: z.string().max(2000).nullable().optional(),
  }, async ({ id, rating, feedback }) => generations.rate(id, rating, feedback));
  tool('backfill_catalog', 'Index immediate audio, MIDI and project files. Only supply verified library IDs for a folder whose inputs you have checked.', {
    directory: schemas.folderName.optional(), game: z.string().max(80).optional(),
    verifiedLibraries: z.array(z.enum(Object.keys(registry))).min(1).optional(),
  }, async ({ directory = '.', verifiedLibraries, game }) => ({ ids: await generations.backfill(directory, verifiedLibraries, game) }));
}
