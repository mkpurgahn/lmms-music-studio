// End-to-end check of develop_motif, list_blueprints and create_from_blueprint through a real stdio connection and the installed LMMS.
// Every blueprint is created at two tempos and rendered. The checks are measurements, not listening.
// Run: node verify-blueprints.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-blueprints-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-blueprints-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_NO_GUI_LAUNCH: '1' },
}));
async function raw(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
}
async function call(name, args = {}) {
  const result = await raw(name, args);
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}
async function fails(name, args, pattern) {
  const result = await raw(name, args);
  assert.ok(result.isError, `${name} should have failed`);
  assert.match(result.content[0].text, pattern);
}
const step = label => console.log('ok', label);
const rows = [];
let lintWarnings = 0;
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['develop_motif', 'list_blueprints', 'create_from_blueprint']) assert.ok(tools.includes(name), name);
  const started = await call('get_started');
  assert.ok(started.moduleGuidance.some(line => line.includes('create_from_blueprint')), 'guidance points at blueprints');
  assert.ok(started.moduleGuidance.some(line => line.includes('develop_motif')), 'guidance points at develop_motif');
  step('tools are registered and get_started carries the guidance');

  const developed = await call('develop_motif', { motif: 'D5:2 F5:2 A5:4 G5:2 F5:2 E5:4', key: 'D minor' });
  assert.equal(developed.variations.length, 14);
  const cadenceLine = developed.variations.find(v => v.operation === 'cadence').line;
  await call('create_project', { output: 'motif.mmp', bpm: 120, tracks: [{ name: 'Lead', voice: 'pluck', role: 'lead', volume: 60,
    patterns: [{ name: 'Cadence', bar: 0, bars: 1, melody: { line: cadenceLine, repeat: false } }] }] });
  await fails('develop_motif', { motif: 'D5:2', key: 'H minor' }, /Unknown key/);
  step('develop_motif lines paste straight into create_project');

  const { blueprints } = await call('list_blueprints');
  assert.equal(blueprints.length, 9);
  assert.ok(blueprints.every(b => b.sections.length && b.tracks.length));
  await fails('create_from_blueprint', { blueprint: 'overworld', output: 'x.mmp', lengthSeconds: 30, lengthBars: 8 }, /not both/);
  await fails('create_from_blueprint', { blueprint: 'overworld', output: 'no-motif.mmp', lengthBars: 8, progression: 'I V vi IV' }, /caller-supplied motif/i);
  await fails('create_from_blueprint', { blueprint: 'overworld', output: 'no-prog.mmp', lengthBars: 8, motif: '1:2 3:2 5:4 r:8' }, /caller-supplied progression/i);
  step('list_blueprints returns nine plans and enforces caller-supplied motif and progression in strict mode');

  const callerSpecFor = b => {
    if (b.id === 'victory') return { motif: '5,:2 1:2 3:4 5:4 3:2 5:2', progression: 'I IV' };
    if (b.id === 'dungeon') return { motif: '1:8 2:4 1:4 r:16 5,:4 6,:4 5,:8 r:16', progression: 'i i II i' };
    if (b.key.includes('phrygian')) return { motif: '1:2 2:2 1:4 5:4 4:2 2:2 1:4 r:12', progression: 'i II i vii' };
    if (b.key.includes('minor')) return { motif: '1:2 3:2 5:4 4:2 3:2 2:4 1:4 r:12', progression: 'i VI III VII' };
    return { motif: '1:2 3:2 5:4 6:2 5:2 3:4 2:4 1:4 r:8', progression: 'I V vi IV' };
  };

  // BLUEPRINTS=town,boss limits the run to those blueprints while you work on them.
  const only = process.env.BLUEPRINTS?.split(',');
  for (const b of blueprints.filter(b => !only || only.includes(b.id))) {
    const tempos = [b.bpm, Math.round(b.bpm * (b.bpm > 120 ? 0.8 : 1.25))];
    for (const [index, bpm] of tempos.entries()) {
      const own = index === 1 && b.kind === 'loop';
      const output = `${b.id}-${bpm}.mmp`;
      const baseCaller = callerSpecFor(b);
      const created = await call('create_from_blueprint', {
        blueprint: b.id, output, bpm, lengthSeconds: b.kind === 'stinger' ? 8 : 45,
        sounds: index === 1 ? 'suggested' : 'default',
        ...(own
          ? {
            motif: 'E5:2 G5:1 F#5:1 E5:2 B4:2 C5:4 r:4',
            key: 'E',
            progression: b.key.includes('major') ? 'E C#m A B' : (b.key.includes('phrygian') ? 'Em F Em Dm' : 'Em C G D'),
          }
          : baseCaller),
      });
      assert.equal(created.lengthSeconds, Number((created.lengthBars * 240 / bpm).toFixed(4)));
      assert.ok(created.tracks.every(t => t.role), 'every track has a role');
      const arrangement = await call('inspect_arrangement', { project: output });
      const roles = arrangement.tracks.filter(t => t.role && t.role !== 'length pin').map(t => t.role);
      assert.equal(roles.length, created.tracks.length, 'roles are stored on the tracks');
      assert.equal(roles.filter(r => r === 'lead').length, 1);
      assert.ok(roles.filter(r => r === 'counter').length <= 1);

      // The arrangement lint (tools/arranger-lint.mjs) must find no errors.
      if (tools.includes('lint_arrangement')) {
        const lint = await call('lint_arrangement', { project: output, key: created.key });
        const errors = (lint.findings ?? []).filter(f => f.severity === 'error');
        assert.deepEqual(errors.map(f => f.message), [], `${output}: lint errors`);
        lintWarnings += (lint.findings ?? []).filter(f => f.severity === 'warning').length;
      }
      const audio = `${b.id}-${bpm}.wav`;
      const mix = await call('render_mix', { project: output, output: audio });
      // LMMS renders whole frames per tick, so at tempos where a tick is not a whole number of samples the file can be up to one tick short.
      const tick = 60 / (bpm * 48);
      assert.ok(Math.abs(mix.durationSeconds - created.lengthSeconds) < tick, `${output}: rendered ${mix.durationSeconds} s, expected ${created.lengthSeconds} s`);
      assert.equal(mix.fullScaleSamples, 0, `${output}: clipped samples`);

      const report = await call('analyze_audio', { audio, bpm, sections: created.sections.map(s => ({ name: s.name, startBar: s.startBar, bars: s.bars })) });
      assert.equal(report.clippedSamples, 0);
      for (const s of report.sections) assert.ok(s.rmsDbfs !== null && s.rmsDbfs > -45, `${output}: section ${s.name} is silent or nearly so (${s.rmsDbfs} dBFS)`);
      const loudness = report.sections.map(s => s.integratedLufs).filter(v => v !== null);
      assert.equal(loudness.length, report.sections.length, `${output}: every section has a loudness reading`);
      const range = Math.max(...loudness) - Math.min(...loudness);
      assert.ok(range <= 14, `${output}: sections differ by ${range.toFixed(1)} LU: ${report.sections.map(s => `${s.name} ${s.integratedLufs}`).join(", ")} with ${created.tracks.map(t => `${t.name}=${t.preset ?? t.voice}@${t.volume}`).join(" ")}`);
      assert.ok(report.integratedLufs >= -30 && report.integratedLufs <= -8, `${output}: overall loudness ${report.integratedLufs} LUFS`);
      // Brightness: the 2-6 kHz band within 16 dB of the 500 Hz-2 kHz band, so the mix is not dull.
      assert.ok(report.bandsDbfs.highMid >= report.bandsDbfs.mid - 16, `${output}: 2-6 kHz at ${report.bandsDbfs.highMid} dBFS against ${report.bandsDbfs.mid} dBFS at 500 Hz-2 kHz`);
      const energy = created.sections.map((s, i) => ({ energy: s.energy, lufs: report.sections[i].integratedLufs }));
      const quiet = Math.max(...energy.filter(e => e.energy === Math.min(...energy.map(x => x.energy))).map(e => e.lufs));
      const loud = Math.max(...energy.filter(e => e.energy === Math.max(...energy.map(x => x.energy))).map(e => e.lufs));
      assert.ok(loud >= quiet - 1, `${output}: the busiest sections (${loud} LUFS) are not quieter than the calmest (${quiet} LUFS)`);
      rows.push({ file: output, frameGap: Math.round((created.lengthSeconds - mix.durationSeconds) * 48000), sounds: index === 1 ? 'suggested' : 'default', centroidHz: report.centroidHz, highMidDbfs: report.bandsDbfs.highMid, airDbfs: report.bandsDbfs.air, midDbfs: report.bandsDbfs.mid, bars: created.lengthBars, seconds: created.lengthSeconds, peakDbfs: mix.peakDbfs,
        lufs: report.integratedLufs, sectionRangeLu: Number(range.toFixed(1)), quietestSectionRmsDbfs: Math.min(...report.sections.map(s => s.rmsDbfs)) });
      step(`${output}: ${created.lengthBars} bars, ${mix.durationSeconds} s, peak ${mix.peakDbfs} dBFS, ${report.integratedLufs} LUFS, section range ${range.toFixed(1)} LU`);
    }
  }
  console.table(rows);
  console.log(`lint_arrangement: no errors, ${lintWarnings} warnings in total`);
  console.log('All blueprint checks passed.');
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
