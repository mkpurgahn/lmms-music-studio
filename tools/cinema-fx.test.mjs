import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { analyze, decodeWav, spectrum } from '../audio.mjs';
import {
  CINEMA_FX_KINDS,
  CINEMA_FX_SAMPLE_RATE,
  renderCinemaFxToWorkspace,
  synthesizeCinemaFx,
} from './cinema-fx.mjs';
import { runCommandSafe } from './fs-atomic.mjs';
import { provenancePathFor, verifyAudioFileProvenance } from './provenance.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(repoRoot, '.test-scratch');

async function makeScratch(t, prefix) {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function rmsWindow(channels, startFrame, endFrame) {
  let sumSq = 0;
  let count = 0;
  for (const ch of channels) {
    for (let i = startFrame; i < endFrame; i++) {
      sumSq += ch[i] * ch[i];
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

test('synthesizeCinemaFx generates 48 kHz stereo zero-DC zero-clipping audio across all four physical models', () => {
  for (const kind of CINEMA_FX_KINDS) {
    const res = synthesizeCinemaFx({
      kind,
      durationSeconds: kind === 'heartbeat_arc' ? 6 : 3,
      seed: 2026,
    });
    assert.equal(res.sampleRate, CINEMA_FX_SAMPLE_RATE);
    assert.equal(res.channels, 2);

    const decoded = decodeWav(res.wav);
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.channels.length, 2);

    const report = analyze(decoded);
    assert.equal(report.clippedSamples, 0, `${kind} must have zero clipped samples`);
    assert.equal(Math.abs(report.dcOffset), 0, `${kind} must have zero DC offset (got ${report.dcOffset})`);
    assert.ok(report.peakDbfs !== null && report.peakDbfs > -6 && report.peakDbfs < -0.4, `${kind} peakDbfs=${report.peakDbfs}`);
    assert.ok(report.rmsDbfs !== null && report.rmsDbfs > -32, `${kind} should have solid audible RMS energy`);
  }

  // Deterministic PRNG check
  const first = synthesizeCinemaFx({ kind: 'waterphone', durationSeconds: 2, seed: 77 });
  const second = synthesizeCinemaFx({ kind: 'waterphone', durationSeconds: 2, seed: 77 });
  assert.equal(first.wav.compare(second.wav), 0, 'Same seed must produce byte-identical WAV output');
});

test('waterphone concentrates modal energy in 190-4800 Hz and respects 24-36 mode count', () => {
  const res = synthesizeCinemaFx({
    kind: 'waterphone',
    durationSeconds: 3.5,
    modeCount: 32,
    sloshDepthCents: 75,
    bowPressure: 0.72,
    seed: 909,
  });
  assert.equal(res.details.modeCount, 32);
  assert.deepEqual(res.details.modeRangeHz, [190, 4800]);

  const spec = spectrum(res.audio);
  // Mid + highMid (500-6000 Hz) + lowMid (150-500 Hz) should strongly exceed sub (< 60 Hz).
  assert.ok(spec.bandsDbfs.mid > (spec.bandsDbfs.sub ?? -120) + 18, 'Waterphone modal midband should sit well above sub');
  assert.ok(spec.bandsDbfs.highMid > (spec.bandsDbfs.sub ?? -120) + 14, 'Waterphone metallic screech highMid should sit well above sub');
  assert.ok(spec.centroidHz >= 350 && spec.centroidHz <= 4200, `Expected waterphone centroid inside 350..4200 Hz, got ${spec.centroidHz}`);
});

test('heartbeat_arc accelerates pulse intervals from startBpm to endBpm with 42-58 Hz skin-membrane dominance', () => {
  const res = synthesizeCinemaFx({
    kind: 'heartbeat_arc',
    durationSeconds: 10,
    startBpm: 60,
    endBpm: 162,
    curve: 'exponential',
    membraneHz: 48,
    seed: 404,
  });
  assert.ok(res.details.heartbeatCount >= 14, `Expected >= 14 heartbeats over 10s 60->162 BPM arc, got ${res.details.heartbeatCount}`);

  // Sub (20-60 Hz) + Bass (60-150 Hz) should dominate upper frequencies for authentic skin-membrane thud.
  const spec = spectrum(res.audio);
  assert.ok(spec.bandsDbfs.sub > spec.bandsDbfs.highMid + 15, 'Heartbeat sub-membrane should dominate highMid');

  // Verify acceleration & dynamic intensity build: late window has more pulse energy density than opening window.
  const sr = res.sampleRate;
  const earlyRms = rmsWindow(res.audio.channels, Math.round(0.1 * sr), Math.round(2.6 * sr));
  const lateRms = rmsWindow(res.audio.channels, Math.round(7.0 * sr), Math.round(9.5 * sr));
  assert.ok(lateRms > earlyRms * 1.45, `Expected accelerating/intensifying heartbeat RMS (${lateRms} > ${earlyRms} * 1.45)`);
});

test('dread_riser swells exponentially and executes a razor-clean silence cutoff at durationSeconds', () => {
  const res = synthesizeCinemaFx({
    kind: 'dread_riser',
    durationSeconds: 4,
    baseHz: 46.25,
    riseSemitones: 14,
    cutoffTailMs: 16,
    seed: 5150,
  });
  const sr = res.sampleRate;
  const openingRms = rmsWindow(res.audio.channels, Math.round(0.1 * sr), Math.round(0.9 * sr));
  const climaxRms = rmsWindow(res.audio.channels, Math.round(3.1 * sr), Math.round(3.92 * sr));
  assert.ok(climaxRms > openingRms * 3.5, `Expected strong exponential dread riser swell (${climaxRms} vs ${openingRms})`);

  // Final frames at durationSeconds must be cleanly cut to near-zero silence.
  const tailStart = res.frames - Math.max(4, Math.round(0.003 * sr));
  const cutoffTailRms = rmsWindow(res.audio.channels, tailStart, res.frames);
  assert.ok(cutoffTailRms < 1e-4, `Expected razor-clean cutoff at durationSeconds, got tail RMS ${cutoffTailRms}`);
  assert.equal(res.audio.channels[0][res.frames - 1], 0);
  assert.equal(res.audio.channels[1][res.frames - 1], 0);
});

test('seismic_impact delivers 34 Hz seismic sub boom + Tam-Tam bloom + natural dark hall decay', () => {
  const res = synthesizeCinemaFx({
    kind: 'seismic_impact',
    durationSeconds: 5,
    subHz: 34,
    tamTamLevel: 0.72,
    hallDecay: 0.8,
    seed: 808,
  });
  const sr = res.sampleRate;
  const spec = spectrum(res.audio, 0, Math.round(1.8 * sr));
  assert.ok(spec.bandsDbfs.sub > -24, `Expected strong 34 Hz sub boom energy, got ${spec.bandsDbfs.sub} dBFS`);

  const attackRms = rmsWindow(res.audio.channels, 0, Math.round(0.8 * sr));
  const lateDecayRms = rmsWindow(res.audio.channels, Math.round(3.8 * sr), Math.round(4.8 * sr));
  assert.ok(attackRms > lateDecayRms * 4, `Expected natural hall decay (${attackRms} vs ${lateDecayRms})`);
});

test('CLI and MCP render_cinema_fx write provenanced WAVs and support placing onto LMMS projects', async t => {
  const ws = await makeScratch(t, 'cinema-fx-e2e-');

  // 1. Direct CLI invocation
  const cliRun = await runCommandSafe(process.execPath, [
    path.join(repoRoot, 'tools', 'cinema-fx.mjs'),
    '--kind', 'waterphone',
    '--output', 'cli-waterphone-v1.wav',
    '--workspace', ws,
    '--duration', '2.5',
    '--modeCount', '28',
    '--seed', '1234',
  ]);
  const cliJson = JSON.parse(cliRun.stdout.trim());
  assert.equal(cliJson.file, 'cli-waterphone-v1.wav');
  assert.equal(cliJson.provenanceClassification, 'pure-synthesis');
  assert.equal(cliJson.dcOffset, 0);
  assert.equal(existsSync(provenancePathFor(path.join(ws, 'cli-waterphone-v1.wav'))), true);

  const provCheck = await verifyAudioFileProvenance(path.join(ws, 'cli-waterphone-v1.wav'), {
    workspaceDir: ws,
    env: { LMMS_STRICT_COPYRIGHT: '1' },
  });
  assert.equal(provCheck.verified, true);
  assert.equal(provCheck.record.classification, 'pure-synthesis');

  // 2. MCP tool call + place onto LMMS project + strict audit_copyright
  const client = new Client({ name: 'cinema-fx-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'server.mjs')],
    cwd: repoRoot,
    env: { ...process.env, LMMS_WORKSPACE: ws, LMMS_STRICT_COPYRIGHT: '1', LMMS_LOG_LEVEL: 'error' },
    stderr: 'ignore',
  }));
  t.after(() => client.close().catch(() => {}));

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    assert.equal(Boolean(res.isError), false, `${name} failed: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };

  await call('create_project', {
    output: 'horror-cue-v1.mmp',
    bpm: 60,
    lengthBars: 4,
    tracks: [{
      name: 'Sub Drone',
      voice: 'bass',
      role: 'bass',
      volume: 70,
      patterns: [{ name: 'Drone', bar: 0, bars: 4, notes: [{ tick: 0, midi: 30, length: 768, velocity: 85 }] }],
    }],
  });

  const fxPlaced = await call('render_cinema_fx', {
    kind: 'seismic_impact',
    output: 'act4-impact-v1.wav',
    durationSeconds: 3,
    subHz: 34,
    place: {
      project: 'horror-cue-v1.mmp',
      output: 'horror-cue-v2.mmp',
      bar: 2,
      trackName: 'Seismic Impact',
      role: 'fx',
      volume: 95,
    },
  });
  assert.equal(fxPlaced.file, 'act4-impact-v1.wav');
  assert.equal(fxPlaced.placed.project, 'horror-cue-v2.mmp');
  assert.equal(fxPlaced.placed.track, 'Seismic Impact');

  const audit = await call('audit_copyright', { project: 'horror-cue-v2.mmp' });
  assert.equal(audit.compliant, true);
  assert.equal(audit.classification, 'pure-synthesis');

  // Verify direct programmatic helper rejects duplicate output unless overwrite: true
  await assert.rejects(
    renderCinemaFxToWorkspace({ workspaceDir: ws, kind: 'dread_riser', output: 'act4-impact-v1.wav', durationSeconds: 2 }),
    /already exists/i,
  );
  const readBack = await readFile(path.join(ws, 'act4-impact-v1.wav'));
  assert.ok(readBack.length > 44);
});
