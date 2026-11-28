// Non-destructive MCP configuration merger (.mcp.json, .vscode/mcp.json, and ~/.copilot/mcp-config.json),
// user skill installer (~/.copilot/skills + ~/.agents/skills), path resolver, and SoundFont lockfile verifier
// used by install-windows.ps1 and unit tests. Uses only Node built-ins and zero-dependency local helpers
// so preflight checks can run before `npm ci` on a fresh checkout.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from './fs-atomic.mjs';
import {
  resolveLmmsExecutable,
  resolveSoundfontsDir,
  resolveWorkspaceDir,
} from './workspace-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TRACKED_LOCK_PATH = path.join(REPO_ROOT, 'soundfont-lock.json');

export const PACK_TARGET_IDS = Object.freeze({
  core: Object.freeze(['upright-piano-kw', 'meta-guitars', 'virtuosity-drums', 'vsco-orchestra-core']),
  'upright-bass': Object.freeze(['upright-bass']),
  'meta-piano': Object.freeze(['meta-piano']),
  'vsco-extended': Object.freeze(['vsco-orchestra-extended']),
  'vsco-complete': Object.freeze([
    'vsco-strings-complete',
    'vsco-brass-complete',
    'vsco-winds-complete',
    'vsco-percussion-keys',
    'vsco-orch-perc',
  ]),
  all: Object.freeze([
    'upright-piano-kw',
    'meta-guitars',
    'virtuosity-drums',
    'vsco-orchestra-core',
    'upright-bass',
    'meta-piano',
    'vsco-orchestra-extended',
    'vsco-strings-complete',
    'vsco-brass-complete',
    'vsco-winds-complete',
    'vsco-percussion-keys',
    'vsco-orch-perc',
  ]),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWindowsStylePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value ?? '')) || String(value ?? '').startsWith('\\\\');
}

function normalizeTargetPath(value, platform = process.platform) {
  const trimmed = String(value ?? '').trim();
  if (platform === 'win32' || isWindowsStylePath(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, '\\')).replace(/\\+$/, '');
  }
  return path.resolve(trimmed);
}

async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function resolveInstallerPaths({
  workspace = '',
  soundfontsDir = '',
  env = process.env,
  homedir,
  platform = process.platform,
} = {}) {
  const wsOverride = typeof workspace === 'string' && workspace.trim().length > 0 ? workspace.trim() : null;
  const sfOverride = typeof soundfontsDir === 'string' && soundfontsDir.trim().length > 0 ? soundfontsDir.trim() : null;

  const effectiveEnv = {
    ...env,
    ...(wsOverride ? { LMMS_WORKSPACE: wsOverride } : {}),
    ...(sfOverride ? { LMMS_SOUNDFONTS: sfOverride } : {}),
  };

  const homeOpts = homedir ? { homedir } : {};
  return {
    workspace: resolveWorkspaceDir(effectiveEnv, homeOpts),
    soundfontsDir: resolveSoundfontsDir(effectiveEnv, homeOpts),
    lmmsExecutable: resolveLmmsExecutable(effectiveEnv, { platform }),
  };
}

function resolveEffectiveHome({ env = process.env, homedir } = {}) {
  if (typeof homedir === 'string' && homedir.trim().length > 0) {
    return path.resolve(homedir.trim());
  }
  const candidate = env.USERPROFILE || env.HOME || os.homedir();
  return path.resolve(candidate);
}

export function resolveGlobalMcpConfigPath({
  mcpPath = '',
  env = process.env,
  homedir,
} = {}) {
  if (typeof mcpPath === 'string' && mcpPath.trim().length > 0) {
    return path.resolve(mcpPath.trim());
  }
  if (typeof env.LMMS_INSTALLER_GLOBAL_MCP_PATH === 'string' && env.LMMS_INSTALLER_GLOBAL_MCP_PATH.trim().length > 0) {
    return path.resolve(env.LMMS_INSTALLER_GLOBAL_MCP_PATH.trim());
  }
  return path.join(resolveEffectiveHome({ env, homedir }), '.copilot', 'mcp-config.json');
}

export function resolveUserSkillRoots({
  copilotSkillsDir = '',
  agentsSkillsDir = '',
  env = process.env,
  homedir,
} = {}) {
  const home = resolveEffectiveHome({ env, homedir });
  const copilotOverride = typeof copilotSkillsDir === 'string' && copilotSkillsDir.trim().length > 0
    ? copilotSkillsDir.trim()
    : (typeof env.LMMS_INSTALLER_COPILOT_SKILLS_DIR === 'string' ? env.LMMS_INSTALLER_COPILOT_SKILLS_DIR.trim() : '');
  const agentsOverride = typeof agentsSkillsDir === 'string' && agentsSkillsDir.trim().length > 0
    ? agentsSkillsDir.trim()
    : (typeof env.LMMS_INSTALLER_AGENTS_SKILLS_DIR === 'string' ? env.LMMS_INSTALLER_AGENTS_SKILLS_DIR.trim() : '');

  return {
    copilotSkillsRoot: copilotOverride ? path.resolve(copilotOverride) : path.join(home, '.copilot', 'skills'),
    agentsSkillsRoot: agentsOverride ? path.resolve(agentsOverride) : path.join(home, '.agents', 'skills'),
  };
}

export async function installUserSkills({
  repoRoot = REPO_ROOT,
  copilotSkillsDir = '',
  agentsSkillsDir = '',
  env = process.env,
  homedir,
} = {}) {
  const sourceSkillDir = path.join(path.resolve(repoRoot), 'skills', 'make-music');
  if (!existsSync(sourceSkillDir)) {
    throw new Error(`Skill source directory missing: ${sourceSkillDir}`);
  }
  for (const requiredFile of ['SKILL.md', 'producer-tool-reference.md']) {
    const candidate = path.join(sourceSkillDir, requiredFile);
    if (!existsSync(candidate)) {
      throw new Error(`Required skill file missing: ${candidate}`);
    }
  }

  const { copilotSkillsRoot, agentsSkillsRoot } = resolveUserSkillRoots({
    copilotSkillsDir,
    agentsSkillsDir,
    env,
    homedir,
  });
  const entries = await readdir(sourceSkillDir);
  const installedDirs = [];
  const removedLegacyDirs = [];

  for (const targetSkillsRoot of [copilotSkillsRoot, agentsSkillsRoot]) {
    const targetSkillDir = path.join(targetSkillsRoot, 'make-music');
    await mkdir(targetSkillDir, { recursive: true });
    for (const entry of entries) {
      await cp(path.join(sourceSkillDir, entry), path.join(targetSkillDir, entry), {
        recursive: true,
        force: true,
      });
    }
    const legacyDir = path.join(targetSkillsRoot, 'lmms-music-studio');
    if (existsSync(legacyDir)) {
      await rm(legacyDir, { recursive: true, force: true });
      removedLegacyDirs.push(legacyDir);
    }
    installedDirs.push(targetSkillDir);
  }

  return {
    copilotSkillDir: installedDirs[0],
    agentsSkillDir: installedDirs[1],
    removedLegacyDirs,
  };
}

export async function verifyInstalledPacks({
  packs = ['core'],
  soundfontsDir = resolveSoundfontsDir(process.env),
  trackedLockPath = DEFAULT_TRACKED_LOCK_PATH,
} = {}) {
  const packList = (Array.isArray(packs) ? packs : String(packs).split(','))
    .map(name => String(name).trim())
    .filter(Boolean);
  if (packList.length === 0) {
    throw new Error('At least one SoundFont pack name is required');
  }

  const targetIds = [];
  for (const packName of packList) {
    const ids = PACK_TARGET_IDS[packName];
    if (!ids) {
      throw new Error(`Unknown SoundFont pack "${packName}". Expected one of: ${Object.keys(PACK_TARGET_IDS).join(', ')}`);
    }
    for (const id of ids) {
      if (!targetIds.includes(id)) targetIds.push(id);
    }
  }

  const resolvedSoundfontsDir = path.resolve(soundfontsDir);
  const localLockPath = path.join(resolvedSoundfontsDir, 'soundfont-lock.json');

  const readLockJson = async filePath => {
    if (!filePath || !existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      return isPlainObject(parsed) && isPlainObject(parsed.soundfonts) ? parsed : null;
    } catch {
      return null;
    }
  };

  const localLock = await readLockJson(localLockPath);
  const trackedLock = await readLockJson(trackedLockPath);
  const lockExists = Boolean(localLock);
  const unverifiedTargets = [];

  if (!localLock) {
    return {
      soundfontsDir: resolvedSoundfontsDir,
      localLockPath,
      lockExists: false,
      packsVerified: false,
      verifiedTargets: [],
      unverifiedTargets: targetIds,
    };
  }

  const verifiedTargets = [];
  for (const id of targetIds) {
    const localEntry = localLock.soundfonts[id];
    const trackedEntry = trackedLock?.soundfonts?.[id] ?? null;
    const expectedSha = String(trackedEntry?.sf2Sha256 ?? localEntry?.sf2Sha256 ?? '').toLowerCase();
    const fileName = localEntry?.fileName ?? trackedEntry?.fileName;
    if (!localEntry || !fileName || !/^[0-9a-f]{64}$/.test(expectedSha)) {
      unverifiedTargets.push(id);
      continue;
    }
    if (trackedEntry?.sf2Sha256 && String(localEntry.sf2Sha256 ?? '').toLowerCase() !== expectedSha) {
      unverifiedTargets.push(id);
      continue;
    }
    const sf2Path = path.join(resolvedSoundfontsDir, fileName);
    const info = await stat(sf2Path).catch(() => null);
    if (!info?.isFile()) {
      unverifiedTargets.push(id);
      continue;
    }
    const expectedBytes = trackedEntry?.sf2Bytes ?? localEntry?.sf2Bytes;
    if (Number.isInteger(expectedBytes) && info.size !== expectedBytes) {
      unverifiedTargets.push(id);
      continue;
    }
    const actualSha = (await hashFileSha256(sf2Path)).toLowerCase();
    if (actualSha !== expectedSha) {
      unverifiedTargets.push(id);
      continue;
    }
    verifiedTargets.push(id);
  }

  return {
    soundfontsDir: resolvedSoundfontsDir,
    localLockPath,
    lockExists,
    packsVerified: unverifiedTargets.length === 0 && verifiedTargets.length === targetIds.length,
    verifiedTargets,
    unverifiedTargets,
  };
}

function buildStudioServerPaths({
  repoRoot = REPO_ROOT,
  workspace,
  soundfontsDir,
  platform = process.platform,
  callerName = 'mergeMcpConfig',
}) {
  if (!workspace || typeof workspace !== 'string') {
    throw new Error(`${callerName} requires a resolved workspace path`);
  }
  if (!soundfontsDir || typeof soundfontsDir !== 'string') {
    throw new Error(`${callerName} requires a resolved soundfontsDir path`);
  }

  const winMode = platform === 'win32' || isWindowsStylePath(repoRoot);
  const normalizedRoot = normalizeTargetPath(repoRoot, winMode ? 'win32' : platform);
  const serverScript = winMode
    ? path.win32.join(normalizedRoot, 'server.mjs')
    : path.join(normalizedRoot, 'server.mjs');
  const normalizedWorkspace = normalizeTargetPath(workspace, winMode ? 'win32' : platform);
  const normalizedSoundfonts = normalizeTargetPath(soundfontsDir, winMode ? 'win32' : platform);
  return { serverScript, normalizedWorkspace, normalizedSoundfonts };
}

export function mergeMcpConfig(existingConfig, {
  repoRoot = REPO_ROOT,
  workspace,
  soundfontsDir,
  strictCopyright = '1',
  platform = process.platform,
} = {}) {
  if (existingConfig !== null && existingConfig !== undefined && !isPlainObject(existingConfig)) {
    throw new Error('Existing MCP config root value must be a JSON object');
  }

  const base = existingConfig ? { ...existingConfig } : {};
  if (base.mcpServers !== undefined && !isPlainObject(base.mcpServers)) {
    throw new Error('Existing MCP config "mcpServers" property must be a JSON object');
  }

  const { serverScript, normalizedWorkspace, normalizedSoundfonts } = buildStudioServerPaths({
    repoRoot,
    workspace,
    soundfontsDir,
    platform,
    callerName: 'mergeMcpConfig',
  });

  const existingServers = base.mcpServers ?? {};
  const previousStudio = isPlainObject(existingServers['lmms-music-studio'])
    ? existingServers['lmms-music-studio']
    : {};
  const previousEnv = isPlainObject(previousStudio.env) ? previousStudio.env : {};

  const studioEntry = {
    ...previousStudio,
    command: 'node',
    args: [serverScript],
    env: {
      ...previousEnv,
      LMMS_WORKSPACE: normalizedWorkspace,
      LMMS_SOUNDFONTS: normalizedSoundfonts,
      LMMS_STRICT_COPYRIGHT: String(strictCopyright),
    },
  };

  return {
    ...base,
    mcpServers: {
      ...existingServers,
      'lmms-music-studio': studioEntry,
    },
  };
}

export function mergeVscodeMcpConfig(existingConfig, {
  repoRoot = REPO_ROOT,
  workspace,
  soundfontsDir,
  strictCopyright = '1',
  platform = process.platform,
} = {}) {
  if (existingConfig !== null && existingConfig !== undefined && !isPlainObject(existingConfig)) {
    throw new Error('Existing .vscode/mcp.json root value must be a JSON object');
  }

  const base = existingConfig ? { ...existingConfig } : {};
  if (base.servers !== undefined && !isPlainObject(base.servers)) {
    throw new Error('Existing .vscode/mcp.json "servers" property must be a JSON object');
  }

  const { serverScript, normalizedWorkspace, normalizedSoundfonts } = buildStudioServerPaths({
    repoRoot,
    workspace,
    soundfontsDir,
    platform,
    callerName: 'mergeVscodeMcpConfig',
  });

  const existingServers = base.servers ?? {};
  const previousStudio = isPlainObject(existingServers['lmms-music-studio'])
    ? existingServers['lmms-music-studio']
    : {};
  const previousEnv = isPlainObject(previousStudio.env) ? previousStudio.env : {};
  const {
    type: _ignoredType,
    command: _ignoredCommand,
    args: _ignoredArgs,
    env: _ignoredEnv,
    ...restPreviousStudio
  } = previousStudio;

  const studioEntry = {
    type: 'stdio',
    command: 'node',
    args: [serverScript],
    env: {
      ...previousEnv,
      LMMS_WORKSPACE: normalizedWorkspace,
      LMMS_SOUNDFONTS: normalizedSoundfonts,
      LMMS_STRICT_COPYRIGHT: String(strictCopyright),
    },
    ...restPreviousStudio,
  };

  return {
    ...base,
    servers: {
      ...existingServers,
      'lmms-music-studio': studioEntry,
    },
  };
}

async function upsertJsonConfigFile(configPath, mergeFn, options = {}) {
  const resolvedPath = path.resolve(configPath);
  const existed = existsSync(resolvedPath);
  let rawExisting = null;
  let parsedExisting = null;

  if (existed) {
    rawExisting = await readFile(resolvedPath, 'utf8');
    const withoutBom = rawExisting.charCodeAt(0) === 0xfeff ? rawExisting.slice(1) : rawExisting;
    if (withoutBom.trim().length > 0) {
      try {
        parsedExisting = JSON.parse(withoutBom);
      } catch {
        throw new Error(
          `Cannot update ${resolvedPath}: existing configuration file is not valid JSON. Fix or back up the file and re-run install-windows.ps1.`,
        );
      }
    }
  }

  const merged = mergeFn(parsedExisting, options);
  const serialized = JSON.stringify(merged, null, 2) + '\n';

  if (existed && rawExisting === serialized) {
    return {
      created: false,
      changed: false,
      path: resolvedPath,
    };
  }

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFileAtomic(resolvedPath, serialized, { overwrite: true });
  return {
    created: !existed,
    changed: true,
    path: resolvedPath,
  };
}

export async function upsertMcpConfigFile(mcpConfigPath, options = {}) {
  return upsertJsonConfigFile(mcpConfigPath, mergeMcpConfig, options);
}

export async function upsertVscodeMcpConfigFile(vscodeMcpPath, options = {}) {
  return upsertJsonConfigFile(vscodeMcpPath, mergeVscodeMcpConfig, options);
}

function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1).toLowerCase() === path.resolve(fileURLToPath(metaUrl)).toLowerCase();
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'repo-root': { type: 'string' },
      'mcp-path': { type: 'string' },
      'copilot-skills-dir': { type: 'string', default: '' },
      'agents-skills-dir': { type: 'string', default: '' },
      workspace: { type: 'string', default: '' },
      soundfonts: { type: 'string', default: '' },
      packs: { type: 'string', default: 'core' },
    },
  });

  const repoRoot = path.resolve(values['repo-root'] || REPO_ROOT);
  const resolved = resolveInstallerPaths({
    workspace: values.workspace,
    soundfontsDir: values.soundfonts,
    env: process.env,
  });

  if (values.mode === 'preflight') {
    const lmmsExists = path.isAbsolute(resolved.lmmsExecutable)
      ? existsSync(resolved.lmmsExecutable)
      : false;
    const packCheck = await verifyInstalledPacks({
      packs: values.packs,
      soundfontsDir: resolved.soundfontsDir,
      trackedLockPath: path.join(repoRoot, 'soundfont-lock.json'),
    });
    process.stdout.write(JSON.stringify({
      repoRoot,
      workspace: resolved.workspace,
      soundfontsDir: resolved.soundfontsDir,
      lmmsExecutable: resolved.lmmsExecutable,
      lmmsExists,
      lockExists: packCheck.lockExists,
      packsVerified: packCheck.packsVerified,
      verifiedTargets: packCheck.verifiedTargets,
      unverifiedTargets: packCheck.unverifiedTargets,
    }) + '\n');
  } else if (values.mode === 'merge-mcp') {
    const mcpPath = path.resolve(values['mcp-path'] || path.join(repoRoot, '.mcp.json'));
    const result = await upsertMcpConfigFile(mcpPath, {
      repoRoot,
      workspace: resolved.workspace,
      soundfontsDir: resolved.soundfontsDir,
      strictCopyright: '1',
    });
    process.stdout.write(JSON.stringify({
      created: result.created,
      changed: result.changed,
      path: result.path,
    }) + '\n');
  } else if (values.mode === 'merge-vscode-mcp') {
    const vscodeMcpPath = path.resolve(values['mcp-path'] || path.join(repoRoot, '.vscode', 'mcp.json'));
    const result = await upsertVscodeMcpConfigFile(vscodeMcpPath, {
      repoRoot,
      workspace: resolved.workspace,
      soundfontsDir: resolved.soundfontsDir,
      strictCopyright: '1',
    });
    process.stdout.write(JSON.stringify({
      created: result.created,
      changed: result.changed,
      path: result.path,
    }) + '\n');
  } else if (values.mode === 'merge-global-mcp') {
    const globalMcpPath = resolveGlobalMcpConfigPath({
      mcpPath: values['mcp-path'],
      env: process.env,
    });
    const result = await upsertMcpConfigFile(globalMcpPath, {
      repoRoot,
      workspace: resolved.workspace,
      soundfontsDir: resolved.soundfontsDir,
      strictCopyright: '1',
    });
    process.stdout.write(JSON.stringify({
      created: result.created,
      changed: result.changed,
      path: result.path,
    }) + '\n');
  } else if (values.mode === 'install-user-skills') {
    const skillResult = await installUserSkills({
      repoRoot,
      copilotSkillsDir: values['copilot-skills-dir'],
      agentsSkillsDir: values['agents-skills-dir'],
      env: process.env,
    });
    process.stdout.write(JSON.stringify(skillResult) + '\n');
  } else {
    throw new Error('Expected --mode preflight, merge-mcp, merge-vscode-mcp, merge-global-mcp, or install-user-skills');
  }
}
