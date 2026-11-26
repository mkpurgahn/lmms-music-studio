import path from 'node:path';
import midiPackage from '@tonejs/midi';
import { modelFromDoc } from './arranger-lint.mjs';
import { loadAtelierModule, readWorkspaceFile } from './atelier-groovebox.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { assertProjectProvenance, writeProvenanceSidecar } from './provenance.mjs';

const modules = {
  atelier: 'src/instruments/atelier/index.js',
  theremin: 'src/instruments/theremin/index.js',
  'atelier-factory': 'src/instruments/atelier/factory.js',
};
export function loadInstrument(kind) {
  return loadAtelierModule(kind, modules[kind]);
}
function selectTrack(tracks, name) {
  const matching = tracks.filter(track => track.notes.length && (name === undefined || track.name === name));
  if (matching.length !== 1) throw new Error('Select exactly one nonempty track by name.');
  return matching[0].notes;
}

function align(render, seconds) {
  if (seconds === undefined) return render;
  const count = Math.round(seconds * render.sampleRate);
  if (count < render.left.length) throw new Error('durationSeconds must include the voice release or reverb tail.');
  const left = new Float32Array(count), right = new Float32Array(count);
  left.set(render.left);
  right.set(render.right);
  return { sampleRate: render.sampleRate, left, right };
}

export function register({ tool, z, root, paths, schemas, project, dsp }) {
  const note = z.strictObject({
    midi: z.number().min(0).max(127), start: z.number().min(0).max(300).default(0),
    duration: z.number().positive().max(300), velocity: z.number().min(0).max(1).optional(),
    slideFrom: z.number().min(0).max(127).optional(),
  });
  const pointPitch = { midi: z.number().min(0).max(127).optional(), hz: z.number().positive().optional() };
  const point = z.strictObject({ time: z.number().min(0).max(300), ...pointPitch, amplitude: z.number().min(0).max(1).optional() });
  const performedNote = z.strictObject({ start: z.number().min(0).max(300).optional(), duration: z.number().positive().max(300),
    ...pointPitch, amplitude: z.number().min(0).max(1).optional() });
  const length = z.number().positive().max(600).optional();
  async function save(render, output, durationSeconds, generatorTool, pluginOrLibrary) {
    const take = align(render, durationSeconds);
    const outPath = path.join(root, output);
    await writeFileAtomic(outPath, dsp.encodeWav({ sampleRate: take.sampleRate, channels: [take.left, take.right] }), { overwrite: false });
    await writeProvenanceSidecar(outPath, {
      workspaceDir: root,
      classification: 'pure-synthesis',
      generatorTool,
      sources: [{
        kind: 'pure-synthesis',
        pluginOrLibrary,
        licence: 'unrestricted-synthesis',
      }],
    });
    return { file: output, sampleRate: take.sampleRate, frames: take.left.length, channels: 2 };
  }
  tool('render_atelier', 'Render a Fathom, Vesper or Halo voice to a stereo WAV stem. Load a workspace bank or use the installed factory bank.', {
    model: z.enum(['fathom', 'vesper', 'halo']).optional(),
    bank: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.json$/i).optional(),
    preset: z.string().min(1).max(80).optional(),
    midiFile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i).optional(),
    project: schemas.projectName.optional(), track: z.string().min(1).max(120).optional(),
    notes: z.array(note).min(1).max(4096).optional(),
    seed: z.number().int().min(0).max(4294967295).optional(), durationSeconds: length, output: schemas.wavName,
  }, async ({ model, bank, preset, midiFile, project: projectFile, track, notes, seed, durationSeconds, output }) => {
    if ([midiFile, projectFile, notes].filter(Boolean).length !== 1) throw new Error('Supply exactly one of notes, midiFile or project.');
    const engine = await loadInstrument('atelier');
    let input;
    if (midiFile) {
      const midi = new midiPackage.Midi(await readWorkspaceFile(root, midiFile, 4 * 1024 * 1024));
      input = selectTrack(midi.tracks, track).map(({ midi, time, duration, velocity }) => ({ midi, start: time, duration, velocity }));
    } else if (projectFile) {
      const doc = await project.load(projectFile);
      await assertProjectProvenance(doc, {
        projectName: projectFile,
        workspaceDir: root,
        soundfontsDir: paths?.soundfonts,
        presetsDir: paths?.presets,
        env: process.env,
      });
      const secondsPerTick = 60 / (project.songInfo(doc).bpm * 48);
      input = selectTrack(modelFromDoc(doc, project).tracks, track).map(({ midi, tick, length, velocity }) => ({
        midi, start: tick * secondsPerTick, duration: length * secondsPerTick, velocity: Math.min(1, velocity / 100),
      }));
    } else input = notes;
    const bankData = bank ? await readWorkspaceFile(root, bank, 2 * 1024 * 1024) : undefined;
    const patch = preset && !bankData ? await (await loadInstrument('atelier-factory')).readFactoryAtelierPatch(preset) : undefined;
    return save(
      engine.renderAtelier({ model, preset, patch, bank: bankData?.toString('utf8'), notes: input, sampleRate: 48000, seed }),
      output,
      durationSeconds,
      'render_atelier',
      `atelier:${model ?? 'atelier'}`,
    );
  });

  tool('render_theremin', 'Render a theremin line from explicit notes or a continuous pitch curve to stereo WAV.', {
    notes: z.array(performedNote).min(1).max(4096).optional(), curve: z.array(point).min(2).max(4096).optional(),
    mode: z.enum(['free', 'scale']).optional(), key: z.string().max(2).optional(), scale: z.enum(['major', 'minor', 'pentatonic', 'blues']).optional(),
    preset: z.enum(['classic-sci-fi', 'eerie-pad', 'soaring-lead', 'wobble']).optional(),
    vibratoOnset: z.number().min(0).max(5).optional(), vibratoRate: z.number().min(0).max(16).optional(), vibratoCents: z.number().min(0).max(200).optional(),
    durationSeconds: length, output: schemas.wavName,
  }, async ({ output, durationSeconds, ...options }) => {
    const engine = await loadInstrument('theremin');
    return save(engine.renderTheremin({ ...options, sampleRate: 48000 }), output, durationSeconds, 'render_theremin', 'atelier:theremin');
  });
}
