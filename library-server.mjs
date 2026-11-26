#!/usr/bin/env node
// Serve the sound library page and every sample it lists from one local address, so the page can play them.
// Usage: node library-server.mjs [port]
// Uses tools/workspace-config.mjs so server.mjs and library-server.mjs share identical defaults. Listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localHost, readContained, serveDesk } from './tools/mix-desk/api.mjs';
import { createLogger } from './tools/logger.mjs';
import { resolveLmmsSamplesDir, resolveSoundfontsDir, resolveWorkspaceDir } from './tools/workspace-config.mjs';

export const log = createLogger('library-server');

const types = { '.html': 'text/html; charset=utf-8', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };

export function mounts(env = process.env) {
  const studioLib = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'lmms-music-studio', 'libraries') : null;
  const legacyLib = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'lmms-mcp', 'libraries') : null;
  return {
    workspace: resolveWorkspaceDir(env),
    stock: resolveLmmsSamplesDir(env),
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
export function resolveRequest(urlPath, folders) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\0:\\]/.test(decoded)
      || decoded.split('/').some(segment => segment.startsWith('.'))) return null;
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
export function startServer({ port = 18290, folders = mounts(), logger = log } = {}) {
  const server = createServer(async (request, response) => {
    if (!localHost(request.headers.host)) { response.writeHead(403).end('Expected a local host'); return; }
    let urlPath;
    try { urlPath = decodeURIComponent(request.url.split('?')[0]); }
    catch { response.writeHead(400).end('Invalid URL'); return; }
    if (await serveDesk(request, response, folders)) return;
    const file = request.method === 'GET' || request.method === 'HEAD' ? resolveRequest(request.url, folders) : null;
    const base = urlPath.startsWith('/_stock/') ? folders.stock : urlPath.startsWith('/_lib/') ? folders.library : folders.workspace;
    const info = file && await readContained(file, base);
    if (!info) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not found'); return; }
    const headers = { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    const range = parseRange(request.headers.range, info.size);
    if (range) { headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`; headers['content-length'] = range.end - range.start + 1; response.writeHead(206, headers); }
    else { headers['content-length'] = info.size; response.writeHead(200, headers); }
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(info.path, range ?? {}).on('error', error => {
      logger.warn('Stream read error', { path: info.path, error });
      response.destroy();
    }).pipe(response);
  });
  server.listen(port, '127.0.0.1');
  return server;
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
