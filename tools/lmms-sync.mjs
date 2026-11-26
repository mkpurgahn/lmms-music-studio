// Two-way Desktop LMMS sync: open workspace projects in Desktop LMMS safely,
// detect out-of-band user saves (.mmp or sibling .mmpz), block silent MCP overwrites,
// and re-verify strict copyright provenance on sync_from_lmms.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { writeFileAtomic } from './fs-atomic.mjs';
import { createLogger } from './logger.mjs';
import {
  assertRealpathContained,
  auditProjectProvenance,
  sha256File,
  writeProjectOrRenderProvenance,
} from './provenance.mjs';
import {
  resolveLmmsExecutable,
  resolveLmmsPresetsDir,
  resolveSoundfontsDir,
  resolveWorkspaceDir,
} from './workspace-config.mjs';

const defaultLog = createLogger('lmms-sync');

export const SYNC_STATE_FILE = '.studio-lmms-sync.json';
export const SYNC_STATE_VERSION = 1;

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i;
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_STATE_BYTES = 1024 * 1024;

function isNoGuiLaunch(env = process.env) {
  const raw = String(env?.LMMS_NO_GUI_LAUNCH ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function validateProjectName(project) {
  if (typeof project !== 'string' || !PROJECT_NAME_PATTERN.test(project.trim())) {
    throw new Error('Expected a plain workspace project name ending in .mmp or .mmpz');
  }
  return project.trim();
}

function siblingMmpzName(projectName) {
  return /\.mmp$/i.test(projectName) ? `${projectName}z` : null;
}

async function inspectOptionalSibling(workspaceDir, projectName) {
  const siblingName = siblingMmpzName(projectName);
  if (!siblingName) return null;
  const siblingPath = path.join(workspaceDir, siblingName);
  const linkInfo = await lstat(siblingPath).catch(() => null);
  if (!linkInfo || linkInfo.isSymbolicLink() || !linkInfo.isFile()) return null;
  try {
    const contained = await assertRealpathContained(siblingPath, workspaceDir, 'Sibling project file');
    const sha256 = await sha256File(contained.realPath);
    const info = await stat(contained.realPath);
    return {
      name: siblingName,
      path: contained.realPath,
      sha256,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch {
    return null;
  }
}

export function decodeProjectXmlBuffer(rawBuffer, fileName) {
  if (rawBuffer.length > MAX_PROJECT_BYTES) {
    throw new Error(`Project "${fileName}" exceeds 32 MiB`);
  }
  const isCompressed = /\.mmpz$/i.test(fileName);
  let xmlText;
  if (!isCompressed) {
    xmlText = rawBuffer.toString('utf8');
  } else {
    if (rawBuffer.length < 5) {
      throw new Error(`Invalid compressed LMMS project "${fileName}"`);
    }
    const expectedLen = rawBuffer.readUInt32BE(0);
    if (expectedLen > MAX_PROJECT_BYTES) {
      throw new Error(`Compressed LMMS project "${fileName}" exceeds 32 MiB uncompressed`);
    }
    const inflated = inflateSync(rawBuffer.subarray(4), { maxOutputLength: MAX_PROJECT_BYTES });
    if (inflated.length !== expectedLen) {
      throw new Error(`Compressed LMMS project "${fileName}" size header mismatch`);
    }
    xmlText = inflated.toString('utf8');
  }
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (!doc?.documentElement || doc.documentElement.tagName !== 'lmms-project') {
    throw new Error(`"${fileName}" is not a valid <lmms-project> document`);
  }
  return { doc, xmlBuffer: Buffer.from(xmlText, 'utf8'), isCompressed };
}

function summarizeDoc(doc) {
  const childElements = (node, tag) =>
    Array.from(node?.childNodes ?? []).filter(c => c.nodeType === 1 && (!tag || c.nodeName === tag));
  const [head] = childElements(doc.documentElement, 'head');
  const bpm = Number(head?.getAttribute('bpm') || 140);
  const timeSignature = [
    Number(head?.getAttribute('timesig_numerator') || 4),
    Number(head?.getAttribute('timesig_denominator') || 4),
  ];
  const [song] = childElements(doc.documentElement, 'song');
  const [trackContainer] = childElements(song, 'trackcontainer');
  const trackNodes = childElements(trackContainer, 'track').filter(
    t => !(t.getAttribute('type') === '2' && t.getAttribute('name') === 'Song length'),
  );
  const tracks = trackNodes.map(t => {
    const type = t.getAttribute('type') ?? '0';
    const [instTrack] = childElements(t, 'instrumenttrack');
    const [inst] = childElements(instTrack, 'instrument');
    const patterns = childElements(t, 'pattern');
    const noteCount = patterns.reduce((sum, p) => sum + childElements(p, 'note').length, 0);
    return {
      name: t.getAttribute('name') || 'Unnamed',
      type,
      plugin: inst?.getAttribute('name') ?? (type === '2' ? 'sampletrack' : null),
      muted: t.getAttribute('muted') === '1',
      solo: t.getAttribute('solo') === '1',
      ...(instTrack ? { volume: Number(instTrack.getAttribute('vol') ?? 100), pan: Number(instTrack.getAttribute('pan') ?? 0) } : {}),
      patterns: patterns.length,
      notes: noteCount,
    };
  });
  return { bpm, timeSignature, tracks };
}

function syncStatePath(workspaceDir) {
  return path.join(path.resolve(workspaceDir), SYNC_STATE_FILE);
}

export async function readSyncState(workspaceDir) {
  const filePath = syncStatePath(workspaceDir);
  const info = await lstat(filePath).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (!info) return { version: SYNC_STATE_VERSION, projects: {} };
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SYNC_STATE_BYTES) {
    throw new Error(`Invalid ${SYNC_STATE_FILE} state file in workspace`);
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: SYNC_STATE_VERSION, projects: {} };
    }
    const projects = parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
      ? { ...parsed.projects }
      : {};
    if (typeof parsed.project === 'string' && typeof parsed.openedSha256 === 'string' && !projects[parsed.project]) {
      projects[parsed.project] = {
        project: parsed.project,
        openedSha256: parsed.openedSha256,
        openedMtimeMs: parsed.openedMtimeMs ?? 0,
        openedAt: parsed.openedAt ?? null,
      };
    }
    return {
      version: SYNC_STATE_VERSION,
      ...(parsed.project ? {
        project: parsed.project,
        openedSha256: parsed.openedSha256,
        openedMtimeMs: parsed.openedMtimeMs,
        openedAt: parsed.openedAt,
      } : {}),
      projects,
    };
  } catch {
    return { version: SYNC_STATE_VERSION, projects: {} };
  }
}

async function writeSyncEntry(workspaceDir, entry) {
  const current = await readSyncState(workspaceDir);
  const projects = {
    ...current.projects,
    [entry.project]: entry,
  };
  const nextState = {
    version: SYNC_STATE_VERSION,
    project: entry.project,
    openedSha256: entry.openedSha256,
    openedMtimeMs: entry.openedMtimeMs,
    openedAt: entry.openedAt,
    projects,
  };
  await mkdir(workspaceDir, { recursive: true });
  await writeFileAtomic(syncStatePath(workspaceDir), JSON.stringify(nextState, null, 2) + '\n', { overwrite: true });
  return nextState;
}

export async function checkProjectDirtyFromLmms(project, {
  workspaceDir,
  env = process.env,
  adoptCompressedCopy = true,
} = {}) {
  const cleanName = validateProjectName(project);
  const wsDir = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  const state = await readSyncState(wsDir);
  const entry = state.projects?.[cleanName] ?? null;
  if (!entry || typeof entry.openedSha256 !== 'string') {
    return { tracked: false, dirty: false, project: cleanName, entry: null };
  }

  const projectPath = path.join(wsDir, cleanName);
  const linkInfo = await lstat(projectPath).catch(() => null);
  let currentSha256 = null;
  let currentMtimeMs = null;
  if (linkInfo && !linkInfo.isSymbolicLink() && linkInfo.isFile()) {
    currentSha256 = await sha256File(projectPath);
    currentMtimeMs = linkInfo.mtimeMs;
  }

  const sibling = adoptCompressedCopy ? await inspectOptionalSibling(wsDir, cleanName) : null;
  const projectChanged = currentSha256 !== null && currentSha256.toLowerCase() !== entry.openedSha256.toLowerCase();
  const siblingChanged = Boolean(
    sibling && sibling.sha256.toLowerCase() !== String(entry.siblingSha256 ?? '').toLowerCase(),
  );

  return {
    tracked: true,
    dirty: projectChanged || siblingChanged,
    projectChanged,
    siblingChanged,
    project: cleanName,
    entry,
    currentSha256,
    currentMtimeMs,
    sibling,
  };
}

export async function assertProjectNotDirtyFromLmms(project, options = {}) {
  if (!project || typeof project !== 'string' || !PROJECT_NAME_PATTERN.test(project.trim())) return;
  const status = await checkProjectDirtyFromLmms(project, options);
  if (status.dirty) {
    const where = status.siblingChanged && !status.projectChanged
      ? `sibling compressed copy "${status.sibling.name}"`
      : `"${status.project}"`;
    throw new Error(
      `Un-synced Desktop LMMS edits detected on ${where} since open_in_lmms (opened sha256 ${status.entry.openedSha256.slice(0, 12)}...). ` +
      `Call sync_from_lmms({ project: "${status.project}" }) before running MCP edits so user changes are provenance-checked and preserved.`,
    );
  }
}

export async function recordMcpProjectSave(project, { workspaceDir, env = process.env } = {}) {
  if (!project || typeof project !== 'string' || !PROJECT_NAME_PATTERN.test(project.trim())) return;
  const cleanName = project.trim();
  const wsDir = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  const state = await readSyncState(wsDir);
  const existing = state.projects?.[cleanName];
  if (!existing) return;

  const projectPath = path.join(wsDir, cleanName);
  const info = await stat(projectPath).catch(() => null);
  if (!info?.isFile()) return;
  const newSha256 = await sha256File(projectPath);
  const sibling = await inspectOptionalSibling(wsDir, cleanName);
  await writeSyncEntry(wsDir, {
    ...existing,
    project: cleanName,
    openedSha256: newSha256,
    openedMtimeMs: info.mtimeMs,
    siblingSha256: sibling?.sha256 ?? null,
    siblingMtimeMs: sibling?.mtimeMs ?? null,
  });
}

async function spawnDetachedLmms(executable, projectRealPath, workspaceDir) {
  if (path.isAbsolute(executable) && !existsSync(executable)) {
    throw new Error(`LMMS executable not found at "${executable}". Set LMMS_EXECUTABLE to your lmms binary.`);
  }
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [projectRealPath], {
        cwd: workspaceDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

export async function openInLmms({
  project,
  workspaceDir,
  soundfontsDir,
  presetsDir,
  lmmsExecutable,
  env = process.env,
  launcher,
  logger = defaultLog,
} = {}) {
  const cleanName = validateProjectName(project);
  const wsDir = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  const sfDir = path.resolve(soundfontsDir ?? resolveSoundfontsDir(env));
  const exe = lmmsExecutable ?? resolveLmmsExecutable(env);
  const prDir = path.resolve(presetsDir ?? resolveLmmsPresetsDir(env, exe));

  const candidatePath = path.join(wsDir, cleanName);
  const linkInfo = await lstat(candidatePath).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (!linkInfo) {
    throw Object.assign(new Error(`Project "${cleanName}" was not found in the workspace`), { status: 404 });
  }
  if (linkInfo.isSymbolicLink()) {
    throw Object.assign(new Error(`Refusing symbolic link or junction for project "${cleanName}"`), { status: 403 });
  }
  const { realPath, realContainer } = await assertRealpathContained(candidatePath, wsDir, 'Project file');

  const rawBuffer = await readFile(realPath);
  const { doc } = decodeProjectXmlBuffer(rawBuffer, cleanName);
  const auditReport = await auditProjectProvenance(doc, {
    projectName: cleanName,
    workspaceDir: realContainer,
    soundfontsDir: sfDir,
    presetsDir: prDir,
    env,
  });
  if (auditReport.strictMode && !auditReport.compliant) {
    throw new Error(
      `Strict copyright provenance gate blocked "${cleanName}": ${auditReport.issues.join('; ')}`,
    );
  }

  const openedSha256 = await sha256File(realPath);
  const fileStat = await stat(realPath);
  const openedMtimeMs = fileStat.mtimeMs;
  const openedAt = new Date().toISOString();
  const sibling = await inspectOptionalSibling(realContainer, cleanName);

  await writeSyncEntry(realContainer, {
    project: cleanName,
    openedSha256,
    openedMtimeMs,
    openedAt,
    siblingSha256: sibling?.sha256 ?? null,
    siblingMtimeMs: sibling?.mtimeMs ?? null,
  });

  const args = [realPath];
  let launched = false;
  let skippedLaunchReason = null;

  if (typeof launcher === 'function') {
    await launcher({
      executable: exe,
      args,
      project: cleanName,
      projectPath: realPath,
      workspaceDir: realContainer,
      env,
    });
    launched = true;
  } else if (isNoGuiLaunch(env)) {
    launched = false;
    skippedLaunchReason = 'LMMS_NO_GUI_LAUNCH';
    logger.info('Skipped Desktop LMMS GUI spawn due to LMMS_NO_GUI_LAUNCH', { project: cleanName });
  } else {
    await spawnDetachedLmms(exe, realPath, realContainer);
    launched = true;
    logger.info('Launched Desktop LMMS for project', { project: cleanName, executable: exe });
  }

  return {
    project: cleanName,
    projectPath: realPath,
    executable: exe,
    args,
    launched,
    ...(skippedLaunchReason ? { skippedLaunchReason } : {}),
    openedSha256,
    openedMtimeMs,
    openedAt,
    syncStateFile: SYNC_STATE_FILE,
    next: 'Edit and save in Desktop LMMS (Ctrl+S), then call sync_from_lmms before running further MCP project edits.',
  };
}

function formatProvenanceSyncError(fileName, report) {
  const nonCompliantTracks = (report.tracksOrInputs ?? []).filter(t => !t.compliant);
  const details = nonCompliantTracks.length > 0
    ? nonCompliantTracks.map(t => {
      const pluginLabel = t.plugin ? ` (plugin "${t.plugin}")` : '';
      const trackReason = Array.isArray(t.issues) && t.issues.length > 0
        ? t.issues.join('; ')
        : 'unverified source';
      return `Track "${t.track}"${pluginLabel}: ${trackReason}`;
    })
    : report.issues;
  return (
    `sync_from_lmms could not adopt "${fileName}" because strict copyright provenance rejected Desktop LMMS additions: ` +
    `${details.join(' | ')}. ` +
    `Your saved file on disk was preserved untouched. Replace the unverified sample or plugin with a pure-synthesis instrument, ` +
    `synth drum, or locked CC0-1.0 SoundFont (.sf2), save in LMMS, and run sync_from_lmms again.`
  );
}

export async function syncFromLmms({
  project,
  adoptCompressedCopy = true,
  workspaceDir,
  soundfontsDir,
  presetsDir,
  env = process.env,
  logger = defaultLog,
} = {}) {
  const cleanName = validateProjectName(project);
  const wsDir = path.resolve(workspaceDir ?? resolveWorkspaceDir(env));
  const sfDir = path.resolve(soundfontsDir ?? resolveSoundfontsDir(env));
  const exe = resolveLmmsExecutable(env);
  const prDir = path.resolve(presetsDir ?? resolveLmmsPresetsDir(env, exe));

  const realContainer = await realpath(wsDir);
  const dirtyStatus = await checkProjectDirtyFromLmms(cleanName, {
    workspaceDir: realContainer,
    env,
    adoptCompressedCopy,
  });

  const projectCandidatePath = path.join(realContainer, cleanName);
  const projectLinkInfo = await lstat(projectCandidatePath).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (projectLinkInfo?.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link or junction for project "${cleanName}"`);
  }

  const sibling = adoptCompressedCopy ? await inspectOptionalSibling(realContainer, cleanName) : null;
  if (!projectLinkInfo && !sibling) {
    throw new Error(`Project "${cleanName}" was not found in the workspace`);
  }

  let useSibling = false;
  if (sibling) {
    if (!projectLinkInfo) {
      useSibling = true;
    } else if (dirtyStatus.tracked) {
      if (dirtyStatus.siblingChanged && (!dirtyStatus.projectChanged || sibling.mtimeMs >= (dirtyStatus.currentMtimeMs ?? 0))) {
        useSibling = true;
      }
    } else if (sibling.mtimeMs > projectLinkInfo.mtimeMs) {
      useSibling = true;
    }
  }

  const sourcePath = useSibling
    ? sibling.path
    : (await assertRealpathContained(projectCandidatePath, realContainer, 'Project file')).realPath;
  const sourceFileName = useSibling ? sibling.name : cleanName;

  const rawBuffer = await readFile(sourcePath);
  const { doc, xmlBuffer } = decodeProjectXmlBuffer(rawBuffer, sourceFileName);

  const report = await auditProjectProvenance(doc, {
    projectName: sourceFileName,
    workspaceDir: realContainer,
    soundfontsDir: sfDir,
    presetsDir: prDir,
    env,
  });

  if (report.strictMode && !report.compliant) {
    throw new Error(formatProvenanceSyncError(sourceFileName, report));
  }

  let adoptedCompressedCopy = false;
  if (useSibling && /\.mmp$/i.test(cleanName)) {
    await writeFileAtomic(projectCandidatePath, xmlBuffer, { overwrite: true });
    adoptedCompressedCopy = true;
    await writeProjectOrRenderProvenance(sibling.path, report, {
      workspaceDir: realContainer,
      generatorTool: 'sync_from_lmms',
    });
  }

  const finalProjectContained = await assertRealpathContained(projectCandidatePath, realContainer, 'Project file');
  const provenanceRecord = await writeProjectOrRenderProvenance(finalProjectContained.realPath, report, {
    workspaceDir: realContainer,
    generatorTool: 'sync_from_lmms',
  });

  const finalSha256 = await sha256File(finalProjectContained.realPath);
  const finalStat = await stat(finalProjectContained.realPath);
  const refreshedSibling = await inspectOptionalSibling(realContainer, cleanName);
  const syncedAt = new Date().toISOString();

  await writeSyncEntry(realContainer, {
    project: cleanName,
    openedSha256: finalSha256,
    openedMtimeMs: finalStat.mtimeMs,
    openedAt: dirtyStatus.entry?.openedAt ?? syncedAt,
    syncedAt,
    siblingSha256: refreshedSibling?.sha256 ?? null,
    siblingMtimeMs: refreshedSibling?.mtimeMs ?? null,
  });

  const summary = summarizeDoc(doc);
  const previousSha256 = dirtyStatus.entry?.openedSha256 ?? null;
  const changed = previousSha256 ? previousSha256.toLowerCase() !== finalSha256.toLowerCase() || adoptedCompressedCopy : true;

  logger.info('Synced project from Desktop LMMS', {
    project: cleanName,
    changed,
    adoptedCompressedCopy,
    classification: report.classification,
  });

  return {
    project: cleanName,
    synced: true,
    changed,
    adoptedCompressedCopy,
    sourceFile: sourceFileName,
    previousSha256,
    sha256: finalSha256,
    classification: report.classification,
    provenanceFile: path.basename(`${finalProjectContained.realPath}.provenance.json`),
    strictCompliant: provenanceRecord.strictCompliant,
    bpm: summary.bpm,
    timeSignature: summary.timeSignature,
    tracks: summary.tracks,
  };
}

export function register({ tool, z, root, paths, schemas, moduleGuidance, logger }) {
  const syncLogger = logger?.child ? logger.child('lmms-sync') : defaultLog;
  moduleGuidance.push(
    'When the user wants to inspect or tweak notes/mix in Desktop LMMS, call open_in_lmms on the workspace project; after they save in LMMS, call sync_from_lmms to verify copyright provenance and adopt their edits before any further MCP edits.',
  );

  tool(
    'open_in_lmms',
    'Validate a workspace LMMS project (.mmp or .mmpz), record its SHA-256 baseline in .studio-lmms-sync.json so un-synced user edits are never overwritten, and open it in Desktop LMMS.',
    {
      project: schemas.projectName.describe('Workspace LMMS project (.mmp or .mmpz) to open in Desktop LMMS.'),
    },
    async ({ project }) => openInLmms({
      project,
      workspaceDir: root,
      soundfontsDir: paths?.soundfonts,
      presetsDir: paths?.presets,
      lmmsExecutable: paths?.lmms,
      env: process.env,
      logger: syncLogger,
    }),
  );

  tool(
    'sync_from_lmms',
    'Adopt user edits saved from Desktop LMMS (including a sibling .mmpz created by Save/Save As), verify every track and plugin against strict copyright provenance, update <project>.provenance.json, and advance .studio-lmms-sync.json.',
    {
      project: schemas.projectName.describe('Workspace LMMS project (.mmp or .mmpz) previously opened in LMMS.'),
      adoptCompressedCopy: z.boolean().default(true)
        .describe('When project is .mmp and the user saved a newer sibling .mmpz in LMMS, adopt its XML into the .mmp file.'),
    },
    async ({ project, adoptCompressedCopy }) => syncFromLmms({
      project,
      adoptCompressedCopy,
      workspaceDir: root,
      soundfontsDir: paths?.soundfonts,
      presetsDir: paths?.presets,
      env: process.env,
      logger: syncLogger,
    }),
  );
}
