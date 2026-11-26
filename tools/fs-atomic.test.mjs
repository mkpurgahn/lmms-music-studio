import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommandSafe, writeFileAtomic } from './fs-atomic.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(repoRoot, '.test-scratch');

async function makeScratch(t, prefix) {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('writeFileAtomic writes atomically, cleans temp files, and enforces overwrite: false', async t => {
  const dir = await makeScratch(t, 'atomic-write-');
  const target = path.join(dir, 'project.mmp');

  await writeFileAtomic(target, '<lmms-project/>', { overwrite: false });
  assert.equal(await readFile(target, 'utf8'), '<lmms-project/>');
  assert.deepEqual(await readdir(dir), ['project.mmp']);

  await assert.rejects(
    writeFileAtomic(target, '<overwritten/>', { overwrite: false }),
    error => error.code === 'EEXIST',
  );
  assert.equal(await readFile(target, 'utf8'), '<lmms-project/>');
  assert.deepEqual(await readdir(dir), ['project.mmp']);

  await writeFileAtomic(target, Buffer.from('<updated/>'), { overwrite: true });
  assert.equal(await readFile(target, 'utf8'), '<updated/>');
  assert.deepEqual(await readdir(dir), ['project.mmp']);
});

test('runCommandSafe collects stdout/stderr, reports ENOENT, and terminates full process trees on timeout without leaking locked files', async t => {
  const ok = await runCommandSafe(process.execPath, ['-e', 'process.stdout.write("hello"); process.stderr.write("diag");'], {
    timeoutMs: 10000,
  });
  assert.equal(ok.stdout, 'hello');
  assert.equal(ok.stderr, 'diag');
  assert.equal(ok.exitCode, 0);

  await assert.rejects(
    runCommandSafe('nonexistent-binary-lmms-studio-xyz', ['--version'], { timeoutMs: 5000 }),
    error => error.code === 'ENOENT',
  );

  const dir = await makeScratch(t, 'tree-kill-');
  const lockedWav = path.join(dir, 'locked.wav');
  const readyFile = path.join(dir, 'ready.txt');
  const childScript = path.join(dir, 'grandchild.mjs');
  const parentScript = path.join(dir, 'parent.mjs');

  await writeFile(
    childScript,
    [
      'import { openSync, writeFileSync } from "node:fs";',
      'const fd = openSync(process.argv[2], "w");',
      'writeFileSync(process.argv[3], String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  await writeFile(
    parentScript,
    [
      'import { spawn } from "node:child_process";',
      'spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore", windowsHide: true });',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );

  await assert.rejects(
    runCommandSafe(process.execPath, [parentScript, childScript, lockedWav, readyFile], { timeoutMs: 700 }),
    error => error.timedOut === true && error.killed === true,
  );

  // Prove the grandchild holding locked.wav was terminated with the process tree so unlink succeeds immediately.
  await unlink(lockedWav);
});
