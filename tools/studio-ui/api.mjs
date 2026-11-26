// Hardened dynamic /studio/* UI routes and /api/studio/* bridge endpoints.
// Enforces host check, exact loopback Origin match, HttpOnly SameSite=Strict cookie + X-Studio-Token
// double-submit capability check, strict script-src 'self' CSP with zero inline scripts, and realpath containment.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { localHost } from '../mix-desk/api.mjs';
import { writeFileAtomic } from '../fs-atomic.mjs';
import { createLogger } from '../logger.mjs';
import { parseFeedback } from '../audition.mjs';
import { openInLmms } from '../lmms-sync.mjs';

const defaultLog = createLogger('studio-ui');

export const STUDIO_DESCRIPTOR_SCHEMA = 'lmms-music-studio/studio-descriptor';
export const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'";

const ASSET_ROOT = new URL('./', import.meta.url);
const STATIC_ASSETS = new Map([
  ['/studio/timeline.js', ['timeline.js', 'text/javascript; charset=utf-8']],
  ['/studio/audition.js', ['audition.js', 'text/javascript; charset=utf-8']],
  ['/studio/studio.css', ['studio.css', 'text/css; charset=utf-8']],
]);

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookieHeader(header) {
  const cookies = {};
  if (typeof header !== 'string' || !header.trim()) return cookies;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in cookies)) cookies[key] = val;
  }
  return cookies;
}

export function createStudioAuth() {
  const studioToken = randomBytes(32).toString('hex');
  const cookieSecret = randomBytes(32).toString('hex');
  const cookieValue = createHmac('sha256', cookieSecret)
    .update(`studio_auth_v1:${studioToken}`)
    .digest('hex');
  return Object.freeze({
    studioToken,
    cookieSecret,
    cookieValue,
    setCookieHeader: `studio_auth=${cookieValue}; HttpOnly; SameSite=Strict; Path=/api/studio`,
  });
}

function sendJson(response, code, payload) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readBodyLimited(request, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw fail('Request body exceeds 256 KiB limit.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function isSafeWorkspaceUrl(urlValue) {
  if (typeof urlValue !== 'string' || !urlValue.trim()) return false;
  if (/[\0\\]/.test(urlValue) || /^https?:\/\//i.test(urlValue) || urlValue.startsWith('//')) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(urlValue.split('?')[0]);
  } catch {
    return false;
  }
  const clean = decoded.replace(/^\/+/, '');
  if (!clean) return false;
  const parts = clean.split('/');
  return !parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'));
}

export async function readContainedStrict(relativePath, workspaceDir) {
  if (!relativePath || !workspaceDir || typeof relativePath !== 'string') {
    return { status: 400, file: null };
  }
  if (/[\0]/.test(relativePath)) return { status: 400, file: null };

  let rootReal;
  try {
    rootReal = await realpath(path.resolve(workspaceDir));
  } catch {
    return { status: 404, file: null };
  }

  const normalizedRel = relativePath.replace(/^[\\/]+/, '');
  const candidate = path.resolve(rootReal, normalizedRel);
  const rel = path.relative(rootReal, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { status: 400, file: null };
  }
  const segments = rel.split(path.sep);
  if (segments.some(seg => !seg || seg.startsWith('.'))) {
    return { status: 403, file: null };
  }

  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 404, file: null };
      return { status: 403, file: null };
    }
    if (info.isSymbolicLink()) {
      return { status: 403, file: null };
    }
    if (i === segments.length - 1 && !info.isFile()) {
      return { status: 404, file: null };
    }
    if (i < segments.length - 1 && !info.isDirectory()) {
      return { status: 404, file: null };
    }
  }

  let targetReal;
  try {
    targetReal = await realpath(current);
  } catch {
    return { status: 404, file: null };
  }
  const realRel = path.relative(rootReal, targetReal);
  if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
    return { status: 403, file: null };
  }
  if (realRel.split(path.sep).some(seg => seg.startsWith('.'))) {
    return { status: 403, file: null };
  }

  const finalStat = await lstat(targetReal);
  if (!finalStat.isFile()) return { status: 404, file: null };
  return {
    status: 200,
    file: {
      path: targetReal,
      size: finalStat.size,
      rootReal,
    },
  };
}

function validateTimelineDescriptor(raw, expectedSession) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('Timeline descriptor must be a JSON object.', 400);
  }
  if (raw.schema !== STUDIO_DESCRIPTOR_SCHEMA || raw.kind !== 'timeline') {
    throw fail('Invalid timeline studio descriptor schema.', 400);
  }
  if (typeof raw.bpm !== 'number' || !Number.isFinite(raw.bpm) || raw.bpm <= 0) {
    throw fail('Timeline descriptor requires a positive static bpm.', 400);
  }
  if (typeof raw.seconds !== 'number' || !Number.isFinite(raw.seconds) || raw.seconds <= 0) {
    throw fail('Timeline descriptor requires positive seconds.', 400);
  }
  if (raw.projectFile !== null && raw.projectFile !== undefined && !PROJECT_NAME_PATTERN.test(String(raw.projectFile))) {
    throw fail('Timeline descriptor has an invalid projectFile.', 400);
  }
  if (raw.mix && !isSafeWorkspaceUrl(raw.mix.url)) {
    throw fail('Timeline descriptor mix URL is invalid.', 400);
  }
  const lanes = Array.isArray(raw.lanes) ? raw.lanes : [];
  for (const lane of lanes) {
    if (!lane || typeof lane.name !== 'string' || !isSafeWorkspaceUrl(lane.url)) {
      throw fail('Timeline descriptor contains an invalid stem lane.', 400);
    }
  }
  return {
    ...raw,
    session: expectedSession,
    title: String(raw.title || expectedSession).slice(0, 120),
    timeSignature: Array.isArray(raw.timeSignature) && raw.timeSignature.length === 2 ? raw.timeSignature : [4, 4],
    lanes,
    sections: Array.isArray(raw.sections) ? raw.sections : [],
    effects: Array.isArray(raw.effects) ? raw.effects : [],
    feedbackName: `${expectedSession}-feedback.json`,
  };
}

function validateAuditionDescriptor(raw, expectedSession) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('Audition descriptor must be a JSON object.', 400);
  }
  if (raw.schema !== STUDIO_DESCRIPTOR_SCHEMA || raw.studioKind !== 'audition') {
    throw fail('Invalid audition studio descriptor schema.', 400);
  }
  if (!['game', 'compare'].includes(raw.kind)) {
    throw fail('Audition descriptor requires kind "game" or "compare".', 400);
  }
  if (raw.projectFile !== null && raw.projectFile !== undefined && !PROJECT_NAME_PATTERN.test(String(raw.projectFile))) {
    throw fail('Audition descriptor has an invalid projectFile.', 400);
  }
  const urlsToCheck = [
    raw.intro?.src,
    raw.loop?.src,
    ...(Array.isArray(raw.layers) ? raw.layers.map(l => l?.src) : []),
    ...(Array.isArray(raw.stingers) ? raw.stingers.map(s => s?.src) : []),
    ...(Array.isArray(raw.compare) ? raw.compare.map(c => c?.src) : []),
    ...(raw.spectrogram ? [raw.spectrogram] : []),
  ].filter(Boolean);
  for (const u of urlsToCheck) {
    if (!isSafeWorkspaceUrl(u)) {
      throw fail(`Audition descriptor contains unsafe asset URL: ${u}`, 400);
    }
  }
  return {
    ...raw,
    session: expectedSession,
    title: String(raw.title || expectedSession).slice(0, 120),
    layers: Array.isArray(raw.layers) ? raw.layers : [],
    stingers: Array.isArray(raw.stingers) ? raw.stingers : [],
    compare: Array.isArray(raw.compare) ? raw.compare : [],
    sections: Array.isArray(raw.sections) ? raw.sections : [],
    feedbackName: `${expectedSession}-feedback.json`,
  };
}

export function renderStudioTimelineHtml(descriptor, { studioToken, session }) {
  const safeTitle = escapeHtml(descriptor.title);
  const safeToken = escapeHtml(studioToken);
  const safeSession = escapeHtml(session);
  const safeConfig = escapeHtml(JSON.stringify(descriptor));
  const initialModeText = descriptor.lanes?.length
    ? 'Stems (isolated pre-master tracks)'
    : 'Master Mix (authoritative post-master output)';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="/studio/studio.css" />
</head>
<body data-studio-token="${safeToken}" data-studio-session="${safeSession}" data-studio-kind="timeline">
<div id="studio-app" data-studio-config="${safeConfig}">
<header class="studio-header">
<h1>${safeTitle}</h1>
<div class="row">
<button id="play" type="button" title="Play or pause (Space)">Play</button>
<button id="start" type="button" title="Jump back to Bar 1">Start</button>
<span class="clock" id="clock">Bar 1 | Beat 1 | 0:00.0</span>
<button id="mode" type="button" title="Toggle between isolated stems and master mix">Switch to Master Mix</button>
<span class="mode-badge" id="mode-banner">${escapeHtml(initialModeText)}</span>
<select id="loop" title="Loop a single section"><option value="">Loop: off</option></select>
<button id="unsolo" type="button">Clear mute and solo</button>
<button id="open-lmms" type="button">Open in LMMS</button>
</div>
<div class="row" style="margin-top:6px">
<span class="hint" id="status">Loading WebAudio stems...</span>
</div>
</header>
<div class="wrap"><div id="head"></div><div class="board" id="board"></div></div>
<section class="notes-panel">
<h2>Notes for the next version</h2>
<textarea id="notetext" placeholder="What needs changing at this bar? Press Add note here (or N) to pin it with current mute/solo state."></textarea>
<div class="row" style="margin-top:8px">
<button id="note" class="primary" type="button" title="Pin a note to the bar under the playhead (N)">Add note here</button>
<select id="noterating">
<option value="">No rating</option>
<option value="1">1 poor</option>
<option value="2">2</option>
<option value="3">3</option>
<option value="4">4</option>
<option value="5">5 great</option>
</select>
<button id="send-feedback" class="primary" type="button">Send Feedback to Studio</button>
<button id="save" type="button">Save feedback</button>
<button id="copy" type="button">Copy notes</button>
<span class="hint" id="feedback-status"></span>
</div>
<ul id="notes"></ul>
</section>
</div>
<script src="/studio/timeline.js"></script>
</body>
</html>
`;
}

export function renderStudioAuditionHtml(descriptor, { studioToken, session }) {
  const safeTitle = escapeHtml(descriptor.title);
  const safeToken = escapeHtml(studioToken);
  const safeSession = escapeHtml(session);
  const safeConfig = escapeHtml(JSON.stringify(descriptor));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="/studio/studio.css" />
</head>
<body data-studio-token="${safeToken}" data-studio-session="${safeSession}" data-studio-kind="audition">
<div id="studio-app" data-studio-config="${safeConfig}">
<main class="audition-main">
<div class="row" style="justify-content:space-between">
<div>
<h1 id="title">${safeTitle}</h1>
<p class="sub" id="subtitle"></p>
</div>
<button type="button" id="open-lmms">Open in LMMS</button>
</div>
<section class="panel" id="loader">
<p class="status" id="status">Loading audio...</p>
<div id="picker" class="hidden">
<p class="sub">Choose the folder that holds this export or select the audio files directly.</p>
<div class="row">
<label><button type="button" id="pickfolder">Choose folder</button></label>
<input type="file" id="folderinput" class="hidden" multiple="multiple" webkitdirectory="webkitdirectory" />
<button type="button" id="pickfiles">Choose files</button>
<input type="file" id="filesinput" class="hidden" multiple="multiple" accept="audio/*" />
</div>
</div>
</section>
<section class="panel">
<div class="row">
<button type="button" id="play" class="primary" disabled="disabled">Play</button>
<button type="button" id="restart" disabled="disabled">From start</button>
<span class="clock" id="clock">0:00.000</span>
<span class="pos" id="pos"></span>
<span class="sectionname" id="secname"></span>
</div>
<div class="bar" id="timeline"><div class="fill" id="fill"></div><div class="head" id="head"></div></div>
<div class="row">
<span class="status">Master</span>
<input type="range" id="master" min="-30" max="6" step="0.5" value="0" />
<span class="db" id="masterdb">0.0 dB</span>
<span class="status"><span class="kbd">Space</span> play or pause, <span class="kbd">N</span> new note</span>
</div>
</section>
<section class="panel hidden" id="comparepanel">
<h2>Compare</h2>
<div class="row" id="comparebuttons"></div>
<p class="status" id="compareinfo"></p>
</section>
<section class="panel hidden" id="layerpanel">
<h2>Layers</h2>
<div class="row" style="margin-bottom:6px">
<button type="button" id="modemix">Full mix</button>
<button type="button" id="modelayers">Layers</button>
<span class="mode-badge" id="mode-banner">Stems (isolated pre-master tracks)</span>
</div>
<div id="layers"></div>
</section>
<section class="panel hidden" id="stingerpanel">
<h2>Stingers</h2>
<div class="row" id="stingers"></div>
<label class="status"><input type="checkbox" id="quantise" checked="checked" /> Wait for the next bar</label>
</section>
<section class="panel hidden" id="sectionpanel">
<h2>Sections</h2>
<div id="sections"></div>
</section>
<section class="panel">
<h2>Notes</h2>
<textarea id="notetext" placeholder="What do you hear? The note is pinned to the current time, bar and layer settings."></textarea>
<div class="row" style="margin-top:6px">
<button type="button" id="addnote" class="primary">Add note here</button>
<select id="noterating">
<option value="">No rating</option>
<option value="1">1 poor</option>
<option value="2">2</option>
<option value="3">3</option>
<option value="4">4</option>
<option value="5">5 great</option>
</select>
<span class="status" id="notewhere"></span>
</div>
<ul class="notes" id="notes"></ul>
<div class="row" style="margin-top:8px">
<button type="button" id="send-feedback" class="primary">Send Feedback to Studio</button>
<button type="button" id="save">Save feedback</button>
<button type="button" id="copy">Copy feedback</button>
<span class="status" id="savestatus"></span>
</div>
</section>
<section class="panel hidden" id="specpanel">
<h2>Spectrogram</h2>
<img class="spec" id="spec" alt="Spectrogram of the render" />
</section>
</main>
</div>
<script src="/studio/audition.js"></script>
</body>
</html>
`;
}

function verifyStudioPost(request, studioAuth) {
  if (!localHost(request.headers.host)) {
    throw fail('Expected a local host.', 403);
  }
  const expectedOrigin = `http://${request.headers.host}`;
  if (request.headers.origin !== expectedOrigin) {
    throw fail('Cross-origin requests are forbidden on Studio endpoints.', 403);
  }
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieVal = cookies.studio_auth ?? '';
  const headerToken = typeof request.headers['x-studio-token'] === 'string'
    ? request.headers['x-studio-token']
    : '';
  if (!safeStringEqual(cookieVal, studioAuth.cookieValue) || !safeStringEqual(headerToken, studioAuth.studioToken)) {
    throw fail('Missing or invalid Studio capability token or cookie.', 403);
  }
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw fail('Expected Content-Type: application/json.', 415);
  }
}

export async function serveStudio(request, response, folders, {
  env = process.env,
  logger = defaultLog,
  launcher,
  studioAuth,
} = {}) {
  let url;
  try {
    url = new URL(request.url, 'http://127.0.0.1');
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return true;
  }

  const pathname = url.pathname;
  if (!pathname.startsWith('/studio') && !pathname.startsWith('/api/studio')) {
    return false;
  }

  try {
    if (!localHost(request.headers.host)) {
      throw fail('Expected a local host.', 403);
    }

    if (pathname === '/api/studio/health' && ['GET', 'HEAD'].includes(request.method)) {
      const workspaceRealpath = await realpath(path.resolve(folders.workspace))
        .catch(() => path.resolve(folders.workspace));
      const payload = JSON.stringify({
        ok: true,
        service: 'lmms-music-studio',
        workspaceRealpath,
        pid: process.pid,
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : payload);
      return true;
    }

    if (STATIC_ASSETS.has(pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const [fileName, contentType] = STATIC_ASSETS.get(pathname);
      const bytes = await readFile(new URL(fileName, ASSET_ROOT));
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': STUDIO_CSP,
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return true;
    }

    if ((pathname === '/studio/timeline' || pathname === '/studio/audition') && ['GET', 'HEAD'].includes(request.method)) {
      const session = url.searchParams.get('session') ?? '';
      if (!SESSION_ID_PATTERN.test(session)) {
        throw fail('Expected a valid session query parameter (letters, digits, underscores, hyphens).', 400);
      }
      const isTimeline = pathname === '/studio/timeline';
      const descriptorName = `${session}.${isTimeline ? 'timeline' : 'audition'}.studio.json`;
      const check = await readContainedStrict(descriptorName, folders.workspace);
      if (check.status === 403) throw fail('Refusing symbolic link, junction, or hidden file.', 403);
      if (!check.file) throw fail(`Studio session "${session}" was not found.`, 404);
      if (check.file.size > MAX_DESCRIPTOR_BYTES) throw fail('Studio session descriptor is too large.', 413);

      let parsedRaw;
      try {
        parsedRaw = JSON.parse(await readFile(check.file.path, 'utf8'));
      } catch {
        throw fail('Studio session descriptor is not valid JSON.', 400);
      }

      const descriptor = isTimeline
        ? validateTimelineDescriptor(parsedRaw, session)
        : validateAuditionDescriptor(parsedRaw, session);
      const html = isTimeline
        ? renderStudioTimelineHtml(descriptor, { studioToken: studioAuth.studioToken, session })
        : renderStudioAuditionHtml(descriptor, { studioToken: studioAuth.studioToken, session });
      const htmlBytes = Buffer.from(html, 'utf8');

      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': htmlBytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': STUDIO_CSP,
        'set-cookie': studioAuth.setCookieHeader,
      });
      response.end(request.method === 'HEAD' ? undefined : htmlBytes);
      return true;
    }

    if (pathname === '/api/studio/feedback' && request.method === 'POST') {
      verifyStudioPost(request, studioAuth);
      const rawBytes = await readBodyLimited(request, MAX_JSON_BYTES);
      let bodyJson;
      try {
        bodyJson = JSON.parse(rawBytes.toString('utf8'));
      } catch {
        throw fail('Request body is not valid JSON.', 400);
      }
      if (!bodyJson || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) {
        throw fail('Expected a JSON object body.', 400);
      }

      const session = String(bodyJson.session ?? url.searchParams.get('session') ?? '').trim();
      if (!SESSION_ID_PATTERN.test(session)) {
        throw fail('Expected a valid session identifier.', 400);
      }

      const feedbackPayload = bodyJson.feedback && typeof bodyJson.feedback === 'object'
        ? bodyJson.feedback
        : bodyJson;
      const validated = parseFeedback(feedbackPayload);

      const rootReal = await realpath(path.resolve(folders.workspace)).catch(() => {
        throw fail('Workspace directory does not exist.', 404);
      });
      const outName = `${session}-feedback.json`;
      const outPath = path.join(rootReal, outName);
      const existing = await lstat(outPath).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw fail('Refusing to overwrite symbolic link or non-regular file.', 403);
      }

      await writeFileAtomic(outPath, JSON.stringify(validated, null, 2) + '\n', { overwrite: true });
      logger.info('Saved studio listener feedback', { file: outName, notes: validated.notes.length, version: validated.version });
      sendJson(response, 200, {
        ok: true,
        file: outName,
        version: validated.version,
        noteCount: validated.notes.length,
        message: `Saved to workspace (${outName}) \u2014 tell your LLM to apply your notes`,
      });
      return true;
    }

    if (pathname === '/api/studio/open-lmms' && request.method === 'POST') {
      verifyStudioPost(request, studioAuth);
      const rawBytes = await readBodyLimited(request, MAX_JSON_BYTES);
      let bodyJson;
      try {
        bodyJson = JSON.parse(rawBytes.toString('utf8'));
      } catch {
        throw fail('Request body is not valid JSON.', 400);
      }
      if (!bodyJson || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) {
        throw fail('Expected a JSON object body.', 400);
      }

      let project = typeof bodyJson.project === 'string' ? bodyJson.project.trim() : '';
      if (!project && typeof bodyJson.session === 'string' && SESSION_ID_PATTERN.test(bodyJson.session.trim())) {
        const s = bodyJson.session.trim();
        for (const kind of ['timeline', 'audition']) {
          const check = await readContainedStrict(`${s}.${kind}.studio.json`, folders.workspace);
          if (check.file && check.file.size <= MAX_DESCRIPTOR_BYTES) {
            try {
              const desc = JSON.parse(await readFile(check.file.path, 'utf8'));
              if (typeof desc?.projectFile === 'string') {
                project = desc.projectFile.trim();
                break;
              }
            } catch { /* ignore */ }
          }
        }
      }

      if (!project || !PROJECT_NAME_PATTERN.test(project)) {
        throw fail('Expected a valid workspace .mmp or .mmpz project filename.', 400);
      }

      const check = await readContainedStrict(project, folders.workspace);
      if (check.status === 403) throw fail('Refusing symbolic link, junction, or hidden file.', 403);
      if (!check.file) throw fail(`Project "${project}" was not found in the workspace.`, 404);

      const result = await openInLmms({
        project,
        workspaceDir: check.file.rootReal,
        soundfontsDir: folders.soundfonts,
        env,
        launcher,
        logger,
      });
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    throw fail('Studio route not found.', 404);
  } catch (error) {
    const status = error.status ?? 400;
    if (status >= 500) {
      logger.error('Studio API failure', { path: pathname, error });
    }
    sendJson(response, status, { error: error.message || 'Studio request failed.' });
    return true;
  }
}
