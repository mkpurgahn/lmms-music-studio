import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import midiPackage from '@tonejs/midi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodeWav } from '../audio.mjs';
import { startServer } from '../library-server.mjs';
import {
  LEGAL_SCOPE_NOTE,
  PROVENANCE_SCHEMA,
  PROVENANCE_VERSION,
  assertProjectProvenance,
  auditProjectProvenance,
  combineClassifications,
  inspectPresetFile,
  isStrictCopyright,
  provenancePathFor,
  sha256File,
  verifyAudioFileProvenance,
  verifySoundfontProvenance,
  writeProvenanceSidecar,
} from './provenance.mjs';
import { buildSf2Buffer } from './sf2-builder.mjs';
import { TRACKED_LOCK_PATH } from './soundfont-pack.mjs';
import { resolveLmmsExecutable, resolveLmmsPresetsDir, resolveSoundfontsDir } from './workspace-config.mjs';

function makeSineWav(sampleRate = 48000, seconds = 2.5, hz = 220) {
  const frames = Math.round(sampleRate * seconds);
  const left = Float32Array.from({ length: frames }, (_, i) => {
    const click = i % (sampleRate / 2) < 120 ? 0.35 : 0;
    return 0.25 * Math.sin(2 * Math.PI * hz * i / sampleRate) + click;
  });
  return encodeWav({ sampleRate, frames, channels: [left, Float32Array.from(left)] });
}

function makeDummySf2(bankName = 'Unlocked Fixture Bank') {
  const sr = 48000;
  const wave = Int16Array.from({ length: 4800 }, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * 261.63 * i / sr)));
  return buildSf2Buffer({
    bankName,
    presets: [{
      name: 'Test Piano',
      bank: 0,
      preset: 0,
      zones: [{ sampleName: 'tone', sampleRate: sr, channels: [wave], lokey: 36, hikey: 84, rootKey: 60 }],
    }],
  });
}

test('isStrictCopyright defaults to true and only disables on "0" or "false"', () => {
  assert.equal(isStrictCopyright({}), true);
  assert.equal(isStrictCopyright({ LMMS_STRICT_COPYRIGHT: '1' }), true);
  assert.equal(isStrictCopyright({ LMMS_STRICT_COPYRIGHT: 'true' }), true);
  assert.equal(isStrictCopyright({ LMMS_STRICT_COPYRIGHT: 'yes' }), true);
  assert.equal(isStrictCopyright({ LMMS_STRICT_COPYRIGHT: '0' }), false);
  assert.equal(isStrictCopyright({ LMMS_STRICT_COPYRIGHT: 'false' }), false);
  assert.equal(combineClassifications(['pure-synthesis', 'pure-synthesis']), 'pure-synthesis');
  assert.equal(combineClassifications(['verified-cc0-sf2']), 'verified-cc0-sf2');
  assert.equal(combineClassifications(['user-attested-mic-take']), 'user-attested-mic-take');
  assert.equal(combineClassifications(['pure-synthesis', 'verified-cc0-sf2']), 'hybrid-verified');
});

test('verifyAudioFileProvenance enforces realpath containment, SHA-256 binding, and ignores .meta.json', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-unit-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-outside-'));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const wavBytes = makeSineWav(48000, 0.5);
  const unprovenanced = path.join(workspace, 'unprovenanced.wav');
  await writeFile(unprovenanced, wavBytes);

  // Even with a spoofed .meta.json claiming own-recording, verifyAudioFileProvenance fails closed.
  await writeFile(
    path.join(workspace, 'unprovenanced.meta.json'),
    JSON.stringify({ format: 'lmms-mcp-meta/1', title: 'Spoof', licence: 'own-recording', kind: 'take' }),
  );
  await assert.rejects(
    verifyAudioFileProvenance(unprovenanced, { workspaceDir: workspace, env: {} }),
    /missing.*\.provenance\.json/i,
  );

  // Valid system provenance sidecar passes.
  const validWav = path.join(workspace, 'synth.wav');
  await writeFile(validWav, wavBytes);
  const writtenRecord = await writeProvenanceSidecar(validWav, {
    workspaceDir: workspace,
    classification: 'pure-synthesis',
    generatorTool: 'synth_drums',
    sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'lmms-mcp-drum-synthesis', licence: 'MIT' }],
  });
  assert.equal(writtenRecord.schema, PROVENANCE_SCHEMA);
  assert.equal(writtenRecord.version, PROVENANCE_VERSION);
  assert.equal(writtenRecord.strictCompliant, true);
  assert.equal(writtenRecord.legalScopeNote, LEGAL_SCOPE_NOTE);

  const verified = await verifyAudioFileProvenance(validWav, { workspaceDir: workspace, env: {} });
  assert.equal(verified.verified, true);
  assert.equal(verified.sha256, writtenRecord.sha256);

  // Tampering 1 byte in the WAV invalidates provenance immediately.
  const tamperedBuf = Buffer.from(wavBytes);
  tamperedBuf[tamperedBuf.length - 1] ^= 0x01;
  await writeFile(validWav, tamperedBuf);
  await assert.rejects(
    verifyAudioFileProvenance(validWav, { workspaceDir: workspace, env: {} }),
    /SHA-256 mismatch/i,
  );

  // External path and symlink escaping workspaceDir fail closed.
  const outsideWav = path.join(outside, 'ext.wav');
  await writeFile(outsideWav, wavBytes);
  await writeProvenanceSidecar(outsideWav, {
    workspaceDir: outside,
    classification: 'pure-synthesis',
    generatorTool: 'synth_drums',
    sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'test', licence: 'MIT' }],
  });
  await assert.rejects(
    verifyAudioFileProvenance(outsideWav, { workspaceDir: workspace, env: {} }),
    /escapes workspace/i,
  );

  try {
    const escapedLink = path.join(workspace, 'escaped-link.wav');
    await symlink(outsideWav, escapedLink, 'file');
    await assert.rejects(
      verifyAudioFileProvenance(escapedLink, { workspaceDir: workspace, env: {} }),
      /escapes workspace/i,
    );
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
});

test('inspectPresetFile rejects audiofileprocessor, vestige, and tripleoscillator wavetype=7 or userwavefile', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lmms-preset-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const writePreset = async (name, innerXml) => {
    const full = path.join(dir, name);
    await writeFile(
      full,
      `<?xml version="1.0"?><lmms-project version="1.0" type="instrumenttracksettings"><head/><instrumenttracksettings><instrumenttrack vol="100" basenote="57">${innerXml}</instrumenttrack></instrumenttracksettings></lmms-project>`,
    );
    return full;
  };

  const cleanTo = await writePreset(
    'clean.xpf',
    '<instrument name="tripleoscillator"><tripleoscillator wavetype0="0" wavetype1="2" wavetype2="6" userwavefile0="" userwavefile1="" userwavefile2=""/></instrument>',
  );
  const resClean = await inspectPresetFile(cleanTo, { workspaceDir: dir, env: {} });
  assert.equal(resClean.allowed, true);
  assert.equal(resClean.classification, 'pure-synthesis');

  const wave7 = await writePreset(
    'wave7.xpf',
    '<instrument name="tripleoscillator"><tripleoscillator wavetype0="0" wavetype1="7" wavetype2="0" userwavefile0="" userwavefile1="" userwavefile2=""/></instrument>',
  );
  const resWave7 = await inspectPresetFile(wave7, { workspaceDir: dir, env: {} });
  assert.equal(resWave7.allowed, false);
  assert.match(resWave7.reason, /wavetype1="7"/i);

  const userWave = await writePreset(
    'userwave.xpf',
    '<instrument name="tripleoscillator"><tripleoscillator wavetype0="0" wavetype1="0" wavetype2="0" userwavefile0="samples/empty.wav"/></instrument>',
  );
  const resUserWave = await inspectPresetFile(userWave, { workspaceDir: dir, env: {} });
  assert.equal(resUserWave.allowed, false);
  assert.match(resUserWave.reason, /userwavefile0/i);

  for (const forbidden of ['vestige', 'patman', 'gigplayer', 'carlarack', 'carlapatchbay', 'mysteryplugin']) {
    const p = await writePreset(`${forbidden}.xpf`, `<instrument name="${forbidden}"><${forbidden}/></instrument>`);
    const res = await inspectPresetFile(p, { workspaceDir: dir, env: {} });
    assert.equal(res.allowed, false, `${forbidden} must be rejected`);
  }

  const afp = await writePreset(
    'afp.xpf',
    '<instrument name="audiofileprocessor"><audiofileprocessor src="drums/kick01.ogg"/></instrument>',
  );
  const resAfp = await inspectPresetFile(afp, { workspaceDir: dir, env: {} });
  assert.equal(resAfp.allowed, false);
  assert.match(resAfp.reason, /audiofileprocessor/i);
});

test('verifySoundfontProvenance and assertProjectProvenance enforce soundfont-lock.json SHA-256 and hybrid classification', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lmms-sf2-lock-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const lockedSf2Bytes = makeDummySf2('Locked CC0 Unit Bank');
  const lockedSha = createHash('sha256').update(lockedSf2Bytes).digest('hex');
  const lockedSf2Path = path.join(dir, 'unit-locked.sf2');
  await writeFile(lockedSf2Path, lockedSf2Bytes);

  const unlockedSf2Bytes = makeDummySf2('Unlocked Other Bank');
  const unlockedSf2Path = path.join(dir, 'unlocked.sf2');
  await writeFile(unlockedSf2Path, unlockedSf2Bytes);

  const customLockPath = path.join(dir, 'custom-lock.json');
  await writeFile(customLockPath, JSON.stringify({
    lockVersion: 1,
    licencePolicy: 'CC0-1.0-only',
    soundfonts: {
      'unit-locked': {
        id: 'unit-locked',
        pack: 'core',
        fileName: 'unit-locked.sf2',
        licence: 'CC0-1.0',
        repository: 'https://github.com/example/cc0-sfz.git',
        commit: '0123456789abcdef0123456789abcdef01234567',
        sf2Sha256: lockedSha,
      },
    },
  }, null, 2));

  // Unlocked SF2 fails against both real TRACKED_LOCK_PATH and custom lock.
  await assert.rejects(
    verifySoundfontProvenance(unlockedSf2Path, { workspaceDir: dir, soundfontsDir: dir, env: {} }),
    /not an approved CC0-1.0 entry/i,
  );
  await assert.rejects(
    verifySoundfontProvenance(unlockedSf2Path, { workspaceDir: dir, soundfontsDir: dir, env: {}, lockPath: customLockPath }),
    /not an approved CC0-1.0 entry/i,
  );

  // Locked SF2 passes.
  const okCheck = await verifySoundfontProvenance(lockedSf2Path, {
    workspaceDir: dir,
    soundfontsDir: dir,
    env: {},
    lockPath: customLockPath,
  });
  assert.equal(okCheck.verified, true);
  assert.equal(okCheck.source.licence, 'CC0-1.0');

  // Hybrid project (kicker + locked sf2player + Song length anchor) audits as hybrid-verified.
  const hybridXml = `<?xml version="1.0"?><lmms-project version="1.0" type="song"><head bpm="120"/><song><trackcontainer type="song">
    <track name="Kick" type="0" muted="0" solo="0"><instrumenttrack vol="80" basenote="57"><instrument name="kicker"><kicker/></instrument></instrumenttrack></track>
    <track name="Piano" type="0" muted="0" solo="0"><instrumenttrack vol="90" basenote="57"><instrument name="sf2player"><sf2player src="${lockedSf2Path.replaceAll('\\', '/')}" bank="0" patch="0"/></instrument></instrumenttrack></track>
    <track name="Song length" type="2" muted="0" solo="0"><sampletrack vol="0" pan="0"/><sampletco pos="0" len="384" src=""/></track>
  </trackcontainer></song></lmms-project>`;
  const hybridDoc = new DOMParser().parseFromString(hybridXml, 'application/xml');
  const report = await assertProjectProvenance(hybridDoc, {
    projectName: 'hybrid.mmp',
    workspaceDir: dir,
    soundfontsDir: dir,
    env: {},
    lockPath: customLockPath,
  });
  assert.equal(report.compliant, true);
  assert.equal(report.classification, 'hybrid-verified');
  assert.equal(report.hasUserAttestedTakes, false);

  // Flipping 1 byte in the SF2 on disk causes assertProjectProvenance to fail closed immediately!
  const tamperedSf2 = Buffer.from(lockedSf2Bytes);
  tamperedSf2[tamperedSf2.length - 4] ^= 0xff;
  await writeFile(lockedSf2Path, tamperedSf2);
  await assert.rejects(
    assertProjectProvenance(hybridDoc, {
      projectName: 'hybrid.mmp',
      workspaceDir: dir,
      soundfontsDir: dir,
      env: {},
      lockPath: customLockPath,
    }),
    /not an approved CC0-1.0 entry|modified/i,
  );
  const failedAudit = await auditProjectProvenance(hybridDoc, {
    projectName: 'hybrid.mmp',
    workspaceDir: dir,
    soundfontsDir: dir,
    env: {},
    lockPath: customLockPath,
  });
  assert.equal(failedAudit.compliant, false);

  // Updating soundfont-lock.json on disk reloads automatically via mtime/size check without process restart.
  const hotSf2Bytes = makeDummySf2('Hot Installed CC0 Bank');
  const hotSf2Path = path.join(dir, 'hot-added.sf2');
  await writeFile(hotSf2Path, hotSf2Bytes);
  await assert.rejects(
    verifySoundfontProvenance(hotSf2Path, { workspaceDir: dir, soundfontsDir: dir, env: {}, lockPath: customLockPath }),
    /rejected SoundFont/i,
  );
  const updatedLock = JSON.parse(await readFile(customLockPath, 'utf8'));
  updatedLock.soundfonts['hot-added'] = {
    id: 'hot-added',
    pack: 'vsco-complete',
    fileName: 'hot-added.sf2',
    licence: 'CC0-1.0',
    repository: 'https://github.com/sgossner/VSCO-2-CE.git',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    sf2Sha256: createHash('sha256').update(hotSf2Bytes).digest('hex'),
  };
  await writeFile(customLockPath, JSON.stringify(updatedLock, null, 2) + '\n');
  const hotVerified = await verifySoundfontProvenance(hotSf2Path, {
    workspaceDir: dir,
    soundfontsDir: dir,
    env: {},
    lockPath: customLockPath,
  });
  assert.equal(hotVerified.verified, true);
  assert.equal(hotVerified.source.pluginOrLibrary, 'hot-added');
});

test('Mix Desk blocks /_stock/ in strict mode and stamps user-attested-mic-take provenance on live mic takes', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-desk-'));
  const stockDir = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-stock-'));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stockDir, { recursive: true, force: true });
  });

  await mkdir(path.join(stockDir, 'drums'), { recursive: true });
  await writeFile(path.join(stockDir, 'drums', 'kick01.ogg'), Buffer.from('fake-ogg'));

  const server = startServer({
    port: 0,
    folders: { workspace, stock: stockDir, soundfonts: workspace, library: null },
    env: { LMMS_STRICT_COPYRIGHT: '1' },
  });
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // /_stock/ serving is 404 in strict mode even if folders.stock was passed.
  const stockRes = await fetch(`${baseUrl}/_stock/drums/kick01.ogg`);
  assert.equal(stockRes.status, 404);

  // Live mic take upload writes <name>.wav.provenance.json with user-attested-mic-take.
  const wav = makeSineWav(48000, 0.4, 330);
  const takeRes = await fetch(`${baseUrl}/api/mix-desk/take?name=vox-take&kind=take&tags=vocal`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', origin: baseUrl },
    body: wav,
  });
  assert.equal(takeRes.status, 201);
  const body = await takeRes.json();
  assert.equal(body.provenance, 'vox-take.wav.provenance.json');

  const check = await verifyAudioFileProvenance(path.join(workspace, 'vox-take.wav'), {
    workspaceDir: workspace,
    env: {},
  });
  assert.equal(check.verified, true);
  assert.equal(check.record.classification, 'user-attested-mic-take');
  assert.equal(check.record.sha256, createHash('sha256').update(wav).digest('hex'));

  // Mix Desk library listing excludes stock items in strict mode.
  const libJson = await (await fetch(`${baseUrl}/api/mix-desk/library`)).json();
  assert.equal(libJson.rows.some(r => r.source === 'stock' || r.url.startsWith('/_stock/')), false);
  assert.equal(libJson.rows.some(r => r.url === '/vox-take.wav'), true);
});

const lmmsExe = resolveLmmsExecutable();
const hasLmms = path.isAbsolute(lmmsExe) ? existsSync(lmmsExe) : false;
const presetsDir = resolveLmmsPresetsDir(process.env, lmmsExe);
const hasPresets = existsSync(presetsDir);
const defaultSfDir = resolveSoundfontsDir();
const hasInstalledCoreSf2 = existsSync(path.join(defaultSfDir, 'upright-piano-kw.sf2')) &&
  existsSync(path.join(defaultSfDir, 'virtuosity-drums.sf2'));

test('end-to-end MCP strict copyright provenance gate across projects, presets, SF2s, DSP tools, discovery, blueprints, and audit_copyright', {
  timeout: 240000,
}, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-mcp-'));
  const customSfDir = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-sf2-'));
  const fakeSamplesDir = await mkdtemp(path.join(os.tmpdir(), 'lmms-prov-samples-'));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(customSfDir, { recursive: true, force: true });
    await rm(fakeSamplesDir, { recursive: true, force: true });
  });

  // Plant a stock sample and an unlocked SF2 + tampered SF2 to ensure discovery and save/render reject all of them.
  await mkdir(path.join(fakeSamplesDir, 'drums'), { recursive: true });
  await writeFile(path.join(fakeSamplesDir, 'drums', 'kick01.ogg'), Buffer.from('OggS-fake-stock-sample'));
  await writeFile(path.join(customSfDir, 'unlocked-rogue.sf2'), makeDummySf2('Rogue SoundFont'));
  await writeFile(path.join(workspace, 'workspace-rogue.sf2'), makeDummySf2('Workspace Rogue'));

  if (hasInstalledCoreSf2) {
    const pianoBytes = await readFile(path.join(defaultSfDir, 'upright-piano-kw.sf2'));
    await writeFile(path.join(customSfDir, 'upright-piano-kw.sf2'), pianoBytes);
    const tamperedPiano = Buffer.from(pianoBytes);
    tamperedPiano[tamperedPiano.length - 8] ^= 0x55;
    await writeFile(path.join(customSfDir, 'tampered-piano.sf2'), tamperedPiano);

    const drumBytes = await readFile(path.join(defaultSfDir, 'virtuosity-drums.sf2'));
    await writeFile(path.join(customSfDir, 'virtuosity-drums.sf2'), drumBytes);
  }

  // Also plant a raw un-provenanced WAV in the workspace.
  const rawWavBytes = makeSineWav(48000, 4, 110);
  await writeFile(path.join(workspace, 'raw-unverified.wav'), rawWavBytes);

  const client = new Client({ name: 'provenance-regression-suite', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: {
      ...process.env,
      LMMS_WORKSPACE: workspace,
      LMMS_SOUNDFONTS: customSfDir,
      LMMS_SAMPLES: fakeSamplesDir,
      LMMS_LIVE_PIPE: 'should_be_disabled_in_strict_mode',
      LMMS_STRICT_COPYRIGHT: '1',
    },
  }));
  t.after(() => client.close().catch(() => {}));

  const callOk = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.equal(Boolean(res.isError), false, `${name} unexpectedly failed: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };
  const callFail = async (name, args = {}, pattern) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.equal(Boolean(res.isError), true, `${name} should have failed in strict mode`);
    if (pattern) {
      assert.match(res.content?.[0]?.text ?? '', pattern, `${name} error message mismatch`);
    }
    return res.content?.[0]?.text ?? '';
  };

  // 0. LMMS_LIVE_PIPE tools are disabled in strict mode even when LMMS_LIVE_PIPE is set!
  const listedTools = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(listedTools.some(n => n.startsWith('live_')), false, 'live_* tools must not register in strict mode');
  assert.equal(listedTools.includes('audit_copyright'), true, 'audit_copyright must be registered');
  const started = await callOk('get_started');
  assert.equal(started.setup.strictCopyright, true);
  assert.equal(started.setup.liveToolsEnabled, false);

  // 1. Rejecting stock factorySample, un-provenanced WAV, tampered WAV, and tag_sound own-recording spoofing.
  await callFail('create_project', {
    output: 'bad-stock.mmp',
    bpm: 120,
    tracks: [{
      name: 'Kick',
      voice: 'sample',
      factorySample: 'drums/kick01.ogg',
      volume: 80,
      patterns: [{ name: 'P', bar: 0, bars: 1, steps: { grid: 'X---X---X---X---' } }],
    }],
  }, /forbidden|strict copyright/i);
  assert.equal(existsSync(path.join(workspace, 'bad-stock.mmp')), false);

  await callFail('create_project', {
    output: 'bad-raw-wav.mmp',
    bpm: 120,
    tracks: [{
      name: 'RawLoop',
      voice: 'sample',
      sample: 'raw-unverified.wav',
      volume: 80,
      patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 69, length: 96, velocity: 100 }] }],
    }],
  }, /provenance/i);

  // tag_sound spoofing with licence: 'own-recording' is rejected, and tagging with 'CC0' still does NOT grant provenance!
  await callFail('tag_sound', {
    file: 'raw-unverified.wav',
    meta: { title: 'Spoofed Take', licence: 'own-recording' },
  }, /own-recording.*forbidden/i);

  await callOk('tag_sound', {
    file: 'raw-unverified.wav',
    meta: { title: 'Claimed CC0', licence: 'CC0' },
  });
  await callFail('create_project', {
    output: 'still-bad-after-tag.mmp',
    bpm: 120,
    tracks: [{
      name: 'RawLoop',
      voice: 'sample',
      sample: 'raw-unverified.wav',
      volume: 80,
      patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 69, length: 96, velocity: 100 }] }],
    }],
  }, /provenance/i);

  const rawAudit = await callOk('audit_copyright', { audio: 'raw-unverified.wav' });
  assert.equal(rawAudit.compliant, false);

  // Generate provenanced synth drums, verify they work, then tamper 1 byte and verify rejection!
  const drumHits = await callOk('synth_drums', {
    outputDirectory: 'synthhits',
    hits: [
      { role: 'kick', midi: 36, decayMs: 250, seed: 1 },
      { role: 'snare', midi: 38, decayMs: 250, seed: 2 },
    ],
  });
  const kickRel = drumHits.files[0].file;
  const snareRel = drumHits.files[1].file;
  const kickAudit = await callOk('audit_copyright', { audio: kickRel });
  assert.equal(kickAudit.compliant, true);
  assert.equal(kickAudit.classification, 'pure-synthesis');

  // Copy kick to tampered-kick.wav + its sidecar, then flip 1 byte in tampered-kick.wav.
  const kickFull = path.join(workspace, kickRel);
  const tamperedRel = 'tampered-kick.wav';
  const tamperedFull = path.join(workspace, tamperedRel);
  const kickBytes = await readFile(kickFull);
  await writeFile(tamperedFull, kickBytes);
  await writeProvenanceSidecar(tamperedFull, {
    workspaceDir: workspace,
    classification: 'pure-synthesis',
    generatorTool: 'synth_drums',
    sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'lmms-mcp-drum-synthesis', licence: 'MIT' }],
  });
  const mutatedKick = Buffer.from(kickBytes);
  mutatedKick[60] ^= 0x7f;
  await writeFile(tamperedFull, mutatedKick);

  await callFail('create_project', {
    output: 'tampered-proj.mmp',
    bpm: 120,
    tracks: [{
      name: 'Tampered',
      voice: 'sample',
      sample: tamperedRel,
      volume: 80,
      patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 69, length: 48, velocity: 100 }] }],
    }],
  }, /SHA-256 mismatch/i);

  // 2. Rejecting .xpf presets using audiofileprocessor or tripleoscillator wavetype="7"/userwavefile via MCP.
  if (hasPresets) {
    await callFail('create_project', {
      output: 'bad-afp-preset.mmp',
      bpm: 120,
      tracks: [{
        name: 'AFP',
        voice: 'preset',
        preset: 'AudioFileProcessor/Erazor.xpf',
        volume: 60,
        patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 60, length: 48, velocity: 90 }] }],
      }],
    }, /blocked|audiofileprocessor/i);

    await callFail('create_project', {
      output: 'bad-wave7-preset.mmp',
      bpm: 120,
      tracks: [{
        name: 'SqPing',
        voice: 'preset',
        preset: 'TripleOscillator/SquarePing.xpf',
        volume: 60,
        patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 60, length: 48, velocity: 90 }] }],
      }],
    }, /wavetype1="7"/i);

    await callFail('create_project', {
      output: 'bad-userwave-preset.mmp',
      bpm: 120,
      tracks: [{
        name: 'Bell',
        voice: 'preset',
        preset: 'TripleOscillator/Bell.xpf',
        volume: 60,
        patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 60, length: 48, velocity: 90 }] }],
      }],
    }, /userwavefile/i);

    await callFail('preview_sound', {
      factorySample: 'drums/kick01.ogg',
      output: 'blocked-preview.wav',
    }, /strict copyright/i);
  }

  // Also reject set_native_instrument with vestige.
  await callOk('create_project', {
    output: 'clean-synth.mmp',
    bpm: 120,
    tracks: [{
      name: 'Lead',
      voice: 'pluck',
      role: 'lead',
      volume: 70,
      patterns: [{ name: 'Hook', bar: 0, bars: 2, melody: { line: 'D5:4 F5:4 A5:8' } }],
    }],
  });
  await callFail('set_native_instrument', {
    project: 'clean-synth.mmp',
    output: 'bad-vestige.mmp',
    trackName: 'Lead',
    instrument: 'vestige',
  }, /strict copyright/i);

  // 3. Rejecting unlocked/modified .sf2 in sf2player and render_soundfont!
  await callFail('create_project', {
    output: 'bad-sf2.mmp',
    bpm: 120,
    tracks: [{
      name: 'Rogue',
      voice: 'sf2',
      sf2: 'unlocked-rogue.sf2',
      bank: 0,
      patch: 0,
      volume: 80,
      patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 60, length: 48, velocity: 100 }] }],
    }],
  }, /soundfont-lock\.json|not an approved CC0-1\.0/i);

  const exportedMidi = await callOk('export_midi', { project: 'clean-synth.mmp', output: 'clean-synth.mid' });
  assert.equal(existsSync(provenancePathFor(path.join(workspace, exportedMidi.file))), true);

  await callFail('render_soundfont', {
    midi: 'clean-synth.mid',
    soundfont: 'unlocked-rogue.sf2',
    output: 'rogue-sf2.wav',
  }, /soundfont-lock\.json|not an approved CC0-1\.0/i);

  if (hasInstalledCoreSf2) {
    await callFail('create_project', {
      output: 'tampered-sf2.mmp',
      bpm: 120,
      tracks: [{
        name: 'TamperedPiano',
        voice: 'sf2',
        sf2: 'tampered-piano.sf2',
        bank: 0,
        patch: 0,
        volume: 80,
        patterns: [{ name: 'P', bar: 0, bars: 1, notes: [{ tick: 0, midi: 60, length: 48, velocity: 100 }] }],
      }],
    }, /soundfont-lock\.json|not an approved CC0-1\.0/i);

    await callFail('render_soundfont', {
      midi: 'clean-synth.mid',
      soundfont: 'tampered-piano.sf2',
      output: 'tampered-sf2.wav',
    }, /soundfont-lock\.json|not an approved CC0-1\.0/i);
  }

  // 4. Rejecting direct WAV DSP tools on un-provenanced/tampered WAVs while succeeding and propagating .provenance.json on verified WAVs!
  await callFail('master_audio', { audio: 'raw-unverified.wav', output: 'm-bad.wav', targetLufs: -16 }, /provenance/i);
  await callFail('dj_effects', {
    audio: 'raw-unverified.wav',
    output: 'dj-bad.wav',
    bpm: 120,
    effects: [{ type: 'filter_sweep', startBar: 0, bars: 1 }],
  }, /provenance/i);
  await callFail('fatten', { input: 'raw-unverified.wav', output: 'fat-bad.wav' }, /provenance/i);
  await callFail('chop_break', {
    audio: 'raw-unverified.wav',
    sourceBpm: 120,
    targetBpm: 120,
    outputDirectory: 'chopbad',
  }, /provenance/i);
  await callFail('prepare_loop', {
    audio: 'raw-unverified.wav',
    outputDirectory: 'loopbad',
    startSeconds: 0.2,
    endSeconds: 2.2,
  }, /provenance/i);
  await callFail('export_one_shots', {
    outputDirectory: 'shotsbad',
    sounds: [{ input: 'raw-unverified.wav', name: 'badshot' }],
  }, /provenance/i);

  // Now run those exact DSP tools on provenanced audio (from synth_drums / render_vocal_syllable / render_mix) and verify propagation!
  await callOk('render_vocal_syllable', { output: 'vox-synth.wav', vowel: 'a', duration: 2 });
  await callOk('fatten', { input: 'vox-synth.wav', output: 'vox-fat.wav' });
  await callOk('dj_effects', {
    audio: 'vox-fat.wav',
    output: 'vox-dj.wav',
    bpm: 120,
    effects: [{ type: 'filter_sweep', startBar: 0, bars: 0.5 }],
  });
  await callOk('master_audio', {
    audio: 'vox-dj.wav',
    output: 'vox-mastered.wav',
    trimTail: false,
    fadeOutSeconds: 0.05,
  });
  await callOk('chop_break', {
    audio: 'vox-mastered.wav',
    sourceBpm: 120,
    targetBpm: 120,
    outputDirectory: 'voxchop',
  });
  await callOk('prepare_loop', {
    audio: 'vox-mastered.wav',
    outputDirectory: 'voxloop',
    startSeconds: 0.1,
    endSeconds: 1.5,
  });
  await callOk('layer_drum', {
    output: 'drum-layered.wav',
    layers: [{ file: kickRel }, { file: snareRel, offsetMs: 40 }],
  });
  await callOk('export_one_shots', {
    outputDirectory: 'oneshots',
    sounds: [{ input: 'drum-layered.wav', name: 'combo' }],
  });
  await callOk('write_loop_points', {
    audio: 'vox-mastered.wav',
    inPlace: true,
    startFrame: 0,
    endFrame: 24000,
  });

  for (const rel of [
    'vox-synth.wav',
    'vox-fat.wav',
    'vox-dj.wav',
    'vox-mastered.wav',
    'voxchop/sequence.wav',
    'voxchop/slice-001.wav',
    'voxloop/vox-mastered-loop.wav',
    'drum-layered.wav',
    'oneshots/combo.wav',
  ]) {
    const check = await verifyAudioFileProvenance(path.join(workspace, rel), { workspaceDir: workspace, env: {} });
    assert.equal(check.verified, true, `Expected valid propagated provenance on ${rel}`);
    assert.equal(check.record.classification, 'pure-synthesis');
  }

  // Blueprint strict gate: requires caller-supplied motif and progression, and creates a compliant project when provided.
  await callFail('create_from_blueprint', {
    blueprint: 'overworld',
    output: 'bp-nomotif.mmp',
    progression: 'I V vi IV',
  }, /motif/i);
  await callFail('create_from_blueprint', {
    blueprint: 'overworld',
    output: 'bp-noprog.mmp',
    motif: 'D5:2 F#5:2 A5:4 r:8',
  }, /progression/i);

  const bpCreated = await callOk('create_from_blueprint', {
    blueprint: 'overworld',
    output: 'bp-strict.mmp',
    motif: 'D5:2 F#5:2 A5:4 B5:4 A5:4 r:16',
    progression: 'D A Bm G',
    lengthBars: 14,
  });
  assert.equal(bpCreated.project, 'bp-strict.mmp');
  const bpAudit = await callOk('audit_copyright', { project: 'bp-strict.mmp' });
  assert.equal(bpAudit.compliant, true);
  assert.equal(bpAudit.classification, 'pure-synthesis');

  // 5. Discovery filtering: search_sounds, list_presets, list_samples, list_soundfonts, list_sf2_presets, build_library_page return ZERO strict-blocked entries!
  const samplesRes = await callOk('list_samples', {});
  assert.equal(samplesRes.total, 0);
  assert.deepEqual(samplesRes.samples, []);

  const sfRes = await callOk('list_soundfonts', {});
  assert.equal(
    sfRes.soundfonts.some(sf => sf.path.includes('rogue') || sf.path.includes('tampered')),
    false,
    'list_soundfonts must exclude unlocked and tampered SoundFonts',
  );
  const sfPresetsRes = await callOk('list_sf2_presets', {});
  assert.equal(
    sfPresetsRes.soundfonts.some(sf => sf.sf2.includes('rogue') || sf.sf2.includes('tampered')),
    false,
    'list_sf2_presets must exclude unlocked and tampered SoundFonts',
  );
  if (hasInstalledCoreSf2) {
    assert.equal(sfRes.soundfonts.some(sf => sf.path === 'upright-piano-kw.sf2'), true);
    assert.equal(sfPresetsRes.soundfonts.some(sf => sf.sf2 === 'upright-piano-kw.sf2' && sf.verifiedCc0 === true), true);
  }

  if (hasPresets) {
    const listedPresets = await callOk('list_presets', {});
    assert.ok(listedPresets.presets.length > 0, 'Expected clean pure-synth presets to remain available');
    for (const preset of listedPresets.presets) {
      const inspected = await inspectPresetFile(path.join(presetsDir, preset), {
        presetsDir,
        workspaceDir: workspace,
        soundfontsDir: customSfDir,
        env: {},
      });
      assert.equal(inspected.allowed, true, `list_presets leaked strict-blocked preset: ${preset}`);
    }

    const searched = await callOk('search_sounds', { query: '', engine: 'lmms', limit: 100 });
    assert.ok(searched.sounds.length > 0);
    for (const item of searched.sounds) {
      const inspected = await inspectPresetFile(path.join(presetsDir, item.preset), {
        presetsDir,
        workspaceDir: workspace,
        soundfontsDir: customSfDir,
        env: {},
      });
      assert.equal(inspected.allowed, true, `search_sounds leaked strict-blocked preset: ${item.preset}`);
    }
  }

  const libPage = await callOk('build_library_page', { output: 'strict-lib.html', overwrite: true });
  assert.equal(libPage.counts.stock ?? 0, 0);
  const libHtml = await readFile(path.join(workspace, 'strict-lib.html'), 'utf8');
  assert.equal(libHtml.includes('raw-unverified.wav'), false, 'build_library_page must exclude un-provenanced workspace WAVs');
  assert.equal(libHtml.includes('kick01.ogg'), false, 'build_library_page must exclude stock samples');
  assert.equal(libHtml.includes('vox-synth.wav'), true, 'build_library_page includes provenanced workspace WAVs');

  // 6. Hybrid native-synth + locked-CC0-SF2 project: verify <project>.provenance.json, render_mix, render_stems, export_game_audio, and audit_copyright!
  if (hasInstalledCoreSf2) {
    const trackedLock = JSON.parse(await readFile(TRACKED_LOCK_PATH, 'utf8'));
    await callOk('create_project', {
      output: 'hybrid-ensemble.mmp',
      bpm: 120,
      lengthBars: 2,
      tracks: [
        {
          name: 'Piano',
          voice: 'sf2',
          sf2: 'upright-piano-kw.sf2',
          bank: 0,
          patch: 0,
          role: 'harmony',
          volume: 95,
          patterns: [{ name: 'Chords', bar: 0, bars: 2, chords: { progression: 'Dm C' } }],
        },
        {
          name: 'SynthBass',
          voice: 'bass',
          role: 'bass',
          volume: 85,
          patterns: [{ name: 'Bass', bar: 0, bars: 2, chords: { progression: 'Dm C', style: 'bass' } }],
        },
        {
          name: 'SynthKick',
          voice: 'kick',
          role: 'drums',
          volume: 85,
          patterns: [{ name: 'Beat', bar: 0, bars: 2, steps: { grid: 'X---X---X---X---' } }],
        },
      ],
    });

    const projPath = path.join(workspace, 'hybrid-ensemble.mmp');
    const projProv = JSON.parse(await readFile(provenancePathFor(projPath), 'utf8'));
    assert.equal(projProv.schema, PROVENANCE_SCHEMA);
    assert.equal(projProv.version, PROVENANCE_VERSION);
    assert.equal(projProv.sha256, await sha256File(projPath));
    assert.equal(projProv.classification, 'hybrid-verified');
    assert.equal(projProv.strictCompliant, true);
    assert.ok(projProv.sources.some(s => s.kind === 'verified-cc0-sf2' && s.pluginOrLibrary === 'upright-piano-kw' && s.sha256 === trackedLock.soundfonts['upright-piano-kw'].sf2Sha256));
    assert.ok(projProv.sources.some(s => s.kind === 'pure-synthesis' && s.pluginOrLibrary === 'tripleoscillator'));
    assert.ok(projProv.sources.some(s => s.kind === 'pure-synthesis' && s.pluginOrLibrary === 'kicker'));

    const auditProj = await callOk('audit_copyright', { project: 'hybrid-ensemble.mmp' });
    assert.equal(auditProj.compliant, true);
    assert.equal(auditProj.strictMode, true);
    assert.equal(auditProj.classification, 'hybrid-verified');
    assert.equal(auditProj.hasUserAttestedTakes, false);
    assert.equal(auditProj.legalScopeNote, LEGAL_SCOPE_NOTE);

    if (hasLmms) {
      const rendered = await callOk('render_mix', {
        project: 'hybrid-ensemble.mmp',
        output: 'hybrid-mix.wav',
        tail: 'cut',
      });
      const mixCheck = await verifyAudioFileProvenance(path.join(workspace, rendered.audio), {
        workspaceDir: workspace,
        env: {},
      });
      assert.equal(mixCheck.verified, true);
      assert.equal(mixCheck.record.classification, 'hybrid-verified');

      const auditMix = await callOk('audit_copyright', { audio: 'hybrid-mix.wav' });
      assert.equal(auditMix.compliant, true);
      assert.equal(auditMix.classification, 'hybrid-verified');

      const stemsRes = await callOk('render_stems', {
        project: 'hybrid-ensemble.mmp',
        outputDirectory: 'hybridstems',
        tail: 'cut',
      });
      assert.equal(stemsRes.stems.length, 3);
      const pianoStem = stemsRes.stems.find(s => s.track === 'Piano');
      const bassStem = stemsRes.stems.find(s => s.track === 'SynthBass');
      const pianoStemProv = await verifyAudioFileProvenance(path.join(workspace, 'hybridstems', pianoStem.file), { workspaceDir: workspace, env: {} });
      const bassStemProv = await verifyAudioFileProvenance(path.join(workspace, 'hybridstems', bassStem.file), { workspaceDir: workspace, env: {} });
      assert.equal(pianoStemProv.record.classification, 'verified-cc0-sf2');
      assert.equal(bassStemProv.record.classification, 'pure-synthesis');

      const gameRes = await callOk('export_game_audio', {
        project: 'hybrid-ensemble.mmp',
        outputDirectory: 'hybridgame',
        name: 'theme',
      });
      const gameLoopCheck = await verifyAudioFileProvenance(
        path.join(workspace, 'hybridgame', gameRes.loop.file),
        { workspaceDir: workspace, env: {} },
      );
      assert.equal(gameLoopCheck.verified, true);
      assert.equal(gameLoopCheck.record.classification, 'hybrid-verified');
    }
  }

  // Also check import_midi writes a compliant project + .provenance.json.
  const midiObj = new midiPackage.Midi();
  midiObj.header.setTempo(120);
  const mTrack = midiObj.addTrack();
  mTrack.name = 'Theme';
  mTrack.addNote({ midi: 60, ticks: 0, durationTicks: 480, velocity: 0.8 });
  mTrack.addNote({ midi: 64, ticks: 480, durationTicks: 480, velocity: 0.8 });
  await writeFile(path.join(workspace, 'score.mid'), Buffer.from(midiObj.toArray()));
  const importedProj = await callOk('import_midi', { midi: 'score.mid', output: 'imported.mmp', voice: 'pluck' });
  const importedAudit = await callOk('audit_copyright', { project: importedProj.project });
  assert.equal(importedAudit.compliant, true);
  assert.equal(importedAudit.classification, 'pure-synthesis');
});
