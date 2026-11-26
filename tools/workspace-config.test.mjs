import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensureLmmsAsciiPath,
  hasNonAscii,
  lmmsDataCandidates,
  lmmsDataDirectory,
  renderTimeoutMs,
  resolveAsciiCacheDir,
  resolveFfmpegExecutable,
  resolveLmmsDataDir,
  resolveLmmsExecutable,
  resolveSoundfontsDir,
  resolveWorkspaceDir,
  sanitizeAsciiBasename,
} from './workspace-config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(repoRoot, '.test-scratch');

async function makeScratch(t, prefix) {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveWorkspaceDir uses LMMS_WORKSPACE or defaults to ~/Music/LMMS Music Studio', () => {
  assert.equal(
    resolveWorkspaceDir({}, { homedir: 'C:\\Users\\studio' }),
    path.resolve('C:\\Users\\studio', 'Music', 'LMMS Music Studio'),
  );
  assert.equal(
    resolveWorkspaceDir({ LMMS_WORKSPACE: '  F:\\audio-work  ' }, { homedir: 'C:\\Users\\studio' }),
    path.resolve('F:\\audio-work'),
  );
});

test('resolveSoundfontsDir uses LMMS_SOUNDFONTS or LOCALAPPDATA/lmms-music-studio/soundfonts', () => {
  assert.equal(
    resolveSoundfontsDir({ LOCALAPPDATA: 'C:\\Users\\studio\\AppData\\Local' }, { homedir: 'C:\\Users\\studio' }),
    path.resolve('C:\\Users\\studio\\AppData\\Local', 'lmms-music-studio', 'soundfonts'),
  );
  assert.equal(
    resolveSoundfontsDir({}, { homedir: 'C:\\Users\\studio' }),
    path.resolve('C:\\Users\\studio', 'AppData', 'Local', 'lmms-music-studio', 'soundfonts'),
  );
  assert.equal(
    resolveSoundfontsDir({ LMMS_SOUNDFONTS: 'F:\\soundfonts' }),
    path.resolve('F:\\soundfonts'),
  );
});

test('resolveLmmsExecutable and resolveFfmpegExecutable respect env overrides and platform defaults', () => {
  assert.equal(resolveLmmsExecutable({}, { platform: 'win32' }), 'C:\\Program Files\\LMMS\\lmms.exe');
  assert.equal(resolveLmmsExecutable({}, { platform: 'linux' }), 'lmms');
  assert.equal(resolveLmmsExecutable({ LMMS_EXECUTABLE: 'D:\\LMMS\\lmms.exe' }, { platform: 'win32' }), 'D:\\LMMS\\lmms.exe');
  assert.equal(resolveFfmpegExecutable({}), 'ffmpeg');
  assert.equal(resolveFfmpegExecutable({ LMMS_FFMPEG: 'C:\\ffmpeg\\bin\\ffmpeg.exe' }), 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  assert.equal(resolveAsciiCacheDir({}, { platform: 'win32' }), 'C:\\Users\\Public\\lmms-music-studio-cache');
});

test('Linux and Windows LMMS data directories are discovered beside executable or in share/lmms', () => {
  const candidates = lmmsDataCandidates('/opt/lmms/bin/lmms', { platform: 'linux' });
  assert.deepEqual(candidates, ['/opt/lmms/bin/data', '/opt/lmms/share/lmms', '/usr/share/lmms', '/usr/local/share/lmms']);
  assert.equal(resolveLmmsDataDir('/opt/lmms/bin/lmms', { platform: 'linux', exists: p => p === '/opt/lmms/share/lmms' }), '/opt/lmms/share/lmms');
  assert.equal(lmmsDataDirectory('/usr/bin/lmms', { platform: 'linux', exists: p => p === '/usr/share/lmms' }), '/usr/share/lmms');
  assert.equal(lmmsDataDirectory('/opt/lmms/bin/lmms', { platform: 'linux', exists: () => true }), '/opt/lmms/bin/data');
  assert.equal(lmmsDataDirectory('/nowhere/bin/lmms', { platform: 'linux', exists: () => false }), '/nowhere/bin/data');
  assert.equal(lmmsDataDirectory('C:/Program Files/LMMS/lmms.exe', { platform: 'win32', exists: () => false }), 'C:\\Program Files\\LMMS\\data');
  const existsOnPath = p => p === '/usr/bin/lmms' || p === '/usr/share/lmms';
  assert.equal(lmmsDataDirectory('lmms', { platform: 'linux', pathEnv: '/bin:/usr/bin', exists: existsOnPath }), '/usr/share/lmms');
});

test('renderTimeoutMs grows with tracks and length, never drops below 590 s, and accepts env overrides', () => {
  assert.equal(renderTimeoutMs(1, 30, {}), 590000);
  assert.ok(renderTimeoutMs(8, 240, {}) > renderTimeoutMs(4, 240, {}));
  assert.ok(renderTimeoutMs(8, 600, {}) <= 3600000);
  assert.equal(renderTimeoutMs(8, 240, { LMMS_RENDER_TIMEOUT_SECONDS: '900' }), 900000);
  assert.equal(renderTimeoutMs(1, 30, { LMMS_RENDER_TIMEOUT_SECONDS: 'invalid' }), 590000);
});

test('ensureLmmsAsciiPath returns ASCII paths unchanged and leaves non-Windows paths untouched', async t => {
  const dir = await makeScratch(t, 'ascii-plain-');
  const asciiFile = path.join(dir, 'FluidR3_GM.sf2');
  await writeFile(asciiFile, 'RIFF-SF2');
  assert.equal(await ensureLmmsAsciiPath(asciiFile, { platform: 'win32' }), path.resolve(asciiFile));

  const unicodePath = path.join(dir, 'piano-\u00e9tude.sf2');
  assert.equal(await ensureLmmsAsciiPath(unicodePath, { platform: 'linux' }), path.resolve(unicodePath));
});

test('ensureLmmsAsciiPath uses Windows 8.3 short path when available and ASCII', async t => {
  const dir = await makeScratch(t, 'ascii-short-');
  const unicodeDir = path.join(dir, 'dossier-\u00e9t\u00e9');
  const cacheDir = path.join(dir, 'cache');
  const fakeShort = path.join(dir, 'DOSSIE~1.SF2');
  await mkdir(unicodeDir, { recursive: true });
  const sourceFile = path.join(unicodeDir, 'pi\u00e8ce.sf2');
  await writeFile(sourceFile, 'sf2-payload');
  await writeFile(fakeShort, 'sf2-payload');

  const resolved = await ensureLmmsAsciiPath(sourceFile, {
    platform: 'win32',
    cacheDir,
    shortPathResolver: () => fakeShort,
  });
  assert.equal(resolved, fakeShort);
  assert.equal(hasNonAscii(resolved), false);
});

test('ensureLmmsAsciiPath stages file into SHA-256 + sanitized ASCII cache when 8.3 short path is unavailable or non-ASCII', async t => {
  const dir = await makeScratch(t, 'ascii-stage-');
  const unicodeDir = path.join(dir, 'biblioth\u00e8que-\u97f3\u697d');
  const cacheDir = path.join(dir, 'ascii-cache');
  await mkdir(unicodeDir, { recursive: true });

  const payload = Buffer.from('SoundFont-binary-payload-1234567890');
  const expectedSha = createHash('sha256').update(payload).digest('hex');
  const sourceFile = path.join(unicodeDir, 'Grand Piano \u00c9t\u00e9 \u97f3.sf2');
  await writeFile(sourceFile, payload);

  // Simulate NTFS volume with 8dot3name disabled (short-path lookup still returns non-ASCII path).
  const stagedFirst = await ensureLmmsAsciiPath(sourceFile, {
    platform: 'win32',
    cacheDir,
    shortPathResolver: input => input,
  });

  assert.equal(hasNonAscii(stagedFirst), false);
  assert.ok(stagedFirst.startsWith(cacheDir + path.sep));
  assert.ok(path.basename(stagedFirst).startsWith(expectedSha + '-'));
  assert.ok(stagedFirst.endsWith('.sf2'));
  assert.deepEqual(await readFile(stagedFirst), payload);

  // Second call reuses the cached file deterministically.
  const stagedSecond = await ensureLmmsAsciiPath(sourceFile, {
    platform: 'win32',
    cacheDir,
    shortPathResolver: () => null,
  });
  assert.equal(stagedSecond, stagedFirst);

  // Real default Windows shortPathResolver path (either 8.3 ASCII or cache fallback, always pure ASCII & readable).
  if (process.platform === 'win32') {
    const realResolved = await ensureLmmsAsciiPath(sourceFile, { cacheDir });
    assert.equal(hasNonAscii(realResolved), false);
    assert.deepEqual(await readFile(realResolved), payload);
  }
});

test('sanitizeAsciiBasename strips non-ASCII characters and preserves valid extensions', () => {
  assert.equal(sanitizeAsciiBasename('Grand Piano \u00c9t\u00e9 \u97f3.sf2'), 'Grand_Piano_t.sf2');
  assert.equal(sanitizeAsciiBasename('\u97f3\u697d\u306e\u307f.wav'), 'asset.wav');
});

test('ensureLmmsAsciiPath rejects non-ASCII fallback cache directories', async t => {
  const dir = await makeScratch(t, 'ascii-badcache-');
  const unicodeDir = path.join(dir, 'source-\u00e9');
  const badCache = path.join(dir, 'cache-\u00fc');
  await mkdir(unicodeDir, { recursive: true });
  const sourceFile = path.join(unicodeDir, 'tone.wav');
  await writeFile(sourceFile, 'wav');

  await assert.rejects(
    ensureLmmsAsciiPath(sourceFile, {
      platform: 'win32',
      cacheDir: badCache,
      shortPathResolver: () => null,
    }),
    /ASCII fallback cache path itself contains non-ASCII/,
  );
});

test('default workspace path matches os.homedir Music/LMMS Music Studio', () => {
  assert.equal(resolveWorkspaceDir({}), path.join(os.homedir(), 'Music', 'LMMS Music Studio'));
});
