// Deterministic SoundFont 2.01 (RIFF sfbk) binary compiler, parser, and single-articulation SFZ flattener.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommandSafe, writeFileAtomic } from './fs-atomic.mjs';
import { createLogger } from './logger.mjs';
import { resolveFfmpegExecutable } from './workspace-config.mjs';

const log = createLogger('sf2-builder');

export const SF2_GENERATORS = Object.freeze({
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  pan: 17,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  initialAttenuation: 48,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  exclusiveClass: 57,
  overridingRootKey: 58,
});

export const SF2_SAMPLE_TYPES = Object.freeze({
  monoSample: 1,
  leftSample: 2,
  rightSample: 4,
});

export const SF2_GUARD_SAMPLES = 46;

const NOTE_PITCH_CLASS = Object.freeze({
  c: 0,
  'c#': 1, cs: 1, db: 1,
  d: 2,
  'd#': 3, ds: 3, eb: 3,
  e: 4, fb: 3,
  f: 5, 'e#': 5,
  'f#': 6, fs: 6, gb: 6,
  g: 7,
  'g#': 8, gs: 8, ab: 8,
  a: 9,
  'a#': 10, as: 10, bb: 10,
  b: 11, cb: 11,
});

export function parseSfzNote(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(127, Math.round(value)));
  }
  const raw = String(value ?? '').trim();
  if (/^-?\d+$/.test(raw)) {
    return Math.max(0, Math.min(127, Number.parseInt(raw, 10)));
  }
  const match = /^([a-g](?:[#b]|s)?)(-?\d+)$/i.exec(raw);
  if (!match) {
    throw new Error(`Invalid SFZ MIDI note value: "${value}"`);
  }
  const pc = NOTE_PITCH_CLASS[match[1].toLowerCase()];
  const octave = Number.parseInt(match[2], 10);
  if (pc === undefined || !Number.isFinite(octave)) {
    throw new Error(`Invalid SFZ MIDI note value: "${value}"`);
  }
  return Math.max(0, Math.min(127, (octave + 1) * 12 + pc));
}

function stripSfzComments(source) {
  const withoutBlock = String(source).replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlock
    .split(/\r?\n/)
    .map(line => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function expandMacrosInText(text, macros) {
  if (!macros.size || !text.includes('$')) return text;
  const sortedKeys = [...macros.keys()].sort((a, b) => b.length - a.length);
  let current = text;
  for (let pass = 0; pass < 4 && current.includes('$'); pass++) {
    let changed = false;
    for (const key of sortedKeys) {
      if (current.includes(key)) {
        current = current.split(key).join(macros.get(key));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

function resolveContainedPath(baseDir, candidatePath, boundaryDir) {
  const normalizedRel = candidatePath.replaceAll('\\', '/');
  const resolved = path.resolve(baseDir, normalizedRel);
  if (boundaryDir) {
    const rel = path.relative(boundaryDir, resolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error(`SFZ path escapes library boundary: ${candidatePath}`);
    }
  }
  return resolved;
}

export async function preprocessSfzFile(sfzPath, {
  boundaryDir,
  macros = new Map(),
  rootSfzDir,
  includeStack = [],
} = {}) {
  const resolvedSfz = path.resolve(sfzPath);
  const effectiveRootDir = rootSfzDir ?? path.dirname(resolvedSfz);
  const effectiveBoundary = boundaryDir ? path.resolve(boundaryDir) : null;
  if (includeStack.includes(resolvedSfz)) {
    throw new Error(`Circular SFZ #include detected: ${[...includeStack, resolvedSfz].join(' -> ')}`);
  }
  if (includeStack.length >= 16) {
    throw new Error(`SFZ #include depth exceeded 16 at ${resolvedSfz}`);
  }

  const rawText = await readFile(resolvedSfz, 'utf8');
  const stripped = stripSfzComments(rawText);
  const lines = stripped.split('\n');
  const outputChunks = [];
  const currentFileDir = path.dirname(resolvedSfz);

  for (const rawLine of lines) {
    let line = expandMacrosInText(rawLine, macros);

    // Process #define directives before any #include resolution on this or later lines.
    const defineRegex = /#define\s+(\$[A-Za-z0-9_]+)\s+([^\r\n#]+?)(?=\s+#define|\s+#include|$)/g;
    let hadDefine = false;
    line = line.replace(defineRegex, (_full, macroName, macroVal) => {
      hadDefine = true;
      const expandedVal = expandMacrosInText(macroVal.trim(), macros);
      macros.set(macroName, expandedVal);
      return '';
    });
    if (hadDefine) {
      line = expandMacrosInText(line, macros);
    }

    if (!line.includes('#include')) {
      outputChunks.push(line);
      continue;
    }

    // Expand #include directives inline (including when on the same line as <group> or <region>).
    const includeRegex = /#include\s+"([^"]+)"/g;
    let cursor = 0;
    let match;
    while ((match = includeRegex.exec(line)) !== null) {
      const before = expandMacrosInText(line.slice(cursor, match.index), macros);
      if (before.trim()) outputChunks.push(before);
      const rawIncludeTarget = expandMacrosInText(match[1].trim(), macros);
      const fromRoot = resolveContainedPath(effectiveRootDir, rawIncludeTarget, effectiveBoundary);
      const fromCurrent = resolveContainedPath(currentFileDir, rawIncludeTarget, effectiveBoundary);
      const targetFile = existsSync(fromRoot) ? fromRoot : fromCurrent;
      if (!existsSync(targetFile)) {
        throw new Error(`SFZ #include file not found: "${rawIncludeTarget}" (from ${resolvedSfz})`);
      }
      const nested = await preprocessSfzFile(targetFile, {
        boundaryDir: effectiveBoundary,
        macros,
        rootSfzDir: effectiveRootDir,
        includeStack: [...includeStack, resolvedSfz],
      });
      outputChunks.push(nested);
      line = expandMacrosInText(line, macros);
      cursor = match.index + match[0].length;
    }
    const after = expandMacrosInText(line.slice(cursor), macros);
    if (after.trim()) outputChunks.push(after);
  }

  return outputChunks.join('\n');
}

export function parseOpcodesBlock(blockText) {
  const opcodes = {};
  const matches = [];
  const opcodeStart = /(?:^|\s)([A-Za-z0-9_$]+)=/g;
  let match;
  while ((match = opcodeStart.exec(blockText)) !== null) {
    const key = match[1].toLowerCase();
    const valueStart = match.index + match[0].length;
    matches.push({ key, matchIndex: match.index, valueStart });
  }
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const valueEnd = i + 1 < matches.length ? matches[i + 1].matchIndex : blockText.length;
    const rawVal = blockText.slice(current.valueStart, valueEnd).trim();
    opcodes[current.key] = rawVal;
  }
  return opcodes;
}

export function resolveVelocityCrossfades(regions) {
  const byKeySpan = new Map();
  for (const region of regions) {
    const spanKey = `${region.lokey}:${region.hikey}:${region.exclusiveClass ?? 0}`;
    if (!byKeySpan.has(spanKey)) byKeySpan.set(spanKey, []);
    byKeySpan.get(spanKey).push({ ...region });
  }

  const output = [];
  for (const group of byKeySpan.values()) {
    group.sort((a, b) => {
      const centerA = (a.lovel + a.hivel) / 2;
      const centerB = (b.lovel + b.hivel) / 2;
      return centerA - centerB || a.lovel - b.lovel || a.hivel - b.hivel || a._order - b._order;
    });

    // Deduplicate exact [lovel, hivel] collisions on the same key span by keeping the first region.
    const unique = [];
    for (const item of group) {
      const prev = unique.at(-1);
      if (prev && prev.lovel === item.lovel && prev.hivel === item.hivel &&
          prev.xfin_lovel === item.xfin_lovel && prev.xfout_hivel === item.xfout_hivel) {
        continue;
      }
      unique.push(item);
    }

    for (let i = 0; i + 1 < unique.length; i++) {
      const lower = unique[i];
      const upper = unique[i + 1];
      const hasOverlap = lower.hivel >= upper.lovel ||
        (lower.xfout_hivel !== undefined && upper.xfin_lovel !== undefined && lower.xfout_hivel >= upper.xfin_lovel);
      if (!hasOverlap) continue;

      const overlapLo = Math.max(lower.lovel, upper.xfin_lovel ?? upper.lovel);
      const overlapHi = Math.min(upper.hivel, lower.xfout_hivel ?? lower.hivel);
      const midpoint = overlapLo <= overlapHi
        ? Math.floor((overlapLo + overlapHi) / 2)
        : Math.floor((lower.hivel + upper.lovel) / 2);
      const clampedMid = Math.max(lower.lovel, Math.min(upper.hivel - 1, midpoint));
      lower.hivel = clampedMid;
      upper.lovel = clampedMid + 1;
    }

    for (const item of unique) {
      if (item.lovel <= item.hivel) {
        delete item.xfin_lovel;
        delete item.xfin_hivel;
        delete item.xfout_lovel;
        delete item.xfout_hivel;
        output.push(item);
      }
    }
  }

  return output.sort((a, b) => a.lokey - b.lokey || a.lovel - b.lovel || a._order - b._order);
}

function coalesceKeyZones(regions, stride) {
  if (!stride || stride <= 1 || regions.length <= 1) return regions;
  const sorted = [...regions].sort((a, b) => a.lokey - b.lokey || a.hikey - b.hikey);
  // Only coalesce single-velocity non-overlapping melodic key maps.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].lokey <= sorted[i - 1].hikey) return regions;
  }
  const merged = [];
  for (let i = 0; i < sorted.length; i += stride) {
    const chunk = sorted.slice(i, i + stride);
    const chosen = chunk[Math.floor((chunk.length - 1) / 2)];
    merged.push({
      ...chosen,
      lokey: chunk[0].lokey,
      hikey: chunk.at(-1).hikey,
    });
  }
  return merged;
}

export async function parseSfzArticulation(sfzPath, {
  boundaryDir,
  drumMode = false,
  keyFilter,
  allowedKeys,
  targetVelocity,
  zoneStride = 1,
} = {}) {
  const resolvedSfz = path.resolve(sfzPath);
  const rootSfzDir = path.dirname(resolvedSfz);
  const effectiveBoundary = boundaryDir ? path.resolve(boundaryDir) : null;
  const expanded = await preprocessSfzFile(resolvedSfz, { boundaryDir: effectiveBoundary, rootSfzDir });

  const headerRegex = /<([a-zA-Z0-9_]+)>/g;
  const sections = [];
  let match;
  let lastHeader = null;
  let lastContentStart = 0;
  while ((match = headerRegex.exec(expanded)) !== null) {
    if (lastHeader !== null) {
      sections.push({
        header: lastHeader.toLowerCase(),
        body: expanded.slice(lastContentStart, match.index),
      });
    }
    lastHeader = match[1];
    lastContentStart = match.index + match[0].length;
  }
  if (lastHeader !== null) {
    sections.push({
      header: lastHeader.toLowerCase(),
      body: expanded.slice(lastContentStart),
    });
  }

  let defaultPath = '';
  let octaveOffset = 0;
  let noteOffset = 0;
  const controlCC = new Map();
  let globalState = {};
  let masterState = {};
  let groupState = {};
  const rawRegions = [];
  let fileSwDefault;

  for (const section of sections) {
    const opcodes = parseOpcodesBlock(section.body);
    if (opcodes.sw_default !== undefined && fileSwDefault === undefined) {
      fileSwDefault = parseSfzNote(opcodes.sw_default);
    }
    switch (section.header) {
      case 'control': {
        if (opcodes.default_path !== undefined) {
          defaultPath = opcodes.default_path.replaceAll('\\', '/');
          if (defaultPath && !defaultPath.endsWith('/')) defaultPath += '/';
        }
        if (opcodes.octave_offset !== undefined) octaveOffset = Number(opcodes.octave_offset) || 0;
        if (opcodes.note_offset !== undefined) noteOffset = Number(opcodes.note_offset) || 0;
        for (const [k, v] of Object.entries(opcodes)) {
          const ccMatch = /^set_(?:hd)?cc(\d+)$/i.exec(k);
          if (ccMatch) controlCC.set(Number.parseInt(ccMatch[1], 10), Number(v));
        }
        break;
      }
      case 'global': {
        globalState = { ...opcodes };
        masterState = {};
        groupState = {};
        break;
      }
      case 'master': {
        masterState = { ...opcodes };
        groupState = {};
        break;
      }
      case 'group': {
        groupState = { ...opcodes };
        break;
      }
      case 'region': {
        const merged = { ...globalState, ...masterState, ...groupState };
        // If a narrower scope sets `key`, clear broader `lokey`/`hikey`/`pitch_keycenter` before applying region opcodes.
        for (const scope of [globalState, masterState, groupState, opcodes]) {
          if (scope.key !== undefined) {
            merged.key = scope.key;
            if (scope.lokey === undefined) delete merged.lokey;
            if (scope.hikey === undefined) delete merged.hikey;
            if (scope.pitch_keycenter === undefined) delete merged.pitch_keycenter;
          }
          Object.assign(merged, scope);
        }
        rawRegions.push({
          opcodes: merged,
          defaultPath,
          octaveOffset,
          noteOffset,
          setCC: new Map(controlCC),
          order: rawRegions.length,
        });
        break;
      }
      default:
        // Ignore SFZ2 <curve>, <effect>, <midi>, <sample> sections cleanly.
        break;
    }
  }

  // Fallback keyswitch if sw_last is used without sw_default: pick lowest sw_last value.
  if (fileSwDefault === undefined) {
    const swCandidates = rawRegions
      .map(r => r.opcodes.sw_last)
      .filter(v => v !== undefined)
      .map(parseSfzNote);
    if (swCandidates.length) fileSwDefault = Math.min(...swCandidates);
  }

  const allowedSet = allowedKeys ? new Set(allowedKeys) : null;
  const candidateRegions = [];
  const cc4Key42Candidates = [];

  for (const entry of rawRegions) {
    const op = entry.opcodes;
    if (!op.sample || op.sample.startsWith('*')) continue;
    const trigger = (op.trigger ?? 'attack').toLowerCase();
    if (trigger !== 'attack') continue;

    // 1. Default keyswitch filter.
    const swDefault = op.sw_default !== undefined ? parseSfzNote(op.sw_default) : fileSwDefault;
    if (op.sw_last !== undefined) {
      if (swDefault !== undefined && parseSfzNote(op.sw_last) !== swDefault) continue;
    } else if (op.sw_down !== undefined) {
      if (swDefault === undefined || parseSfzNote(op.sw_down) !== swDefault) continue;
    } else if (op.sw_lokey !== undefined) {
      const swLo = parseSfzNote(op.sw_lokey);
      const swHi = op.sw_hikey !== undefined ? parseSfzNote(op.sw_hikey) : swLo;
      if (swDefault !== undefined && (swDefault < swLo || swDefault > swHi)) continue;
    }

    // 2. Channel 1 only filter.
    const lochan = op.lochan !== undefined ? Number(op.lochan) : 1;
    const hichan = op.hichan !== undefined ? Number(op.hichan) : 16;
    if (!(lochan <= 1 && hichan >= 1)) continue;

    // 3. Single round-robin filter.
    const seqPos = op.seq_position !== undefined ? Number(op.seq_position) : 1;
    if (seqPos !== 1) continue;
    if (op.lorand !== undefined && Number(op.lorand) > 0.001) continue;

    // 4. CC-gated FX / trigger filter (with drum CC4 hi-hat support).
    const opKeys = Object.keys(op);
    if (opKeys.some(k => /^on_(?:lo|hi)cc\d+$/i.test(k))) continue;

    const shift = entry.octaveOffset * 12 + entry.noteOffset;
    const baseKey = op.key !== undefined ? parseSfzNote(op.key) + shift : undefined;
    let lokey = Math.max(0, Math.min(127, (op.lokey !== undefined ? parseSfzNote(op.lokey) + shift : (baseKey ?? 0))));
    let hikey = Math.max(0, Math.min(127, (op.hikey !== undefined ? parseSfzNote(op.hikey) + shift : (baseKey ?? 127))));
    let pitchKeycenter = Math.max(0, Math.min(127, (op.pitch_keycenter !== undefined ? parseSfzNote(op.pitch_keycenter) + shift : (baseKey ?? 60))));

    const ccNums = new Set();
    for (const k of opKeys) {
      const m = /^(?:lo|hi)cc(\d+)$/i.exec(k);
      if (m) ccNums.add(Number.parseInt(m[1], 10));
    }

    const isCc4HiHat = ccNums.has(4) && lokey === 42 && hikey === 42;
    let blockedByCc = false;
    for (const cc of ccNums) {
      if (cc === 4 && isCc4HiHat) continue;
      const currentVal = entry.setCC.get(cc) ?? 0;
      const lo = op[`locc${cc}`] !== undefined ? Number(op[`locc${cc}`]) : 0;
      const hi = op[`hicc${cc}`] !== undefined ? Number(op[`hicc${cc}`]) : 127;
      if (currentVal < lo || currentVal > hi) {
        blockedByCc = true;
        break;
      }
    }
    if (blockedByCc) continue;

    const relSample = (entry.defaultPath + op.sample.replaceAll('\\', '/')).replace(/\/+/g, '/');
    const samplePath = resolveContainedPath(rootSfzDir, relSample, effectiveBoundary);

    const lovel = op.lovel !== undefined ? Math.max(0, Math.min(127, Number(op.lovel))) : 0;
    const hivel = op.hivel !== undefined ? Math.max(0, Math.min(127, Number(op.hivel))) : 127;

    const sfzGroup = op.group !== undefined ? Number(op.group) : undefined;
    const sfzOffBy = op.off_by !== undefined ? Number(op.off_by) : undefined;
    let exclusiveClass;
    if (drumMode && (lokey === 42 || lokey === 44 || lokey === 46) && lokey === hikey) {
      exclusiveClass = 1;
    } else if (Number.isInteger(sfzGroup) && sfzGroup > 0 && sfzGroup <= 127 && sfzGroup === sfzOffBy) {
      exclusiveClass = sfzGroup;
    }

    const parsedRegion = {
      samplePath,
      sampleRel: op.sample.replaceAll('\\', '/'),
      lokey,
      hikey,
      pitchKeycenter,
      lovel,
      hivel,
      xfin_lovel: op.xfin_lovel !== undefined ? Number(op.xfin_lovel) : undefined,
      xfin_hivel: op.xfin_hivel !== undefined ? Number(op.xfin_hivel) : undefined,
      xfout_lovel: op.xfout_lovel !== undefined ? Number(op.xfout_lovel) : undefined,
      xfout_hivel: op.xfout_hivel !== undefined ? Number(op.xfout_hivel) : undefined,
      volumeDb: op.volume !== undefined ? Number(op.volume) : 0,
      pan: op.pan !== undefined ? Number(op.pan) : 0,
      transpose: op.transpose !== undefined ? Math.round(Number(op.transpose)) : 0,
      tune: op.tune !== undefined ? Math.round(Number(op.tune)) : 0,
      loopMode: (op.loop_mode ?? '').toLowerCase(),
      loopStart: op.loop_start !== undefined ? Number(op.loop_start) : undefined,
      loopEnd: op.loop_end !== undefined ? Number(op.loop_end) : undefined,
      ampegAttack: op.ampeg_attack !== undefined ? Number(op.ampeg_attack) : undefined,
      ampegHold: op.ampeg_hold !== undefined ? Number(op.ampeg_hold) : undefined,
      ampegDecay: op.ampeg_decay !== undefined ? Number(op.ampeg_decay) : undefined,
      ampegSustain: op.ampeg_sustain !== undefined ? Number(op.ampeg_sustain) : undefined,
      ampegRelease: op.ampeg_release !== undefined ? Number(op.ampeg_release) : undefined,
      pitchKeytrack: op.pitch_keytrack !== undefined ? Number(op.pitch_keytrack) : 100,
      exclusiveClass,
      locc4: op.locc4 !== undefined ? Number(op.locc4) : undefined,
      hicc4: op.hicc4 !== undefined ? Number(op.hicc4) : undefined,
      _order: entry.order,
    };

    if (isCc4HiHat) {
      cc4Key42Candidates.push(parsedRegion);
    } else {
      candidateRegions.push(parsedRegion);
    }
  }

  // Resolve drum CC4 hi-hat bands on key 42 into closed (key 42, exclusiveClass=1) and open (key 46, exclusiveClass=1).
  if (cc4Key42Candidates.length > 0) {
    const bands = new Map();
    for (const reg of cc4Key42Candidates) {
      const lo = reg.locc4 ?? 0;
      const hi = reg.hicc4 ?? 127;
      const key = `${lo}:${hi}`;
      if (!bands.has(key)) bands.set(key, { lo, hi, regions: [] });
      bands.get(key).regions.push(reg);
    }
    const bandList = [...bands.values()].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const lowestBand = bandList[0];
    const highestBand = bandList.at(-1);

    const isNamedOpen = list => list.some(r => /(?:^|[_/-])open(?:[_/.-]|$)/i.test(r.sampleRel));
    const isNamedClosed = list => list.some(r => /(?:^|[_/-])closed(?:[_/.-]|$)/i.test(r.sampleRel));

    let closedBand = lowestBand;
    let openBand = bandList.length > 1 ? highestBand : null;
    if (openBand && isNamedOpen(lowestBand.regions) && isNamedClosed(highestBand.regions)) {
      closedBand = highestBand;
      openBand = lowestBand;
    }

    for (const reg of closedBand.regions) {
      candidateRegions.push({
        ...reg,
        lokey: 42,
        hikey: 42,
        pitchKeycenter: 42,
        exclusiveClass: 1,
      });
    }
    if (openBand && openBand !== closedBand) {
      for (const reg of openBand.regions) {
        candidateRegions.push({
          ...reg,
          lokey: 46,
          hikey: 46,
          pitchKeycenter: 46,
          exclusiveClass: 1,
        });
      }
    }
  }

  // Apply keyFilter and allowedKeys after hi-hat 42 -> 46 remapping.
  const keyFiltered = [];
  for (const reg of candidateRegions) {
    let { lokey, hikey } = reg;
    if (keyFilter) {
      if (typeof keyFilter === 'function') {
        if (!keyFilter(lokey, hikey, reg)) continue;
      } else {
        const minKey = keyFilter.minKey ?? 0;
        const maxKey = keyFilter.maxKey ?? 127;
        lokey = Math.max(lokey, minKey);
        hikey = Math.min(hikey, maxKey);
        if (lokey > hikey) continue;
      }
    }
    if (allowedSet) {
      let anyAllowed = false;
      for (let k = lokey; k <= hikey; k++) {
        if (allowedSet.has(k)) { anyAllowed = true; break; }
      }
      if (!anyAllowed) continue;
    }
    keyFiltered.push({ ...reg, lokey, hikey });
  }

  let flattened = resolveVelocityCrossfades(keyFiltered);

  if (targetVelocity !== undefined) {
    const bySpan = new Map();
    for (const reg of flattened) {
      const k = `${reg.lokey}:${reg.hikey}:${reg.exclusiveClass ?? 0}`;
      if (!bySpan.has(k)) bySpan.set(k, []);
      bySpan.get(k).push(reg);
    }
    const singleVel = [];
    for (const group of bySpan.values()) {
      const exact = group.find(r => r.lovel <= targetVelocity && targetVelocity <= r.hivel);
      const chosen = exact ?? group.reduce((best, cur) => {
        const distBest = Math.min(Math.abs(targetVelocity - best.lovel), Math.abs(targetVelocity - best.hivel));
        const distCur = Math.min(Math.abs(targetVelocity - cur.lovel), Math.abs(targetVelocity - cur.hivel));
        return distCur < distBest ? cur : best;
      });
      singleVel.push({ ...chosen, lovel: 0, hivel: 127 });
    }
    flattened = singleVel.sort((a, b) => a.lokey - b.lokey || a._order - b._order);
  }

  if (zoneStride > 1) {
    flattened = coalesceKeyZones(flattened, zoneStride);
  }

  for (const reg of flattened) {
    delete reg.locc4;
    delete reg.hicc4;
    delete reg._order;
  }

  return flattened;
}

function parseWavLoopPoints(rawBuffer) {
  if (rawBuffer.length < 44 || rawBuffer.toString('ascii', 0, 4) !== 'RIFF' || rawBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  for (let offset = 12; offset + 8 <= rawBuffer.length;) {
    const chunkId = rawBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = rawBuffer.readUInt32LE(offset + 4);
    const chunkEnd = Math.min(rawBuffer.length, offset + 8 + chunkSize);
    if (chunkId === 'smpl' && chunkEnd - (offset + 8) >= 60) {
      const body = rawBuffer.subarray(offset + 8, chunkEnd);
      const numLoops = body.readUInt32LE(28);
      if (numLoops >= 1) {
        const start = body.readUInt32LE(36 + 8);
        const end = body.readUInt32LE(36 + 12);
        if (end > start) return { loopStart: start, loopEnd: end };
      }
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  return null;
}

function parseStreamedPcm16Wav(wavBuffer) {
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('ffmpeg did not emit a valid RIFF WAVE stream');
  }
  let fmt = null;
  let data = null;
  for (let offset = 12; offset + 8 <= wavBuffer.length;) {
    const id = wavBuffer.toString('ascii', offset, offset + 4);
    const size = wavBuffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const end = size === 0xffffffff ? wavBuffer.length : Math.min(wavBuffer.length, offset + 8 + size);
      data = wavBuffer.subarray(offset + 8, end);
      break;
    }
    const end = Math.min(wavBuffer.length, offset + 8 + size);
    if (id === 'fmt ') fmt = wavBuffer.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data) {
    throw new Error('Decoded WAV stream missing fmt or data chunk');
  }
  const formatTag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitsPerSample = fmt.readUInt16LE(14);
  if ((formatTag !== 1 && formatTag !== 0xfffe) || bitsPerSample !== 16 || (channels !== 1 && channels !== 2)) {
    throw new Error(`Unsupported decoded PCM format: tag=${formatTag}, channels=${channels}, bits=${bitsPerSample}`);
  }
  const frameBytes = channels * 2;
  const frames = Math.floor(data.length / frameBytes);
  if (frames <= 0) {
    throw new Error('Decoded audio sample has zero frames');
  }
  const channelArrays = Array.from({ length: channels }, () => new Int16Array(frames));
  for (let f = 0, byteOffset = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++, byteOffset += 2) {
      channelArrays[c][f] = data.readInt16LE(byteOffset);
    }
  }
  return { sampleRate, channels: channelArrays, frames };
}

export async function decodeAudioSamplePcm16(filePath, {
  ffmpeg = resolveFfmpegExecutable(process.env),
  gainDb = 0,
} = {}) {
  const resolved = path.resolve(filePath);
  let embeddedLoop = null;
  if (/\.wav$/i.test(resolved)) {
    const rawHeader = await readFile(resolved);
    embeddedLoop = parseWavLoopPoints(rawHeader);
  }

  const { stdout } = await runCommandSafe(
    ffmpeg,
    [
      '-nostdin',
      '-v', 'error',
      '-i', resolved,
      '-fflags', '+bitexact',
      '-flags:a', '+bitexact',
      '-acodec', 'pcm_s16le',
      '-f', 'wav',
      'pipe:1',
    ],
    { encoding: null, maxBuffer: 128 * 1024 * 1024, timeoutMs: 120000 },
  );

  const decoded = parseStreamedPcm16Wav(stdout);
  let residualAttenuationCb = 0;

  if (gainDb > 0.01) {
    let peakInt = 0;
    for (const ch of decoded.channels) {
      for (let i = 0; i < ch.length; i++) {
        const abs = Math.abs(ch[i]);
        if (abs > peakInt) peakInt = abs;
      }
    }
    if (peakInt > 0) {
      const requestedLinear = 10 ** (gainDb / 20);
      const maxSafeLinear = (32767 * 0.94) / peakInt;
      const appliedLinear = Math.min(requestedLinear, Math.max(1, maxSafeLinear));
      for (const ch of decoded.channels) {
        for (let i = 0; i < ch.length; i++) {
          ch[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * appliedLinear)));
        }
      }
    }
  } else if (gainDb < -0.01) {
    residualAttenuationCb = Math.min(1440, Math.round(-gainDb * 10));
  }

  return {
    ...decoded,
    embeddedLoop,
    residualAttenuationCb,
  };
}

function evenNullTerminatedAscii(text) {
  const clean = String(text ?? '').replace(/[^\x20-\x7E]/g, '?');
  const baseLen = clean.length + 1;
  const paddedLen = baseLen + (baseLen % 2);
  const buf = Buffer.alloc(paddedLen, 0);
  buf.write(clean, 0, clean.length, 'ascii');
  return buf;
}

function fixedAscii20(text) {
  const buf = Buffer.alloc(20, 0);
  const clean = String(text ?? '').replace(/[^\x20-\x7E]/g, '_').slice(0, 19);
  buf.write(clean, 0, clean.length, 'ascii');
  return buf;
}

function riffChunk(fourcc, payload) {
  const pad = payload.length % 2;
  const out = Buffer.alloc(8 + payload.length + pad, 0);
  out.write(fourcc, 0, 4, 'ascii');
  out.writeUInt32LE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

function riffList(listType, childChunks) {
  const body = Buffer.concat([Buffer.from(listType, 'ascii'), ...childChunks]);
  return riffChunk('LIST', body);
}

export function secondsToTimecents(seconds) {
  const clamped = Math.max(0.001, Math.min(100, Number(seconds) || 0.001));
  return Math.max(-12000, Math.min(8000, Math.round(1200 * Math.log2(clamped))));
}

function writeGenRecord(oper, amountInt16OrUint16, { unsigned = false } = {}) {
  const rec = Buffer.alloc(4);
  rec.writeUInt16LE(oper, 0);
  if (unsigned) rec.writeUInt16LE(amountInt16OrUint16 & 0xffff, 2);
  else rec.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(amountInt16OrUint16))), 2);
  return rec;
}

function writeRangeGenRecord(oper, lo, hi) {
  const rec = Buffer.alloc(4);
  rec.writeUInt16LE(oper, 0);
  rec.writeUInt8(Math.max(0, Math.min(127, Math.round(lo))), 2);
  rec.writeUInt8(Math.max(0, Math.min(127, Math.round(hi))), 3);
  return rec;
}

function sanitizeUniqueSampleName(rawBase, suffix, usedNames) {
  const suffixStr = suffix ?? '';
  const maxStem = 19 - suffixStr.length;
  const cleanStem = String(rawBase || 'sample').replace(/[^\x20-\x7E]/g, '_').slice(0, Math.max(1, maxStem));
  let candidate = `${cleanStem}${suffixStr}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    const numSuffix = `_${counter}${suffixStr}`;
    candidate = `${cleanStem.slice(0, Math.max(1, 19 - numSuffix.length))}${numSuffix}`;
    counter++;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Build a SoundFont 2.01 RIFF `sfbk` binary buffer from in-memory presets and decoded samples.
 *
 * Each preset: {
 *   name: string,
 *   bank: number (0..128),
 *   preset: number (0..127),
 *   zones: Array<{
 *     sampleName?: string,
 *     sampleRate: number,
 *     channels: Int16Array[], // length 1 (mono) or 2 (stereo L/R)
 *     lokey: number,
 *     hikey: number,
 *     lovel?: number,
 *     hivel?: number,
 *     rootKey: number,
 *     pan?: number, // -100..100
 *     attenuationCb?: number,
 *     coarseTune?: number,
 *     fineTune?: number,
 *     attackSeconds?: number,
 *     holdSeconds?: number,
 *     decaySeconds?: number,
 *     sustainPct?: number, // 0..100 (100 = full sustain)
 *     releaseSeconds?: number,
 *     loopMode?: number, // 0 = none, 1 = continuous, 3 = sustain
 *     loopStart?: number,
 *     loopEnd?: number,
 *     scaleTuning?: number,
 *     exclusiveClass?: number,
 *     sampleKey?: string, // optional deduplication key
 *   }>
 * }
 */
export function buildSf2Buffer({
  bankName = 'LMMS Music Studio Bank',
  copyright = 'CC0-1.0',
  software = 'lmms-music-studio',
  presets = [],
} = {}) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new Error('buildSf2Buffer requires at least one preset');
  }

  const sortedPresets = [...presets].sort((a, b) => (a.bank ?? 0) - (b.bank ?? 0) || (a.preset ?? 0) - (b.preset ?? 0));

  const samplePool = new Map();
  const shdrEntries = [];
  const smplBuffers = [];
  let currentSamplePointOffset = 0;
  const usedSampleNames = new Set(['EOS']);

  const appendMonoSample = ({ name, pcm, sampleRate, rootKey, loopStart, loopEnd, sampleType, sampleLink }) => {
    const frames = pcm.length;
    if (frames <= 0) throw new Error(`Sample "${name}" has zero frames`);
    const totalPoints = frames + SF2_GUARD_SAMPLES;
    const pcmBuf = Buffer.alloc(totalPoints * 2, 0);
    for (let i = 0; i < frames; i++) {
      pcmBuf.writeInt16LE(pcm[i], i * 2);
    }
    // Trailing 46 int16 samples remain 0x0000 per SF2 2.01 Section 7.2.
    smplBuffers.push(pcmBuf);

    const dwStart = currentSamplePointOffset;
    const dwEnd = dwStart + frames;
    const validLoop = loopStart !== undefined && loopEnd !== undefined && loopEnd > loopStart && loopEnd <= frames;
    const dwStartloop = validLoop ? dwStart + loopStart : dwStart + Math.min(8, Math.max(0, frames - 1));
    const dwEndloop = validLoop ? dwStart + loopEnd : dwStart + Math.max(0, frames - 1);
    currentSamplePointOffset += totalPoints;

    const index = shdrEntries.length;
    shdrEntries.push({
      name,
      dwStart,
      dwEnd,
      dwStartloop,
      dwEndloop,
      dwSampleRate: sampleRate,
      byOriginalPitch: Math.max(0, Math.min(127, Math.round(rootKey))),
      chPitchCorrection: 0,
      wSampleLink: sampleLink,
      sfSampleType: sampleType,
    });
    return index;
  };

  const registerSample = zone => {
    const dedupKey = zone.sampleKey ?? null;
    if (dedupKey && samplePool.has(dedupKey)) {
      return samplePool.get(dedupKey);
    }
    const chCount = zone.channels.length;
    if (chCount !== 1 && chCount !== 2) {
      throw new Error(`Sample must have 1 or 2 channels, got ${chCount}`);
    }
    const baseLabel = zone.sampleName || 'sample';
    let entry;
    if (chCount === 1) {
      const monoName = sanitizeUniqueSampleName(baseLabel, '', usedSampleNames);
      const monoIdx = appendMonoSample({
        name: monoName,
        pcm: zone.channels[0],
        sampleRate: zone.sampleRate,
        rootKey: zone.rootKey,
        loopStart: zone.loopStart,
        loopEnd: zone.loopEnd,
        sampleType: SF2_SAMPLE_TYPES.monoSample,
        sampleLink: 0,
      });
      entry = { stereo: false, monoIdx };
    } else {
      const leftName = sanitizeUniqueSampleName(baseLabel, 'L', usedSampleNames);
      const rightName = sanitizeUniqueSampleName(baseLabel, 'R', usedSampleNames);
      const leftIdx = shdrEntries.length;
      const rightIdx = leftIdx + 1;
      appendMonoSample({
        name: leftName,
        pcm: zone.channels[0],
        sampleRate: zone.sampleRate,
        rootKey: zone.rootKey,
        loopStart: zone.loopStart,
        loopEnd: zone.loopEnd,
        sampleType: SF2_SAMPLE_TYPES.leftSample,
        sampleLink: rightIdx,
      });
      appendMonoSample({
        name: rightName,
        pcm: zone.channels[1],
        sampleRate: zone.sampleRate,
        rootKey: zone.rootKey,
        loopStart: zone.loopStart,
        loopEnd: zone.loopEnd,
        sampleType: SF2_SAMPLE_TYPES.rightSample,
        sampleLink: leftIdx,
      });
      entry = { stereo: true, leftIdx, rightIdx };
    }
    if (dedupKey) samplePool.set(dedupKey, entry);
    return entry;
  };

  const phdrRecords = [];
  const pbagRecords = [];
  const pgenRecords = [];
  const instRecords = [];
  const ibagRecords = [];
  const igenRecords = [];

  for (const preset of sortedPresets) {
    if (!preset.zones?.length) {
      throw new Error(`Preset "${preset.name}" (bank ${preset.bank}, preset ${preset.preset}) has no zones`);
    }
    const instIdx = instRecords.length;
    const pbagIdx = pbagRecords.length;
    const pgenIdx = pgenRecords.length;

    phdrRecords.push({
      name: preset.name || `Preset ${preset.preset}`,
      preset: preset.preset ?? 0,
      bank: preset.bank ?? 0,
      pbagNdx: pbagIdx,
    });
    pbagRecords.push({ genNdx: pgenIdx, modNdx: 0 });
    pgenRecords.push(writeGenRecord(SF2_GENERATORS.instrument, instIdx, { unsigned: true }));

    const instStartIbag = ibagRecords.length;
    instRecords.push({
      name: preset.name || `Instrument ${instIdx}`,
      ibagNdx: instStartIbag,
    });

    const emitInstrumentZone = (zone, sampleId, panTenthsPercent) => {
      ibagRecords.push({ genNdx: igenRecords.length, modNdx: 0 });

      // SF2 2.01 Section 8.1.2: keyRange must be first, followed by velRange if present.
      igenRecords.push(writeRangeGenRecord(SF2_GENERATORS.keyRange, zone.lokey ?? 0, zone.hikey ?? 127));
      const lovel = zone.lovel ?? 0;
      const hivel = zone.hivel ?? 127;
      if (lovel > 0 || hivel < 127) {
        igenRecords.push(writeRangeGenRecord(SF2_GENERATORS.velRange, lovel, hivel));
      }
      if (zone.attenuationCb && zone.attenuationCb > 0) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.initialAttenuation, Math.min(1440, zone.attenuationCb)));
      }
      if (panTenthsPercent !== 0) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.pan, Math.max(-500, Math.min(500, panTenthsPercent))));
      }
      if (zone.coarseTune) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.coarseTune, zone.coarseTune));
      }
      if (zone.fineTune) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.fineTune, zone.fineTune));
      }
      if (zone.attackSeconds !== undefined) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.attackVolEnv, secondsToTimecents(zone.attackSeconds)));
      }
      if (zone.holdSeconds !== undefined) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.holdVolEnv, secondsToTimecents(zone.holdSeconds)));
      }
      if (zone.decaySeconds !== undefined) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.decayVolEnv, secondsToTimecents(zone.decaySeconds)));
      }
      if (zone.sustainPct !== undefined && zone.sustainPct < 100) {
        const clampedPct = Math.max(0, Math.min(100, zone.sustainPct));
        const sustainCb = clampedPct <= 0.01 ? 1000 : Math.min(1000, Math.round(-200 * Math.log10(clampedPct / 100)));
        if (sustainCb > 0) igenRecords.push(writeGenRecord(SF2_GENERATORS.sustainVolEnv, sustainCb));
      }
      if (zone.releaseSeconds !== undefined) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.releaseVolEnv, secondsToTimecents(zone.releaseSeconds)));
      }
      if (zone.loopMode) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.sampleModes, zone.loopMode, { unsigned: true }));
      }
      if (zone.scaleTuning !== undefined && zone.scaleTuning !== 100) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.scaleTuning, zone.scaleTuning));
      }
      if (zone.exclusiveClass !== undefined && zone.exclusiveClass > 0) {
        igenRecords.push(writeGenRecord(SF2_GENERATORS.exclusiveClass, zone.exclusiveClass, { unsigned: true }));
      }
      igenRecords.push(writeGenRecord(SF2_GENERATORS.overridingRootKey, zone.rootKey ?? 60, { unsigned: true }));
      // sampleID (53) MUST be the terminal generator of each non-global instrument zone.
      igenRecords.push(writeGenRecord(SF2_GENERATORS.sampleID, sampleId, { unsigned: true }));
    };

    for (const zone of preset.zones) {
      const sampleRef = registerSample(zone);
      const basePanTenths = Math.round((zone.pan ?? 0) * 5);
      if (!sampleRef.stereo) {
        emitInstrumentZone(zone, sampleRef.monoIdx, basePanTenths);
      } else {
        const leftPan = Math.max(-500, Math.min(500, -500 + basePanTenths));
        const rightPan = Math.max(-500, Math.min(500, 500 + basePanTenths));
        emitInstrumentZone(zone, sampleRef.leftIdx, leftPan);
        emitInstrumentZone(zone, sampleRef.rightIdx, rightPan);
      }
    }
  }

  // Build INFO list
  const ifil = Buffer.alloc(4);
  ifil.writeUInt16LE(2, 0);
  ifil.writeUInt16LE(1, 2);
  const infoList = riffList('INFO', [
    riffChunk('ifil', ifil),
    riffChunk('isng', evenNullTerminatedAscii('EMU8000')),
    riffChunk('INAM', evenNullTerminatedAscii(bankName)),
    riffChunk('ICOP', evenNullTerminatedAscii(copyright)),
    riffChunk('ISFT', evenNullTerminatedAscii(software)),
  ]);

  // Build sdta list
  const smplChunk = riffChunk('smpl', Buffer.concat(smplBuffers));
  const sdtaList = riffList('sdta', [smplChunk]);

  // Build pdta sub-chunks with required terminal records (EOP, EOI, EOS)
  const phdrBuf = Buffer.alloc((phdrRecords.length + 1) * 38, 0);
  phdrRecords.forEach((rec, i) => {
    const off = i * 38;
    fixedAscii20(rec.name).copy(phdrBuf, off);
    phdrBuf.writeUInt16LE(rec.preset, off + 20);
    phdrBuf.writeUInt16LE(rec.bank, off + 22);
    phdrBuf.writeUInt16LE(rec.pbagNdx, off + 24);
  });
  const eopOff = phdrRecords.length * 38;
  fixedAscii20('EOP').copy(phdrBuf, eopOff);
  phdrBuf.writeUInt16LE(pbagRecords.length, eopOff + 24);

  const pbagBuf = Buffer.alloc((pbagRecords.length + 1) * 4, 0);
  pbagRecords.forEach((rec, i) => {
    pbagBuf.writeUInt16LE(rec.genNdx, i * 4);
    pbagBuf.writeUInt16LE(rec.modNdx, i * 4 + 2);
  });
  pbagBuf.writeUInt16LE(pgenRecords.length, pbagRecords.length * 4);

  const pmodBuf = Buffer.alloc(10, 0);
  const pgenBuf = Buffer.concat([...pgenRecords, Buffer.alloc(4, 0)]);

  const instBuf = Buffer.alloc((instRecords.length + 1) * 22, 0);
  instRecords.forEach((rec, i) => {
    const off = i * 22;
    fixedAscii20(rec.name).copy(instBuf, off);
    instBuf.writeUInt16LE(rec.ibagNdx, off + 20);
  });
  const eoiOff = instRecords.length * 22;
  fixedAscii20('EOI').copy(instBuf, eoiOff);
  instBuf.writeUInt16LE(ibagRecords.length, eoiOff + 20);

  const ibagBuf = Buffer.alloc((ibagRecords.length + 1) * 4, 0);
  ibagRecords.forEach((rec, i) => {
    ibagBuf.writeUInt16LE(rec.genNdx, i * 4);
    ibagBuf.writeUInt16LE(rec.modNdx, i * 4 + 2);
  });
  ibagBuf.writeUInt16LE(igenRecords.length, ibagRecords.length * 4);

  const imodBuf = Buffer.alloc(10, 0);
  const igenBuf = Buffer.concat([...igenRecords, Buffer.alloc(4, 0)]);

  const shdrBuf = Buffer.alloc((shdrEntries.length + 1) * 46, 0);
  shdrEntries.forEach((rec, i) => {
    const off = i * 46;
    fixedAscii20(rec.name).copy(shdrBuf, off);
    shdrBuf.writeUInt32LE(rec.dwStart, off + 20);
    shdrBuf.writeUInt32LE(rec.dwEnd, off + 24);
    shdrBuf.writeUInt32LE(rec.dwStartloop, off + 28);
    shdrBuf.writeUInt32LE(rec.dwEndloop, off + 32);
    shdrBuf.writeUInt32LE(rec.dwSampleRate, off + 36);
    shdrBuf.writeUInt8(rec.byOriginalPitch, off + 40);
    shdrBuf.writeInt8(rec.chPitchCorrection, off + 41);
    shdrBuf.writeUInt16LE(rec.wSampleLink, off + 42);
    shdrBuf.writeUInt16LE(rec.sfSampleType, off + 44);
  });
  fixedAscii20('EOS').copy(shdrBuf, shdrEntries.length * 46);

  const pdtaList = riffList('pdta', [
    riffChunk('phdr', phdrBuf),
    riffChunk('pbag', pbagBuf),
    riffChunk('pmod', pmodBuf),
    riffChunk('pgen', pgenBuf),
    riffChunk('inst', instBuf),
    riffChunk('ibag', ibagBuf),
    riffChunk('imod', imodBuf),
    riffChunk('igen', igenBuf),
    riffChunk('shdr', shdrBuf),
  ]);

  const sfbkPayload = Buffer.concat([Buffer.from('sfbk', 'ascii'), infoList, sdtaList, pdtaList]);
  return riffChunk('RIFF', sfbkPayload);
}

function readZeroString(buf) {
  const zeroIdx = buf.indexOf(0);
  return buf.subarray(0, zeroIdx >= 0 ? zeroIdx : buf.length).toString('ascii');
}

export function parseSf2Buffer(buffer, { includeSamples = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'sfbk') {
    throw new Error('Expected a valid RIFF sfbk SoundFont 2 file');
  }
  const riffSize = buffer.readUInt32LE(4);
  if (8 + riffSize > buffer.length) {
    throw new Error('Truncated RIFF sfbk file');
  }

  const info = {};
  let smplBuffer = null;
  const pdtaChunks = new Map();

  for (let offset = 12; offset + 8 <= 8 + riffSize;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.length) throw new Error(`Truncated chunk ${id}`);
    if (id === 'LIST' && size >= 4) {
      const listType = buffer.toString('ascii', bodyStart, bodyStart + 4);
      for (let sub = bodyStart + 4; sub + 8 <= bodyEnd;) {
        const subId = buffer.toString('ascii', sub, sub + 4);
        const subSize = buffer.readUInt32LE(sub + 4);
        const subData = buffer.subarray(sub + 8, sub + 8 + subSize);
        if (sub + 8 + subSize > bodyEnd) throw new Error(`Truncated subchunk ${subId} in LIST ${listType}`);
        if (listType === 'INFO') {
          if (subId === 'ifil' && subSize >= 4) {
            info.version = { major: subData.readUInt16LE(0), minor: subData.readUInt16LE(2) };
          } else {
            info[subId] = readZeroString(subData);
          }
        } else if (listType === 'sdta') {
          if (subId === 'smpl') smplBuffer = subData;
        } else if (listType === 'pdta') {
          pdtaChunks.set(subId, subData);
        }
        sub += 8 + subSize + (subSize % 2);
      }
    }
    offset = bodyEnd + (size % 2);
  }

  const phdr = pdtaChunks.get('phdr');
  const pbag = pdtaChunks.get('pbag');
  const pgen = pdtaChunks.get('pgen');
  const inst = pdtaChunks.get('inst');
  const ibag = pdtaChunks.get('ibag');
  const igen = pdtaChunks.get('igen');
  const shdr = pdtaChunks.get('shdr');
  if (!phdr || phdr.length < 38 || phdr.length % 38 !== 0) {
    throw new Error('Invalid or missing SF2 phdr chunk');
  }

  const presets = [];
  const phdrCount = phdr.length / 38;
  for (let i = 0; i < phdrCount - 1; i++) {
    const off = i * 38;
    presets.push({
      name: readZeroString(phdr.subarray(off, off + 20)),
      preset: phdr.readUInt16LE(off + 20),
      bank: phdr.readUInt16LE(off + 22),
      pbagNdx: phdr.readUInt16LE(off + 24),
    });
  }
  const terminalPhdrName = readZeroString(phdr.subarray((phdrCount - 1) * 38, (phdrCount - 1) * 38 + 20));

  const instruments = [];
  let terminalInstName = null;
  if (inst && inst.length >= 22 && inst.length % 22 === 0) {
    const instCount = inst.length / 22;
    for (let i = 0; i < instCount - 1; i++) {
      const off = i * 22;
      const ibagStart = inst.readUInt16LE(off + 20);
      const ibagEnd = inst.readUInt16LE((i + 1) * 22 + 20);
      const zones = [];
      if (ibag && igen) {
        for (let b = ibagStart; b < ibagEnd; b++) {
          const genStart = ibag.readUInt16LE(b * 4);
          const genEnd = ibag.readUInt16LE((b + 1) * 4);
          const gens = [];
          for (let g = genStart; g < genEnd; g++) {
            const oper = igen.readUInt16LE(g * 4);
            const u16 = igen.readUInt16LE(g * 4 + 2);
            const i16 = igen.readInt16LE(g * 4 + 2);
            const lo = igen.readUInt8(g * 4 + 2);
            const hi = igen.readUInt8(g * 4 + 3);
            gens.push({ oper, u16, i16, lo, hi });
          }
          zones.push({ generators: gens });
        }
      }
      instruments.push({
        name: readZeroString(inst.subarray(off, off + 20)),
        ibagNdx: ibagStart,
        zones,
      });
    }
    terminalInstName = readZeroString(inst.subarray((instCount - 1) * 22, (instCount - 1) * 22 + 20));
  }

  const samples = [];
  let terminalSampleName = null;
  if (shdr && shdr.length >= 46 && shdr.length % 46 === 0) {
    const shdrCount = shdr.length / 46;
    for (let i = 0; i < shdrCount - 1; i++) {
      const off = i * 46;
      samples.push({
        name: readZeroString(shdr.subarray(off, off + 20)),
        dwStart: shdr.readUInt32LE(off + 20),
        dwEnd: shdr.readUInt32LE(off + 24),
        dwStartloop: shdr.readUInt32LE(off + 28),
        dwEndloop: shdr.readUInt32LE(off + 32),
        dwSampleRate: shdr.readUInt32LE(off + 36),
        byOriginalPitch: shdr.readUInt8(off + 40),
        chPitchCorrection: shdr.readInt8(off + 41),
        wSampleLink: shdr.readUInt16LE(off + 42),
        sfSampleType: shdr.readUInt16LE(off + 44),
      });
    }
    terminalSampleName = readZeroString(shdr.subarray((shdrCount - 1) * 46, (shdrCount - 1) * 46 + 20));
  }

  return {
    info,
    presets,
    instruments,
    samples,
    terminals: {
      phdr: terminalPhdrName,
      inst: terminalInstName,
      shdr: terminalSampleName,
    },
    pdtaChunkOrder: [...pdtaChunks.keys()],
    pbagCount: pbag ? pbag.length / 4 : 0,
    pgenCount: pgen ? pgen.length / 4 : 0,
    smplSamplePoints: smplBuffer ? smplBuffer.length / 2 : 0,
    ...(includeSamples ? { smplBuffer } : {}),
  };
}

/**
 * Compile one or more SFZ instrument definitions into a single deterministic SoundFont 2.01 file.
 */
export async function compileSfzToSf2({
  bankName,
  copyright = 'CC0-1.0',
  outputPath,
  ffmpeg = resolveFfmpegExecutable(process.env),
  presets,
}) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new Error('compileSfzToSf2 requires a non-empty presets array');
  }

  const decodedCache = new Map();
  const inputSampleHashes = new Map();
  const builtPresets = [];

  for (const presetSpec of presets) {
    const drumMode = Boolean(presetSpec.drumMode || presetSpec.bank === 128);
    const regions = await parseSfzArticulation(presetSpec.sfzPath, {
      boundaryDir: presetSpec.boundaryDir,
      drumMode,
      keyFilter: presetSpec.keyFilter,
      allowedKeys: presetSpec.allowedKeys,
      targetVelocity: presetSpec.targetVelocity,
      zoneStride: presetSpec.zoneStride ?? 1,
    });
    if (!regions.length) {
      throw new Error(`No playable regions remained after filtering SFZ: ${presetSpec.sfzPath}`);
    }

    const zones = [];
    for (const reg of regions) {
      if (!existsSync(reg.samplePath)) {
        throw new Error(`Referenced SFZ sample does not exist: ${reg.samplePath}`);
      }
      if (!inputSampleHashes.has(reg.samplePath)) {
        const rawBytes = await readFile(reg.samplePath);
        inputSampleHashes.set(reg.samplePath, createHash('sha256').update(rawBytes).digest('hex'));
      }

      const roundedGainDb = Math.round(((reg.volumeDb ?? 0) + (presetSpec.gainBoostDb ?? 0)) * 100) / 100;
      const cacheKey = `${reg.samplePath}::gain=${roundedGainDb}`;
      let decoded = decodedCache.get(cacheKey);
      if (!decoded) {
        decoded = await decodeAudioSamplePcm16(reg.samplePath, { ffmpeg, gainDb: roundedGainDb });
        decodedCache.set(cacheKey, decoded);
      }

      const sampleDuration = decoded.frames / decoded.sampleRate;
      const isOneShot = reg.loopMode === 'one_shot' || drumMode;
      const isContinuousLoop = reg.loopMode === 'loop_continuous' ||
        (reg.loopMode === '' && !drumMode && decoded.embeddedLoop !== null);
      const isSustainLoop = reg.loopMode === 'loop_sustain';

      const loopStart = reg.loopStart ?? decoded.embeddedLoop?.loopStart;
      const loopEnd = reg.loopEnd ?? decoded.embeddedLoop?.loopEnd;
      const loopMode = isSustainLoop ? 3 : isContinuousLoop && loopEnd > loopStart ? 1 : 0;

      let releaseSeconds = reg.ampegRelease;
      if (isOneShot) {
        releaseSeconds = Math.max(releaseSeconds ?? 0, Math.min(8, sampleDuration + 0.1));
      }

      const rawStem = path.basename(reg.samplePath, path.extname(reg.samplePath));
      zones.push({
        sampleName: rawStem,
        sampleKey: cacheKey,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        lokey: reg.lokey,
        hikey: reg.hikey,
        lovel: reg.lovel,
        hivel: reg.hivel,
        rootKey: reg.pitchKeycenter,
        pan: reg.pan,
        attenuationCb: decoded.residualAttenuationCb,
        coarseTune: reg.transpose,
        fineTune: reg.tune,
        attackSeconds: reg.ampegAttack,
        holdSeconds: reg.ampegHold,
        decaySeconds: reg.ampegDecay,
        sustainPct: reg.ampegSustain,
        releaseSeconds,
        loopMode,
        loopStart,
        loopEnd,
        scaleTuning: reg.pitchKeytrack,
        exclusiveClass: reg.exclusiveClass,
      });
    }

    builtPresets.push({
      name: presetSpec.name,
      bank: presetSpec.bank ?? 0,
      preset: presetSpec.preset ?? 0,
      zones,
    });
  }

  const sf2Buffer = buildSf2Buffer({
    bankName,
    copyright,
    presets: builtPresets,
  });

  if (outputPath) {
    await writeFileAtomic(outputPath, sf2Buffer, { overwrite: true });
    log.info('Compiled SF2 SoundFont', {
      outputPath,
      bytes: sf2Buffer.length,
      presets: builtPresets.length,
      uniqueSamples: inputSampleHashes.size,
    });
  }

  const sortedSampleEntries = [...inputSampleHashes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const aggregateSampleHasher = createHash('sha256');
  for (const [, digest] of sortedSampleEntries) {
    aggregateSampleHasher.update(digest + '\n');
  }

  return {
    buffer: sf2Buffer,
    sha256: createHash('sha256').update(sf2Buffer).digest('hex'),
    bytes: sf2Buffer.length,
    inputSampleCount: sortedSampleEntries.length,
    aggregateSampleSha256: aggregateSampleHasher.digest('hex'),
    presets: builtPresets.map(p => ({
      name: p.name,
      bank: p.bank,
      preset: p.preset,
      zoneCount: p.zones.length,
    })),
  };
}
