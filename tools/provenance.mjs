// Hash-bound copyright provenance engine, preset inspector, and central LMMS project gate.
// Enforces fail-closed strict copyright provenance by default (LMMS_STRICT_COPYRIGHT !== '0' && !== 'false').
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { writeFileAtomic } from './fs-atomic.mjs';
import { createLogger } from './logger.mjs';
import { SOUNDFONT_TARGETS, TRACKED_LOCK_PATH, loadSoundfontLock } from './soundfont-pack.mjs';
import {
  resolveLmmsExecutable,
  resolveLmmsPresetsDir,
  resolveSoundfontsDir,
  resolveWorkspaceDir,
} from './workspace-config.mjs';

const log = createLogger('provenance');

export const PROVENANCE_SCHEMA = 'lmms-music-studio/provenance';
export const PROVENANCE_VERSION = 1;
export const PROVENANCE_SUFFIX = '.provenance.json';

export const VALID_CLASSIFICATIONS = Object.freeze([
  'pure-synthesis',
  'verified-cc0-sf2',
  'hybrid-verified',
  'user-attested-mic-take',
]);

export const PURE_SYNTH_PLUGINS = Object.freeze([
  'tripleoscillator',
  'kicker',
  'lb302',
  'monstro',
  'opl2',
  'opulenz',
  'organic',
  'sfxr',
  'watsyn',
  'vibedstrings',
  'zynaddsubfx',
  'bitinvader',
  'nes',
  'papu',
  'sid',
  'malletsstk',
]);

export const FORBIDDEN_PLUGINS = Object.freeze([
  'vestige',
  'patman',
  'gigplayer',
  'carlarack',
  'carlapatchbay',
]);

export const LEGAL_SCOPE_NOTE =
  'Synthesis and verified CC0-1.0 SoundFont SHA-256 hashes prove third-party-loop-free origin for Content ID disputes; user-attested-mic-take is attested by the user and copyright authorship depends on human creative direction.';

const PURE_SYNTH_SET = new Set(PURE_SYNTH_PLUGINS);
const FORBIDDEN_SET = new Set(FORBIDDEN_PLUGINS);
const VALID_CLASSIFICATION_SET = new Set(VALID_CLASSIFICATIONS);
const SETTINGS_TAGS = new Set(['eldata', 'chordcreator', 'arpeggiator', 'midiport', 'fxchain', 'midi', 'surpos']);
const ANCHOR_TRACK_NAME = 'Song length';

export function isStrictCopyright(env = process.env) {
  const raw = env?.LMMS_STRICT_COPYRIGHT;
  return !(raw === '0' || raw === 'false');
}

export function provenancePathFor(targetFilePath) {
  return `${path.resolve(targetFilePath)}${PROVENANCE_SUFFIX}`;
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function combineClassifications(classifications) {
  const list = classifications.filter(Boolean);
  if (list.length === 0) return 'pure-synthesis';
  const unique = new Set(list);
  if (unique.size === 1) {
    const [only] = unique;
    return VALID_CLASSIFICATION_SET.has(only) ? only : 'hybrid-verified';
  }
  return 'hybrid-verified';
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const clean = {
      ...(src.track ? { track: String(src.track) } : {}),
      kind: String(src.kind),
      pluginOrLibrary: String(src.pluginOrLibrary),
      ...(src.sha256 ? { sha256: String(src.sha256).toLowerCase() } : {}),
      ...(src.sourceRepo ? { sourceRepo: String(src.sourceRepo) } : {}),
      ...(src.sourceCommit ? { sourceCommit: String(src.sourceCommit) } : {}),
      licence: String(src.licence),
    };
    const key = JSON.stringify(clean);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  }
  return result;
}

export async function assertRealpathContained(targetPath, containerDir, label = 'File') {
  if (!containerDir) {
    throw new Error(`${label} verification requires a workspace directory`);
  }
  let realContainer;
  try {
    realContainer = await realpath(path.resolve(containerDir));
  } catch {
    throw new Error(`Workspace directory does not exist: ${containerDir}`);
  }

  let realTarget;
  try {
    realTarget = await realpath(path.resolve(targetPath));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${label} not found: ${targetPath}`);
    }
    throw error;
  }

  const rel = path.relative(realContainer, realTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes workspace directory (${realContainer}): ${targetPath}`);
  }

  const info = await lstat(realTarget);
  if (!info.isFile()) {
    throw new Error(`${label} is not a regular file: ${targetPath}`);
  }

  return {
    realPath: realTarget,
    realContainer,
    relativePosix: rel.split(path.sep).join('/'),
  };
}

function relativeTargetLabel(resolvedTarget, workspaceDir) {
  if (!workspaceDir) return path.basename(resolvedTarget);
  const resolvedWs = path.resolve(workspaceDir);
  const rel = path.relative(resolvedWs, resolvedTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return path.basename(resolvedTarget);
  }
  return rel.split(path.sep).join('/');
}

export async function writeProvenanceSidecar(targetFilePath, {
  workspaceDir,
  classification,
  strictCompliant = true,
  generatorTool,
  sources,
  createdAt = new Date().toISOString(),
}) {
  const resolvedTarget = path.resolve(targetFilePath);
  const info = await stat(resolvedTarget);
  if (!info.isFile()) {
    throw new Error(`Cannot write provenance for non-regular file: ${resolvedTarget}`);
  }
  if (strictCompliant && !VALID_CLASSIFICATION_SET.has(classification)) {
    throw new Error(`Invalid strict provenance classification: ${classification}`);
  }
  if (!generatorTool || typeof generatorTool !== 'string') {
    throw new Error('Provenance sidecar requires generatorTool');
  }
  const normalizedSources = dedupeSources(sources ?? []);
  if (strictCompliant && normalizedSources.length === 0) {
    throw new Error('Strict provenance sidecar requires at least one source entry');
  }

  const sha256 = await sha256File(resolvedTarget);
  const record = {
    schema: PROVENANCE_SCHEMA,
    version: PROVENANCE_VERSION,
    targetFile: relativeTargetLabel(resolvedTarget, workspaceDir),
    sha256,
    classification: strictCompliant ? classification : (classification || 'unverified-non-strict'),
    strictCompliant: Boolean(strictCompliant),
    createdAt,
    generatorTool,
    sources: normalizedSources,
    legalScopeNote: LEGAL_SCOPE_NOTE,
  };

  const sidecarPath = provenancePathFor(resolvedTarget);
  await writeFileAtomic(sidecarPath, JSON.stringify(record, null, 2) + '\n', { overwrite: true });
  return record;
}

function validateProvenanceRecordObject(record, actualSha256, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Invalid provenance sidecar for "${label}": expected JSON object`);
  }
  if (record.schema !== PROVENANCE_SCHEMA) {
    throw new Error(`Invalid provenance schema for "${label}": expected "${PROVENANCE_SCHEMA}", got "${record.schema}"`);
  }
  if (record.version !== PROVENANCE_VERSION) {
    throw new Error(`Unsupported provenance version for "${label}": expected ${PROVENANCE_VERSION}, got ${record.version}`);
  }
  if (record.strictCompliant !== true) {
    throw new Error(`Provenance sidecar for "${label}" is not strict-compliant`);
  }
  if (!VALID_CLASSIFICATION_SET.has(record.classification)) {
    throw new Error(`Invalid provenance classification for "${label}": "${record.classification}"`);
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) {
    throw new Error(`Invalid sha256 in provenance sidecar for "${label}"`);
  }
  if (record.sha256.toLowerCase() !== actualSha256.toLowerCase()) {
    throw new Error(
      `Provenance SHA-256 mismatch for "${label}": sidecar records ${record.sha256}, actual file is ${actualSha256}`,
    );
  }
  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    throw new Error(`Provenance sidecar for "${label}" has no verified sources`);
  }
  for (const source of record.sources) {
    if (!source || typeof source !== 'object' || !source.kind || !source.pluginOrLibrary || !source.licence) {
      throw new Error(`Provenance sidecar for "${label}" contains an incomplete source entry`);
    }
  }
  if (typeof record.legalScopeNote !== 'string' || !record.legalScopeNote.trim()) {
    throw new Error(`Provenance sidecar for "${label}" is missing legalScopeNote`);
  }
}

export async function verifyAudioFileProvenance(filePath, {
  workspaceDir,
  env = process.env,
} = {}) {
  const strict = isStrictCopyright(env);
  const wsDir = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  const normalizedInput = process.platform === 'win32' && typeof filePath === 'string'
    ? filePath.replaceAll('/', '\\')
    : String(filePath ?? '');
  if (!normalizedInput.trim()) {
    throw new Error('Audio file path is empty');
  }
  const candidate = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(wsDir, normalizedInput);

  const { realPath, relativePosix } = await assertRealpathContained(candidate, wsDir, 'Audio file');
  const actualSha256 = await sha256File(realPath);
  const sidecarPath = provenancePathFor(realPath);

  if (!existsSync(sidecarPath)) {
    if (strict) {
      throw new Error(
        `Strict copyright provenance gate rejected "${relativePosix}": missing ${path.basename(sidecarPath)} sidecar`,
      );
    }
    return {
      verified: false,
      strictMode: false,
      filePath: realPath,
      relativePath: relativePosix,
      sha256: actualSha256,
      record: null,
    };
  }

  try {
    await assertRealpathContained(sidecarPath, wsDir, 'Provenance sidecar');
    const parsed = JSON.parse(await readFile(sidecarPath, 'utf8'));
    validateProvenanceRecordObject(parsed, actualSha256, relativePosix);
    return {
      verified: true,
      strictMode: strict,
      filePath: realPath,
      relativePath: relativePosix,
      sha256: actualSha256,
      record: parsed,
    };
  } catch (error) {
    if (strict) {
      throw error;
    }
    log.warn('Ignoring invalid provenance sidecar because LMMS_STRICT_COPYRIGHT is disabled', {
      file: relativePosix,
      error: error.message,
    });
    return {
      verified: false,
      strictMode: false,
      filePath: realPath,
      relativePath: relativePosix,
      sha256: actualSha256,
      record: null,
    };
  }
}

export async function writeDerivedAudioProvenance(outputFilePath, inputChecks, {
  workspaceDir,
  generatorTool,
  extraSources = [],
}) {
  const checks = Array.isArray(inputChecks) ? inputChecks : [inputChecks];
  const allVerified = checks.length > 0 && checks.every(c => c?.verified && c?.record?.strictCompliant === true);
  if (!allVerified) {
    return null;
  }

  const classifications = [
    ...checks.map(c => c.record.classification),
    ...extraSources.map(s => s.classification).filter(Boolean),
  ];
  const classification = combineClassifications(classifications);

  const sources = [];
  for (const check of checks) {
    for (const upstream of check.record.sources ?? []) {
      sources.push(upstream);
    }
    sources.push({
      kind: check.record.classification,
      pluginOrLibrary: check.relativePath,
      sha256: check.sha256,
      licence: check.record.classification === 'verified-cc0-sf2'
        ? 'CC0-1.0'
        : check.record.classification === 'user-attested-mic-take'
          ? 'user-attested-own-recording'
          : 'unrestricted-synthesis',
    });
  }
  for (const extra of extraSources) {
    const { classification: _ignored, ...rest } = extra;
    sources.push(rest);
  }

  return writeProvenanceSidecar(outputFilePath, {
    workspaceDir,
    classification,
    strictCompliant: true,
    generatorTool,
    sources,
  });
}

async function loadApprovedCc0SoundfontEntries({ soundfontsDir, lockPath = TRACKED_LOCK_PATH } = {}) {
  const tracked = await loadSoundfontLock(lockPath).catch(() => null);
  const entriesById = new Map();

  for (const [id, entry] of Object.entries(tracked?.soundfonts ?? {})) {
    if (entry && entry.licence === 'CC0-1.0' && typeof entry.sf2Sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sf2Sha256)) {
      entriesById.set(id, entry);
    }
  }

  if (soundfontsDir && lockPath === TRACKED_LOCK_PATH) {
    const localLock = await loadSoundfontLock(path.join(soundfontsDir, 'soundfont-lock.json')).catch(() => null);
    for (const [id, entry] of Object.entries(localLock?.soundfonts ?? {})) {
      if (entriesById.has(id)) continue;
      const target = SOUNDFONT_TARGETS[id];
      if (!target || target.licence !== 'CC0-1.0' || entry?.licence !== 'CC0-1.0') continue;
      if (entry.fileName !== target.fileName) continue;
      if (target.repoUrl && entry.repository !== target.repoUrl) continue;
      if (target.commit && entry.commit !== target.commit) continue;
      if (target.licenceSha256 && entry.licenceSha256 !== target.licenceSha256) continue;
      if (typeof entry.sf2Sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sf2Sha256)) {
        entriesById.set(id, entry);
      }
    }
  }

  return [...entriesById.values()];
}

function resolveCandidateSf2OnDisk(rawSrc, { workspaceDir, soundfontsDir }) {
  if (!rawSrc || typeof rawSrc !== 'string' || !rawSrc.trim()) {
    throw new Error('SoundFont path is empty');
  }
  const trimmed = rawSrc.trim();
  if (/^(?:\\\\|\/\/)/.test(trimmed)) {
    throw new Error(`Refusing network/UNC SoundFont path: ${trimmed}`);
  }
  const normalized = process.platform === 'win32' ? trimmed.replaceAll('/', '\\') : trimmed;
  if (path.isAbsolute(normalized)) {
    const resolved = path.resolve(normalized);
    if (!existsSync(resolved)) {
      throw new Error(`SoundFont file not found: ${trimmed}`);
    }
    return resolved;
  }
  if (normalized.split(/[\\/]/).includes('..')) {
    throw new Error(`SoundFont path must not contain "..": ${trimmed}`);
  }
  if (workspaceDir) {
    const wsCandidate = path.resolve(workspaceDir, normalized);
    if (!path.relative(path.resolve(workspaceDir), wsCandidate).startsWith('..') && existsSync(wsCandidate)) {
      return wsCandidate;
    }
  }
  if (soundfontsDir) {
    const sfCandidate = path.resolve(soundfontsDir, normalized);
    if (!path.relative(path.resolve(soundfontsDir), sfCandidate).startsWith('..') && existsSync(sfCandidate)) {
      return sfCandidate;
    }
  }
  throw new Error(`SoundFont file not found: ${trimmed}`);
}

export async function verifySoundfontProvenance(sf2PathOrSrc, {
  workspaceDir,
  soundfontsDir,
  env = process.env,
  lockPath = TRACKED_LOCK_PATH,
} = {}) {
  const strict = isStrictCopyright(env);
  const sfDir = soundfontsDir ? path.resolve(soundfontsDir) : resolveSoundfontsDir(env);
  const wsDir = workspaceDir ? path.resolve(workspaceDir) : resolveWorkspaceDir(env);
  const resolved = resolveCandidateSf2OnDisk(sf2PathOrSrc, { workspaceDir: wsDir, soundfontsDir: sfDir });

  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`SoundFont is not a regular file: ${resolved}`);
  }

  if (!/\.sf2$/i.test(resolved)) {
    if (strict) {
      throw new Error(`Strict copyright mode requires a locked .sf2 SoundFont (got "${path.basename(resolved)}")`);
    }
    const sha256 = await sha256File(resolved);
    return {
      verified: false,
      strictMode: false,
      fullPath: resolved,
      sha256,
      lockEntry: null,
      source: {
        kind: 'unverified-soundfont',
        pluginOrLibrary: path.basename(resolved),
        sha256,
        licence: 'unknown',
      },
    };
  }

  const actualSha256 = await sha256File(resolved);
  const approvedEntries = await loadApprovedCc0SoundfontEntries({ soundfontsDir: sfDir, lockPath });
  const matched = approvedEntries.find(entry => entry.sf2Sha256.toLowerCase() === actualSha256.toLowerCase()) ?? null;

  if (!matched) {
    if (strict) {
      throw new Error(
        `Strict copyright provenance gate rejected SoundFont "${path.basename(resolved)}" (sha256: ${actualSha256}): not an approved CC0-1.0 entry in soundfont-lock.json or modified on disk`,
      );
    }
    return {
      verified: false,
      strictMode: false,
      fullPath: resolved,
      sha256: actualSha256,
      lockEntry: null,
      source: {
        kind: 'unverified-soundfont',
        pluginOrLibrary: path.basename(resolved),
        sha256: actualSha256,
        licence: 'unknown',
      },
    };
  }

  const sourceRepo = matched.repository ?? matched.sourceUrl ?? undefined;
  return {
    verified: true,
    strictMode: strict,
    fullPath: resolved,
    sha256: actualSha256,
    lockEntry: matched,
    source: {
      kind: 'verified-cc0-sf2',
      pluginOrLibrary: matched.id,
      sha256: actualSha256,
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(matched.commit ? { sourceCommit: matched.commit } : {}),
      licence: 'CC0-1.0',
    },
  };
}

function childElements(node, tagName = null) {
  const target = tagName ? tagName.toLowerCase() : null;
  return Array.from(node?.childNodes ?? []).filter(
    child => child.nodeType === 1 && (!target || child.nodeName.toLowerCase() === target),
  );
}

function readAttrOrModelValue(node, attrName) {
  if (!node) return null;
  if (node.hasAttribute(attrName)) return node.getAttribute(attrName);
  const [child] = childElements(node, attrName);
  if (child && child.hasAttribute('value')) return child.getAttribute('value');
  return null;
}

function inspectTripleOscillatorNode(instNode, label) {
  const [oscNode] = childElements(instNode, 'tripleoscillator');
  if (!oscNode) return null;
  for (const index of [0, 1, 2]) {
    const waveType = readAttrOrModelValue(oscNode, `wavetype${index}`);
    if (waveType !== null && String(waveType).trim() === '7') {
      return `${label}: tripleoscillator wavetype${index}="7" (user-defined sample wave) is forbidden in strict copyright mode`;
    }
    const userWave = readAttrOrModelValue(oscNode, `userwavefile${index}`);
    if (userWave !== null && String(userWave).trim() !== '') {
      return `${label}: tripleoscillator userwavefile${index}="${userWave}" is forbidden in strict copyright mode`;
    }
  }
  return null;
}

function inspectEldataNode(instrumentTrackNode, label) {
  const [eldata] = childElements(instrumentTrackNode, 'eldata');
  if (!eldata) return null;
  for (const envTag of ['elvol', 'elcut', 'elres', 'elpan', 'elpitch']) {
    for (const envNode of childElements(eldata, envTag)) {
      const lshp = readAttrOrModelValue(envNode, 'lshp');
      if (lshp !== null && String(lshp).trim() === '6') {
        return `${label}: ${envTag} lshp="6" (user-defined LFO wave) is forbidden in strict copyright mode`;
      }
      const userWave = readAttrOrModelValue(envNode, 'userwavefile');
      if (userWave !== null && String(userWave).trim() !== '') {
        return `${label}: ${envTag} userwavefile="${userWave}" is forbidden in strict copyright mode`;
      }
    }
  }
  return null;
}

export async function inspectPresetFile(presetPath, {
  presetsDir,
  workspaceDir,
  soundfontsDir,
  env = process.env,
  lockPath = TRACKED_LOCK_PATH,
} = {}) {
  const basePresetsDir = presetsDir ?? resolveLmmsPresetsDir(env, resolveLmmsExecutable(env));
  const fullPath = path.isAbsolute(presetPath) ? path.resolve(presetPath) : path.resolve(basePresetsDir, presetPath);

  let raw;
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) {
      return { allowed: false, plugin: null, classification: null, reason: `Preset is not a regular file: ${presetPath}`, sources: [] };
    }
    raw = await readFile(fullPath);
  } catch (error) {
    return { allowed: false, plugin: null, classification: null, reason: `Preset could not be read (${presetPath}): ${error.message}`, sources: [] };
  }

  if (/\.xiz$/i.test(fullPath)) {
    try {
      const text = (raw[0] === 0x1f && raw[1] === 0x8b
        ? gunzipSync(raw, { maxOutputLength: 8 * 1024 * 1024 })
        : raw).toString('utf8');
      const match = /<INSTRUMENT>[\s\S]*<\/INSTRUMENT>/.exec(text);
      if (!match) {
        return { allowed: false, plugin: 'zynaddsubfx', classification: null, reason: 'Invalid ZynAddSubFX .xiz preset (missing <INSTRUMENT>)', sources: [] };
      }
      const parsed = new DOMParser().parseFromString(match[0], 'application/xml');
      if (!parsed?.documentElement || parsed.documentElement.nodeName !== 'INSTRUMENT') {
        return { allowed: false, plugin: 'zynaddsubfx', classification: null, reason: 'Malformed ZynAddSubFX .xiz XML', sources: [] };
      }
      return {
        allowed: true,
        plugin: 'zynaddsubfx',
        classification: 'pure-synthesis',
        reason: null,
        sources: [{ kind: 'pure-synthesis', pluginOrLibrary: 'zynaddsubfx', licence: 'unrestricted-synthesis' }],
      };
    } catch (error) {
      return { allowed: false, plugin: 'zynaddsubfx', classification: null, reason: `Invalid .xiz preset: ${error.message}`, sources: [] };
    }
  }

  if (!/\.xpf$/i.test(fullPath)) {
    return { allowed: false, plugin: null, classification: null, reason: `Unsupported preset extension: ${path.extname(fullPath)}`, sources: [] };
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(raw.toString('utf8'), 'application/xml');
  } catch (error) {
    return { allowed: false, plugin: null, classification: null, reason: `Malformed .xpf XML: ${error.message}`, sources: [] };
  }

  const settings = doc.getElementsByTagName('instrumenttrack')[0] ?? doc.getElementsByTagName('channeltrack')[0];
  if (!settings) {
    return { allowed: false, plugin: null, classification: null, reason: `Preset "${presetPath}" has no <instrumenttrack> or <channeltrack>`, sources: [] };
  }

  let [instNode] = childElements(settings, 'instrument');
  let pluginName = instNode?.getAttribute('name')?.trim().toLowerCase() ?? null;
  if (!instNode) {
    const barePlugin = childElements(settings).find(node => !SETTINGS_TAGS.has(node.nodeName.toLowerCase()));
    if (!barePlugin) {
      return { allowed: false, plugin: null, classification: null, reason: `Preset "${presetPath}" has no instrument plugin element`, sources: [] };
    }
    pluginName = barePlugin.nodeName.toLowerCase();
    instNode = doc.createElement('instrument');
    instNode.setAttribute('name', pluginName);
    instNode.appendChild(barePlugin.cloneNode(true));
  }

  if (!pluginName) {
    return { allowed: false, plugin: null, classification: null, reason: `Preset "${presetPath}" has an unnamed <instrument>`, sources: [] };
  }

  if (FORBIDDEN_SET.has(pluginName)) {
    return {
      allowed: false,
      plugin: pluginName,
      classification: null,
      reason: `Preset "${presetPath}" uses forbidden plugin "${pluginName}"`,
      sources: [],
    };
  }

  const eldataProblem = inspectEldataNode(settings, `Preset "${presetPath}"`);
  if (eldataProblem) {
    return { allowed: false, plugin: pluginName, classification: null, reason: eldataProblem, sources: [] };
  }

  const [eldataNode] = childElements(settings, 'eldata');
  const hasLinkedIds = node => Boolean(node && Array.from(node.getElementsByTagName('*')).some(child => child.hasAttribute('id')));
  if (hasLinkedIds(instNode) || hasLinkedIds(eldataNode)) {
    return {
      allowed: false,
      plugin: pluginName,
      classification: null,
      reason: `Preset "${presetPath}" contains linked model IDs that cannot be safely imported`,
      sources: [],
    };
  }

  if (PURE_SYNTH_SET.has(pluginName)) {
    if (pluginName === 'tripleoscillator') {
      const toProblem = inspectTripleOscillatorNode(instNode, `Preset "${presetPath}"`);
      if (toProblem) {
        return { allowed: false, plugin: pluginName, classification: null, reason: toProblem, sources: [] };
      }
    }
    return {
      allowed: true,
      plugin: pluginName,
      classification: 'pure-synthesis',
      reason: null,
      sources: [{ kind: 'pure-synthesis', pluginOrLibrary: pluginName, licence: 'unrestricted-synthesis' }],
    };
  }

  if (pluginName === 'sf2player') {
    const [sf2Node] = childElements(instNode, 'sf2player');
    const src = sf2Node?.getAttribute('src')?.trim() ?? '';
    try {
      const check = await verifySoundfontProvenance(src, {
        workspaceDir,
        soundfontsDir,
        env: { ...env, LMMS_STRICT_COPYRIGHT: '1' },
        lockPath,
      });
      return {
        allowed: true,
        plugin: 'sf2player',
        classification: 'verified-cc0-sf2',
        reason: null,
        sources: [check.source],
      };
    } catch (error) {
      return { allowed: false, plugin: 'sf2player', classification: null, reason: error.message, sources: [] };
    }
  }

  if (pluginName === 'audiofileprocessor') {
    const [afpNode] = childElements(instNode, 'audiofileprocessor');
    const src = afpNode?.getAttribute('src')?.trim() ?? '';
    if (!src) {
      return { allowed: false, plugin: 'audiofileprocessor', classification: null, reason: `Preset "${presetPath}" uses audiofileprocessor with empty src`, sources: [] };
    }
    try {
      const check = await verifyAudioFileProvenance(src, {
        workspaceDir,
        env: { ...env, LMMS_STRICT_COPYRIGHT: '1' },
      });
      return {
        allowed: true,
        plugin: 'audiofileprocessor',
        classification: check.record.classification,
        reason: null,
        sources: check.record.sources,
      };
    } catch (error) {
      return {
        allowed: false,
        plugin: 'audiofileprocessor',
        classification: null,
        reason: `Preset "${presetPath}" uses audiofileprocessor ("${src}"): ${error.message}`,
        sources: [],
      };
    }
  }

  return {
    allowed: false,
    plugin: pluginName,
    classification: null,
    reason: `Preset "${presetPath}" uses unknown or disallowed plugin "${pluginName}"`,
    sources: [],
  };
}

function collectAllTracks(doc) {
  const result = [];
  const [song] = childElements(doc.documentElement, 'song');
  const [mainContainer] = childElements(song, 'trackcontainer');
  const topTracks = childElements(mainContainer, 'track');
  for (const t of topTracks) {
    result.push({ node: t, scope: 'song' });
    if (t.getAttribute('type') === '1') {
      const [bbtrack] = childElements(t, 'bbtrack');
      const [bbContainer] = childElements(bbtrack, 'trackcontainer');
      for (const lane of childElements(bbContainer, 'track')) {
        result.push({ node: lane, scope: `bbtrack:${t.getAttribute('name') || 'Beat/Bassline'}` });
      }
    }
  }
  return result;
}

export async function auditProjectProvenance(doc, {
  projectName = null,
  workspaceDir,
  soundfontsDir,
  presetsDir,
  env = process.env,
  lockPath = TRACKED_LOCK_PATH,
} = {}) {
  const strictMode = isStrictCopyright(env);
  const wsDir = workspaceDir ? path.resolve(workspaceDir) : resolveWorkspaceDir(env);
  const sfDir = soundfontsDir ? path.resolve(soundfontsDir) : resolveSoundfontsDir(env);
  const strictEvalEnv = { ...env, LMMS_STRICT_COPYRIGHT: '1' };

  if (!doc?.documentElement || doc.documentElement.tagName !== 'lmms-project') {
    throw new Error('Expected an LMMS <lmms-project> document');
  }

  const issues = [];
  const tracksReport = [];
  const allSources = [];
  const trackClassifications = [];

  const allTracks = collectAllTracks(doc);

  for (const { node: trackNode, scope } of allTracks) {
    const rawName = trackNode.getAttribute('name') || 'Unnamed';
    const trackLabel = scope === 'song' ? rawName : `${scope}/${rawName}`;
    const type = trackNode.getAttribute('type') ?? '0';

    if (type === '5') {
      tracksReport.push({
        track: trackLabel,
        type: 'automation',
        plugin: null,
        compliant: true,
        classification: 'pure-synthesis',
        sources: [],
      });
      continue;
    }

    if (type === '1') {
      tracksReport.push({
        track: trackLabel,
        type: 'bbtrack',
        plugin: null,
        compliant: true,
        classification: 'pure-synthesis',
        sources: [],
      });
      continue;
    }

    if (type === '2') {
      const isAnchor = scope === 'song' && rawName === ANCHOR_TRACK_NAME;
      const clips = childElements(trackNode, 'sampletco');
      const clipSources = [];
      const clipClassifications = [];
      let trackCompliant = true;
      const trackIssues = [];

      for (const clip of clips) {
        const inlineData = clip.getAttribute('data')?.trim();
        if (inlineData) {
          trackCompliant = false;
          const msg = `Track "${trackLabel}": <sampletco> embeds inline unverified sample data`;
          trackIssues.push(msg);
          issues.push(msg);
          continue;
        }
        const src = (clip.getAttribute('src') ?? '').trim();
        if (src === '') {
          if (!isAnchor) {
            trackCompliant = false;
            const msg = `Track "${trackLabel}": empty <sampletco src=""> is only permitted on the "${ANCHOR_TRACK_NAME}" anchor track`;
            trackIssues.push(msg);
            issues.push(msg);
          }
          continue;
        }
        try {
          const check = await verifyAudioFileProvenance(src, { workspaceDir: wsDir, env: strictEvalEnv });
          clipClassifications.push(check.record.classification);
          for (const upstream of check.record.sources) {
            clipSources.push({ ...upstream, track: trackLabel });
          }
          clipSources.push({
            track: trackLabel,
            kind: check.record.classification,
            pluginOrLibrary: check.relativePath,
            sha256: check.sha256,
            licence: check.record.classification === 'verified-cc0-sf2'
              ? 'CC0-1.0'
              : check.record.classification === 'user-attested-mic-take'
                ? 'user-attested-own-recording'
                : 'unrestricted-synthesis',
          });
        } catch (error) {
          trackCompliant = false;
          const msg = `Track "${trackLabel}": ${error.message}`;
          trackIssues.push(msg);
          issues.push(msg);
        }
      }

      const trackClassification = trackCompliant
        ? (clipClassifications.length > 0 ? combineClassifications(clipClassifications) : 'pure-synthesis')
        : null;
      if (trackCompliant && clipClassifications.length > 0) {
        trackClassifications.push(trackClassification);
        allSources.push(...clipSources);
      }

      tracksReport.push({
        track: trackLabel,
        type: isAnchor ? 'anchor' : 'sampletrack',
        plugin: 'sampletrack',
        compliant: trackCompliant,
        classification: trackClassification,
        sources: dedupeSources(clipSources),
        ...(trackIssues.length ? { issues: trackIssues } : {}),
      });
      continue;
    }

    if (type !== '0') {
      const msg = `Track "${trackLabel}": unsupported LMMS track type "${type}" in strict copyright mode`;
      issues.push(msg);
      tracksReport.push({
        track: trackLabel,
        type: `unknown:${type}`,
        plugin: null,
        compliant: false,
        classification: null,
        sources: [],
        issues: [msg],
      });
      continue;
    }

    const [instTrack] = childElements(trackNode, 'instrumenttrack');
    if (!instTrack) {
      const msg = `Track "${trackLabel}": missing <instrumenttrack> element`;
      issues.push(msg);
      tracksReport.push({
        track: trackLabel,
        type: 'instrument',
        plugin: null,
        compliant: false,
        classification: null,
        sources: [],
        issues: [msg],
      });
      continue;
    }

    let [instNode] = childElements(instTrack, 'instrument');
    let pluginName = instNode?.getAttribute('name')?.trim().toLowerCase() ?? null;
    if (!instNode) {
      const barePlugin = childElements(instTrack).find(node => !SETTINGS_TAGS.has(node.nodeName.toLowerCase()));
      if (barePlugin) {
        pluginName = barePlugin.nodeName.toLowerCase();
        instNode = doc.createElement('instrument');
        instNode.setAttribute('name', pluginName);
        instNode.appendChild(barePlugin.cloneNode(true));
      }
    }

    if (!pluginName) {
      const msg = `Track "${trackLabel}": missing <instrument name="..."> plugin declaration`;
      issues.push(msg);
      tracksReport.push({
        track: trackLabel,
        type: 'instrument',
        plugin: null,
        compliant: false,
        classification: null,
        sources: [],
        issues: [msg],
      });
      continue;
    }

    if (FORBIDDEN_SET.has(pluginName)) {
      const msg = `Track "${trackLabel}": plugin "${pluginName}" is forbidden in strict copyright mode`;
      issues.push(msg);
      tracksReport.push({
        track: trackLabel,
        type: 'instrument',
        plugin: pluginName,
        compliant: false,
        classification: null,
        sources: [],
        issues: [msg],
      });
      continue;
    }

    const eldataProblem = inspectEldataNode(instTrack, `Track "${trackLabel}"`);
    if (eldataProblem) {
      issues.push(eldataProblem);
      tracksReport.push({
        track: trackLabel,
        type: 'instrument',
        plugin: pluginName,
        compliant: false,
        classification: null,
        sources: [],
        issues: [eldataProblem],
      });
      continue;
    }

    if (PURE_SYNTH_SET.has(pluginName)) {
      if (pluginName === 'tripleoscillator') {
        const toProblem = inspectTripleOscillatorNode(instNode, `Track "${trackLabel}"`);
        if (toProblem) {
          issues.push(toProblem);
          tracksReport.push({
            track: trackLabel,
            type: 'instrument',
            plugin: pluginName,
            compliant: false,
            classification: null,
            sources: [],
            issues: [toProblem],
          });
          continue;
        }
      }
      const source = {
        track: trackLabel,
        kind: 'pure-synthesis',
        pluginOrLibrary: pluginName,
        licence: 'unrestricted-synthesis',
      };
      trackClassifications.push('pure-synthesis');
      allSources.push(source);
      tracksReport.push({
        track: trackLabel,
        type: 'instrument',
        plugin: pluginName,
        compliant: true,
        classification: 'pure-synthesis',
        sources: [source],
      });
      continue;
    }

    if (pluginName === 'sf2player') {
      const [sf2Node] = childElements(instNode, 'sf2player');
      const src = sf2Node?.getAttribute('src')?.trim() ?? '';
      try {
        const check = await verifySoundfontProvenance(src, {
          workspaceDir: wsDir,
          soundfontsDir: sfDir,
          env: strictEvalEnv,
          lockPath,
        });
        const source = { ...check.source, track: trackLabel };
        trackClassifications.push('verified-cc0-sf2');
        allSources.push(source);
        tracksReport.push({
          track: trackLabel,
          type: 'instrument',
          plugin: 'sf2player',
          compliant: true,
          classification: 'verified-cc0-sf2',
          sources: [source],
        });
      } catch (error) {
        const msg = `Track "${trackLabel}": ${error.message}`;
        issues.push(msg);
        tracksReport.push({
          track: trackLabel,
          type: 'instrument',
          plugin: 'sf2player',
          compliant: false,
          classification: null,
          sources: [],
          issues: [msg],
        });
      }
      continue;
    }

    if (pluginName === 'audiofileprocessor') {
      const [afpNode] = childElements(instNode, 'audiofileprocessor');
      const src = afpNode?.getAttribute('src')?.trim() ?? '';
      if (!src) {
        const msg = `Track "${trackLabel}": audiofileprocessor has empty src`;
        issues.push(msg);
        tracksReport.push({
          track: trackLabel,
          type: 'instrument',
          plugin: 'audiofileprocessor',
          compliant: false,
          classification: null,
          sources: [],
          issues: [msg],
        });
        continue;
      }
      try {
        const check = await verifyAudioFileProvenance(src, { workspaceDir: wsDir, env: strictEvalEnv });
        const trackSources = [
          ...check.record.sources.map(s => ({ ...s, track: trackLabel })),
          {
            track: trackLabel,
            kind: check.record.classification,
            pluginOrLibrary: check.relativePath,
            sha256: check.sha256,
            licence: check.record.classification === 'verified-cc0-sf2'
              ? 'CC0-1.0'
              : check.record.classification === 'user-attested-mic-take'
                ? 'user-attested-own-recording'
                : 'unrestricted-synthesis',
          },
        ];
        trackClassifications.push(check.record.classification);
        allSources.push(...trackSources);
        tracksReport.push({
          track: trackLabel,
          type: 'instrument',
          plugin: 'audiofileprocessor',
          compliant: true,
          classification: check.record.classification,
          sources: dedupeSources(trackSources),
        });
      } catch (error) {
        const msg = `Track "${trackLabel}": ${error.message}`;
        issues.push(msg);
        tracksReport.push({
          track: trackLabel,
          type: 'instrument',
          plugin: 'audiofileprocessor',
          compliant: false,
          classification: null,
          sources: [],
          issues: [msg],
        });
      }
      continue;
    }

    const msg = `Track "${trackLabel}": unknown or unverified instrument plugin "${pluginName}" is forbidden in strict copyright mode`;
    issues.push(msg);
    tracksReport.push({
      track: trackLabel,
      type: 'instrument',
      plugin: pluginName,
      compliant: false,
      classification: null,
      sources: [],
      issues: [msg],
    });
  }

  for (const fxNode of Array.from(doc.getElementsByTagName('effect'))) {
    const fxName = fxNode.getAttribute('name')?.trim().toLowerCase() ?? '';
    if (fxName === 'vsteffect' || FORBIDDEN_SET.has(fxName)) {
      issues.push(`Effect plugin "${fxName}" is forbidden in strict copyright mode`);
    }
  }

  const compliant = issues.length === 0;
  const dedupedSources = dedupeSources(
    allSources.length > 0
      ? allSources
      : [{ kind: 'pure-synthesis', pluginOrLibrary: 'lmms-empty-song', licence: 'unrestricted-synthesis' }],
  );
  const classification = compliant ? combineClassifications(trackClassifications) : null;
  const hasUserAttestedTakes = Boolean(
    classification === 'user-attested-mic-take' ||
    dedupedSources.some(s => s.kind === 'user-attested-mic-take') ||
    tracksReport.some(t => t.classification === 'user-attested-mic-take'),
  );

  return {
    projectName,
    compliant,
    strictMode,
    classification,
    tracksOrInputs: tracksReport,
    sources: dedupedSources,
    hasUserAttestedTakes,
    issues,
    legalScopeNote: LEGAL_SCOPE_NOTE,
  };
}

export async function assertProjectProvenance(doc, options = {}) {
  const report = await auditProjectProvenance(doc, options);
  if (report.strictMode && !report.compliant) {
    throw new Error(
      `Strict copyright provenance gate blocked${report.projectName ? ` "${report.projectName}"` : ' project'}: ${report.issues.join('; ')}`,
    );
  }
  return report;
}

export async function writeProjectOrRenderProvenance(targetFilePath, auditReport, {
  workspaceDir,
  generatorTool,
  trackName = null,
}) {
  if (!auditReport?.compliant) {
    return writeProvenanceSidecar(targetFilePath, {
      workspaceDir,
      classification: 'unverified-non-strict',
      strictCompliant: false,
      generatorTool,
      sources: auditReport?.sources ?? [],
    });
  }

  if (trackName) {
    const trackEntry = auditReport.tracksOrInputs.find(t => t.track === trackName);
    if (trackEntry && trackEntry.compliant && trackEntry.sources?.length) {
      return writeProvenanceSidecar(targetFilePath, {
        workspaceDir,
        classification: trackEntry.classification ?? auditReport.classification,
        strictCompliant: true,
        generatorTool,
        sources: trackEntry.sources,
      });
    }
  }

  return writeProvenanceSidecar(targetFilePath, {
    workspaceDir,
    classification: auditReport.classification,
    strictCompliant: true,
    generatorTool,
    sources: auditReport.sources,
  });
}
