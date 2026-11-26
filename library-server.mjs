#!/usr/bin/env node
// Serve the sound library page and every sample it lists from one local address, so the page can play them.
// Usage: node library-server.mjs [port]
// Uses tools/workspace-config.mjs so server.mjs and library-server.mjs share identical defaults. Listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localHost, readContained, serveDesk } from './tools/mix-desk/api.mjs';
import { createStudioAuth, serveStudio } from './tools/studio-ui/api.mjs';
import { createLogger } from './tools/logger.mjs';
import { isStrictCopyright } from './tools/provenance.mjs';
import { resolveLmmsSamplesDir, resolveSoundfontsDir, resolveWorkspaceDir } from './tools/workspace-config.mjs';

export const log = createLogger('library-server');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.md': 'text/markdown; charset=utf-8',
};
const attachmentExtensions = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);
const STATIC_SANDBOX_CSP = "sandbox; default-src 'none'";

export function mounts(env = process.env) {
  const studioLib = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'lmms-music-studio', 'libraries') : null;
  const legacyLib = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'lmms-mcp', 'libraries') : null;
  return {
    workspace: resolveWorkspaceDir(env),
    stock: isStrictCopyright(env) ? null : resolveLmmsSamplesDir(env),
    soundfonts: resolveSoundfontsDir(env),
    library: env.LMMS_SAMPLE_LIBRARIES
      ? path.resolve(env.LMMS_SAMPLE_LIBRARIES)
      : studioLib && existsSync(studioLib)
        ? studioLib
        : legacyLib && existsSync(legacyLib)
          ? legacyLib
          : null,
  };
}
// Map a request path to a file inside one of the mounted folders, or null. /_stock/ and /_lib/ are the external mounts; anything else is the workspace.
export function resolveRequest(urlPath, folders, { env = process.env } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\0:\\]/.test(decoded)
      || decoded.split('/').some(segment => segment.startsWith('.'))) return null;
  if (decoded.startsWith('/_stock/') && isStrictCopyright(env)) return null;
  const pick = decoded.startsWith('/_stock/')
    ? [folders.stock, decoded.slice(8)]
    : decoded.startsWith('/_lib/')
      ? [folders.library, decoded.slice(6)]
      : [folders.workspace, decoded.slice(1)];
  const [base, relative] = pick;
  if (!base) return null;
  const full = path.resolve(base, relative || 'sound-library.html');
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (path.basename(full).startsWith('.')) return null;
  return full;
}
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : size - Number(match[2]), end = match[1] && match[2] ? Number(match[2]) : size - 1;
  start = Math.max(0, start); end = Math.min(size - 1, end);
  return start <= end ? { start, end } : null;
}
export function startServer({ port = 18290, folders, env = process.env, logger = log, launcher, listen = true } = {}) {
  const activeFolders = folders ?? mounts(env);
  const studioAuth = createStudioAuth();
  const server = createServer(async (request, response) => {
    if (!localHost(request.headers.host)) { response.writeHead(403).end('Expected a local host'); return; }
    let urlPath;
    try { urlPath = decodeURIComponent(request.url.split('?')[0]); }
    catch { response.writeHead(400).end('Invalid URL'); return; }
    if (await serveStudio(request, response, activeFolders, { env, logger, launcher, studioAuth })) return;
    if (await serveDesk(request, response, activeFolders, { env })) return;
    const file = request.method === 'GET' || request.method === 'HEAD' ? resolveRequest(request.url, activeFolders, { env }) : null;
    const base = urlPath.startsWith('/_stock/')
      ? (isStrictCopyright(env) ? null : activeFolders.stock)
      : urlPath.startsWith('/_lib/')
        ? activeFolders.library
        : activeFolders.workspace;
    const info = file && await readContained(file, base);
    if (!info) {
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': STATIC_SANDBOX_CSP,
        'x-content-type-options': 'nosniff',
      });
      response.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': types[ext] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'content-security-policy': STATIC_SANDBOX_CSP,
      'x-content-type-options': 'nosniff',
    };
    if (attachmentExtensions.has(ext)) {
      const safeFilename = path.basename(file).replace(/["\\\r\n]/g, '_');
      headers['content-disposition'] = `attachment; filename="${safeFilename}"`;
    }
    const range = parseRange(request.headers.range, info.size);
    if (range) { headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`; headers['content-length'] = range.end - range.start + 1; response.writeHead(206, headers); }
    else { headers['content-length'] = info.size; response.writeHead(200, headers); }
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(info.path, range ?? {}).on('error', error => {
      logger.warn('Stream read error', { path: info.path, error });
      response.destroy();
    }).pipe(response);
  });
  if (listen) server.listen(port, '127.0.0.1');
  return server;
}

export const STUDIO_PORT_START = 18290;
export const STUDIO_PORT_END = 18299;

const inProcessStudioServers = new Map();
const pendingStudioStarts = new Map();
let exitHookRegistered = false;

function normalizeRealpathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ensureProcessExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const entry of inProcessStudioServers.values()) {
      try { entry.server.closeAllConnections?.(); entry.server.close(); } catch { /* ignore */ }
    }
    inProcessStudioServers.clear();
  });
}

async function probeStudioPort(port, expectedKey, timeoutMs = 300) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/studio/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 200) {
      const data = await response.json().catch(() => null);
      if (
        data?.ok === true &&
        data?.service === 'lmms-music-studio' &&
        typeof data?.workspaceRealpath === 'string' &&
        normalizeRealpathKey(data.workspaceRealpath) === expectedKey
      ) {
        return { port, status: 'matched', workspaceRealpath: data.workspaceRealpath };
      }
    }
    return { port, status: 'occupied' };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? '';
    if (code === 'ECONNREFUSED') {
      return { port, status: 'free' };
    }
    return { port, status: 'occupied' };
  }
}

function tryListenOnPort(candidatePort, folders, { env, logger, launcher }) {
  return new Promise((resolve, reject) => {
    const srv = startServer({ port: candidatePort, folders, env, logger, launcher, listen: false });
    const onError = error => {
      srv.removeListener('listening', onListening);
      try { srv.close(); } catch { /* ignore */ }
      reject(error);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      resolve(srv);
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(candidatePort, '127.0.0.1');
  });
}

export async function ensureStudioServer({
  workspaceDir,
  soundfontsDir,
  env = process.env,
  logger = log,
  portRange = [STUDIO_PORT_START, STUDIO_PORT_END],
  probeTimeoutMs = 300,
  launcher,
  bypassInProcessCache = false,
} = {}) {
  const targetWorkspace = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  await mkdir(targetWorkspace, { recursive: true });
  const workspaceRealpath = await realpath(targetWorkspace);
  const wsKey = normalizeRealpathKey(workspaceRealpath);

  if (!bypassInProcessCache) {
    const cached = inProcessStudioServers.get(wsKey);
    if (cached && cached.server.listening) {
      return {
        port: cached.port,
        baseUrl: `http://127.0.0.1:${cached.port}`,
        workspaceRealpath,
        reused: true,
        inProcess: true,
      };
    }
  }

  if (!bypassInProcessCache && pendingStudioStarts.has(wsKey)) {
    return pendingStudioStarts.get(wsKey);
  }

  const startPromise = (async () => {
    const [rangeStart, rangeEnd] = portRange;
    const ports = [];
    for (let p = rangeStart; p <= rangeEnd; p++) ports.push(p);

    const probes = await Promise.all(ports.map(p => probeStudioPort(p, wsKey, probeTimeoutMs)));
    const matched = probes.find(p => p.status === 'matched');
    if (matched) {
      logger.debug('Attached to existing Studio server', { port: matched.port, workspace: workspaceRealpath });
      return {
        port: matched.port,
        baseUrl: `http://127.0.0.1:${matched.port}`,
        workspaceRealpath,
        reused: true,
        inProcess: inProcessStudioServers.get(wsKey)?.port === matched.port,
      };
    }

    const freeCandidates = [...probes.filter(p => p.status === 'free').map(p => p.port), 0];
    const folders = {
      ...mounts(env),
      workspace: workspaceRealpath,
      ...(soundfontsDir ? { soundfonts: path.resolve(soundfontsDir) } : {}),
    };

    let boundServer = null;
    let lastError = null;
    for (const candidatePort of freeCandidates) {
      try {
        boundServer = await tryListenOnPort(candidatePort, folders, { env, logger, launcher });
        break;
      } catch (error) {
        lastError = error;
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue;
        throw error;
      }
    }
    if (!boundServer) {
      throw lastError ?? new Error('Unable to bind a local loopback port for Studio server');
    }

    boundServer.unref();
    boundServer.on('connection', socket => socket.unref());
    ensureProcessExitCleanup();
    const actualPort = boundServer.address().port;
    inProcessStudioServers.set(wsKey, {
      server: boundServer,
      port: actualPort,
      workspaceRealpath,
    });
    boundServer.once('close', () => {
      const cur = inProcessStudioServers.get(wsKey);
      if (cur?.server === boundServer) inProcessStudioServers.delete(wsKey);
    });

    logger.info('Started in-process Studio server', {
      url: `http://127.0.0.1:${actualPort}`,
      workspace: workspaceRealpath,
    });
    return {
      port: actualPort,
      baseUrl: `http://127.0.0.1:${actualPort}`,
      workspaceRealpath,
      reused: false,
      inProcess: true,
    };
  })();

  if (!bypassInProcessCache) {
    pendingStudioStarts.set(wsKey, startPromise);
  }
  try {
    return await startPromise;
  } finally {
    if (!bypassInProcessCache) {
      pendingStudioStarts.delete(wsKey);
    }
  }
}

export async function closeStudioServers() {
  const entries = [...inProcessStudioServers.values()];
  inProcessStudioServers.clear();
  await Promise.all(entries.map(({ server }) => new Promise(resolve => {
    try {
      server.closeAllConnections?.();
      server.close(() => resolve());
    } catch {
      resolve();
    }
  })));
}
function isExecutedDirectly(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1).toLowerCase() === path.resolve(fileURLToPath(metaUrl)).toLowerCase();
  }
}
if (isExecutedDirectly(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 18290), folders = mounts();
  if (!existsSync(folders.workspace)) {
    mkdirSync(folders.workspace, { recursive: true });
  }
  startServer({ port, folders });
  log.info('Sound library server listening', {
    url: `http://127.0.0.1:${port}/sound-library.html`,
    workspace: folders.workspace,
    stock: folders.stock,
    soundfonts: folders.soundfonts,
    libraries: folders.library,
  });
}
