// Canonical configuration, tool-path discovery, and Windows non-ASCII path staging
// shared by server.mjs, library-server.mjs, and setup scripts.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const nonEmpty = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

export const hasNonAscii = value => /[^\x00-\x7F]/.test(String(value ?? ''));

export function resolveWorkspaceDir(env = process.env, { homedir = os.homedir() } = {}) {
  const configured = nonEmpty(env?.LMMS_WORKSPACE);
  return path.resolve(configured ?? path.join(homedir, 'Music', 'LMMS Music Studio'));
}

export function resolveSoundfontsDir(env = process.env, { homedir = os.homedir() } = {}) {
  const configured = nonEmpty(env?.LMMS_SOUNDFONTS);
  if (configured) return path.resolve(configured);
  const localAppData = nonEmpty(env?.LOCALAPPDATA) ?? path.join(homedir, 'AppData', 'Local');
  return path.resolve(path.join(localAppData, 'lmms-music-studio', 'soundfonts'));
}

export function resolveLmmsExecutable(env = process.env, { platform = process.platform } = {}) {
  const configured = nonEmpty(env?.LMMS_EXECUTABLE);
  if (configured) return configured;
  return platform === 'win32' ? 'C:\\Program Files\\LMMS\\lmms.exe' : 'lmms';
}

export function lmmsDataCandidates(lmmsPath, { platform = process.platform, pathEnv = process.env.PATH ?? '', exists = existsSync } = {}) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [];
  const add = dir => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  const hasDirectory = /[\\/]/.test(lmmsPath);
  const folders = [];
  if (hasDirectory) {
    folders.push(pathModule.dirname(lmmsPath));
  } else {
    for (const entry of pathEnv.split(platform === 'win32' ? ';' : ':')) {
      if (!entry) continue;
      for (const name of platform === 'win32' ? [lmmsPath + '.exe', lmmsPath] : [lmmsPath]) {
        if (exists(pathModule.join(entry, name))) {
          folders.push(entry);
          break;
        }
      }
    }
  }
  if (!folders.length) folders.push(pathModule.dirname(lmmsPath));
  for (const folder of folders) {
    add(pathModule.join(folder, 'data'));
    if (folder !== '.') add(pathModule.resolve(folder, '..', 'share', 'lmms'));
  }
  if (platform !== 'win32') {
    add('/usr/share/lmms');
    add('/usr/local/share/lmms');
  }
  return dirs;
}

export function lmmsDataDirectory(lmmsPath, options = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = lmmsDataCandidates(lmmsPath, options);
  return candidates.find(candidate => exists(candidate)) ?? candidates[0];
}

export function resolveLmmsDataDir(lmmsExe, options = {}) {
  return lmmsDataDirectory(lmmsExe, options);
}

export function resolveLmmsPresetsDir(env = process.env, lmmsExe = resolveLmmsExecutable(env)) {
  const configured = nonEmpty(env?.LMMS_PRESETS);
  return path.resolve(configured ?? path.join(resolveLmmsDataDir(lmmsExe), 'presets'));
}

export function resolveLmmsSamplesDir(env = process.env, lmmsExe = resolveLmmsExecutable(env)) {
  const configured = nonEmpty(env?.LMMS_SAMPLES);
  return path.resolve(configured ?? path.join(resolveLmmsDataDir(lmmsExe), 'samples'));
}

export function resolveLmmsPluginsDir(env = process.env, lmmsExe = resolveLmmsExecutable(env)) {
  const configured = nonEmpty(env?.LMMS_PLUGINS);
  return path.resolve(configured ?? path.join(path.dirname(lmmsExe), 'plugins'));
}

export function resolveFfmpegExecutable(env = process.env) {
  return nonEmpty(env?.LMMS_FFMPEG) ?? 'ffmpeg';
}

export function resolveAsciiCacheDir(env = process.env, { platform = process.platform, homedir = os.homedir() } = {}) {
  const configured = nonEmpty(env?.LMMS_ASCII_CACHE);
  if (configured) return path.resolve(configured);
  return platform === 'win32'
    ? 'C:\\Users\\Public\\lmms-music-studio-cache'
    : path.resolve(path.join(homedir, '.cache', 'lmms-music-studio'));
}

export function renderTimeoutMs(trackCount, durationSeconds, env = process.env) {
  const override = Number(env?.LMMS_RENDER_TIMEOUT_SECONDS ?? env?.LMMS_VST3_TIMEOUT_SECONDS);
  if (Number.isFinite(override) && override > 0) return Math.round(Math.min(override, 6 * 3600) * 1000);
  const seconds = 60 + Math.max(1, trackCount) * (60 + 0.5 * Math.max(0, durationSeconds));
  return Math.round(Math.min(Math.max(590, seconds), 3600) * 1000);
}

export function sanitizeAsciiBasename(filename) {
  const rawExt = path.extname(filename);
  const ext = /^[.][a-zA-Z0-9]{1,12}$/.test(rawExt) ? rawExt : '';
  const rawStem = ext ? filename.slice(0, -ext.length) : filename;
  const stem = rawStem
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || 'asset';
  return `${stem}${ext}`;
}

async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function tryWindowsShortPath(targetPath, { timeoutMs = 5000 } = {}) {
  if (!targetPath || /["%\r\n\0]/.test(targetPath) || !existsSync(targetPath)) return null;
  let originalStat;
  try {
    originalStat = statSync(targetPath, { bigint: true });
  } catch {
    return null;
  }
  const commandLine = `"for %I in ("${targetPath}") do @echo %~sI"`;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', commandLine], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.status !== 0 || result.error) return null;
  const candidate = (result.stdout ?? '').trim().split(/\r?\n/)[0]?.trim();
  if (!candidate || candidate.includes('?') || hasNonAscii(candidate)) return null;
  try {
    const candidateStat = statSync(candidate, { bigint: true });
    if (candidateStat.dev !== originalStat.dev || candidateStat.ino !== originalStat.ino || candidateStat.size !== originalStat.size) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export async function ensureLmmsAsciiPath(targetPath, {
  cacheDir,
  env = process.env,
  platform = process.platform,
  shortPathResolver = tryWindowsShortPath,
} = {}) {
  const resolved = path.resolve(targetPath);
  if (platform !== 'win32' || !hasNonAscii(resolved)) {
    return resolved;
  }

  const shortCandidate = shortPathResolver ? await shortPathResolver(resolved) : null;
  if (shortCandidate && !hasNonAscii(shortCandidate) && existsSync(shortCandidate)) {
    return shortCandidate;
  }

  const effectiveCacheDir = path.resolve(cacheDir ?? resolveAsciiCacheDir(env, { platform }));
  if (hasNonAscii(effectiveCacheDir)) {
    throw new Error(`ASCII fallback cache path itself contains non-ASCII characters: ${effectiveCacheDir}. Set LMMS_ASCII_CACHE to an ASCII-only directory.`);
  }

  const sourceInfo = await stat(resolved);
  await mkdir(effectiveCacheDir, { recursive: true });

  if (sourceInfo.isDirectory()) {
    const dirHash = createHash('sha256').update(resolved).digest('hex');
    const dirName = `${dirHash}-${sanitizeAsciiBasename(path.basename(resolved) || 'dir')}`;
    const stagedDir = path.join(effectiveCacheDir, dirName);
    await mkdir(stagedDir, { recursive: true });
    return stagedDir;
  }

  if (!sourceInfo.isFile()) {
    throw new Error(`Expected a regular file or directory for ASCII staging: ${resolved}`);
  }

  const digest = await hashFileSha256(resolved);
  const safeName = sanitizeAsciiBasename(path.basename(resolved));
  const stagedPath = path.join(effectiveCacheDir, `${digest}-${safeName}`);

  const existing = await stat(stagedPath).catch(() => null);
  if (existing?.isFile() && existing.size === sourceInfo.size) {
    return stagedPath;
  }

  const tempPath = path.join(effectiveCacheDir, `.${safeName}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await copyFile(resolved, tempPath);
    await rename(tempPath, stagedPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    const raced = await stat(stagedPath).catch(() => null);
    if (raced?.isFile() && raced.size === sourceInfo.size) {
      return stagedPath;
    }
    throw error;
  }
  return stagedPath;
}
