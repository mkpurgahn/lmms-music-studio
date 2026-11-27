import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(process.argv[2] ?? 'output/demo');
await mkdir(workspace, { recursive: true });
const client = new Client({ name: 'lmms-mcp-demo', version: '0.1.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_NO_GUI_LAUNCH: '1' },
}));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 200000 });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

const japaneseInspired = process.argv.includes('--japanese');
const chords = japaneseInspired
  ? [[50, 55, 57, 63], [46, 50, 55, 57], [43, 50, 58, 63], [45, 51, 55, 62]]
  : [[50, 53, 57, 64], [46, 53, 57, 60], [48, 55, 58, 62], [45, 52, 58, 61]];
const sections = ['Approach', 'Pressure', 'Sparks', 'Return'];
const arpOrders = [[0, 2, 3, 1, 2], [0, 1, 3, 2, 1], [2, 3, 1, 2, 3], [0, 2, 1, 3, 2]];
const hit = (step, midi, length, velocity) => ({ tick: step * 12, midi, length, velocity });
function parts(compose) {
  return sections.map((name, index) => ({
    name, bar: index * 4, bars: 4,
    notes: chords.flatMap((chord, bar) => compose(chord, bar, index).map(n => ({ ...n, tick: n.tick + bar * 192 }))),
  }));
}
const arp = parts((chord, bar, section) => {
  const order = arpOrders[(bar + section) % 4];
  const steps = japaneseInspired ? [0, 3, 7, 12] :
    section === 2 ? [0, 3, 6, 9, 12, 14] : [0, 3, 6, 10, 13];
  return steps.map((step, index) => {
    const pitch = chord[order[index % order.length]] + 12;
    return hit(step, pitch + (section === 2 && index === 5 ? 12 : 0), index === 0 ? 13 : 8, [85, 56, 73, 66, 58, 51][index]);
  });
});
const tracks = [
  { name: 'Glass relay', voice: 'pluck', volume: 33, pan: 14, patterns: arp },
  { name: 'Voltage bass', voice: 'bass', volume: 43, pan: 0, patterns: parts((chord, bar) =>
    [hit(0, chord[0] - 12, 29, 89), hit(4, chord[0] - 12, 16, 77),
     hit(7, chord[0], 9, 62), hit(10, chord[0] - 12, 26, 84),
     hit(14, chord[0] - (bar === 3 ? 1 : 12), 11, 66)]) },
  { name: 'Foundry haze', voice: 'pad', volume: 20, pan: -17, patterns: parts((chord, bar, section) =>
    chord.slice(1).map((pitch, index) => hit(section === 2 ? 2 : 0, pitch, bar === 3 ? 146 : 174, 57 - index * 5))) },
  { name: 'Kick', voice: 'kick', volume: 68, pan: 0, patterns: parts((_, bar, section) =>
    (japaneseInspired ? [0, 7, 12] :
      bar === 3 ? [0, 6, 8, 14] : section === 2 ? [0, 4, 8, 11, 14] : [0, 6, 8, 11]).map((step, i) =>
      hit(step, 69, 12, i === 0 ? 100 : 78))) },
  { name: 'Clap', voice: 'clap', volume: 49, pan: -6, patterns: parts((_, bar) =>
    (bar === 3 ? [4, 12, 15] : [4, 12]).map((step, i) => hit(step, 69, 11, i === 2 ? 45 : 87))) },
  { name: 'Closed hat', voice: 'hat', volume: 29, pan: 22, patterns: parts((_, bar, section) =>
    (section === 2 || bar === 3 ? [2, 5, 6, 9, 10, 13, 14, 15] : [2, 6, 10, 14]).map((step, i) =>
      hit(step, 69, 5, [77, 51, 66, 43][i % 4]))) },
];

try {
  const project = 'demo-loop.mmp';
  const alternate = 'demo-loop-sparks-variation.mmp';
  await call('create_project', { output: project, bpm: japaneseInspired ? 112 : 128, tracks });
  const manifest = await call('inspect_project', { project });
  assert.equal(manifest.length, tracks.length);
  assert.ok(manifest.every(t => t.patterns.length === 4));

  const sparse = { ...arp[2], name: 'Sparks sparse', notes: arp[2].notes.filter((_, n) => n % 3 !== 1) };
  const sourceNotes = await call('read_pattern', { project, trackName: 'Glass relay', bar: 8 });
  assert.deepEqual(sourceNotes.notes, arp[2].notes);
  await call('replace_pattern', { project, output: alternate, trackName: 'Glass relay', pattern: sparse });
  const revised = await call('inspect_project', { project: alternate });
  assert.deepEqual(revised.slice(1), manifest.slice(1));
  assert.equal(revised[0].patterns.find(p => p.tick === 1536).notes, sparse.notes.length);
  const [original, changed] = await Promise.all([project, alternate].map(name => readFile(path.join(workspace, name), 'utf8')));
  const untouchedTracks = /<track muted="0" solo="0" type="0" name="Voltage bass">.*$/s;
  assert.ok(untouchedTracks.test(original));
  assert.equal(original.match(untouchedTracks)[0], changed.match(untouchedTracks)[0]);

  console.log(await call('render_mix', { project, output: 'demo-loop.wav' }));
  console.log(await call('render_mix', { project: alternate, output: 'demo-loop-sparks-variation.wav' }));
  const audit = await call('audit_copyright', { project });
  assert.equal(audit.compliant, true);
} finally {
  await client.close().catch(() => {});
}
