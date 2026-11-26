// Non-destructive .mcp.json configuration merger, path resolver, and SoundFont lockfile verifier
// used by install-windows.ps1 and unit tests. Uses only Node built-ins and zero-dependency local helpers
// so preflight checks can run before `npm ci` on a fresh checkout.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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

export function mergeMcpConfig(existingConfig, {
  repoRoot = REPO_ROOT,
  workspace,
  soundfontsDir,
  strictCopyright = '1',
  platform = process.platform,
} = {}) {
  if (existingConfig !== null && existingConfig !== undefined && !isPlainObject(existingConfig)) {
    throw new Error('Existing .mcp.json root value must be a JSON object');
  }
  if (!workspace || typeof workspace !== 'string') {
    throw new Error('mergeMcpConfig requires a resolved workspace path');
  }
  if (!soundfontsDir || typeof soundfontsDir !== 'string') {
    throw new Error('mergeMcpConfig requires a resolved soundfontsDir path');
  }

  const base = existingConfig ? { ...existingConfig } : {};
  if (base.mcpServers !== undefined && !isPlainObject(base.mcpServers)) {
    throw new Error('Existing .mcp.json "mcpServers" property must be a JSON object');
  }

  const winMode = platform === 'win32' || isWindowsStylePath(repoRoot);
  const normalizedRoot = normalizeTargetPath(repoRoot, winMode ? 'win32' : platform);
  const serverScript = winMode
    ? path.win32.join(normalizedRoot, 'server.mjs')
    : path.join(normalizedRoot, 'server.mjs');
  const normalizedWorkspace = normalizeTargetPath(workspace, winMode ? 'win32' : platform);
  const normalizedSoundfonts = normalizeTargetPath(soundfontsDir, winMode ? 'win32' : platform);

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

export async function upsertMcpConfigFile(mcpConfigPath, options = {}) {
  const resolvedPath = path.resolve(mcpConfigPath);
  const existed = existsSync(resolvedPath);
  let rawExisting = null;
  let parsedExisting = null;

  if (existed) {
    rawExisting = await readFile(resolvedPath, 'utf8');
    const withoutBom = rawExisting.charCodeAt(0) === 0xfeff ? rawExisting.slice(1) : rawExisting;
    if (withoutBom.trim().length > 0) {
      try {
        parsedExisting = JSON.parse(withoutBom);
      } catch (error) {
        throw new Error(
          `Cannot update ${resolvedPath}: existing .mcp.json is not valid JSON (${error.message}). Fix or back up the file and re-run install-windows.ps1.`,
        );
      }
    }
  }

  const merged = mergeMcpConfig(parsedExisting, options);
  const serialized = JSON.stringify(merged, null, 2) + '\n';

  if (existed && rawExisting === serialized) {
    return {
      path: resolvedPath,
      created: false,
      changed: false,
      config: merged,
    };
  }

  await writeFileAtomic(resolvedPath, serialized, { overwrite: true });
  return {
    path: resolvedPath,
    created: !existed,
    changed: true,
    config: merged,
  };
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
      path: result.path,
      created: result.created,
      changed: result.changed,
      workspace: resolved.workspace,
      soundfontsDir: resolved.soundfontsDir,
    }) + '\n');
  } else {
    throw new Error('Expected --mode preflight or --mode merge-mcp');
  }
}
