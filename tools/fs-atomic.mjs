// Atomic file writes and safe child-process execution with full Windows process-tree cleanup.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resolveWriteOptions(options) {
  if (typeof options === 'string') return { encoding: options, mode: undefined, overwrite: true };
  const flag = options?.flag;
  const exclusive = flag === 'wx' || flag === 'xw' || options?.overwrite === false;
  return {
    encoding: options?.encoding ?? 'utf8',
    mode: options?.mode,
    overwrite: !exclusive,
  };
}

async function assertNotExists(targetPath) {
  const existing = await lstat(targetPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    throw Object.assign(new Error(`EEXIST: file already exists, open '${targetPath}'`), {
      code: 'EEXIST',
      syscall: 'open',
      path: targetPath,
    });
  }
}

export async function writeFileAtomic(targetPath, bufferOrString, options = {}) {
  const resolved = path.resolve(targetPath);
  const { encoding, mode, overwrite } = resolveWriteOptions(options);
  if (!overwrite) await assertNotExists(resolved);

  const directory = path.dirname(resolved);
  const base = path.basename(resolved);
  const tempPath = path.join(directory, `.${base}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);

  let handle;
  try {
    handle = await open(tempPath, 'wx', mode);
    if (Buffer.isBuffer(bufferOrString) || bufferOrString instanceof Uint8Array) {
      await handle.writeFile(bufferOrString);
    } else {
      await handle.writeFile(String(bufferOrString), encoding);
    }
    await handle.close();
    handle = null;

    if (!overwrite) await assertNotExists(resolved);

    const maxAttempts = process.platform === 'win32' ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await rename(tempPath, resolved);
        break;
      } catch (error) {
        const transientWinLock = process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES');
        if (!transientWinLock || attempt === maxAttempts) throw error;
        await sleep(15 * attempt);
        if (!overwrite) await assertNotExists(resolved);
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function killProcessTreeByPid(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === 'win32') {
    return new Promise(resolve => {
      let killer;
      try {
        killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        resolve();
        return;
      }
      const fallbackTimer = setTimeout(() => resolve(), 3000);
      fallbackTimer.unref?.();
      killer.on('error', () => { clearTimeout(fallbackTimer); resolve(); });
      killer.on('close', () => { clearTimeout(fallbackTimer); resolve(); });
    });
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
  return Promise.resolve();
}

export async function runCommandSafe(exe, args = [], {
  timeoutMs = 120000,
  env = process.env,
  cwd,
  maxBuffer = 64 * 1024 * 1024,
  encoding = 'utf8',
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let maxBufferExceeded = false;
    let spawnError = null;
    let settled = false;
    let timer = null;

    const decode = (chunks, totalBytes) => {
      const buf = Buffer.concat(chunks, totalBytes);
      return encoding ? buf.toString(encoding) : buf;
    };

    const terminateTree = async () => {
      if (child.pid) {
        await killProcessTreeByPid(child.pid);
      }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        void terminateTree();
      }, timeoutMs);
    }

    child.stdout?.on('data', chunk => {
      if (maxBufferExceeded) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        maxBufferExceeded = true;
        void terminateTree();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', chunk => {
      if (maxBufferExceeded) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        maxBufferExceeded = true;
        void terminateTree();
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', error => {
      spawnError = error;
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const stdout = decode(stdoutChunks, stdoutBytes);
      const stderr = decode(stderrChunks, stderrBytes);

      if (spawnError) {
        reject(Object.assign(spawnError, { stdout, stderr, killed: timedOut, timedOut }));
        return;
      }
      if (maxBufferExceeded) {
        reject(Object.assign(new Error(`Command output exceeded maxBuffer (${maxBuffer} bytes)`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
          killed: true,
          timedOut: false,
        }));
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`Command timed out after ${timeoutMs} ms: ${exe}`), {
          code: 'ETIMEDOUT',
          exitCode,
          signal,
          killed: true,
          timedOut: true,
          stdout,
          stderr,
        }));
        return;
      }
      if (exitCode !== 0) {
        const detail = (typeof stderr === 'string' ? stderr : '').trim().split(/\r?\n/).filter(Boolean).at(-1);
        reject(Object.assign(new Error(`Command failed with exit code ${exitCode}${detail ? ': ' + detail : ''}`), {
          code: exitCode,
          exitCode,
          signal,
          killed: Boolean(signal),
          timedOut: false,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}
