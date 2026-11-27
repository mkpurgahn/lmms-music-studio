// End-to-end verification of the LMMS Music Studio V3 workflow over a real MCP stdio transport.
// Proves JSON-RPC stdout/stderr hygiene, CC0 SoundFont lockfile discovery, fail-closed provenance gates,
// 5-track hybrid synth + native <sf2player> composition with sample-aligned tail: "ring" stem/master rendering,
// hardened /studio/timeline CSP + headless WebAudio decode + Unified Feedback v2 round-trip, and two-way Desktop LMMS sync.
// Run: node verify-studio-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { decodeWav, encodeWav } from './audio.mjs';
import { killProcessTreeByPid } from './tools/fs-atomic.mjs';
import { inspectPresetFile, provenancePathFor, sha256File } from './tools/provenance.mjs';
import { loadSoundfontLock, TRACKED_LOCK_PATH } from './tools/soundfont-pack.mjs';
import { STUDIO_CSP } from './tools/studio-ui/api.mjs';
import { MAX_DECODED_BYTES } from './tools/timeline.mjs';
import { resolveLmmsExecutable, resolveLmmsPresetsDir, resolveSoundfontsDir } from './tools/workspace-config.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const step = label => console.log('ok', label);

function makeSineWav(seconds = 0.5, freq = 220, sampleRate = 48000) {
  const frames = Math.round(seconds * sampleRate);
  const channel = Float32Array.from({ length: frames }, (_, i) => 0.25 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  return encodeWav({ sampleRate, channels: [channel, channel] });
}

function computeFloatRms(audio) {
  let sumSq = 0;
  let count = 0;
  for (const ch of audio.channels) {
    for (let i = 0; i < ch.length; i++) {
      sumSq += ch[i] * ch[i];
    }
    count += ch.length;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

function browserCandidates() {
  if (process.env.LMMS_AUDITION_BROWSER) {
    return process.env.LMMS_AUDITION_BROWSER === 'none' ? [] : [process.env.LMMS_AUDITION_BROWSER];
  }
  const list = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  return list.filter(candidate => existsSync(candidate));
}

async function launchHeadlessBrowser(executable, profileDir) {
  await mkdir(profileDir, { recursive: true });
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) {
    await pause(100);
  }
  if (!existsSync(portFile)) {
    if (child.pid) await killProcessTreeByPid(child.pid);
    try { child.kill(); } catch { /* ignore */ }
    return null;
  }

  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page');
  if (!target) {
    if (child.pid) await killProcessTreeByPid(child.pid);
    try { child.kill(); } catch { /* ignore */ }
    return null;
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  const responses = [];

  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    const { method, params } = message;
    if (method === 'Runtime.consoleAPICalled') {
      problems.push(`console.${params.type}: ${params.args.map(a => a.value ?? a.description).join(' ')}`);
    }
    if (method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    }
    if (method === 'Log.entryAdded' && params.entry.level === 'error' && !/favicon\.ico/.test(params.entry.url ?? '')) {
      problems.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
    }
    if (method === 'Network.responseReceived') {
      responses.push({
        url: params.response.url,
        status: params.response.status,
      });
    }
  };

  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  const evaluate = async expression =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

  return {
    problems,
    responses,
    evaluate,
    async open(url, untilExpression, timeoutMs = 90000) {
      problems.length = 0;
      responses.length = 0;
      await send('Page.navigate', { url });
      await pause(250);
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await pause(200)) {
        const value = await evaluate(untilExpression);
        if (value !== null && value !== undefined) return value;
      }
      throw new Error(`Timed out waiting for ${untilExpression} at ${url}`);
    },
    async close() {
      await Promise.race([send('Browser.close').catch(() => {}), pause(1500)]);
      try { socket.close(); } catch { /* ignore */ }
      if (child.pid) await killProcessTreeByPid(child.pid);
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}

function extractCookieAndToken(response, html) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookieMatch = /studio_auth=([0-9a-f]+)/i.exec(setCookie);
  const tokenMatch = /<body[^>]*\bdata-studio-token="([0-9a-f]{64})"/i.exec(html);
  return {
    cookieHeader: cookieMatch ? `studio_auth=${cookieMatch[1]}` : '',
    studioToken: tokenMatch ? tokenMatch[1] : '',
  };
}

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-studio-e2e-'));
const browserProfileRoot = await mkdtemp(path.join(scratchRoot, 'lmms-studio-browser-'));

const soundfontsDir = resolveSoundfontsDir(process.env);
const lmmsExe = resolveLmmsExecutable(process.env);
const presetsDir = resolveLmmsPresetsDir(process.env, lmmsExe);
const serverScript = fileURLToPath(new URL('./server.mjs', import.meta.url));

const stderrChunks = [];
const protocolErrors = [];
let stdoutBuffer = '';
let jsonRpcFrameCount = 0;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  cwd: path.dirname(serverScript),
  env: {
    ...process.env,
    LMMS_WORKSPACE: workspace,
    LMMS_SOUNDFONTS: soundfontsDir,
    LMMS_STRICT_COPYRIGHT: '1',
    LMMS_NO_GUI_LAUNCH: '1',
  },
  stderr: 'pipe',
});

transport.stderr.on('data', chunk => {
  stderrChunks.push(chunk.toString('utf8'));
});

const client = new Client({ name: 'lmms-studio-e2e-verify', version: '3.0.0' });
client.onerror = error => {
  protocolErrors.push(error?.message ?? String(error));
};

await client.connect(transport);
client.onerror = error => {
  protocolErrors.push(error?.message ?? String(error));
};

if (transport._process?.stdout) {
  transport._process.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const trimmed = rawLine.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        protocolErrors.push(`Corrupted non-JSON stdout line: ${trimmed} (${err.message})`);
        continue;
      }
      if (parsed?.jsonrpc !== '2.0') {
        protocolErrors.push(`Non-JSON-RPC message on stdout: ${trimmed}`);
      } else {
        jsonRpcFrameCount++;
      }
    }
  });
}

async function callRaw(name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
}

async function call(name, args = {}) {
  const result = await callRaw(name, args);
  assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function fails(name, args, pattern) {
  const result = await callRaw(name, args);
  assert.equal(Boolean(result.isError), true, `${name} should have failed with isError: true`);
  if (pattern) {
    assert.match(result.content?.[0]?.text ?? '', pattern);
  }
  return result.content?.[0]?.text ?? '';
}

let browser = null;

try {
  // -------------------------------------------------------------------------
  // 1. Discovery & Lockfile Check
  // -------------------------------------------------------------------------
  const started = await call('get_started');
  assert.equal(started.setup.strictCopyright, true);
  assert.equal(started.setup.lmmsFound, true, `LMMS executable not found at ${started.setup.lmmsExecutable}`);
  assert.equal(started.setup.soundfontsDirectoryFound, true, `LMMS_SOUNDFONTS not found at ${started.setup.soundfontsDirectory}`);

  const toolNames = new Set((await client.listTools()).tools.map(t => t.name));
  for (const workflowTools of Object.values(started.workflows)) {
    for (const toolName of workflowTools) {
      assert.ok(toolNames.has(toolName), `get_started references unregistered tool "${toolName}"`);
    }
  }

  const lock = await loadSoundfontLock(TRACKED_LOCK_PATH);
  const sf2Presets = await call('list_sf2_presets');
  const expectedCoreSf2 = [
    'upright-piano-kw.sf2',
    'meta-guitars.sf2',
    'virtuosity-drums.sf2',
    'vsco-orchestra-core.sf2',
  ];
  const byFileName = new Map(sf2Presets.soundfonts.map(entry => [path.basename(entry.sf2), entry]));
  for (const fileName of expectedCoreSf2) {
    const found = byFileName.get(fileName);
    assert.ok(found, `Expected locked CC0 SoundFont "${fileName}" in list_sf2_presets`);
    assert.equal(found.verifiedCc0, true, `${fileName} must be verifiedCc0`);
    assert.equal(found.licence, 'CC0-1.0');
    const lockEntry = Object.values(lock.soundfonts).find(item => item.fileName === fileName);
    assert.equal(found.sha256, lockEntry.sf2Sha256, `${fileName} SHA-256 must match soundfont-lock.json`);
  }
  const drumSf2Entry = byFileName.get('virtuosity-drums.sf2');
  assert.ok(
    drumSf2Entry.presets.some(p => p.bank === 128 && p.patch === 0 && p.isDrumBank === true),
    'virtuosity-drums.sf2 must expose Bank 128 Patch 0 GM drum preset',
  );

  const samplesList = await call('list_samples');
  assert.equal(samplesList.strictMode, true);
  assert.equal(samplesList.total, 0);
  assert.deepEqual(samplesList.samples, []);

  const presetsList = await call('list_presets');
  assert.ok(Array.isArray(presetsList.presets) && presetsList.presets.length > 0);
  assert.ok(
    presetsList.presets.every(p => !/^audiofileprocessor\//i.test(p)),
    'Zero audiofileprocessor sample presets may appear in strict list_presets',
  );
  for (const presetRel of presetsList.presets) {
    const check = await inspectPresetFile(path.join(presetsDir, presetRel), {
      presetsDir,
      workspaceDir: workspace,
      soundfontsDir,
      env: { ...process.env, LMMS_STRICT_COPYRIGHT: '1' },
    });
    assert.equal(check.allowed, true, `Blocked preset leaked into list_presets: ${presetRel}`);
  }

  const searched = await call('search_sounds', { query: '', limit: 100 });
  assert.ok(
    searched.sounds.every(s => !/^audiofileprocessor\//i.test(s.preset ?? '')),
    'Zero blocked sample presets may appear in strict search_sounds',
  );

  const drumKits = await call('list_drum_kits');
  for (const kitId of ['tight-synth', 'house-synth', 'electro-synth', '808-synth', 'acoustic-cc0']) {
    assert.ok(drumKits.kits[kitId], `Expected drum kit "${kitId}" in list_drum_kits`);
    assert.equal(drumKits.kits[kitId].publishable, true);
  }
  assert.equal(drumKits.kits['acoustic-cc0'].available, true);
  assert.equal(drumKits.kits['acoustic-cc0'].sf2, 'virtuosity-drums.sf2');
  assert.equal(drumKits.kits['acoustic-cc0'].bank, 128);
  step(`discovery & lockfile check: ${sf2Presets.count} verified CC0 .sf2 banks, 0 stock samples, ${presetsList.presets.length} clean synth presets`);

  // -------------------------------------------------------------------------
  // 2. Fail-Closed Negative Provenance Proof
  // -------------------------------------------------------------------------
  await fails('create_project', {
    output: 'blocked-factory.mmp',
    bpm: 120,
    tracks: [{
      name: 'Kick',
      voice: 'sample',
      factorySample: 'drums/kick01.ogg',
      volume: 80,
      patterns: [{ name: 'Beat', bar: 0, bars: 1, steps: { grid: 'X---x---X---x---' } }],
    }],
  }, /strict copyright mode/i);
  assert.equal(existsSync(path.join(workspace, 'blocked-factory.mmp')), false, 'Blocked project must not be written to disk');

  await writeFile(path.join(workspace, 'rogue.wav'), makeSineWav(1.0, 220));
  await fails('tag_sound', {
    file: 'rogue.wav',
    meta: { title: 'x', licence: 'own-recording' },
  }, /own-recording.*forbidden/i);
  assert.equal(existsSync(path.join(workspace, 'rogue.meta.json')), false, 'Forbidden own-recording tag must not write .meta.json');

  await fails('master_audio', {
    audio: 'rogue.wav',
    output: 'rogue-master.wav',
    targetLufs: -16,
  }, /provenance/i);
  assert.equal(existsSync(path.join(workspace, 'rogue-master.wav')), false, 'Un-provenanced WAV must not be mastered');
  step('fail-closed negative provenance proof: factorySample, spoofed own-recording tag_sound, and un-provenanced master_audio all rejected');

  // -------------------------------------------------------------------------
  // 3. Hybrid Synth + Native CC0 <sf2player> Composition, tail: "ring" Stem Render, & Provenance Manifest
  // -------------------------------------------------------------------------
  const bpm = 108;
  const lengthBars = 4;
  const barSeconds = 240 / bpm;
  const singleBarFrames = Math.round(barSeconds * 48000);
  const fourBarFrames = Math.round(lengthBars * barSeconds * 48000);

  const drumBarNotes = [
    // Kick (36) on beats 1, 2.5, 3
    { tick: 0, midi: 36, length: 24, velocity: 108 },
    { tick: 72, midi: 36, length: 24, velocity: 92 },
    { tick: 96, midi: 36, length: 24, velocity: 104 },
    // Snare (38) on beats 2 and 4
    { tick: 48, midi: 38, length: 24, velocity: 102 },
    { tick: 144, midi: 38, length: 24, velocity: 104 },
    // Closed hat (42) eighth-note groove + open hat (46) on final offbeat
    { tick: 0, midi: 42, length: 18, velocity: 82 },
    { tick: 24, midi: 42, length: 18, velocity: 68 },
    { tick: 48, midi: 42, length: 18, velocity: 78 },
    { tick: 72, midi: 42, length: 18, velocity: 66 },
    { tick: 96, midi: 42, length: 18, velocity: 80 },
    { tick: 120, midi: 42, length: 18, velocity: 68 },
    { tick: 144, midi: 42, length: 18, velocity: 78 },
    { tick: 168, midi: 46, length: 24, velocity: 86 },
  ];
  const fourBarsOfDrums = [0, 1, 2, 3].flatMap(barIdx =>
    drumBarNotes.map(n => ({ ...n, tick: barIdx * 192 + n.tick })));

  await call('create_project', {
    output: 'hybrid-demo.mmp',
    bpm,
    lengthBars,
    tracks: [
      {
        name: 'Piano',
        voice: 'sf2',
        soundfont: 'upright-piano-kw.sf2',
        bank: 0,
        patch: 0,
        role: 'harmony',
        volume: 78,
        pan: -16,
        patterns: [{
          name: 'Chords',
          bar: 0,
          bars: 4,
          chords: { progression: 'Am F C G', style: 'block', octave: 3, gate: 1, velocity: 86 },
        }],
      },
      {
        name: 'Strings',
        voice: 'sf2',
        soundfont: 'vsco-orchestra-core.sf2',
        bank: 0,
        patch: 0,
        role: 'texture',
        volume: 52,
        pan: 18,
        patterns: [{
          name: 'Pad',
          bar: 0,
          bars: 4,
          chords: { progression: 'Am F C G', style: 'block', octave: 3, gate: 1, velocity: 74 },
        }],
      },
      {
        name: 'Guitar',
        voice: 'sf2',
        soundfont: 'meta-guitars.sf2',
        bank: 0,
        patch: 0,
        role: 'lead',
        volume: 110,
        pan: 8,
        patterns: [{
          name: 'LeadArp',
          bar: 0,
          bars: 4,
          notes: [
            // Bar 0 (Am): A4-C5-E5-C5 phrase in natural nylon guitar range above octave-3 harmony
            { tick: 0, midi: 69, length: 42, velocity: 108 },
            { tick: 48, midi: 72, length: 42, velocity: 102 },
            { tick: 96, midi: 76, length: 54, velocity: 112 },
            { tick: 156, midi: 72, length: 30, velocity: 96 },
            // Bar 1 (F): A4-C5-F5-E5
            { tick: 192, midi: 69, length: 42, velocity: 104 },
            { tick: 240, midi: 72, length: 42, velocity: 100 },
            { tick: 288, midi: 77, length: 54, velocity: 110 },
            { tick: 348, midi: 76, length: 36, velocity: 98 },
            // Bar 2 (C): G4-C5-E5-D5
            { tick: 384, midi: 67, length: 42, velocity: 106 },
            { tick: 432, midi: 72, length: 42, velocity: 102 },
            { tick: 480, midi: 76, length: 54, velocity: 112 },
            { tick: 540, midi: 74, length: 36, velocity: 98 },
            // Bar 3 (G): B4-D5-G5 sustained to the bar line so Guitar rings past bar 4
            { tick: 576, midi: 71, length: 48, velocity: 104 },
            { tick: 624, midi: 74, length: 48, velocity: 106 },
            { tick: 672, midi: 67, length: 96, velocity: 114 },
          ],
        }],
      },
      {
        name: 'Bass',
        voice: 'bass',
        role: 'bass',
        volume: 74,
        pan: 0,
        patterns: [{
          name: 'Bassline',
          bar: 0,
          bars: 4,
          chords: { progression: 'Am F C G', style: 'bass', figure: 'eighths', octave: 2, velocity: 92 },
        }],
      },
      {
        name: 'Drums',
        voice: 'sf2',
        soundfont: 'virtuosity-drums.sf2',
        bank: 128,
        patch: 0,
        role: 'drums',
        volume: 88,
        pan: 0,
        patterns: [{
          name: 'Groove',
          bar: 0,
          bars: 4,
          notes: fourBarsOfDrums,
        }],
      },
    ],
  });

  const lintReport = await call('lint_arrangement', { project: 'hybrid-demo.mmp', key: 'A minor' });
  assert.equal(lintReport.counts.error, 0, `Unexpected arrangement errors: ${JSON.stringify(lintReport.findings)}`);

  const masterRender = await call('render_mix', {
    project: 'hybrid-demo.mmp',
    output: 'hybrid-master.wav',
    tail: 'ring',
    ringSeconds: 3,
    targetLufs: -16,
  });
  const stemsRender = await call('render_stems', {
    project: 'hybrid-demo.mmp',
    outputDirectory: 'hybrid-stems',
    tail: 'ring',
    ringSeconds: 3,
  });

  const masterDecoded = decodeWav(await readFile(path.join(workspace, 'hybrid-master.wav')));
  assert.equal(masterRender.frames, masterDecoded.frames);
  assert.equal(stemsRender.frames, masterDecoded.frames, 'render_stems and render_mix must agree on exact ring-trimmed frame count');
  assert.ok(
    masterDecoded.frames > fourBarFrames && masterDecoded.frames > 4 * singleBarFrames,
    `Expected ring-out frames (${masterDecoded.frames}) > 4 * barFrames (${fourBarFrames})`,
  );
  assert.equal(stemsRender.stems.length, 5);

  const stemMetrics = [];
  for (const stem of stemsRender.stems) {
    const stemPath = path.join(workspace, 'hybrid-stems', stem.file);
    const stemDecoded = decodeWav(await readFile(stemPath));
    const floatRms = computeFloatRms(stemDecoded);
    assert.equal(
      stemDecoded.frames,
      masterDecoded.frames,
      `Stem "${stem.track}" frames (${stemDecoded.frames}) must equal master frames (${masterDecoded.frames})`,
    );
    assert.ok(
      stem.rmsDbfs !== null && Number.isFinite(stem.rmsDbfs) && stem.rmsDbfs > -65 && floatRms > 1e-4,
      `Stem "${stem.track}" must have non-zero RMS (got rmsDbfs=${stem.rmsDbfs}, floatRms=${floatRms})`,
    );
    stemMetrics.push({ track: stem.track, file: stem.file, frames: stemDecoded.frames, rmsDbfs: stem.rmsDbfs, peakDbfs: stem.peakDbfs });
  }

  const masterAnalysis = await call('analyze_audio', {
    audio: 'hybrid-master.wav',
    bpm,
    targetLufs: -16,
  });
  assert.equal(masterAnalysis.clippedSamples, 0, 'Master render must have 0 clipped samples');
  assert.ok(Number.isFinite(masterAnalysis.integratedLufs), 'Master render must report finite integratedLufs');
  assert.ok(Math.abs(masterAnalysis.integratedLufs - (-16)) <= 0.8, `Expected ~-16 LUFS, got ${masterAnalysis.integratedLufs}`);

  const projectAudit = await call('audit_copyright', { project: 'hybrid-demo.mmp' });
  assert.equal(projectAudit.compliant, true);
  assert.equal(projectAudit.strictMode, true);
  assert.equal(projectAudit.classification, 'hybrid-verified');

  const audioAudit = await call('audit_copyright', { audio: 'hybrid-master.wav' });
  assert.equal(audioAudit.compliant, true);
  assert.equal(audioAudit.strictMode, true);
  assert.equal(audioAudit.classification, 'hybrid-verified');

  const projSidecarPath = provenancePathFor(path.join(workspace, 'hybrid-demo.mmp'));
  const masterSidecarPath = provenancePathFor(path.join(workspace, 'hybrid-master.wav'));
  assert.equal(existsSync(projSidecarPath), true, 'hybrid-demo.mmp.provenance.json must exist');
  assert.equal(existsSync(masterSidecarPath), true, 'hybrid-master.wav.provenance.json must exist');

  const projSidecar = JSON.parse(await readFile(projSidecarPath, 'utf8'));
  const masterSidecar = JSON.parse(await readFile(masterSidecarPath, 'utf8'));
  assert.equal(projSidecar.sha256, await sha256File(path.join(workspace, 'hybrid-demo.mmp')));
  assert.equal(masterSidecar.sha256, await sha256File(path.join(workspace, 'hybrid-master.wav')));
  assert.equal(projSidecar.classification, 'hybrid-verified');
  assert.equal(masterSidecar.classification, 'hybrid-verified');
  step(`hybrid 5-track render: ${masterDecoded.frames} frames (> ${fourBarFrames} 4-bar frames), ${masterAnalysis.integratedLufs} LUFS, truePeak ${masterAnalysis.truePeakDbfs} dBTP, 0 clipped, hybrid-verified`);

  // -------------------------------------------------------------------------
  // 4. Headless Browser /studio/timeline CSP, WebAudio Decode, Sandbox Security, & v2 Feedback Round-Trip
  // -------------------------------------------------------------------------
  const timelineBuilt = await call('build_timeline_page', {
    stems: 'hybrid-stems',
    mix: 'hybrid-master.wav',
    project: 'hybrid-demo.mmp',
    sections: [
      { name: 'Opening', startBar: 0, bars: 2 },
      { name: 'Lift', startBar: 2, bars: 2 },
    ],
    title: 'Hybrid Studio E2E',
    output: 'hybrid-timeline.html',
  });
  assert.ok(
    typeof timelineBuilt.studioUrl === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+\/studio\/timeline\?session=hybrid-timeline$/.test(timelineBuilt.studioUrl),
    `Unexpected studioUrl: ${timelineBuilt.studioUrl}`,
  );

  const studioOrigin = new URL(timelineBuilt.studioUrl).origin;
  const studioPageRes = await fetch(timelineBuilt.studioUrl);
  assert.equal(studioPageRes.status, 200);
  assert.equal(studioPageRes.headers.get('content-security-policy'), STUDIO_CSP);
  const studioPageHtml = await studioPageRes.text();
  const { cookieHeader, studioToken } = extractCookieAndToken(studioPageRes, studioPageHtml);
  assert.ok(cookieHeader && studioToken.length === 64, 'Studio page must issue HttpOnly auth cookie and 64-hex capability token');

  // Static .html file on the same port must return sandbox CSP + Content-Disposition: attachment
  const staticHtmlRes = await fetch(`${studioOrigin}/hybrid-timeline.html`);
  assert.equal(staticHtmlRes.status, 200);
  assert.equal(staticHtmlRes.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.match(staticHtmlRes.headers.get('content-disposition') ?? '', /^attachment;\s*filename="hybrid-timeline\.html"/i);

  const testFeedbackPayload = JSON.stringify({
    session: 'hybrid-timeline',
    feedback: {
      schema: 'lmms-mcp/audition-feedback',
      version: 2,
      title: 'Hybrid Studio E2E',
      bpm,
      timeSignature: [4, 4],
      sections: [],
      notes: [{ seconds: 4.444, bar: 2, displayBar: 3, beat: 1, text: 'Probe' }],
    },
  });

  // Cross-origin POST -> 403
  const evilOriginRes = await fetch(`${studioOrigin}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: 'http://evil.example',
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: testFeedbackPayload,
  });
  assert.equal(evilOriginRes.status, 403, 'Cross-origin POST /api/studio/feedback must return 403');

  // Missing X-Studio-Token -> 403
  const missingTokenRes = await fetch(`${studioOrigin}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: studioOrigin,
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: testFeedbackPayload,
  });
  assert.equal(missingTokenRes.status, 403, 'Missing X-Studio-Token POST /api/studio/feedback must return 403');

  let usedBrowser = null;
  for (const candidate of browserCandidates()) {
    try {
      browser = await launchHeadlessBrowser(
        candidate,
        path.join(browserProfileRoot, path.basename(candidate, path.extname(candidate))),
      );
    } catch {
      browser = null;
    }
    if (browser) {
      usedBrowser = candidate;
      break;
    }
  }
  assert.ok(browser, 'Expected a local headless Chromium/Edge binary to verify /studio/timeline');

  const selftestRaw = await browser.open(
    `${timelineBuilt.studioUrl}#selftest`,
    "document.getElementById('board')?.dataset?.selftest ?? null",
  );
  assert.deepEqual(browser.problems, [], `Expected 0 browser errors/CSP violations, got: ${browser.problems.join(' | ')}`);

  const scriptInfo = await browser.evaluate(`JSON.stringify({
    ready: document.body.dataset.ready,
    scriptCount: document.querySelectorAll('script').length,
    scriptSrc: document.querySelector('script')?.getAttribute('src') ?? null
  })`);
  assert.deepEqual(JSON.parse(scriptInfo), {
    ready: 'yes',
    scriptCount: 1,
    scriptSrc: '/studio/timeline.js',
  });

  const selftest = JSON.parse(selftestRaw);
  assert.equal(selftest.ok, true);
  assert.equal(selftest.loadedLanes, 6, 'Expected Master Mix + 5 stems decoded in WebAudio');
  assert.equal(selftest.lazyLanes, 0);
  assert.equal(selftest.maxStemDriftSamples, 0);
  assert.ok(selftest.decodedBytes > 0 && selftest.decodedBytes <= MAX_DECODED_BYTES);

  // Jump to Display Bar 3 (the "Lift" section starting at 0-based bar 2), pin feedback note, and submit via UI button
  const clockAtBar3 = await browser.evaluate(`(function () {
    var secBlocks = document.querySelectorAll('.blocks.sec div');
    secBlocks[1].click();
    return document.getElementById('clock').textContent;
  })()`);
  assert.match(clockAtBar3, /^Bar 3 \| Beat 1 \|/, `Expected clock at Display Bar 3, got "${clockAtBar3}"`);

  await browser.evaluate(`(function () {
    document.getElementById('notetext').value = 'Guitar slightly bright in bar 3; add gentle warmth';
    document.getElementById('note').click();
    document.getElementById('send-feedback').click();
  })()`);

  let feedbackBanner = '';
  for (let i = 0; i < 60; i++) {
    feedbackBanner = await browser.evaluate("document.getElementById('feedback-status')?.textContent ?? ''");
    if (feedbackBanner.startsWith('Saved to workspace')) break;
    await pause(100);
  }
  assert.match(feedbackBanner, /^Saved to workspace \(hybrid-timeline-feedback\.json\)/);
  assert.deepEqual(browser.problems, [], `Expected 0 browser errors after feedback POST, got: ${browser.problems.join(' | ')}`);

  const feedbackPostResponse = browser.responses.find(r => r.url.endsWith('/api/studio/feedback'));
  assert.ok(feedbackPostResponse && [200, 201].includes(feedbackPostResponse.status), 'Expected HTTP 200/201 from page feedback POST');

  await browser.close();
  browser = null;

  const feedbackRead = await call('read_feedback', { file: 'hybrid-timeline-feedback.json' });
  assert.equal(feedbackRead.version, 2);
  assert.equal(feedbackRead.staleProjectRevision, false);
  assert.equal(feedbackRead.noteCount, 1);
  assert.equal(feedbackRead.notes[0].bar, 2, 'Display Bar 3 must map to 0-based MCP bar 2');
  assert.equal(feedbackRead.notes[0].displayBar, 3);
  assert.equal(feedbackRead.notes[0].text, 'Guitar slightly bright in bar 3; add gentle warmth');
  step(`headless ${path.basename(usedBrowser)}: /studio/timeline CSP clean, ${selftest.decodedBytes} WebAudio bytes decoded, Feedback v2 Display Bar 3 -> bar 2 verified`);

  // -------------------------------------------------------------------------
  // 5. Two-Way Desktop LMMS Sync Proof
  // -------------------------------------------------------------------------
  const openedLmms = await call('open_in_lmms', { project: 'hybrid-demo.mmp' });
  assert.equal(openedLmms.launched, false);
  assert.equal(openedLmms.skippedLaunchReason, 'LMMS_NO_GUI_LAUNCH');
  assert.match(openedLmms.openedSha256, /^[0-9a-f]{64}$/);

  // Modify Guitar's first note velocity on disk (simulating user Ctrl+S in Desktop LMMS)
  const mmpDiskPath = path.join(workspace, 'hybrid-demo.mmp');
  const mmpDoc = new DOMParser().parseFromString(await readFile(mmpDiskPath, 'utf8'), 'application/xml');
  const guitarTrackNode = Array.from(mmpDoc.getElementsByTagName('track')).find(t => t.getAttribute('name') === 'Guitar');
  assert.ok(guitarTrackNode, 'Expected Guitar track in hybrid-demo.mmp');
  const firstGuitarNote = guitarTrackNode.getElementsByTagName('note')[0];
  assert.ok(firstGuitarNote, 'Expected first note in Guitar pattern');
  firstGuitarNote.setAttribute('vol', '63');
  await writeFile(mmpDiskPath, new XMLSerializer().serializeToString(mmpDoc));

  // Un-synced MCP edit must refuse to clobber or branch past unsynced Desktop LMMS user edits
  await fails('set_project_tempo', {
    project: 'hybrid-demo.mmp',
    output: 'hybrid-demo-v2.mmp',
    bpm: 112,
  }, /sync_from_lmms/);
  assert.equal(existsSync(path.join(workspace, 'hybrid-demo-v2.mmp')), false);

  const syncedLmms = await call('sync_from_lmms', { project: 'hybrid-demo.mmp' });
  assert.equal(syncedLmms.synced, true);
  assert.equal(syncedLmms.changed, true);
  assert.equal(syncedLmms.strictCompliant, true);

  const syncedGuitarPattern = await call('read_pattern', {
    project: 'hybrid-demo.mmp',
    trackName: 'Guitar',
    bar: 0,
  });
  assert.equal(syncedGuitarPattern.notes[0].velocity, 63, 'User velocity edit from Desktop LMMS must be preserved');

  await call('set_project_tempo', {
    project: 'hybrid-demo.mmp',
    output: 'hybrid-demo-v2.mmp',
    bpm: 112,
  });
  const v2Arrangement = await call('inspect_arrangement', { project: 'hybrid-demo-v2.mmp' });
  assert.equal(v2Arrangement.tempo, 112);
  const v2GuitarPattern = await call('read_pattern', {
    project: 'hybrid-demo-v2.mmp',
    trackName: 'Guitar',
    bar: 0,
  });
  assert.equal(v2GuitarPattern.notes[0].velocity, 63);
  step('two-way Desktop LMMS sync: unsynced MCP edit blocked, sync_from_lmms preserved velocity=63, hybrid-demo-v2.mmp saved at 112 BPM');

  // -------------------------------------------------------------------------
  // 6. Stdout JSON-RPC & Stderr Structured Logging Proof
  // -------------------------------------------------------------------------
  assert.deepEqual(protocolErrors, [], `Expected zero stdout JSON-RPC protocol errors, got: ${protocolErrors.join(' | ')}`);
  assert.ok(jsonRpcFrameCount >= 15, `Expected JSON-RPC frames on stdout, observed ${jsonRpcFrameCount}`);
  const stderrText = stderrChunks.join('');
  assert.match(stderrText, /\[INFO\] \[mcp-server\] Starting LMMS Music Studio MCP server \{/);
  step(`stdio hygiene: ${jsonRpcFrameCount} clean JSON-RPC 2.0 stdout frames, 0 protocol errors, structured logs confirmed on stderr`);

  console.log(JSON.stringify({
    ok: true,
    jsonRpcFrames: jsonRpcFrameCount,
    lockedCc0Soundfonts: expectedCoreSf2,
    master: {
      frames: masterDecoded.frames,
      fourBarFrames,
      durationSeconds: masterRender.durationSeconds,
      tailSeconds: masterRender.tailSeconds,
      integratedLufs: masterAnalysis.integratedLufs,
      truePeakDbfs: masterAnalysis.truePeakDbfs,
      peakDbfs: masterAnalysis.peakDbfs,
      clippedSamples: masterAnalysis.clippedSamples,
      classification: projectAudit.classification,
    },
    stems: stemMetrics,
    browser: {
      executable: path.basename(usedBrowser),
      studioUrl: timelineBuilt.studioUrl,
      decodedBytes: selftest.decodedBytes,
      maxDecodedBytes: selftest.maxDecodedBytes,
      loadedLanes: selftest.loadedLanes,
      maxStemDriftSamples: selftest.maxStemDriftSamples,
      feedbackBar: feedbackRead.notes[0].bar,
      feedbackDisplayBar: feedbackRead.notes[0].displayBar,
      staleProjectRevision: feedbackRead.staleProjectRevision,
    },
    lmmsSync: {
      preservedGuitarVelocity: v2GuitarPattern.notes[0].velocity,
      updatedTempoBpm: v2Arrangement.tempo,
    },
  }, null, 2));
  console.log('All LMMS Music Studio V3 E2E checks passed.');
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  await client.close().catch(() => {});
  await rm(browserProfileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
