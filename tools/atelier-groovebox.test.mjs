import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { loadAtelierGroovebox, register } from './atelier-groovebox.mjs';
import { writeProvenanceSidecar } from './provenance.mjs';

test('a missing optional groovebox checkout gives an actionable message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-unavailable-'));
  try {
    await assert.rejects(loadAtelierGroovebox(root), /Install or link atelier-dsp locally/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let engine;
try {
  engine = await loadAtelierGroovebox();
} catch (error) {
  if (!error.message.startsWith('Install or link atelier-dsp locally')) throw error;
}

test('optional Atelier tools build a grid, load a kit and render WAV and MIDI', { skip: !engine }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-groovebox-'));
  const tools = new Map();
  register({
    root, z, schemas: { workspaceWav: z.string().regex(/^[a-z0-9_-]+\.wav$/i) },
    tool: (name, _description, input, handler) => { tools.set(name, args => handler(z.object(input).parse(args))); },
  });
  try {
    const { project } = await tools.get('groovebox_pattern')({
      bpm: 124, rootMidi: 36, drums: [{ pad: 0, step: 0, velocity: 0.8 }], acid: [{ step: 4, midi: 43, accent: true }],
    });
    assert.equal(project.patterns[0].drums[0][0], 0.8);
    assert.equal(project.patterns[0].acid[4].accent, true);
    await writeFile(path.join(root, 'kit.json'), JSON.stringify({ pads: project.pads }));
    assert.deepEqual((await tools.get('load_pad_kit')({ file: 'kit.json' })).pads, project.pads);
    const render = tools.get('render_groovebox');
    await render({ project, output: 'beat.wav', seed: 82 });
    await render({ project, output: 'beat.mid' });
    assert.equal((await readFile(path.join(root, 'beat.wav'))).toString('ascii', 0, 4), 'RIFF');
    assert.equal((await readFile(path.join(root, 'beat.mid'))).toString('ascii', 0, 4), 'MThd');
    await assert.rejects(render({ project, output: 'beat.wav' }), { code: 'EEXIST' });
    const recording = Float32Array.from({ length: 1200 }, (_, i) => 0.4 * Math.sin(i * Math.PI / 20));
    await writeFile(path.join(root, 'input.wav'), engine.encodeWav({ sampleRate: 24000, left: recording, right: recording }));
    await writeProvenanceSidecar(path.join(root, 'input.wav'), {
      workspaceDir: root,
      classification: 'pure-synthesis',
      generatorTool: 'atelier-test-fixture',
      sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'test', licence: 'MIT' }],
    });
    project.pads[0] = { type: 'sample', sampleId: 'local-take', start: 0.2, end: 0.8, tune: 2 };
    await assert.rejects(render({ project, output: 'sample.wav' }), /Missing WAV sample/);
    await render({ project, output: 'sample.wav', samples: { 'local-take': 'input.wav' } });
    assert.equal((await readFile(path.join(root, 'sample.wav'))).toString('ascii', 0, 4), 'RIFF');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
