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
  installUserSkills,
  mergeMcpConfig,
  mergeVscodeMcpConfig,
  resolveGlobalMcpConfigPath,
  resolveInstallerPaths,
  resolveUserSkillRoots,
  upsertMcpConfigFile,
  upsertVscodeMcpConfigFile,
  verifyInstalledPacks,
} from './installer-config.mjs';
import { runCommandSafe } from './fs-atomic.mjs';
import { PACK_NAMES, targetsForPack } from './soundfont-pack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(repoRoot, '.test-scratch');
const EMOJI_OR_SYMBOL_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const LABEL_HYPERLINK_REGEX = /!?\[[^\]]+\]\([^)]+\)/;

function stripMarkdownCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\r\n]+`/g, '');
}

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

  // Malformed user JSON must never be overwritten or echoed into error text.
  const brokenPath = path.join(dir, 'broken.mcp.json');
  const sentinelSecret = 'UNIT_TEST_SECRET_SENTINEL_NEVER_ECHO_48291';
  const brokenContent = `{ "mcpServers": { "other-server": { "token": "${sentinelSecret}" }, "broken": [unclosed }`;
  await writeFile(brokenPath, brokenContent, 'utf8');
  await assert.rejects(
    async () => {
      try {
        await upsertMcpConfigFile(brokenPath, {
          repoRoot: 'F:\\projects\\lmms-music-studio',
          workspace: 'F:\\Music\\Studio',
          soundfontsDir: 'F:\\Music\\SoundFonts',
          platform: 'win32',
        });
      } catch (err) {
        assert.ok(!String(err.message).includes(sentinelSecret), 'Error message must never echo file contents');
        throw err;
      }
    },
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

test('merge-vscode-mcp non-destructively creates and merges .vscode/mcp.json preserving servers and inputs', async t => {
  const dir = await makeScratch(t, 'installer-vscode-mcp-');
  const vscodeMcpPath = path.join(dir, '.vscode', 'mcp.json');

  // Creates .vscode/ directory and mcp.json when missing.
  const createdRun = await runCommandSafe(process.execPath, [
    path.join(repoRoot, 'tools', 'installer-config.mjs'),
    '--mode', 'merge-vscode-mcp',
    '--mcp-path', vscodeMcpPath,
    '--repo-root', 'C:\\dev\\lmms-music-studio',
    '--workspace', 'C:\\Users\\artist\\Music\\LMMS Music Studio',
    '--soundfonts', 'C:\\Users\\artist\\AppData\\Local\\lmms-music-studio\\soundfonts',
  ]);
  const createdJson = JSON.parse(createdRun.stdout.trim());
  assert.deepEqual(Object.keys(createdJson).sort(), ['changed', 'created', 'path']);
  assert.equal(createdJson.created, true);
  assert.equal(createdJson.changed, true);
  assert.equal(createdJson.path, path.resolve(vscodeMcpPath));

  const expectedServer = {
    type: 'stdio',
    command: 'node',
    args: ['C:\\dev\\lmms-music-studio\\server.mjs'],
    env: {
      LMMS_WORKSPACE: 'C:\\Users\\artist\\Music\\LMMS Music Studio',
      LMMS_SOUNDFONTS: 'C:\\Users\\artist\\AppData\\Local\\lmms-music-studio\\soundfonts',
      LMMS_STRICT_COPYRIGHT: '1',
    },
  };
  assert.deepEqual(JSON.parse(await readFile(vscodeMcpPath, 'utf8')), {
    servers: {
      'lmms-music-studio': expectedServer,
    },
  });

  // Seed existing VS Code inputs + sibling servers + custom LMMS_EXECUTABLE and verify non-destructive merge.
  const existingVscodeConfig = {
    inputs: [
      { id: 'custom-api-key', type: 'promptString', description: 'API Key', password: true },
    ],
    servers: {
      'github-local': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/vscode-mcp'],
      },
      'lmms-music-studio': {
        command: 'node',
        args: ['D:\\stale\\server.mjs'],
        env: {
          LMMS_WORKSPACE: 'D:\\stale\\ws',
          LMMS_EXECUTABLE: 'D:\\AudioApps\\LMMS\\lmms.exe',
        },
      },
    },
  };
  await writeFile(vscodeMcpPath, JSON.stringify(existingVscodeConfig, null, 2) + '\n', 'utf8');

  const merged = await upsertVscodeMcpConfigFile(vscodeMcpPath, {
    repoRoot: 'C:\\dev\\lmms-music-studio',
    workspace: 'C:\\Users\\artist\\Music\\LMMS Music Studio',
    soundfontsDir: 'C:\\Users\\artist\\AppData\\Local\\lmms-music-studio\\soundfonts',
    strictCopyright: '1',
    platform: 'win32',
  });
  assert.deepEqual(merged, {
    created: false,
    changed: true,
    path: path.resolve(vscodeMcpPath),
  });

  const vscodeOnDisk = JSON.parse(await readFile(vscodeMcpPath, 'utf8'));
  assert.deepEqual(vscodeOnDisk.inputs, existingVscodeConfig.inputs);
  assert.deepEqual(vscodeOnDisk.servers['github-local'], existingVscodeConfig.servers['github-local']);
  assert.deepEqual(vscodeOnDisk.servers['lmms-music-studio'], {
    type: 'stdio',
    command: 'node',
    args: ['C:\\dev\\lmms-music-studio\\server.mjs'],
    env: {
      LMMS_WORKSPACE: 'C:\\Users\\artist\\Music\\LMMS Music Studio',
      LMMS_SOUNDFONTS: 'C:\\Users\\artist\\AppData\\Local\\lmms-music-studio\\soundfonts',
      LMMS_STRICT_COPYRIGHT: '1',
      LMMS_EXECUTABLE: 'D:\\AudioApps\\LMMS\\lmms.exe',
    },
  });

  const mtimeBefore = (await stat(vscodeMcpPath)).mtimeMs;
  const noop = await upsertVscodeMcpConfigFile(vscodeMcpPath, {
    repoRoot: 'C:\\dev\\lmms-music-studio',
    workspace: 'C:\\Users\\artist\\Music\\LMMS Music Studio',
    soundfontsDir: 'C:\\Users\\artist\\AppData\\Local\\lmms-music-studio\\soundfonts',
    strictCopyright: '1',
    platform: 'win32',
  });
  assert.equal(noop.created, false);
  assert.equal(noop.changed, false);
  assert.equal((await stat(vscodeMcpPath)).mtimeMs, mtimeBefore);

  assert.throws(
    () => mergeVscodeMcpConfig({ servers: ['bad'] }, {
      repoRoot: 'C:\\dev\\lmms-music-studio',
      workspace: 'C:\\Music',
      soundfontsDir: 'C:\\SF2',
    }),
    /JSON object/,
  );
});

test('hermetic global MCP merge and dual user skill installation (.copilot/skills + .agents/skills) preserve secrets and clean legacy dirs', async t => {
  const dir = await makeScratch(t, 'installer-global-hermetic-');
  const fakeGlobalMcpPath = path.join(dir, 'home', '.copilot', 'mcp-config.json');
  const fakeCopilotSkillsDir = path.join(dir, 'home', '.copilot', 'skills');
  const fakeAgentsSkillsDir = path.join(dir, 'home', '.agents', 'skills');

  assert.equal(
    resolveGlobalMcpConfigPath({ env: { LMMS_INSTALLER_GLOBAL_MCP_PATH: fakeGlobalMcpPath } }),
    path.resolve(fakeGlobalMcpPath),
  );
  assert.deepEqual(
    resolveUserSkillRoots({
      env: {
        LMMS_INSTALLER_COPILOT_SKILLS_DIR: fakeCopilotSkillsDir,
        LMMS_INSTALLER_AGENTS_SKILLS_DIR: fakeAgentsSkillsDir,
      },
    }),
    {
      copilotSkillsRoot: path.resolve(fakeCopilotSkillsDir),
      agentsSkillsRoot: path.resolve(fakeAgentsSkillsDir),
    },
  );

  // Pre-seed global mcp-config.json with another server containing a secret token that must NEVER be printed.
  await mkdir(path.dirname(fakeGlobalMcpPath), { recursive: true });
  const secretSentinel = 'DO_NOT_LOG_GLOBAL_MCP_TOKEN_77341';
  const existingGlobalMcp = {
    mcpServers: {
      'private-corp-mcp': {
        command: 'node',
        args: ['C:\\corp\\mcp.js'],
        env: {
          CORP_AUTH_TOKEN: secretSentinel,
        },
      },
    },
  };
  await writeFile(fakeGlobalMcpPath, JSON.stringify(existingGlobalMcp, null, 2) + '\n', 'utf8');

  const globalMergeRun = await runCommandSafe(
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'installer-config.mjs'),
      '--mode', 'merge-global-mcp',
      '--repo-root', 'D:\\repos\\lmms-music-studio',
      '--workspace', 'D:\\Music\\Workspace',
      '--soundfonts', 'D:\\Music\\SoundFonts',
    ],
    {
      env: {
        ...process.env,
        LMMS_INSTALLER_GLOBAL_MCP_PATH: fakeGlobalMcpPath,
      },
    },
  );

  assert.ok(!globalMergeRun.stdout.includes(secretSentinel), 'stdout must never contain global MCP secrets');
  assert.ok(!globalMergeRun.stderr.includes(secretSentinel), 'stderr must never contain global MCP secrets');
  assert.ok(!globalMergeRun.stdout.includes('private-corp-mcp'), 'stdout must only report { created, changed, path }');

  const globalResult = JSON.parse(globalMergeRun.stdout.trim());
  assert.deepEqual(globalResult, {
    created: false,
    changed: true,
    path: path.resolve(fakeGlobalMcpPath),
  });

  const mergedGlobalOnDisk = JSON.parse(await readFile(fakeGlobalMcpPath, 'utf8'));
  assert.deepEqual(mergedGlobalOnDisk.mcpServers['private-corp-mcp'], existingGlobalMcp.mcpServers['private-corp-mcp']);
  assert.deepEqual(mergedGlobalOnDisk.mcpServers['lmms-music-studio'], {
    command: 'node',
    args: ['D:\\repos\\lmms-music-studio\\server.mjs'],
    env: {
      LMMS_WORKSPACE: 'D:\\Music\\Workspace',
      LMMS_SOUNDFONTS: 'D:\\Music\\SoundFonts',
      LMMS_STRICT_COPYRIGHT: '1',
    },
  });

  // Pre-seed legacy lmms-music-studio directories in both user skill roots and verify hermetic CLI install.
  const legacyCopilotDir = path.join(fakeCopilotSkillsDir, 'lmms-music-studio');
  const legacyAgentsDir = path.join(fakeAgentsSkillsDir, 'lmms-music-studio');
  await mkdir(legacyCopilotDir, { recursive: true });
  await mkdir(legacyAgentsDir, { recursive: true });
  await writeFile(path.join(legacyCopilotDir, 'SKILL.md'), 'legacy', 'utf8');
  await writeFile(path.join(legacyAgentsDir, 'SKILL.md'), 'legacy', 'utf8');

  const skillRun = await runCommandSafe(
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'installer-config.mjs'),
      '--mode', 'install-user-skills',
      '--repo-root', repoRoot,
    ],
    {
      env: {
        ...process.env,
        LMMS_INSTALLER_COPILOT_SKILLS_DIR: fakeCopilotSkillsDir,
        LMMS_INSTALLER_AGENTS_SKILLS_DIR: fakeAgentsSkillsDir,
      },
    },
  );
  const skillResult = JSON.parse(skillRun.stdout.trim());
  assert.equal(skillResult.copilotSkillDir, path.join(fakeCopilotSkillsDir, 'make-music'));
  assert.equal(skillResult.agentsSkillDir, path.join(fakeAgentsSkillsDir, 'make-music'));
  assert.equal(existsSync(legacyCopilotDir), false);
  assert.equal(existsSync(legacyAgentsDir), false);

  for (const fileName of ['SKILL.md', 'producer-tool-reference.md']) {
    const expectedBuf = await readFile(path.join(repoRoot, 'skills', 'make-music', fileName));
    const copilotBuf = await readFile(path.join(fakeCopilotSkillsDir, 'make-music', fileName));
    const agentsBuf = await readFile(path.join(fakeAgentsSkillsDir, 'make-music', fileName));
    assert.equal(Buffer.compare(copilotBuf, expectedBuf), 0, `.copilot/skills/make-music/${fileName} mismatch`);
    assert.equal(Buffer.compare(agentsBuf, expectedBuf), 0, `.agents/skills/make-music/${fileName} mismatch`);
  }

  // Direct API call is idempotent when legacy folders are already gone.
  const repeatSkills = await installUserSkills({
    repoRoot,
    env: {
      LMMS_INSTALLER_COPILOT_SKILLS_DIR: fakeCopilotSkillsDir,
      LMMS_INSTALLER_AGENTS_SKILLS_DIR: fakeAgentsSkillsDir,
    },
  });
  assert.deepEqual(repeatSkills.removedLegacyDirs, []);
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
    'skills/make-music/SKILL.md',
    'skills/make-music/producer-tool-reference.md',
    '.github/skills/make-music/SKILL.md',
    '.github/skills/make-music/producer-tool-reference.md',
    'install-windows.ps1',
    'setup-windows.ps1',
    'setup-libraries-windows.ps1',
    'server.mjs',
    '.mcp.example.json',
    '.vscode/mcp.example.json',
  ];
  for (const rel of mustBeEmojiFree) {
    const full = path.join(repoRoot, rel);
    assert.ok(existsSync(full), `Expected ${rel} to exist`);
    const content = await readFile(full, 'utf8');
    assert.doesNotMatch(content, EMOJI_OR_SYMBOL_REGEX, `${rel} must contain zero emojis or Unicode symbols`);
  }

  // Verify plain URLs/paths (no rendered [label](url) hyperlinks outside code spans) in docs and skills.
  assert.match(stripMarkdownCode('Check [Studio](http://127.0.0.1:18290) and `code`'), LABEL_HYPERLINK_REGEX);
  for (const rel of [
    'README.md',
    'AGENTS.md',
    'skills/make-music/SKILL.md',
    'skills/make-music/producer-tool-reference.md',
    '.github/skills/make-music/SKILL.md',
    '.github/skills/make-music/producer-tool-reference.md',
  ]) {
    const content = await readFile(path.join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(
      stripMarkdownCode(content),
      LABEL_HYPERLINK_REGEX,
      `${rel} must use plain copyable paths/URLs instead of [label](url) links`,
    );
  }

  // Project and user-distributable make-music skill files must match byte-for-byte, have zero hardcoded machine paths, and legacy skill folders must be gone.
  for (const fileName of ['SKILL.md', 'producer-tool-reference.md']) {
    const mainBuf = await readFile(path.join(repoRoot, 'skills/make-music', fileName));
    const ghBuf = await readFile(path.join(repoRoot, '.github/skills/make-music', fileName));
    assert.equal(Buffer.compare(mainBuf, ghBuf), 0, `skills/make-music/${fileName} and .github/skills/make-music/${fileName} must match byte-for-byte`);
    assert.doesNotMatch(mainBuf.toString('utf8'), /F:\\projects\\lmms-music-studio/i, `${fileName} must not contain hardcoded local checkout paths`);
  }
  const skillMarkdown = await readFile(path.join(repoRoot, 'skills/make-music/SKILL.md'), 'utf8');
  assert.match(skillMarkdown, /via LMMS Music Studio \(`mkpurgahn\/lmms-music-studio`\)/);
  assert.equal(existsSync(path.join(repoRoot, 'skills/lmms-game-audio')), false);
  assert.equal(existsSync(path.join(repoRoot, 'skills/lmms-music-studio')), false);
  assert.equal(existsSync(path.join(repoRoot, '.github/skills/lmms-music-studio')), false);

  // Verify installer wires .mcp.json, .vscode/mcp.json, global mcp-config.json (-SkipGlobalMcp), and both user skill roots.
  const installerScript = await readFile(path.join(repoRoot, 'install-windows.ps1'), 'utf8');
  assert.match(installerScript, /skills\\make-music/);
  assert.match(installerScript, /producer-tool-reference\.md/);
  assert.match(installerScript, /merge-vscode-mcp/);
  assert.match(installerScript, /merge-global-mcp/);
  assert.match(installerScript, /install-user-skills/);
  assert.match(installerScript, /SkipGlobalMcp/);
  assert.match(installerScript, /LMMS_INSTALLER_GLOBAL_MCP_PATH/);
  assert.match(installerScript, /LMMS_INSTALLER_AGENTS_SKILLS_DIR/);

  if (process.platform === 'win32') {
    const parseCheck = await runCommandSafe('powershell.exe', [
      '-NoProfile',
      '-Command',
      `foreach ($f in @('${path.join(repoRoot, 'install-windows.ps1').replace(/'/g, "''")}', '${path.join(repoRoot, 'setup-windows.ps1').replace(/'/g, "''")}')) { $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { throw ($errors | Out-String) } }`,
    ]);
    assert.equal(parseCheck.exitCode, 0);
  }

  // Verify .gitignore ignores both .mcp.json and .vscode/mcp.json so local machine paths are never staged.
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.mcp\.json$/m);
  assert.match(gitignore, /^\.vscode\/mcp\.json$/m);

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
