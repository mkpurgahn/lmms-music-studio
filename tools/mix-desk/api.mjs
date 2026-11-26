import { readFile, realpath, lstat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeWav } from '../../audio.mjs';
import { scanWorkspace, applyMeta, facets, validateMeta, metaText, sidecarFor } from '../sound-meta.mjs';
import { sampleItems, classifyWorkspace } from '../library-browser.mjs';
import { writeFileAtomic } from '../fs-atomic.mjs';
import { isStrictCopyright, provenancePathFor, sha256Buffer, writeProvenanceSidecar } from '../provenance.mjs';
import { idPattern, normalizeSession, samplePath } from './state.mjs';

const assets = new Map(Object.entries({
  '/mix-desk/': ['index.html', 'text/html; charset=utf-8'],
  '/mix-desk/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/mix-desk/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/mix-desk/engine.mjs': ['engine.mjs', 'text/javascript; charset=utf-8'],
  '/mix-desk/processor.mjs': ['processor.mjs', 'text/javascript; charset=utf-8'],
  '/mix-desk/state.mjs': ['state.mjs', 'text/javascript; charset=utf-8'],
  '/mix-desk/live.mjs': ['live.mjs', 'text/javascript; charset=utf-8'],
}));
const ASSET_ROOT = new URL('./', import.meta.url);
const audio = /\.(?:wav|ogg|flac|mp3)$/i;
const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_JSON = 256 * 1024;
const encode = text => text.split('/').map(encodeURIComponent).join('/');

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function json(response, code, value) {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request, limit) {
  const chunks = [];
  let count = 0;
  for await (const chunk of request) {
    count += chunk.length;
    if (count > limit) throw fail('Request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, count);
}

export function localHost(host) {
  return /^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/i.test(host ?? '');
}

export async function readContained(file, base) {
  if (!file || !base) return null;
  try {
    const rawStat = await lstat(file);
    if (rawStat.isSymbolicLink() || !rawStat.isFile()) return null;
    const [actual, root] = await Promise.all([realpath(file), realpath(base)]);
    const relative = path.relative(root, actual);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    if (parts.some(part => !part || part.startsWith('.'))) return null;
    let cursor = root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      const stepInfo = await lstat(cursor);
      if (stepInfo.isSymbolicLink()) return null;
    }
    const info = await lstat(actual);
    return info.isFile() ? { path: actual, size: info.size } : null;
  } catch {
    return null;
  }
}

async function catalogue(folders, env = process.env) {
  const strict = isStrictCopyright(env);
  const sources = [
    ['workspace', '', folders.workspace],
    ...(strict ? [] : [['stock', '/_stock', folders.stock]]),
    ['library', '/_lib', folders.library],
  ];
  const rows = [];
  for (const [source, prefix, folder] of sources) {
    if (!folder) continue;
    for (const group of await scanWorkspace(folder)) {
      let meta = {};
      if (group.sidecar) {
        const file = await readContained(path.join(folder, group.sidecar), folder);
        if (file && file.size <= MAX_JSON) {
          try { meta = validateMeta(JSON.parse(await readFile(file.path, 'utf8'))).meta; } catch { /* Let the untagged media show. */ }
        }
      }
      for (const relative of group.files.filter(file => audio.test(file))) {
        const url = prefix + '/' + encode(relative);
        if (!samplePath(url) || !await readContained(path.join(folder, relative), folder)) continue;
        const [entry] = sampleItems([{ relative }], { type: source === 'workspace' ? classifyWorkspace(relative) : 'sample', source, url: () => url });
        applyMeta(entry, { meta, sidecar: group.sidecar });
        rows.push({ url, name: entry.n, source, role: entry.r, tags: entry.g, facets: entry.z ?? {} });
      }
    }
  }
  return { rows, facets };
}

function sessionFile(workspace, id) {
  if (!idPattern.test(id ?? '')) throw fail('Use a session name with letters, digits, underscores or hyphens.');
  return path.join(workspace, `desk-${id}.json`);
}
async function saveTake(request, url, workspace) {
  const name = url.searchParams.get('name');
  const kind = url.searchParams.get('kind');
  if (!idPattern.test(name ?? '') || !['take', 'mix'].includes(kind)) throw fail('Expected a valid recording name and take or mix kind.');
  if (request.headers['content-type']?.split(';')[0] !== 'audio/wav') throw fail('Expected audio/wav.', 415);
  const raw = await body(request, MAX_UPLOAD);
  let parsed;
  try { parsed = decodeWav(raw); } catch { throw fail('The take is not valid PCM WAV.'); }
  if (!parsed.frames || !Number.isFinite(parsed.sampleRate) || parsed.sampleRate < 8000 || parsed.sampleRate > 192000) throw fail('Invalid WAV channel or sample rate.');
  const tags = (url.searchParams.get('tags') ?? '').split(',').map(tag => tag.trim()).filter(Boolean);
  const { meta, errors } = validateMeta({ title: name, kind, licence: 'own-recording', tags,
    durationSeconds: parsed.frames / parsed.sampleRate, date: new Date().toISOString().slice(0, 10) });
  if (errors.length) throw fail(errors.join(' '));
  const filename = path.join(workspace, name + '.wav');
  const sidecar = path.join(workspace, sidecarFor(name + '.wav'));
  const provSidecar = provenancePathFor(filename);
  await writeFileAtomic(filename, raw, { overwrite: false });
  try {
    await writeFileAtomic(sidecar, metaText(meta), { overwrite: false });
    if (kind === 'take') {
      const digest = sha256Buffer(raw);
      await writeProvenanceSidecar(filename, {
        workspaceDir: workspace,
        classification: 'user-attested-mic-take',
        generatorTool: 'mix-desk/saveTake',
        sources: [{
          kind: 'user-attested-mic-take',
          pluginOrLibrary: 'mix-desk-microphone',
          sha256: digest,
          licence: 'user-attested-own-recording',
        }],
      });
    }
  } catch (error) {
    await Promise.allSettled([
      rm(filename, { force: true }),
      rm(sidecar, { force: true }),
      ...(kind === 'take' ? [rm(provSidecar, { force: true })] : []),
    ]);
    throw error;
  }
  return {
    url: '/' + encode(name + '.wav'),
    sidecar: path.basename(sidecar),
    ...(kind === 'take' ? { provenance: path.basename(provSidecar) } : {}),
    name,
    kind,
  };
}

export async function serveDesk(request, response, folders, { env = process.env } = {}) {
  let url;
  try { url = new URL(request.url, 'http://127.0.0.1'); }
  catch { json(response, 400, { error: 'Invalid request URL.' }); return true; }
  const pathname = url.pathname;
  if (!pathname.startsWith('/mix-desk') && !pathname.startsWith('/api/mix-desk/')) return false;
  try {
    if (pathname === '/mix-desk' && request.method === 'GET') {
      response.writeHead(302, { location: '/mix-desk/' }).end();
      return true;
    }
    if (assets.has(pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const [file, type] = assets.get(pathname);
      const bytes = await readFile(new URL(file, ASSET_ROOT));
      response.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return true;
    }
    if (request.method === 'POST' && request.headers.origin !== `http://${request.headers.host}`) throw fail('Expected a same-origin request from the local desk.', 403);
    if (pathname === '/api/mix-desk/library' && request.method === 'GET') json(response, 200, await catalogue(folders, env));
    else if (pathname === '/api/mix-desk/sessions' && request.method === 'GET') {
      const listing = await readdir(folders.workspace, { withFileTypes: true });
      json(response, 200, listing.filter(entry => entry.isFile() && /^desk-[a-z0-9_-]+\.json$/i.test(entry.name))
        .map(entry => entry.name.slice(5, -5)).sort());
    } else if (pathname === '/api/mix-desk/session' && ['GET','POST'].includes(request.method)) {
      const file = sessionFile(folders.workspace, url.searchParams.get('name'));
      if (request.method === 'GET') {
        const match = await readContained(file, folders.workspace);
        if (!match || match.size > MAX_JSON) throw fail('Session is unavailable.', 404);
        json(response, 200, normalizeSession(JSON.parse(await readFile(match.path, 'utf8'))));
      } else {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail('Expected application/json.', 415);
        const input = normalizeSession(JSON.parse(await body(request, MAX_JSON)));
        await writeFileAtomic(file, JSON.stringify(input, null, 2) + '\n', { overwrite: false });
        json(response, 201, { name: url.searchParams.get('name') });
      }
    } else if (pathname === '/api/mix-desk/take' && request.method === 'POST') json(response, 201, await saveTake(request, url, folders.workspace));
    else throw fail('Not found.', 404);
  } catch (error) {
    json(response, error.status ?? (error.code === 'EEXIST' ? 409 : error.code ? 500 : 400),
      { error: error.code === 'EEXIST' ? 'That name already exists. Choose another.' : error.code ? 'Could not access the local workspace.' : error.message });
  }
  return true;
}
