// Render a measured demo of a film persona through the LMMS MCP server.
//   node scripts/personas/persona-demo.mjs --persona action-score [--workspace <dir>] [--seed <n>] [--seconds <n>]
// Uses stock LMMS voices and skips cleanly when LMMS is missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCue, cuePersonas, cueProject } from './persona-cues.mjs';
import { articulationContrast, measureWav } from './persona-measure.mjs';
import { getPersona } from '../../tools/personas.mjs';
import { writeFileAtomic } from '../../tools/fs-atomic.mjs';
import { resolveLmmsExecutable } from '../../tools/workspace-config.mjs';

export function lmmsAvailable(env = process.env) {
  const executable = resolveLmmsExecutable(env);
  if (path.isAbsolute(executable)) return existsSync(executable);
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'where.exe' : '/bin/sh',
    windows ? [executable] : ['-c', 'command -v -- "$1"', 'sh', executable],
    { env, stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

async function connect(workspace, env) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'lmms-mcp-persona-demo', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../server.mjs', import.meta.url))], env: { ...env, LMMS_WORKSPACE: workspace } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 590000 });
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  return { client, call };
}

function attachContrast(measured, contrast) {
  if (!contrast) return;
  measured.articulationContrast = contrast.pairs;
  measured.checks.push(...contrast.checks);
}
const contrastIds = cue => [...new Set((cue.contrast ?? []).flatMap(pair => [pair.legato, pair.short]))];

async function renderNative({ call, workspace, cue, persona }) {
  const project = cueProject(cue), name = `${cue.persona}-s${cue.seed}-native`;
  await call('create_project', { output: `${name}-base.mmp`, bpm: project.bpm, lengthBars: project.lengthBars, masterVolume: project.masterVolume, tracks: project.tracks });
  let source = `${name}-base.mmp`;
  if (project.edits.length) {
    await call('apply_edits', { project: source, output: `${name}.mmp`, edits: project.edits });
    source = `${name}.mmp`;
  }
  const render = await call('render_mix', { project: source, output: `${name}.wav`, tail: 'cut', targetLufs: persona.mix.targets.lufs, ceilingDb: persona.mix.targets.truePeakDb - 0.6 });
  const measured = measureWav(await readFile(path.join(workspace, `${name}.wav`)), cue);
  if (cue.contrast) {
    const pair = contrastIds(cue);
    await call('render_stems', { project: source, outputDirectory: `${name}-stems`, tracks: pair });
    const files = await readdir(path.join(workspace, `${name}-stems`)); // render_stems numbers each file by track position
    const stems = Object.fromEntries(await Promise.all(pair.map(async id => [id, await readFile(path.join(workspace, `${name}-stems`, files.find(file => file.endsWith(`_${id}.wav`))))])));
    attachContrast(measured, articulationContrast(cue, stems));
  }
  return { route: 'native', audio: path.join(workspace, `${name}.wav`), project: path.join(workspace, source), render: { mastering: render.mastering }, measured };
}

export async function runDemo(id, { workspace, mode = 'native', seed, seconds, env = process.env } = {}) {
  const persona = getPersona(id), cue = buildCue(persona, { seed, seconds });
  const result = { persona: id, seed: cue.seed, bpm: cue.bpm, key: cue.key, bars: cue.bars, cueSeconds: cue.seconds, routes: [], skipped: [] };
  if (!lmmsAvailable(env)) { result.skipped.push({ route: 'all', reason: 'LMMS was not found. Set LMMS_EXECUTABLE.' }); return result; }
  if (mode === 'sampled') { result.skipped.push({ route: 'sampled', reason: 'External VST3 sampler route has been retired in V3; use native LMMS or SoundFont rendering.' }); return result; }
  await mkdir(workspace, { recursive: true });
  const { client, call } = await connect(workspace, env);
  try {
    result.routes.push(await renderNative({ call, workspace, cue, persona }));
  } finally {
    await client.close();
  }
  await writeFileAtomic(path.join(workspace, `${id}-s${cue.seed}-report.json`), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const requested = flag('persona') ?? 'all', ids = requested === 'all' ? cuePersonas : [requested];
  const workspace = path.resolve(flag('workspace') ?? 'assets/persona-demos');
  const options = { workspace, mode: flag('mode') ?? 'native', seed: flag('seed') ? Number(flag('seed')) : undefined, seconds: flag('seconds') ? Number(flag('seconds')) : undefined };
  for (const id of ids) process.stderr.write(JSON.stringify(await runDemo(id, options), null, 2) + '\n');
}
