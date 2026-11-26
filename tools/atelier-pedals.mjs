import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeWav, encodeWav } from '../audio.mjs';
import { loadAtelierModule, readWorkspaceFile } from './atelier-groovebox.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

export function register({ tool, z, root, schemas }) {
  const point = z.strictObject({ seconds: z.number().min(0).max(600), value: z.number().min(0).max(1) });
  tool('render_pedal_chain', 'Process a workspace WAV through the optional local Atelier pedalboard. Use a saved atelier-pedalboard/1 JSON preset and optional linear heel-to-toe wah automation in seconds. Preserves the dry file and writes a new stereo WAV.', {
    audio: schemas.workspaceWav,
    preset: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.json$/i),
    output: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.wav$/i),
    wah: z.array(point).min(1).max(512).optional(),
    tailSeconds: z.number().min(0).max(12).default(0),
    outputGainDb: z.number().min(-48).max(12).default(0),
  }, async ({ audio, preset, output, wah, tailSeconds = 0, outputGainDb = 0 }) => {
    const inputCheck = await verifyAudioFileProvenance(path.join(root, audio), {
      workspaceDir: root,
      env: process.env,
    });
    const engine = await loadAtelierModule('pedalboard', 'src/pedalboard/index.js');
    const saved = JSON.parse(await readWorkspaceFile(root, preset, 256 * 1024));
    if (saved?.format !== 'atelier-pedalboard/1' || !Array.isArray(saved.pedals)) throw new Error('Expected an Atelier pedalboard preset.');
    const state = engine.normalizePedalState(saved.pedals);
    const dry = decodeWav(await readWorkspaceFile(root, audio, 64 * 1024 * 1024));
    if (dry.channels.length > 2 || dry.frames === 0 || dry.frames / dry.sampleRate > 600) {
      throw new Error('Provide a nonempty mono or stereo WAV no longer than ten minutes.');
    }
    const frames = dry.frames + Math.round(dry.sampleRate * tailSeconds);
    const automation = wah?.map(point => ({ frame: Math.round(point.seconds * dry.sampleRate), value: point.value }));
    if (automation?.some(({ frame }, i) => frame >= frames || (i > 0 && frame <= automation[i - 1].frame))) {
      throw new Error('Wah points must be strictly increasing within the output duration.');
    }
    const wahPedal = state.find(pedal => pedal.id === 'wah');
    if (automation && (!wahPedal || wahPedal.bypass)) throw new Error('Enable the wah in the pedalboard preset before automating it.');
    const chain = engine.createPedalChain(dry.sampleRate, state);
    const [left, right = left] = dry.channels;
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    const pair = new Float64Array(2), gain = 10 ** (outputGainDb / 20);
    let point = 0, peak = 0, clippedSamples = 0;
    for (let frame = 0; frame < frames; frame++) {
      if (automation && frame >= automation[0].frame) {
        const crossed = point + 1 < automation.length && frame >= automation[point + 1].frame;
        if (crossed) point++;
        if (frame % 32 === 0 || crossed || frame === automation[0].frame) {
          const current = automation[point], next = automation[point + 1];
          const position = next ? current.value + (next.value - current.value) * (frame - current.frame) / (next.frame - current.frame) : current.value;
          if (position !== wahPedal.controls[0]) {
            wahPedal.controls[0] = position;
            chain.set(state);
          }
        }
      }
      chain.process(left[frame] ?? 0, right[frame] ?? 0, pair);
      for (let channel = 0; channel < 2; channel++) {
        const value = pair[channel] * gain;
        if (!Number.isFinite(value)) throw new Error('Pedal processing returned a non-finite sample.');
        peak = Math.max(peak, Math.abs(value));
        if (Math.abs(value) > 1) clippedSamples++;
        channels[channel][frame] = value;
      }
    }
    const outPath = path.join(root, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, encodeWav({ sampleRate: dry.sampleRate, channels }), { overwrite: false });
    await writeDerivedAudioProvenance(outPath, [inputCheck], {
      workspaceDir: root,
      generatorTool: 'render_pedal_chain',
    });
    return { audio, preset, output, sampleRate: dry.sampleRate, frames, peak, clippedSamples, wahPoints: wah?.length ?? 0 };
  });
}
