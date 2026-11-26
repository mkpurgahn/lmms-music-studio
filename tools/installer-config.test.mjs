import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  PACK_TARGET_IDS,
  mergeMcpConfig,
  resolveInstallerPaths,
  upsertMcpConfigFile,
  verifyInstalledPacks,
} from './installer-config.mjs';
import { PACK_NAMES, targetsForPack } from './soundfont-pack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(repoRoot, '.test-scratch');
const EMOJI_OR_SYMBOL_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const LABEL_HYPERLINK_REGEX = /!?\[[^\]]+\]\([^)]+\)/;

async function makeScratch(t, prefix) {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('upsertMcpConfigFile non-destructively merges lmms-music-studio while preserving other-server and top-level keys', async t => {
  const dir = await makeScratch(t, 'installer-mcp-merge-');
  const mcpPath = path.join(dir, '.mcp.json');

  const initialConfig = {
    $schema: 'https://example.com/mcp-schema.json',
    inputs: [{ id: 'api-token', type: 'promptString', password: true }],
    mcpServers: {
      'other-server': {
        command: 'npx',
        args: ['-y', '@example/other-mcp-server', '--port', '9100'],
        env: {
          OTHER_FLAG: 'enabled',
          NESTED_JSON: '{"keep":true}',
        },
        disabled: false,
      },
      'lmms-music-studio': {
        command: 'node',
        args: ['C:\\old-checkout\\server.mjs'],
        env: {
          LMMS_WORKSPACE: 'C:\\old\\workspace',
          LMMS_EXECUTABLE: 'D:\\CustomLMMS\\lmms.exe',
        },
      },
    },
  };
  await writeFile(mcpPath, JSON.stringify(initialConfig, null, 2) + '\n', 'utf8');

  const first = await upsertMcpConfigFile(mcpPath, {
    repoRoot: 'F:\\projects\\lmms-music-studio',
    workspace: 'C:\\Users\\studio\\Music\\LMMS Music Studio',
    soundfontsDir: 'C:\\Users\\studio\\AppData\\Local\\lmms-music-studio\\soundfonts',
    strictCopyright: '1',
    platform: 'win32',
  });

  assert.equal(first.created, false);
  assert.equal(first.changed, true);

  const onDisk = JSON.parse(await readFile(mcpPath, 'utf8'));
  assert.equal(onDisk.$schema, initialConfig.$schema);
  assert.deepEqual(onDisk.inputs, initialConfig.inputs);
  assert.deepEqual(onDisk.mcpServers['other-server'], initialConfig.mcpServers['other-server']);
  assert.deepEqual(onDisk.mcpServers['lmms-music-studio'], {
    command: 'node',
    args: ['F:\\projects\\lmms-music-studio\\server.mjs'],
    env: {
      LMMS_WORKSPACE: 'C:\\Users\\studio\\Music\\LMMS Music Studio',
      LMMS_SOUNDFONTS: 'C:\\Users\\studio\\AppData\\Local\\lmms-music-studio\\soundfonts',
      LMMS_STRICT_COPYRIGHT: '1',
      LMMS_EXECUTABLE: 'D:\\CustomLMMS\\lmms.exe',
    },
  });

  // Repeat run with identical parameters is a fast no-op that preserves file mtime.
  const mtimeBefore = (await stat(mcpPath)).mtimeMs;
  const second = await upsertMcpConfigFile(mcpPath, {
    repoRoot: 'F:\\projects\\lmms-music-studio',
    workspace: 'C:\\Users\\studio\\Music\\LMMS Music Studio',
    soundfontsDir: 'C:\\Users\\studio\\AppData\\Local\\lmms-music-studio\\soundfonts',
    strictCopyright: '1',
    platform: 'win32',
  });
  const mtimeAfter = (await stat(mcpPath)).mtimeMs;
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal(mtimeAfter, mtimeBefore);
});

test('upsertMcpConfigFile creates .mcp.json when missing and refuses to clobber malformed JSON', async t => {
  const dir = await makeScratch(t, 'installer-mcp-create-');
  const mcpPath = path.join(dir, '.mcp.json');

  const created = await upsertMcpConfigFile(mcpPath, {
    repoRoot: 'F:\\projects\\lmms-music-studio',
    workspace: 'F:\\Music\\Studio',
    soundfontsDir: 'F:\\Music\\SoundFonts',
    platform: 'win32',
  });
  assert.equal(created.created, true);
  assert.equal(created.changed, true);
  assert.deepEqual(JSON.parse(await readFile(mcpPath, 'utf8')), {
    mcpServers: {
      'lmms-music-studio': {
        command: 'node',
        args: ['F:\\projects\\lmms-music-studio\\server.mjs'],
        env: {
          LMMS_WORKSPACE: 'F:\\Music\\Studio',
          LMMS_SOUNDFONTS: 'F:\\Music\\SoundFonts',
          LMMS_STRICT_COPYRIGHT: '1',
        },
      },
    },
  });

  // Malformed user JSON must never be overwritten.
  const brokenPath = path.join(dir, 'broken.mcp.json');
  const brokenContent = '{ "mcpServers": { "other-server": [unclosed }';
  await writeFile(brokenPath, brokenContent, 'utf8');
  await assert.rejects(
    upsertMcpConfigFile(brokenPath, {
      repoRoot: 'F:\\projects\\lmms-music-studio',
      workspace: 'F:\\Music\\Studio',
      soundfontsDir: 'F:\\Music\\SoundFonts',
      platform: 'win32',
    }),
    /not valid JSON/,
  );
  assert.equal(await readFile(brokenPath, 'utf8'), brokenContent);

  assert.throws(
    () => mergeMcpConfig(['not-an-object'], {
      repoRoot: 'F:\\projects\\lmms-music-studio',
      workspace: 'F:\\Music\\Studio',
      soundfontsDir: 'F:\\Music\\SoundFonts',
    }),
    /JSON object/,
  );
});

test('PACK_TARGET_IDS matches soundfont-pack targets and verifyInstalledPacks checks SHA-256 integrity', async t => {
  for (const packName of PACK_NAMES) {
    const expectedIds = targetsForPack(packName).map(target => target.id);
    assert.deepEqual(PACK_TARGET_IDS[packName], expectedIds, `Pack target mismatch for ${packName}`);
  }

  const dir = await makeScratch(t, 'installer-pack-verify-');
  const sfDir = path.join(dir, 'soundfonts');
  await mkdir(sfDir, { recursive: true });

  // Empty directory reports unverified.
  const emptyCheck = await verifyInstalledPacks({ packs: ['upright-bass'], soundfontsDir: sfDir });
  assert.equal(emptyCheck.lockExists, false);
  assert.equal(emptyCheck.packsVerified, false);
  assert.deepEqual(emptyCheck.unverifiedTargets, ['upright-bass']);

  // Valid lock + matching .sf2 SHA-256 verifies cleanly.
  const payload = Buffer.from('deterministic-sf2-fixture-bytes');
  const sha = createHash('sha256').update(payload).digest('hex');
  await writeFile(path.join(sfDir, 'upright-bass.sf2'), payload);
  const lockData = {
    lockVersion: 1,
    licencePolicy: 'CC0-1.0-only',
    soundfonts: {
      'upright-bass': {
        id: 'upright-bass',
        pack: 'upright-bass',
        fileName: 'upright-bass.sf2',
        licence: 'CC0-1.0',
        sf2Sha256: sha,
        sf2Bytes: payload.length,
      },
    },
  };
  const lockPath = path.join(sfDir, 'soundfont-lock.json');
  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf8');

  const okCheck = await verifyInstalledPacks({
    packs: ['upright-bass'],
    soundfontsDir: sfDir,
    trackedLockPath: lockPath,
  });
  assert.equal(okCheck.lockExists, true);
  assert.equal(okCheck.packsVerified, true);
  assert.deepEqual(okCheck.verifiedTargets, ['upright-bass']);

  // Corrupting 1 byte invalidates verification so the installer re-runs compilation and space checks.
  const tampered = Buffer.from(payload);
  tampered[0] ^= 0xff;
  await writeFile(path.join(sfDir, 'upright-bass.sf2'), tampered);
  const badCheck = await verifyInstalledPacks({
    packs: ['upright-bass'],
    soundfontsDir: sfDir,
    trackedLockPath: lockPath,
  });
  assert.equal(badCheck.packsVerified, false);
  assert.deepEqual(badCheck.unverifiedTargets, ['upright-bass']);
});

test('resolveInstallerPaths aligns with workspace-config defaults and overrides', () => {
  const defaults = resolveInstallerPaths({
    env: { LOCALAPPDATA: 'C:\\Users\\producer\\AppData\\Local' },
    homedir: 'C:\\Users\\producer',
    platform: 'win32',
  });
  assert.equal(defaults.workspace, path.resolve('C:\\Users\\producer', 'Music', 'LMMS Music Studio'));
  assert.equal(defaults.soundfontsDir, path.resolve('C:\\Users\\producer\\AppData\\Local', 'lmms-music-studio', 'soundfonts'));
  assert.equal(defaults.lmmsExecutable, 'C:\\Program Files\\LMMS\\lmms.exe');

  const overridden = resolveInstallerPaths({
    workspace: 'D:\\StudioWork',
    soundfontsDir: 'D:\\SF2',
    env: { LMMS_EXECUTABLE: 'D:\\LMMS\\lmms.exe' },
    platform: 'win32',
  });
  assert.equal(overridden.workspace, path.resolve('D:\\StudioWork'));
  assert.equal(overridden.soundfontsDir, path.resolve('D:\\SF2'));
  assert.equal(overridden.lmmsExecutable, 'D:\\LMMS\\lmms.exe');
});

test('Phase 5 docs, skills, installer, and MCP onboarding stay emoji-free, plain-URL, and V3-accurate', async t => {
  const mustBeEmojiFree = [
    'README.md',
    'AGENTS.md',
    'skills/lmms-music-studio/SKILL.md',
    '.github/skills/lmms-music-studio/SKILL.md',
    'install-windows.ps1',
    'setup-windows.ps1',
    'setup-libraries-windows.ps1',
    'server.mjs',
    '.mcp.example.json',
  ];
  for (const rel of mustBeEmojiFree) {
    const full = path.join(repoRoot, rel);
    assert.ok(existsSync(full), `Expected ${rel} to exist`);
    const content = await readFile(full, 'utf8');
    assert.doesNotMatch(content, EMOJI_OR_SYMBOL_REGEX, `${rel} must contain zero emojis or Unicode symbols`);
  }

  // Verify plain URLs/paths (no [label](url) hyperlinks) in README.md, AGENTS.md, and SKILL.md.
  for (const rel of ['README.md', 'AGENTS.md', 'skills/lmms-music-studio/SKILL.md', '.github/skills/lmms-music-studio/SKILL.md']) {
    const content = await readFile(path.join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(content, LABEL_HYPERLINK_REGEX, `${rel} must use plain copyable paths/URLs instead of [label](url) links`);
  }

  // Project and user-distributable SKILL.md copies must match byte-for-byte, and legacy lmms-game-audio must be gone.
  const mainSkill = await readFile(path.join(repoRoot, 'skills/lmms-music-studio/SKILL.md'), 'utf8');
  const ghSkill = await readFile(path.join(repoRoot, '.github/skills/lmms-music-studio/SKILL.md'), 'utf8');
  assert.equal(mainSkill, ghSkill);
  assert.equal(existsSync(path.join(repoRoot, 'skills/lmms-game-audio')), false);

  // Verify .gitignore ignores .mcp.json so local machine paths are never staged.
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.mcp\.json$/m);

  // Verify MCP initialization instructions and get_started reflect V3 and omit deleted pre-V3 tools.
  const ws = await makeScratch(t, 'installer-onboarding-mcp-');
  const client = new Client({ name: 'onboarding-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'server.mjs')],
    cwd: repoRoot,
    env: { ...process.env, LMMS_WORKSPACE: ws, LMMS_NO_GUI_LAUNCH: '1', LMMS_LOG_LEVEL: 'error' },
    stderr: 'ignore',
  }));
  t.after(() => client.close().catch(() => {}));

  const initInstructions = client.getInstructions() ?? '';
  for (const stale of ['list_composer_profiles', 'create_composer_sketch', 'render_vst3_stems', 'snare01.ogg', 'kick01.ogg']) {
    assert.ok(!initInstructions.includes(stale), `MCP instructions should not mention stale V2 item "${stale}"`);
  }
  for (const v3Term of ['list_sf2_presets', 'voice: "sf2"', 'acoustic-cc0', 'tail: "ring"', 'tail: "wrap"', 'build_timeline_page', 'build_audition_page', 'read_feedback', 'open_in_lmms', 'sync_from_lmms', 'audit_copyright']) {
    assert.ok(initInstructions.includes(v3Term), `MCP instructions should highlight "${v3Term}"`);
  }

  const res = await client.callTool({ name: 'get_started', arguments: {} });
  assert.equal(Boolean(res.isError), false);
  const started = JSON.parse(res.content[0].text);
  assert.ok(started.v3StudioProtocol, 'get_started should include v3StudioProtocol summary');
  const listedTools = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const toolName of Object.values(started.workflows).flat()) {
    assert.ok(listedTools.has(toolName), `get_started workflow tool "${toolName}" must exist`);
  }
});
