// Phase 4 comprehensive tests: hardened /studio/* routes & CSP, cookie+token+Origin auth,
// static workspace sandboxing, port-collision discovery (18290..18299), 512 MiB WebAudio budget planner,
// Unified Feedback v2 round-trip + staleProjectRevision, two-way Desktop LMMS sync, and Unicode/emoji ban.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { encodeWav } from '../audio.mjs';
import { closeStudioServers, ensureStudioServer, startServer } from '../library-server.mjs';
import { renderPage, gameModel } from './audition.mjs';
import { killProcessTreeByPid } from './fs-atomic.mjs';
import { browserHtml } from './library-browser.mjs';
import { openInLmms, readSyncState, syncFromLmms } from './lmms-sync.mjs';
import { writeProvenanceSidecar } from './provenance.mjs';
import { STUDIO_CSP, STUDIO_DESCRIPTOR_SCHEMA, renderStudioAuditionHtml, renderStudioTimelineHtml } from './studio-ui/api.mjs';
import {
  MAX_DECODED_BYTES,
  buildTimelineFeedback,
  createTimelineNote,
  estimateDecodedBytes,
  planDecodedBudget,
  planOnDemandDecode,
  timelineHtml,
} from './timeline.mjs';

const SERVER_PATH = fileURLToPath(new URL('../server.mjs', import.meta.url));
const FORBIDDEN_UNICODE_MEDIA_EMOJI = /[\u2300-\u27BF\u{1F000}-\u{1FAFF}]/u;

function makeSineWav(seconds = 0.25, freq = 220, sampleRate = 48000) {
  const frames = Math.round(seconds * sampleRate);
  const ch = Float32Array.from({ length: frames }, (_, i) => 0.25 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  return encodeWav({ sampleRate, channels: [ch, ch] });
}

function extractCookieAndToken(response, html) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookieMatch = /studio_auth=([0-9a-f]+)/i.exec(setCookie);
  const tokenMatch = /<body[^>]*\bdata-studio-token="([0-9a-f]{64})"/i.exec(html);
  return {
    setCookie,
    cookieHeader: cookieMatch ? `studio_auth=${cookieMatch[1]}` : '',
    studioToken: tokenMatch ? tokenMatch[1] : '',
  };
}

async function createMcpTestClient(workspace, extraEnv = {}) {
  const client = new Client({ name: 'studio-bridge-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      LMMS_WORKSPACE: workspace,
      LMMS_NO_GUI_LAUNCH: '1',
      LMMS_LOG_LEVEL: 'error',
      ...extraEnv,
    },
    stderr: 'pipe',
  }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
    }
    return JSON.parse(res.content[0].text);
  };
  const callRaw = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, call, callRaw };
}

test('security boundaries: Origin, capability token+cookie, traversal/dotfiles/symlinks, sandboxed static HTML, and script-src self', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-studio-sec-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lmms-studio-outside-'));
  const launchedCalls = [];
  const server = startServer({
    port: 0,
    folders: { workspace, stock: null, soundfonts: workspace, library: null },
    env: { ...process.env, LMMS_STRICT_COPYRIGHT: '1', LMMS_NO_GUI_LAUNCH: '1' },
    launcher: async info => { launchedCalls.push(info); },
  });
  await once(server, 'listening');

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Write sample stem + descriptor + untrusted workspace HTML/SVG + hidden dotfile + valid .mmp project
  await mkdir(path.join(workspace, 'stems'), { recursive: true });
  const wavBytes = makeSineWav(0.2);
  await writeFile(path.join(workspace, 'stems', '1_Kick.wav'), wavBytes);
  await writeFile(path.join(workspace, 'evil.html'), '<!doctype html><script>alert("xss")</script>');
  await writeFile(path.join(workspace, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(path.join(workspace, '.secret-dotfile.json'), '{"secret":true}');
  await writeFile(path.join(outside, 'outside-secret.json'), '{"escaped":true}');

  const validMmp = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE lmms-project>',
    '<lmms-project version="1.0" creator="LMMS" creatorversion="1.2.2" type="song">',
    '<head bpm="120" mastervol="100" timesig_numerator="4" timesig_denominator="4"/>',
    '<song><trackcontainer type="song">',
    '<track type="0" name="Kick" muted="0" solo="0">',
    '<instrumenttrack vol="100" pan="0" basenote="57" fxch="0"><instrument name="kicker"><kicker/></instrument></instrumenttrack>',
    '<pattern name="Beat" pos="0" len="192" type="1" steps="16" muted="0"><note key="57" pos="0" len="48" vol="100" pan="0"/></pattern>',
    '</track>',
    '</trackcontainer></song></lmms-project>',
  ].join('');
  await writeFile(path.join(workspace, 'song.mmp'), validMmp);
  await writeProvenanceSidecar(path.join(workspace, 'song.mmp'), {
    workspaceDir: workspace,
    classification: 'pure-synthesis',
    generatorTool: 'test',
    sources: [{ track: 'Kick', kind: 'pure-synthesis', pluginOrLibrary: 'kicker', licence: 'unrestricted-synthesis' }],
  });

  const timelineDesc = {
    schema: STUDIO_DESCRIPTOR_SCHEMA,
    kind: 'timeline',
    session: 'demo',
    title: 'Demo Song <Safe>',
    bpm: 120,
    timeSignature: [4, 4],
    bars: 4,
    seconds: 8,
    sampleRate: 48000,
    lanes: [{ name: 'Kick', family: 'drums', url: '/stems/1_Kick.wav', peaks: [10, 80, 40], frames: 9600, channels: 2, decodedBytes: 76800 }],
    mix: null,
    sections: [{ name: 'Intro', startBar: 0, bars: 4 }],
    effects: [],
    generated: '2026-11-26',
    projectFile: 'song.mmp',
    projectSha256: null,
  };
  await writeFile(path.join(workspace, 'demo.timeline.studio.json'), JSON.stringify(timelineDesc, null, 2));

  const auditionDesc = {
    schema: STUDIO_DESCRIPTOR_SCHEMA,
    studioKind: 'audition',
    kind: 'compare',
    session: 'demo-ab',
    title: 'Audition Demo',
    name: 'demo-ab',
    source: null,
    sampleRate: 48000,
    bpm: 120,
    timeSignature: [4, 4],
    songBars: 4,
    intro: null,
    loop: null,
    layers: [],
    stingers: [],
    compare: [{ label: 'A', src: '/stems/1_Kick.wav', frames: 9600, lufs: -14, gainDb: 0 }],
    sections: [{ name: 'Intro', startBar: 0, bars: 4 }],
    spectrogram: null,
    projectFile: 'song.mmp',
    projectSha256: null,
  };
  await writeFile(path.join(workspace, 'demo-ab.audition.studio.json'), JSON.stringify(auditionDesc, null, 2));

  // 1. Health endpoint returns expected metadata and leaks zero secrets/tokens
  const healthRes = await fetch(`${baseUrl}/api/studio/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, 'lmms-music-studio');
  assert.equal(healthJson.pid, process.pid);
  assert.ok(typeof healthJson.workspaceRealpath === 'string' && healthJson.workspaceRealpath.length > 0);
  assert.equal(healthJson.studioToken, undefined);
  assert.equal(healthJson.cookieSecret, undefined);

  // 2. Non-local Host header rejected with 403 (using node:http since fetch strips forbidden Host header)
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/api/studio/health', method: 'GET', headers: { host: 'evil.example' } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);

  // 3. Static workspace .html & .svg are strictly sandboxed + forced attachment
  for (const dangerousFile of ['evil.html', 'vector.svg']) {
    const res = await fetch(`${baseUrl}/${dangerousFile}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;\s*filename="/);
  }
  // Static WAV also carries sandbox CSP + nosniff (without attachment disposition)
  const wavRes = await fetch(`${baseUrl}/stems/1_Kick.wav`);
  assert.equal(wavRes.status, 200);
  assert.equal(wavRes.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(wavRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(wavRes.headers.get('content-disposition'), null);

  // 4. /studio/timeline and /studio/audition serve strict CSP with script-src 'self' and ZERO inline <script> tags
  for (const [route, expectedJs] of [
    ['/studio/timeline?session=demo', '/studio/timeline.js'],
    ['/studio/audition?session=demo-ab', '/studio/audition.js'],
  ]) {
    const pageRes = await fetch(`${baseUrl}${route}`);
    assert.equal(pageRes.status, 200);
    assert.equal(pageRes.headers.get('content-security-policy'), STUDIO_CSP);
    assert.match(STUDIO_CSP, /script-src 'self'/);
    assert.doesNotMatch(STUDIO_CSP, /script-src[^;]*'unsafe-inline'/);
    const setCookie = pageRes.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /studio_auth=[0-9a-f]+;\s*HttpOnly;\s*SameSite=Strict;\s*Path=\/api\/studio/i);

    const html = await pageRes.text();
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scriptTags.length, 1, `${route} must have exactly one external <script> tag and zero inline scripts`);
    assert.match(scriptTags[0][1], new RegExp(`src="${expectedJs.replace('/', '\\/')}"`));
    assert.equal(scriptTags[0][2].trim(), '', 'external script body must be empty');
    assert.doesNotMatch(html, /\bon\w+\s*=/i, 'zero inline event handler attributes');
  }

  // External assets return 200 with STUDIO_CSP
  for (const asset of ['/studio/timeline.js', '/studio/audition.js', '/studio/studio.css']) {
    const assetRes = await fetch(`${baseUrl}${asset}`);
    assert.equal(assetRes.status, 200, asset);
    assert.equal(assetRes.headers.get('content-security-policy'), STUDIO_CSP);
  }

  // Extract valid auth from /studio/timeline
  const tlRes = await fetch(`${baseUrl}/studio/timeline?session=demo`);
  const tlHtml = await tlRes.text();
  const { cookieHeader, studioToken } = extractCookieAndToken(tlRes, tlHtml);
  assert.ok(cookieHeader && studioToken.length === 64);

  const sampleFeedbackBody = JSON.stringify({
    session: 'demo',
    feedback: {
      schema: 'lmms-mcp/audition-feedback',
      version: 2,
      title: 'Demo',
      bpm: 120,
      timeSignature: [4, 4],
      sections: [],
      notes: [{ seconds: 2, bar: 1, displayBar: 2, beat: 1, text: 'Tighten kick' }],
    },
  });

  // 5. Cross-origin POST -> 403
  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: 'http://evil.example',
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: sampleFeedbackBody,
  })).status, 403);

  assert.equal((await fetch(`${baseUrl}/api/studio/open-lmms`, {
    method: 'POST',
    headers: {
      origin: 'http://evil.example',
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ project: 'song.mmp' }),
  })).status, 403);

  // 6. Missing/wrong X-Studio-Token or missing/wrong studio_auth cookie -> 403
  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: sampleFeedbackBody,
  })).status, 403, 'missing X-Studio-Token must be 403');

  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: cookieHeader,
      'x-studio-token': '0'.repeat(64),
      'content-type': 'application/json',
    },
    body: sampleFeedbackBody,
  })).status, 403, 'wrong X-Studio-Token must be 403');

  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: sampleFeedbackBody,
  })).status, 403, 'missing studio_auth cookie must be 403');

  assert.equal((await fetch(`${baseUrl}/api/studio/open-lmms`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: 'studio_auth=deadbeef',
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ project: 'song.mmp' }),
  })).status, 403, 'wrong studio_auth cookie must be 403');

  // Wrong Content-Type -> 415, oversize body -> 413
  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'text/plain',
    },
    body: sampleFeedbackBody,
  })).status, 415);

  assert.equal((await fetch(`${baseUrl}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ session: 'demo', pad: 'x'.repeat(270 * 1024) }),
  })).status, 413);

  // 7. Path traversal, dotfiles, and symlink/junction escapes -> 400/403/404
  assert.equal((await fetch(`${baseUrl}/.secret-dotfile.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/..%2Foutside-secret.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/studio/timeline?session=..%2Fescaped`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/studio/timeline?session=.hidden`)).status, 400);

  for (const badSession of ['../escape', '.dot', 'sub/name']) {
    const r = await fetch(`${baseUrl}/api/studio/feedback`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        cookie: cookieHeader,
        'x-studio-token': studioToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ session: badSession, feedback: JSON.parse(sampleFeedbackBody).feedback }),
    });
    assert.equal(r.status, 400);
  }

  for (const badProj of ['../outside.mmp', '.hidden.mmp', 'sub/song.mmp']) {
    const r = await fetch(`${baseUrl}/api/studio/open-lmms`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        cookie: cookieHeader,
        'x-studio-token': studioToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project: badProj }),
    });
    assert.equal(r.status, 400);
  }

  // Junction / symlink escape tests (directory junction works without elevation on Windows; file symlink when permitted)
  await writeFile(path.join(outside, 'escaped.mmp'), validMmp);
  await writeFile(path.join(outside, 'link.timeline.studio.json'), JSON.stringify(timelineDesc));
  try {
    await symlink(outside, path.join(workspace, 'junction-out'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(`${baseUrl}/junction-out/escaped.mmp`)).status, 404);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
  try {
    await symlink(path.join(outside, 'escaped.mmp'), path.join(workspace, 'symlink.mmp'), 'file');
    await symlink(path.join(outside, 'link.timeline.studio.json'), path.join(workspace, 'link.timeline.studio.json'), 'file');
    assert.equal((await fetch(`${baseUrl}/studio/timeline?session=link`)).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/studio/open-lmms`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        cookie: cookieHeader,
        'x-studio-token': studioToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project: 'symlink.mmp' }),
    })).status, 403);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }

  // Valid POST /api/studio/open-lmms invokes injected launcher without spawning GUI
  const openRes = await fetch(`${baseUrl}/api/studio/open-lmms`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ project: 'song.mmp' }),
  });
  assert.equal(openRes.status, 200);
  const openJson = await openRes.json();
  assert.equal(openJson.ok, true);
  assert.equal(openJson.project, 'song.mmp');
  assert.equal(launchedCalls.length, 1);
  assert.ok(launchedCalls[0].args[0].endsWith('song.mmp'));
});

test('ensureStudioServer port-collision discovery: skips occupied 18290 without killing it, binds 18291, and re-attaches on second call', async t => {
  await closeStudioServers();
  const wsOne = await mkdtemp(path.join(os.tmpdir(), 'lmms-port-ws1-'));
  const wsTwo = await mkdtemp(path.join(os.tmpdir(), 'lmms-port-ws2-'));

  let dummyHits = 0;
  const dummy = createServer((_req, res) => {
    dummyHits++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('unrelated service on 18290');
  });

  // Prefer testing 18290..18299 directly; if 18290 is externally held on the host, test an isolated range cleanly.
  let rangeStart = 18290;
  let rangeEnd = 18299;
  try {
    await new Promise((resolve, reject) => {
      dummy.once('error', reject);
      dummy.listen(18290, '127.0.0.1', () => {
        dummy.removeListener('error', reject);
        resolve();
      });
    });
  } catch {
    await new Promise(resolve => dummy.listen(0, '127.0.0.1', resolve));
    rangeStart = dummy.address().port;
    rangeEnd = rangeStart + 9;
  }

  t.after(async () => {
    await closeStudioServers();
    dummy.closeAllConnections?.();
    await new Promise(resolve => dummy.close(resolve));
    await rm(wsOne, { recursive: true, force: true });
    await rm(wsTwo, { recursive: true, force: true });
  });

  const first = await ensureStudioServer({
    workspaceDir: wsOne,
    portRange: [rangeStart, rangeEnd],
  });
  assert.equal(first.port, rangeStart + 1, `expected ${rangeStart + 1} when ${rangeStart} is occupied by dummy HTTP server`);
  assert.equal(first.reused, false);
  assert.ok(dummy.listening && dummyHits >= 1, 'dummy server on first port was probed and never killed');

  // Second call for same workspace attaches to 18291 (both via in-process cache and via live /api/studio/health HTTP probe)
  const secondCached = await ensureStudioServer({
    workspaceDir: wsOne,
    portRange: [rangeStart, rangeEnd],
  });
  assert.equal(secondCached.port, first.port);
  assert.equal(secondCached.reused, true);

  const secondProbed = await ensureStudioServer({
    workspaceDir: wsOne,
    portRange: [rangeStart, rangeEnd],
    bypassInProcessCache: true,
  });
  assert.equal(secondProbed.port, first.port);
  assert.equal(secondProbed.reused, true);

  // Separate workspace skips both dummy (18290) and wsOne (18291) -> binds 18292
  const otherWs = await ensureStudioServer({
    workspaceDir: wsTwo,
    portRange: [rangeStart, rangeEnd],
  });
  assert.equal(otherWs.port, rangeStart + 2);
  assert.equal(otherWs.reused, false);
});

test('Unified Feedback v2 round-trip (Display Bar 5 -> bar 4, staleProjectRevision, dynamic tempo guard, v1 compatibility)', async t => {
  await closeStudioServers();
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-v2-fb-'));
  const mcp = await createMcpTestClient(workspace);

  t.after(async () => {
    await mcp.client.close().catch(() => {});
    await closeStudioServers();
    await rm(workspace, { recursive: true, force: true });
  });

  await mcp.call('create_project', {
    output: 'song.mmp',
    bpm: 120,
    lengthBars: 8,
    tracks: [
      {
        name: 'Kick',
        voice: 'kick',
        role: 'drums',
        volume: 85,
        patterns: [{ name: 'Beat', bar: 0, bars: 8, steps: { grid: 'X---x---X---x---' } }],
      },
      {
        name: 'Snare',
        voice: 'snare',
        role: 'drums',
        volume: 80,
        patterns: [{ name: 'Backbeat', bar: 0, bars: 8, steps: { grid: '----X-------X---' } }],
      },
    ],
  });

  // Create stem WAVs matching 8 bars at 120 BPM 4/4 (16 seconds)
  await mkdir(path.join(workspace, 'stems'), { recursive: true });
  await writeFile(path.join(workspace, 'stems', '1_Kick.wav'), makeSineWav(16, 65));
  await writeFile(path.join(workspace, 'stems', '2_Snare.wav'), makeSineWav(16, 190));
  await writeFile(path.join(workspace, 'master.wav'), makeSineWav(16, 110));

  // Verify dynamic <bpm> tempo automation is clearly rejected when building timeline page
  const rawXml = await readFile(path.join(workspace, 'song.mmp'), 'utf8');
  const dynamicDoc = new DOMParser().parseFromString(rawXml, 'application/xml');
  const headNode = dynamicDoc.getElementsByTagName('head')[0];
  const dynBpmNode = dynamicDoc.createElement('bpm');
  dynBpmNode.setAttribute('value', '120');
  dynBpmNode.setAttribute('id', '999');
  headNode.appendChild(dynBpmNode);
  await writeFile(path.join(workspace, 'dynamic.mmp'), new XMLSerializer().serializeToString(dynamicDoc));

  const dynResult = await mcp.callRaw('build_timeline_page', {
    stems: 'stems',
    project: 'dynamic.mmp',
    output: 'dyn.html',
  });
  assert.equal(dynResult.isError, true);
  assert.match(dynResult.content[0].text, /dynamic <bpm> tempo automation/i);

  // Build Timeline page linked to static song.mmp (bpm & timeSignature derived automatically!)
  const built = await mcp.call('build_timeline_page', {
    stems: 'stems',
    mix: 'master.wav',
    project: 'song.mmp',
    sections: [
      { name: 'Intro', startBar: 0, bars: 4 },
      { name: 'Drop', startBar: 4, bars: 4 },
    ],
    title: 'Club Groove',
    output: 'club-timeline.html',
  });
  assert.ok(built.studioUrl && built.studioUrl.includes('/studio/timeline?session=club-timeline'));
  assert.equal(built.bpm, 120);
  assert.deepEqual(built.timeSignature, [4, 4]);
  assert.equal(built.projectFile, 'song.mmp');
  assert.match(built.projectSha256, /^[0-9a-f]{64}$/);

  // Navigate to studioUrl to receive capability token & cookie
  const pageRes = await fetch(built.studioUrl);
  assert.equal(pageRes.status, 200);
  const pageHtml = await pageRes.text();
  const { cookieHeader, studioToken } = extractCookieAndToken(pageRes, pageHtml);

  // Read written studio descriptor and construct v2 note at Display Bar 5
  const descriptor = JSON.parse(await readFile(path.join(workspace, built.studioDescriptor), 'utf8'));
  const noteAtDisplayBar5 = createTimelineNote(descriptor, {
    displayBar: 5,
    beat: 1,
    text: 'Snare needs sharper transient on drop downbeat',
    rating: 3,
    mode: 'stems',
    soloedLanes: ['Snare'],
    mutedLanes: [],
  });
  assert.equal(noteAtDisplayBar5.bar, 4, 'Display Bar 5 maps to 0-based MCP bar 4');
  assert.equal(noteAtDisplayBar5.displayBar, 5);
  assert.equal(noteAtDisplayBar5.seconds, 8);
  assert.equal(noteAtDisplayBar5.section, 'Drop');

  const feedbackPayload = buildTimelineFeedback(descriptor, [noteAtDisplayBar5], { Intro: 5, Drop: 3 });
  assert.equal(feedbackPayload.schema, 'lmms-mcp/audition-feedback');
  assert.equal(feedbackPayload.version, 2);

  const origin = new URL(built.studioUrl).origin;
  const postRes = await fetch(`${origin}/api/studio/feedback`, {
    method: 'POST',
    headers: {
      origin,
      cookie: cookieHeader,
      'x-studio-token': studioToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      session: built.studioSession,
      feedback: feedbackPayload,
    }),
  });
  assert.equal(postRes.status, 200);
  const postJson = await postRes.json();
  assert.equal(postJson.file, 'club-timeline-feedback.json');
  assert.equal(
    postJson.message,
    'Saved to workspace (club-timeline-feedback.json) \u2014 tell your LLM to apply your notes',
  );

  // read_feedback before project mutation -> bar: 4, displayBar: 5, staleProjectRevision: false
  const readBefore = await mcp.call('read_feedback', { file: 'club-timeline-feedback.json' });
  assert.equal(readBefore.version, 2);
  assert.equal(readBefore.staleProjectRevision, false);
  assert.equal(readBefore.notes.length, 1);
  assert.equal(readBefore.notes[0].bar, 4);
  assert.equal(readBefore.notes[0].displayBar, 5);
  assert.deepEqual(readBefore.notes[0].soloedLanes, ['Snare']);
  assert.deepEqual(readBefore.byBar['4'], ['Snare needs sharper transient on drop downbeat']);

  // Mutate song.mmp via MCP apply_edits and confirm staleProjectRevision becomes true
  await mcp.call('apply_edits', {
    project: 'song.mmp',
    output: 'song.mmp',
    overwrite: true,
    edits: [{ op: 'set_track_mix', args: { trackName: 'Snare', volume: 95 } }],
  });

  const readAfter = await mcp.call('read_feedback', { file: 'club-timeline-feedback.json' });
  assert.equal(readAfter.staleProjectRevision, true);

  // Verify backward-compatible version: 1 feedback reading
  const v1Read = await mcp.call('read_feedback', {
    text: JSON.stringify({
      schema: 'lmms-mcp/audition-feedback',
      version: 1,
      title: 'Legacy',
      bpm: 120,
      timeSignature: [4, 4],
      sections: [],
      notes: [{ seconds: 4, bar: 2, beat: 1, text: 'Legacy v1 note' }],
    }),
  });
  assert.equal(v1Read.version, 1);
  assert.equal(v1Read.notes[0].bar, 2);
  assert.equal(v1Read.notes[0].displayBar, 3);
});

test('two-way Desktop LMMS sync: open_in_lmms (LMMS_NO_GUI_LAUNCH=1), dirty guard blocks clobber, sync_from_lmms preserves notes + rejects unverified sample', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-sync-e2e-'));
  const mcp = await createMcpTestClient(workspace, { LMMS_NO_GUI_LAUNCH: '1' });

  t.after(async () => {
    await mcp.client.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  });

  await mcp.call('create_project', {
    output: 'groove.mmp',
    bpm: 124,
    lengthBars: 4,
    tracks: [
      {
        name: 'Lead',
        voice: 'pluck',
        role: 'lead',
        volume: 80,
        patterns: [{
          name: 'Hook',
          bar: 0,
          bars: 4,
          notes: [{ tick: 0, midi: 60, length: 48, velocity: 100 }],
        }],
      },
    ],
  });

  // 1. open_in_lmms with LMMS_NO_GUI_LAUNCH=1 records baseline without spawning a window
  const opened = await mcp.call('open_in_lmms', { project: 'groove.mmp' });
  assert.equal(opened.launched, false);
  assert.equal(opened.skippedLaunchReason, 'LMMS_NO_GUI_LAUNCH');
  assert.match(opened.openedSha256, /^[0-9a-f]{64}$/);

  const syncState = await readSyncState(workspace);
  assert.equal(syncState.project, 'groove.mmp');
  assert.equal(syncState.openedSha256, opened.openedSha256);

  // Also verify direct openInLmms with injected launcher callback receives exact path
  const directLaunches = [];
  await openInLmms({
    project: 'groove.mmp',
    workspaceDir: workspace,
    env: { ...process.env, LMMS_STRICT_COPYRIGHT: '1' },
    launcher: async callInfo => { directLaunches.push(callInfo); },
  });
  assert.equal(directLaunches.length, 1);
  assert.ok(directLaunches[0].projectPath.endsWith('groove.mmp'));

  // 2. Simulate user editing groove.mmp in Desktop LMMS (adding a second MIDI note G4=67 -> key=55 at tick 96)
  const mmpPath = path.join(workspace, 'groove.mmp');
  const editedDoc = new DOMParser().parseFromString(await readFile(mmpPath, 'utf8'), 'application/xml');
  const patternNode = editedDoc.getElementsByTagName('pattern')[0];
  const userNote = editedDoc.createElement('note');
  userNote.setAttribute('key', '55');
  userNote.setAttribute('pos', '96');
  userNote.setAttribute('len', '48');
  userNote.setAttribute('vol', '110');
  userNote.setAttribute('pan', '0');
  patternNode.appendChild(userNote);
  await writeFile(mmpPath, new XMLSerializer().serializeToString(editedDoc));

  // 3. Un-synced MCP edit MUST refuse to clobber user's Desktop LMMS changes
  const blockedEdit = await mcp.callRaw('apply_edits', {
    project: 'groove.mmp',
    output: 'groove.mmp',
    overwrite: true,
    edits: [{ op: 'set_master', args: { volume: 90 } }],
  });
  assert.equal(blockedEdit.isError, true);
  assert.match(blockedEdit.content[0].text, /sync_from_lmms/);

  // Even editing groove.mmp into a separate output before syncing is blocked so user edits aren't missed
  const blockedCopyEdit = await mcp.callRaw('set_track_mix', {
    project: 'groove.mmp',
    output: 'groove-v2.mmp',
    trackName: 'Lead',
    volume: 75,
  });
  assert.equal(blockedCopyEdit.isError, true);
  assert.match(blockedCopyEdit.content[0].text, /sync_from_lmms/);

  // 4. Call sync_from_lmms -> adopts user edits, updates provenance sidecar, unlocks MCP edits
  const synced = await mcp.call('sync_from_lmms', { project: 'groove.mmp' });
  assert.equal(synced.synced, true);
  assert.equal(synced.changed, true);
  assert.equal(synced.strictCompliant, true);

  const readPat = await mcp.call('read_pattern', { project: 'groove.mmp', trackName: 'Lead', bar: 0 });
  assert.equal(readPat.notes.length, 2, 'user-added note from Desktop LMMS is preserved');
  assert.deepEqual(readPat.notes.map(n => n.midi), [60, 67]);

  const auditAfterSync = await mcp.call('audit_copyright', { project: 'groove.mmp' });
  assert.equal(auditAfterSync.compliant, true);

  // Subsequent MCP edit now succeeds and preserves user's added note!
  await mcp.call('apply_edits', {
    project: 'groove.mmp',
    output: 'groove.mmp',
    overwrite: true,
    edits: [{ op: 'set_track_mix', args: { trackName: 'Lead', volume: 72 } }],
  });
  const readPatAfterMcp = await mcp.call('read_pattern', { project: 'groove.mmp', trackName: 'Lead', bar: 0 });
  assert.deepEqual(readPatAfterMcp.notes.map(n => n.midi), [60, 67]);

  // 5. Simulate user saving a sibling compressed groove.mmpz in Desktop LMMS with a 3rd note (A4=69 -> key=57)
  const mmpzDoc = new DOMParser().parseFromString(await readFile(mmpPath, 'utf8'), 'application/xml');
  const thirdNote = mmpzDoc.createElement('note');
  thirdNote.setAttribute('key', '57');
  thirdNote.setAttribute('pos', '144');
  thirdNote.setAttribute('len', '48');
  thirdNote.setAttribute('vol', '105');
  thirdNote.setAttribute('pan', '0');
  mmpzDoc.getElementsByTagName('pattern')[0].appendChild(thirdNote);
  const xmlBytes = Buffer.from(new XMLSerializer().serializeToString(mmpzDoc), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(xmlBytes.length);
  await writeFile(path.join(workspace, 'groove.mmpz'), Buffer.concat([header, deflateSync(xmlBytes)]));

  const adoptResult = await mcp.call('sync_from_lmms', { project: 'groove.mmp', adoptCompressedCopy: true });
  assert.equal(adoptResult.adoptedCompressedCopy, true);
  const afterAdoptNotes = await mcp.call('read_pattern', { project: 'groove.mmp', trackName: 'Lead', bar: 0 });
  assert.deepEqual(afterAdoptNotes.notes.map(n => n.midi), [60, 67, 69]);

  // 6. Simulate user injecting an unverified stock sample track in Desktop LMMS -> sync_from_lmms fails cleanly and preserves file!
  const taintedDoc = new DOMParser().parseFromString(await readFile(mmpPath, 'utf8'), 'application/xml');
  const containerNode = taintedDoc.getElementsByTagName('trackcontainer')[0];
  const badTrack = taintedDoc.createElement('track');
  badTrack.setAttribute('type', '0');
  badTrack.setAttribute('name', 'UnverifiedSampleLoop');
  badTrack.setAttribute('muted', '0');
  badTrack.setAttribute('solo', '0');
  const badInstTrack = taintedDoc.createElement('instrumenttrack');
  badInstTrack.setAttribute('vol', '100');
  badInstTrack.setAttribute('pan', '0');
  badInstTrack.setAttribute('basenote', '57');
  const badInst = taintedDoc.createElement('instrument');
  badInst.setAttribute('name', 'audiofileprocessor');
  const afp = taintedDoc.createElement('audiofileprocessor');
  afp.setAttribute('src', 'drums/kick01.ogg');
  badInst.appendChild(afp);
  badInstTrack.appendChild(badInst);
  badTrack.appendChild(badInstTrack);
  containerNode.appendChild(badTrack);
  const taintedXml = new XMLSerializer().serializeToString(taintedDoc);
  await writeFile(mmpPath, taintedXml);

  await assert.rejects(
    () => syncFromLmms({ project: 'groove.mmp', workspaceDir: workspace, env: { ...process.env, LMMS_STRICT_COPYRIGHT: '1' } }),
    err => {
      assert.match(err.message, /UnverifiedSampleLoop/);
      assert.match(err.message, /audiofileprocessor/);
      assert.match(err.message, /preserved untouched/i);
      return true;
    },
  );
  assert.equal(await readFile(mmpPath, 'utf8'), taintedXml, 'user edited file on disk was preserved without data loss');
});

test('512 MiB decoded buffer budget planner and LRU stem eviction keep RAM bounded, and zero Unicode media/emoji symbols exist in HTML', () => {
  assert.equal(MAX_DECODED_BYTES, 512 * 1024 * 1024);
  // 5 minutes at 48 kHz stereo = 14,400,000 frames * 2 * 4 = 115,200,000 bytes (~109.86 MiB) per stem
  const frames5Min = 5 * 60 * 48000;
  const stemBytes = estimateDecodedBytes(frames5Min, 2);
  assert.equal(stemBytes, 115_200_000);

  // Mix + 6 stems = 7 * 115.2 MB = 806.4 MB > 512 MiB (536,870,912 bytes). Only 4 tracks (460.8 MB) fit eagerly!
  const items = [
    { id: 'mix', isMix: true, muted: false, solo: false, decodedBytes: stemBytes },
    ...Array.from({ length: 6 }, (_, idx) => ({
      id: `stem-${idx + 1}`,
      isMix: false,
      muted: idx === 1 || idx === 2,
      solo: false,
      decodedBytes: stemBytes,
    })),
  ];

  const initialPlan = planDecodedBudget(items, MAX_DECODED_BYTES);
  assert.ok(initialPlan.plannedBytes <= MAX_DECODED_BYTES);
  assert.equal(initialPlan.eagerIds.length, 4);
  assert.equal(initialPlan.lazyIds.length, 3);
  assert.equal(initialPlan.eagerIds[0], 'mix', 'Master Mix is prioritised first');
  assert.ok(initialPlan.lazyIds.includes('stem-2') && initialPlan.lazyIds.includes('stem-3'), 'muted excess stems stay lazy');

  // Simulate current state: mix + stem-1 (unmuted, lastUsedAt=10) + stem-2 (muted, lastUsedAt=2) + stem-3 (muted, lastUsedAt=5) loaded (460.8 MB).
  // Soloing lazy stem-6 requires 115.2 MB -> must evict oldest muted stem ('stem-2', lastUsedAt=2)!
  const runtimeEntries = [
    { id: 'mix', isMix: true, loaded: true, muted: false, solo: false, decodedBytes: stemBytes, lastUsedAt: 1 },
    { id: 'stem-1', isMix: false, loaded: true, muted: false, solo: false, decodedBytes: stemBytes, lastUsedAt: 10 },
    { id: 'stem-2', isMix: false, loaded: true, muted: true, solo: false, decodedBytes: stemBytes, lastUsedAt: 2 },
    { id: 'stem-3', isMix: false, loaded: true, muted: true, solo: false, decodedBytes: stemBytes, lastUsedAt: 5 },
    { id: 'stem-6', isMix: false, loaded: false, muted: false, solo: true, decodedBytes: stemBytes, lastUsedAt: 20 },
  ];
  const onDemand = planOnDemandDecode(runtimeEntries, 'stem-6', stemBytes, MAX_DECODED_BYTES, { mode: 'stems' });
  assert.equal(onDemand.canLoad, true);
  assert.deepEqual(onDemand.evictIds, ['stem-2'], 'evicts oldest muted LRU stem first');
  assert.ok(onDemand.projectedBytes <= MAX_DECODED_BYTES);

  // Oversized single buffer > 512 MiB is refused cleanly
  const impossible = planOnDemandDecode(runtimeEntries, 'giant', MAX_DECODED_BYTES + 4, MAX_DECODED_BYTES);
  assert.equal(impossible.canLoad, false);

  // Verify zero Unicode media/star/emoji symbols across all 5 HTML generators + required plain-text labels
  const tlOffline = timelineHtml({
    title: 'Clean Song',
    bpm: 120,
    bars: 4,
    seconds: 8,
    lanes: [{ name: 'Kick', family: 'drums', url: 'stems/1_Kick.wav', peaks: [10, 80] }],
    mix: { name: 'Master Mix', family: 'harmony', url: 'mix.wav', peaks: [20, 90] },
    sections: [{ name: 'Intro', startBar: 0, bars: 4 }],
    effects: [],
    generated: '2026-11-26',
    projectFile: 'song.mmp',
  });
  const tlStudio = renderStudioTimelineHtml({
    title: 'Clean Song',
    bpm: 120,
    timeSignature: [4, 4],
    bars: 4,
    seconds: 8,
    lanes: [{ name: 'Kick', family: 'drums', url: '/stems/1_Kick.wav', peaks: [10, 80] }],
    mix: { name: 'Master Mix', family: 'harmony', url: '/mix.wav', peaks: [20, 90] },
    sections: [{ name: 'Intro', startBar: 0, bars: 4 }],
    effects: [],
    projectFile: 'song.mmp',
  }, { studioToken: 'a'.repeat(64), session: 'clean' });

  const audModel = gameModel({
    name: 'forest',
    source: 'song.mmp',
    bpm: 120,
    timeSignature: [4, 4],
    bars: 4,
    sampleRate: 48000,
    loop: { file: 'forest-loop.wav', startFrame: 0, endFrame: 384000 },
    files: [{ file: 'forest-loop.wav', role: 'loop', bars: 4, frames: 384000 }],
  });
  const audOffline = renderPage(audModel);
  const audStudio = renderStudioAuditionHtml({ ...audModel, projectFile: 'song.mmp' }, { studioToken: 'b'.repeat(64), session: 'forest' });
  const libHtml = browserHtml({
    title: 'Sound Library',
    items: [{ t: 'track', n: 'Song', p: 'song.wav', s: 'My tracks', c: '', r: 'track', g: ['wav'], u: 'song.wav' }],
    generated: '2026-11-26',
  });

  for (const [label, html] of [
    ['timelineHtml', tlOffline],
    ['renderStudioTimelineHtml', tlStudio],
    ['renderPage', audOffline],
    ['renderStudioAuditionHtml', audStudio],
    ['browserHtml', libHtml],
  ]) {
    assert.doesNotMatch(html, FORBIDDEN_UNICODE_MEDIA_EMOJI, `${label} must contain zero Unicode media/star/emoji characters`);
  }

  assert.match(tlOffline, /Stems \(isolated pre-master tracks\)/);
  assert.match(tlOffline, /Master Mix \(authoritative post-master output\)/);
  assert.match(tlStudio, />Play</);
  assert.match(tlStudio, />Start</);
  assert.match(tlStudio, />Send Feedback to Studio</);
  assert.match(tlStudio, />Open in LMMS</);
  assert.match(audStudio, />Send Feedback to Studio</);
  assert.match(audStudio, />Open in LMMS</);
  assert.match(libHtml, />Starred</);
  assert.match(libHtml, />Prev</);
  assert.match(libHtml, />Play</);
  assert.match(libHtml, />Next</);
});

test('headless browser verification: /studio/timeline WebAudio #selftest, zero CSP errors, and Send Feedback to Studio click', async t => {
  const candidates = (process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge']
  ).filter(p => existsSync(p));

  if (candidates.length === 0) {
    t.skip('No local Chrome/Edge binary found for headless WebAudio check');
    return;
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-headless-ui-'));
  const profile = await mkdtemp(path.join(os.tmpdir(), 'lmms-headless-profile-'));
  const server = startServer({
    port: 0,
    folders: { workspace, stock: null, soundfonts: workspace, library: null },
    env: { ...process.env, LMMS_STRICT_COPYRIGHT: '1', LMMS_NO_GUI_LAUNCH: '1' },
  });
  await once(server, 'listening');

  let child = null;
  let socket = null;
  let cdp = null;

  t.after(async () => {
    if (cdp && socket && socket.readyState === WebSocket.OPEN) {
      await Promise.race([cdp('Browser.close').catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    }
    try { socket?.close(); } catch { /* ignore */ }
    if (child?.pid) {
      await killProcessTreeByPid(child.pid);
    }
    try { child?.kill(); } catch { /* ignore */ }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });

  await mkdir(path.join(workspace, 'stems'), { recursive: true });
  await writeFile(path.join(workspace, 'stems', '1_Kick.wav'), makeSineWav(2, 80));
  await writeFile(path.join(workspace, 'stems', '2_Bass.wav'), makeSineWav(2, 110));
  await writeFile(path.join(workspace, 'mix.wav'), makeSineWav(2, 95));

  const desc = {
    schema: STUDIO_DESCRIPTOR_SCHEMA,
    kind: 'timeline',
    session: 'headless-song',
    title: 'Headless WebAudio Check',
    bpm: 120,
    timeSignature: [4, 4],
    bars: 1,
    seconds: 2,
    sampleRate: 48000,
    lanes: [
      { name: 'Kick', family: 'drums', url: '/stems/1_Kick.wav', peaks: [20, 90, 40], frames: 96000, channels: 2, decodedBytes: 768000 },
      { name: 'Bass', family: 'bass', url: '/stems/2_Bass.wav', peaks: [50, 70, 60], frames: 96000, channels: 2, decodedBytes: 768000 },
    ],
    mix: { name: 'Master Mix', family: 'harmony', url: '/mix.wav', peaks: [40, 95, 50], frames: 96000, channels: 2, decodedBytes: 768000 },
    sections: [{ name: 'Main', startBar: 0, bars: 1 }],
    effects: [],
    generated: '2026-11-26',
    projectFile: null,
    projectSha256: null,
  };
  await writeFile(path.join(workspace, 'headless-song.timeline.studio.json'), JSON.stringify(desc, null, 2));

  child = spawn(candidates[0], [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 80 && !existsSync(portFile); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!existsSync(portFile)) {
    t.skip('Browser did not start headless DevTools port in this environment');
    return;
  }

  const debugPort = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0].trim();
  const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(x => x.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let msgId = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      browserErrors.push(msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon\.ico/.test(msg.params.entry.url ?? '')) {
      browserErrors.push(msg.params.entry.text);
    }
  };
  cdp = (method, params = {}) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression =>
    (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');

  const url = `http://127.0.0.1:${server.address().port}/studio/timeline?session=headless-song#selftest`;
  await cdp('Page.navigate', { url });

  let selftestJson = null;
  for (let i = 0; i < 60; i++) {
    selftestJson = await evaluate("document.getElementById('board')?.dataset?.selftest ?? null");
    if (selftestJson) break;
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(selftestJson, 'Timeline #selftest finished in headless WebAudio');
  assert.deepEqual(browserErrors, [], 'Zero CSP or runtime errors in headless browser');

  const selftest = JSON.parse(selftestJson);
  assert.equal(selftest.ok, true);
  assert.equal(selftest.maxStemDriftSamples, 0);
  assert.equal(selftest.loadedLanes, 3);
  assert.equal(selftest.lazyLanes, 0);
  assert.ok(selftest.decodedBytes > 0 && selftest.decodedBytes <= MAX_DECODED_BYTES);

  // Toggle mode button and verify authoritative banner text
  const bannerBefore = await evaluate("document.getElementById('mode-banner').textContent");
  assert.equal(bannerBefore, 'Stems (isolated pre-master tracks)');
  await evaluate("document.getElementById('mode').click(); document.getElementById('mode-banner').textContent");
  const bannerAfter = await evaluate("document.getElementById('mode-banner').textContent");
  assert.equal(bannerAfter, 'Master Mix (authoritative post-master output)');

  // Pin a note via UI and click "Send Feedback to Studio"
  await evaluate(`
    document.getElementById('notetext').value = 'Headless DOM note at Bar 1';
    document.getElementById('note').click();
    document.getElementById('send-feedback').click();
  `);
  let confirmText = '';
  for (let i = 0; i < 40; i++) {
    confirmText = await evaluate("document.getElementById('feedback-status')?.textContent ?? ''");
    if (confirmText.startsWith('Saved to workspace')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(
    confirmText,
    'Saved to workspace (headless-song-feedback.json) \u2014 tell your LLM to apply your notes',
  );
  const writtenFeedback = JSON.parse(await readFile(path.join(workspace, 'headless-song-feedback.json'), 'utf8'));
  assert.equal(writtenFeedback.version, 2);
  assert.equal(writtenFeedback.notes[0].bar, 0);
  assert.equal(writtenFeedback.notes[0].displayBar, 1);
  assert.equal(writtenFeedback.notes[0].text, 'Headless DOM note at Bar 1');
});
