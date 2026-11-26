// The private sound engine is loaded only when a groovebox tool is called.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './fs-atomic.mjs';
import {
  verifyAudioFileProvenance,
  writeDerivedAudioProvenance,
  writeProvenanceSidecar,
} from './provenance.mjs';

const name = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const missing = 'Install or link atelier-dsp locally, or set LMMS_ATELIER_DSP to its absolute repository path.';
const maxWavBytes = 32 * 1024 * 1024;

export async function loadAtelierModule(name, entry, directory = process.env.LMMS_ATELIER_DSP) {
  if (directory && !path.isAbsolute(directory)) throw new Error('LMMS_ATELIER_DSP must be an absolute directory path.');
  const source = directory
    ? pathToFileURL(path.join(directory, entry)).href
    : `atelier-dsp/${name}`;
  try {
    return await import(source);
  } catch (error) {
    if ((error.code === 'ERR_MODULE_NOT_FOUND' && (directory ? error.url === source : error.message.includes("package 'atelier-dsp'"))) || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new Error(missing, { cause: error });
    }
    throw error;
  }
}

export const loadAtelierGroovebox = directory => loadAtelierModule('groovebox', 'src/groovebox/index.js', directory);

export async function readWorkspaceFile(root, input, limit) {
  const realRoot = await realpath(root);
  const filename = await realpath(path.join(realRoot, input));
  const relative = path.relative(realRoot, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Input must resolve inside LMMS_WORKSPACE.');
  }
  const info = await stat(filename);
  if (!info.isFile() || info.size > limit) throw new Error(`Input must be a file no larger than ${limit} bytes.`);
  return readFile(filename);
}

export function register({ tool, z, root, schemas }) {
  const kitFile = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.json$/i);
  const event = z.strictObject({
    pad: z.number().int().min(0).max(15), step: z.number().int().min(0).max(15), velocity: z.number().min(0).max(1),
  });
  const acid = z.strictObject({
    step: z.number().int().min(0).max(15), midi: z.number().int().min(12).max(119), accent: z.boolean().optional(), slide: z.boolean().optional(),
  });

  tool('groovebox_pattern', 'Build a normalized Atelier groovebox project with a drum grid and an optional accent/slide bass lane. Pad and step indices start at 0.', {
    kit: z.string().regex(name).optional(), bpm: z.number().min(35).max(300).optional(),
    rootMidi: z.number().int().min(12).max(84).optional(), swing: z.number().min(0).max(0.75).optional(),
    drums: z.array(event).max(256).optional(), acid: z.array(acid).max(16).optional(),
  }, async ({ kit, bpm, rootMidi, swing, drums = [], acid: notes = [] }) => {
    const engine = await loadAtelierGroovebox();
    const project = engine.createProject({ kit, bpm, rootMidi });
    if (swing !== undefined) project.swing = swing;
    const [pattern] = project.patterns;
    for (const { pad, step, velocity } of drums) pattern.drums[pad][step] = velocity;
    for (const { step, midi, accent = false, slide = false } of notes) pattern.acid[step] = { midi, accent, slide };
    return { project: engine.normalizeProject(project) };
  });

  tool('load_pad_kit', 'Read and validate an Atelier pad kit JSON in the workspace. The file may contain a pads array or an object with a pads field.', {
    file: kitFile,
  }, async ({ file }) => {
    const engine = await loadAtelierGroovebox();
    const input = JSON.parse(await readWorkspaceFile(root, file, 256 * 1024));
    return { pads: engine.normalizeKit(Array.isArray(input) ? input : input?.pads) };
  });

  tool('render_groovebox', 'Render an Atelier groovebox project to a new stereo WAV or export the pattern chain as MIDI. Supply workspace WAV files for sampler asset IDs.', {
    project: z.json(),
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.(wav|mid)$/i),
    samples: z.record(z.string().min(1).max(128), schemas.workspaceWav).refine(entries => Object.keys(entries).length <= 16).optional(),
    seed: z.number().int().min(0).max(4294967295).optional(),
  }, async ({ project, output, samples = {}, seed }) => {
    const engine = await loadAtelierGroovebox();
    const score = engine.normalizeProject(project);
    const midi = output.toLowerCase().endsWith('.mid');
    const assets = new Map();
    const inputChecks = [];
    if (!midi) {
      let sourceBytes = 0;
      for (const [id, file] of Object.entries(samples)) {
        const check = await verifyAudioFileProvenance(path.join(root, file), {
          workspaceDir: root,
          env: process.env,
        });
        inputChecks.push(check);
        const bytes = await readWorkspaceFile(root, file, maxWavBytes - sourceBytes);
        sourceBytes += bytes.length;
        assets.set(id, engine.decodeWav(bytes));
      }
    }
    const data = midi ? engine.encodeMidi(score) : engine.encodeWav(engine.renderGroovebox(score, { sampleRate: 48000, samples: assets, seed }));
    const outPath = path.join(root, output);
    await writeFileAtomic(outPath, data, { overwrite: false });
    if (!midi) {
      if (inputChecks.length > 0) {
        await writeDerivedAudioProvenance(outPath, inputChecks, {
          workspaceDir: root,
          generatorTool: 'render_groovebox',
          extraSources: [{
            classification: 'pure-synthesis',
            kind: 'pure-synthesis',
            pluginOrLibrary: 'atelier-groovebox',
            licence: 'unrestricted-synthesis',
          }],
        });
      } else {
        await writeProvenanceSidecar(outPath, {
          workspaceDir: root,
          classification: 'pure-synthesis',
          generatorTool: 'render_groovebox',
          sources: [{
            kind: 'pure-synthesis',
            pluginOrLibrary: 'atelier-groovebox',
            licence: 'unrestricted-synthesis',
          }],
        });
      }
    }
    return { file: output, format: midi ? 'midi' : 'wav', bytes: data.length };
  });
}
