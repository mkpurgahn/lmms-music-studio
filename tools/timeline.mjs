// Timeline page: one song as a DAW-style view. Each stem is a lane with its waveform, above them a bar ruler,
// the sections and any DJ effects as blocks. Lanes play in sample-accurate WebAudio sync with mute, solo and volume
// within a 512 MiB decoded buffer budget, a section can be looped, the finished master mix can be switched in,
// and Unified Feedback v2 notes pinned to a bar can be sent directly to the Studio server or copied as JSON.
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ensureStudioServer } from '../library-server.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { guessRole, relativeUrl, waveformPeaks } from './library-browser.mjs';
import { sha256File } from './provenance.mjs';
import { STUDIO_DESCRIPTOR_SCHEMA } from './studio-ui/api.mjs';

export const MAX_DECODED_BYTES = 512 * 1024 * 1024;

const STUDIO_CSS = readFileSync(new URL('./studio-ui/studio.css', import.meta.url), 'utf8');
const TIMELINE_CLIENT_JS = readFileSync(new URL('./studio-ui/timeline.js', import.meta.url), 'utf8');

// "12_Conga Open.wav" -> { order: 12, name: "Conga Open" }
export function laneName(file) {
  const base = file.replace(/\.[^.]+$/, ''), match = /^(\d+)[_ -]+(.+)$/.exec(base);
  return match ? { order: Number(match[1]), name: match[2].replace(/_/g, ' ') } : { order: 1e6, name: base.replace(/_/g, ' ') };
}

// Lanes are coloured by family so drums, bass, harmony and leads can be told apart at a glance.
export function laneFamily(name, role) {
  const r = role ?? guessRole(name);
  if (['drums', 'kick', 'snare', 'hat', 'clap', 'cymbal', 'tom', 'percussion'].includes(r)) return 'drums';
  if (r === 'bass') return 'bass';
  if (['lead', 'counter', 'brass', 'vocal'].includes(r)) return 'lead';
  if (['texture', 'fx'].includes(r)) return 'texture';
  return 'harmony';
}

// Sections with every start and length filled in, clipped to the song.
export function layoutSections(sections = [], totalBars) {
  const sorted = sections.map(s => ({ ...s })).sort((a, b) => (a.startBar ?? 0) - (b.startBar ?? 0));
  let at = 0;
  return sorted.map((s, i) => {
    const startBar = s.startBar ?? at, next = sorted[i + 1]?.startBar;
    const bars = Math.max(0.25, Math.min(s.bars ?? (next !== undefined ? next - startBar : totalBars - startBar), totalBars - startBar));
    at = startBar + bars;
    return { name: s.name, startBar, bars };
  }).filter(s => s.startBar < totalBars);
}

export function estimateDecodedBytes(frames, channels = 2) {
  return Math.max(0, Math.round(frames)) * Math.max(1, Math.round(channels)) * 4;
}

export function planDecodedBudget(items, maxBytes = MAX_DECODED_BYTES) {
  const indexed = items.map((item, index) => ({
    ...item,
    index,
    bytes: Number.isFinite(item.decodedBytes) && item.decodedBytes >= 0
      ? item.decodedBytes
      : estimateDecodedBytes(item.frames ?? 0, item.channels ?? 2),
  }));
  const sorted = [...indexed].sort((a, b) => {
    const prio = entry => (entry.isMix ? 0 : entry.solo ? 1 : !entry.muted ? 2 : 3);
    return prio(a) - prio(b) || a.index - b.index;
  });

  const eagerIds = [];
  const lazyIds = [];
  let plannedBytes = 0;
  let totalRequestedBytes = 0;

  for (const item of sorted) {
    totalRequestedBytes += item.bytes;
    if (plannedBytes + item.bytes <= maxBytes) {
      eagerIds.push(item.id);
      plannedBytes += item.bytes;
    } else {
      lazyIds.push(item.id);
    }
  }

  return {
    eagerIds,
    lazyIds,
    plannedBytes,
    totalRequestedBytes,
    maxBytes,
  };
}

export function planOnDemandDecode(items, targetId, neededBytes, maxBytes = MAX_DECODED_BYTES, { mode = 'stems' } = {}) {
  const currentBytes = items.reduce((sum, item) => sum + (item.loaded ? (item.decodedBytes ?? 0) : 0), 0);
  if (neededBytes > maxBytes) {
    return { canLoad: false, evictIds: [], freedBytes: 0, projectedBytes: currentBytes, maxBytes };
  }
  if (currentBytes + neededBytes <= maxBytes) {
    return { canLoad: true, evictIds: [], freedBytes: 0, projectedBytes: currentBytes + neededBytes, maxBytes };
  }

  const neededToFree = (currentBytes + neededBytes) - maxBytes;
  const anySolo = items.some(item => !item.isMix && item.solo);
  const isAudible = item => (item.isMix
    ? mode === 'mix'
    : mode === 'stems' && !item.muted && (!anySolo || item.solo));

  const candidates = items
    .filter(item => item.loaded && item.id !== targetId)
    .sort((a, b) => {
      const aAudible = isAudible(a);
      const bAudible = isAudible(b);
      if (aAudible !== bAudible) return aAudible ? 1 : -1;
      if (Boolean(a.isMix) !== Boolean(b.isMix)) return a.isMix ? 1 : -1;
      return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
    });

  const evictIds = [];
  let freedBytes = 0;
  for (const cand of candidates) {
    if (freedBytes >= neededToFree) break;
    evictIds.push(cand.id);
    freedBytes += cand.decodedBytes ?? 0;
  }

  if (currentBytes - freedBytes + neededBytes > maxBytes) {
    return { canLoad: false, evictIds: [], freedBytes: 0, projectedBytes: currentBytes, maxBytes };
  }
  return {
    canLoad: true,
    evictIds,
    freedBytes,
    projectedBytes: currentBytes - freedBytes + neededBytes,
    maxBytes,
  };
}

export function createTimelineNote(descriptor, {
  seconds,
  displayBar,
  bar,
  beat = 1,
  text,
  rating = null,
  mode = 'stems',
  soloedLanes = [],
  mutedLanes = [],
} = {}) {
  const meter = Array.isArray(descriptor.timeSignature) && descriptor.timeSignature.length === 2
    ? descriptor.timeSignature
    : [4, 4];
  const barSec = 240 * meter[0] / (meter[1] * descriptor.bpm);
  let resolvedBar;
  if (Number.isInteger(bar) && bar >= 0) {
    resolvedBar = bar;
  } else if (Number.isInteger(displayBar) && displayBar >= 1) {
    resolvedBar = displayBar - 1;
  } else if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    resolvedBar = Math.floor(seconds / barSec + 1e-9);
  } else {
    resolvedBar = 0;
  }
  const resolvedDisplayBar = resolvedBar + 1;
  const resolvedBeat = Number.isInteger(beat) && beat >= 1 ? Math.min(meter[0], beat) : 1;
  const resolvedSeconds = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Number(seconds.toFixed(3))
    : Number(((resolvedBar + (resolvedBeat - 1) / meter[0]) * barSec).toFixed(3));
  const position = resolvedSeconds / barSec;
  let sectionName = null;
  for (const s of descriptor.sections ?? []) {
    if (position + 1e-9 >= s.startBar && position < s.startBar + s.bars - 1e-9) {
      sectionName = s.name;
    }
  }
  return {
    seconds: resolvedSeconds,
    bar: resolvedBar,
    displayBar: resolvedDisplayBar,
    beat: resolvedBeat,
    section: sectionName,
    text: String(text ?? '').trim(),
    rating,
    mode,
    soloedLanes: [...soloedLanes],
    mutedLanes: [...mutedLanes],
  };
}

export function buildTimelineFeedback(descriptor, notes = [], ratings = {}) {
  const meter = Array.isArray(descriptor.timeSignature) && descriptor.timeSignature.length === 2
    ? descriptor.timeSignature
    : [4, 4];
  const files = [
    ...(descriptor.mix?.url ? [descriptor.mix.url] : []),
    ...(descriptor.lanes ?? []).map(l => l.url).filter(Boolean),
  ];
  return {
    schema: 'lmms-mcp/audition-feedback',
    version: 2,
    kind: 'timeline',
    title: descriptor.title ?? 'Timeline',
    source: descriptor.source ?? descriptor.projectFile ?? null,
    page: descriptor.pageName ?? null,
    projectFile: descriptor.projectFile ?? null,
    projectSha256: descriptor.projectSha256 ?? null,
    files,
    bpm: descriptor.bpm,
    timeSignature: meter,
    introBars: 0,
    savedAt: new Date().toISOString(),
    sections: (descriptor.sections ?? []).map(s => ({
      name: s.name,
      startBar: s.startBar,
      displayStartBar: s.startBar + 1,
      bars: s.bars,
      rating: ratings[s.name] ?? null,
    })),
    notes: [...notes].sort((a, b) => a.seconds - b.seconds),
  };
}

const escapeForScript = text => text.replace(/</g, '\\u003c');
const escapeHtml = text => String(text ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export function timelineHtml({
  title,
  bpm,
  timeSignature = [4, 4],
  bars,
  seconds,
  lanes,
  mix,
  sections,
  effects,
  generated,
  projectFile = null,
  projectSha256 = null,
  session = null,
  pageName = null,
  feedbackName = null,
  sampleRate = 48000,
}) {
  const payload = {
    title,
    bpm,
    timeSignature,
    bars,
    seconds,
    lanes,
    mix,
    sections,
    effects,
    generated,
    ...(projectFile ? { projectFile } : {}),
    ...(projectSha256 ? { projectSha256 } : {}),
    ...(session ? { session } : {}),
    ...(pageName ? { pageName } : {}),
    ...(feedbackName ? { feedbackName } : {}),
    sampleRate,
  };
  const data = escapeForScript(JSON.stringify(payload));
  const safeTitle = escapeHtml(title);
  const initialBanner = lanes?.length
    ? 'Stems (isolated pre-master tracks)'
    : 'Master Mix (authoritative post-master output)';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
${STUDIO_CSS}
</style></head><body>
<header class="studio-header"><h1>${safeTitle}</h1>
<div class="row"><button id="play" type="button" title="Play or pause (space)">Play</button><button id="start" type="button" title="Back to the start">Start</button>
<span class="clock" id="clock">Bar 1 | Beat 1 | 0:00.0</span>
<button id="mode" type="button" title="Switch between the separate stems and the finished mix">Switch to Master Mix</button>
<span class="mode-badge" id="mode-banner">${escapeHtml(initialBanner)}</span>
<select id="loop" title="Repeat one section"><option value="">Loop: off</option></select>
<button id="unsolo" type="button">Clear mute and solo</button>
<button id="open-lmms" type="button">Open in LMMS</button>
<span class="hint" id="status"></span></div></header>
<div class="wrap"><div id="head"></div><div class="board" id="board"></div></div>
<div class="notes-panel"><h2 style="font-size:15px;margin:0 0 6px">Notes for the next version</h2>
<textarea id="notetext" placeholder="What needs changing at this bar? Press Add note here (or N) to pin feedback."></textarea>
<div class="row" style="margin-top:8px"><button id="note" class="primary" type="button" title="Pin a note to the bar under the playhead (N)">Add note here</button>
<select id="noterating"><option value="">No rating</option><option value="1">1 poor</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5 great</option></select>
<button id="send-feedback" class="primary" type="button">Send Feedback to Studio</button>
<button id="save" type="button">Save feedback</button>
<button id="copy" type="button">Copy notes</button>
<span class="hint" id="feedback-status">Each note is pinned to a bar and records which lanes were soloed or muted.</span></div>
<ul id="notes"></ul></div>
<script id="data" type="application/json">${data}</script>
<script>
${TIMELINE_CLIENT_JS}
</script></body></html>
`;
}

export function register({ tool, z, dsp, root, schemas, project, paths, logger, moduleGuidance, env = process.env }) {
  const timelineLogger = logger?.child ? logger.child('timeline') : undefined;
  moduleGuidance.push(
    'To show a person a whole song the way a DAW would, call build_timeline_page after render_stems: every stem becomes a lane with its waveform under a bar ruler in sample-accurate WebAudio sync, and build_timeline_page returns a live studioUrl where the listener can click "Send Feedback to Studio" or "Open in LMMS".',
  );

  tool(
    'build_timeline_page',
    'Write a DAW-style timeline page and live Studio session descriptor of one song: each stem from render_stems is a lane with its waveform under a 1-based bar ruler, sections and DJ effects. Lanes play in sample-accurate WebAudio sync within a 512 MiB decoded buffer budget, switch cleanly between Stems and Master Mix, and emit Unified Feedback v2 JSON directly to the workspace via Send Feedback to Studio.',
    {
      stems: schemas.folderName.optional().describe('Folder written by render_stems. One lane per WAV.'),
      mix: schemas.workspaceWav.optional().describe('The finished master mix, playable in place of the stems.'),
      bpm: z.number().min(40).max(260).optional().describe('Static tempo in BPM (derived automatically when project is supplied).'),
      timeSignature: z.tuple([z.number().int().min(1).max(32), z.number().int().min(1).max(32)]).optional()
        .describe('Meter [numerator, denominator] (derived automatically when project is supplied; defaults to [4, 4]).'),
      sections: z.array(schemas.section).max(64).default([]).describe('Section names with startBar and bars, counted from zero.'),
      effects: z.array(z.object({ type: z.string().min(1).max(40), startBar: z.number().min(0), bars: z.number().min(1 / 64) }).passthrough()).max(200).default([])
        .describe('The effects list that was passed to dj_effects, to draw them on the timeline.'),
      project: schemas.projectName.optional().describe('The workspace LMMS project (.mmp/.mmpz). Derives static bpm/timeSignature, colours lanes by role, records projectSha256, and enables Open in LMMS.'),
      title: z.string().min(1).max(80).default('Timeline'),
      output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.html$/i),
      overwrite: z.boolean().default(false),
    },
    async ({ stems, mix, bpm, timeSignature, sections, effects, project: projectName, title, output, overwrite }) => {
      if (!stems && !mix) throw new Error('Give a stems folder, a mix, or both');
      const target = path.join(root, output);
      if (!overwrite && existsSync(target)) throw new Error('Output already exists. Pass overwrite: true to rebuild it.');

      const roles = {};
      let derivedBpm = bpm;
      let derivedTimeSig = timeSignature ?? [4, 4];
      let projectFile = null;
      let projectSha256 = null;

      if (projectName) {
        const doc = await project.load(projectName);
        const info = project.songInfo(doc);
        if (!info.staticTempo) {
          throw new Error(
            `Project "${projectName}" contains dynamic <bpm> tempo automation. Timeline and bar-indexed feedback require a static tempo; remove tempo automation or omit project.`,
          );
        }
        derivedBpm = info.bpm;
        derivedTimeSig = info.meter;
        projectFile = projectName;
        projectSha256 = await sha256File(path.join(root, projectName));
        for (const t of project.tracks(doc)) {
          const role = project.trackRole(t);
          if (role) roles[t.getAttribute('name')] = role;
        }
      } else if (derivedBpm === undefined) {
        throw new Error('Supply bpm, or pass project so static bpm and timeSignature can be derived from the LMMS project');
      }

      const read = async relative => {
        const full = path.join(root, relative), info = await lstat(full).catch(() => null);
        if (!info?.isFile()) throw new Error(`"${relative}" was not found in the workspace`);
        if (info.size > 256 * 1024 * 1024) throw new Error(`"${relative}" is larger than 256 MiB`);
        return dsp.decodeWav(await readFile(full));
      };

      let seconds = 0;
      let sampleRate = 48000;
      const lanes = [];
      if (stems) {
        const files = (await readdir(path.join(root, stems)).catch(() => {
          throw new Error(`Folder "${stems}" was not found in the workspace`);
        })).filter(f => /\.wav$/i.test(f) && !/^mix\.wav$/i.test(f));
        if (!files.length) throw new Error(`Folder "${stems}" holds no WAV stems`);
        if (files.length > 64) throw new Error('A timeline shows at most 64 lanes');
        const points = Math.round(Math.min(2400, Math.max(600, 16 * 60)));
        for (const file of files) {
          const audio = await read(`${stems}/${file}`), named = laneName(file);
          sampleRate = audio.sampleRate;
          seconds = Math.max(seconds, audio.frames / audio.sampleRate);
          let peak = 0;
          for (const ch of audio.channels) {
            for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
          }
          lanes.push({
            ...named,
            family: laneFamily(named.name, roles[named.name]),
            url: relativeUrl(`${stems}/${file}`),
            peaks: waveformPeaks(audio, points),
            frames: audio.frames,
            channels: audio.channels.length,
            decodedBytes: estimateDecodedBytes(audio.frames, audio.channels.length),
            silent: peak < 1e-4,
          });
        }
        lanes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      }

      let mixLane = null;
      if (mix) {
        const audio = await read(mix);
        sampleRate = audio.sampleRate;
        seconds = Math.max(seconds, audio.frames / audio.sampleRate);
        mixLane = {
          name: 'Master Mix',
          family: 'harmony',
          url: relativeUrl(mix),
          peaks: waveformPeaks(audio, 1600),
          frames: audio.frames,
          channels: audio.channels.length,
          decodedBytes: estimateDecodedBytes(audio.frames, audio.channels.length),
        };
      }

      const barLengthSec = 240 * derivedTimeSig[0] / (derivedTimeSig[1] * derivedBpm);
      const bars = Math.max(1, Math.round(seconds / barLengthSec * 100) / 100);
      const wholeBars = Math.ceil(bars - 0.01);
      const laid = layoutSections(sections, wholeBars);
      const drawn = effects
        .map(({ type, startBar, bars: length, ...rest }) => ({
          type,
          startBar,
          bars: length,
          detail: Object.entries(rest).map(([k, v]) => `${k} ${v}`).join(', '),
        }))
        .filter(e => e.startBar < wholeBars);

      const sessionId = output.replace(/\.html$/i, '');
      const feedbackName = `${sessionId}-feedback.json`;
      const generated = new Date().toISOString().slice(0, 10);
      const cleanLanes = lanes.map(({ order, silent, ...lane }) => lane);

      const html = timelineHtml({
        title,
        bpm: derivedBpm,
        timeSignature: derivedTimeSig,
        bars: wholeBars,
        seconds: Number(seconds.toFixed(3)),
        lanes: cleanLanes,
        mix: mixLane,
        sections: laid,
        effects: drawn,
        generated,
        projectFile,
        projectSha256,
        session: sessionId,
        pageName: output,
        feedbackName,
        sampleRate,
      });

      await writeFileAtomic(target, html, { overwrite });

      const studioDescriptorName = `${sessionId}.timeline.studio.json`;
      const studioDescriptor = {
        schema: STUDIO_DESCRIPTOR_SCHEMA,
        kind: 'timeline',
        session: sessionId,
        title,
        bpm: derivedBpm,
        timeSignature: derivedTimeSig,
        bars: wholeBars,
        seconds: Number(seconds.toFixed(3)),
        sampleRate,
        lanes: cleanLanes.map(l => ({ ...l, url: '/' + l.url.replace(/^\/+/, '') })),
        mix: mixLane ? { ...mixLane, url: '/' + mixLane.url.replace(/^\/+/, '') } : null,
        sections: laid,
        effects: drawn,
        generated,
        pageName: output,
        feedbackName,
        projectFile,
        projectSha256,
      };
      await writeFileAtomic(
        path.join(root, studioDescriptorName),
        JSON.stringify(studioDescriptor, null, 2) + '\n',
        { overwrite: true },
      );

      let studioUrl = null;
      if (env?.LMMS_AUTO_SERVER !== '0') {
        const srv = await ensureStudioServer({
          workspaceDir: root,
          soundfontsDir: paths?.soundfonts,
          env,
          logger: timelineLogger,
        });
        studioUrl = `${srv.baseUrl}/studio/timeline?session=${encodeURIComponent(sessionId)}`;
      }

      return {
        page: output,
        path: target,
        ...(studioUrl ? { studioUrl } : {}),
        studioSession: sessionId,
        studioDescriptor: studioDescriptorName,
        feedbackFile: feedbackName,
        bpm: derivedBpm,
        timeSignature: derivedTimeSig,
        ...(projectFile ? { projectFile, projectSha256 } : {}),
        lanes: lanes.length,
        silentLanes: lanes.filter(l => l.silent).map(l => l.name),
        bars: wholeBars,
        seconds: Number(seconds.toFixed(2)),
        sections: laid.length,
        effects: drawn.length,
        next: studioUrl
          ? `Open ${studioUrl} in a browser: stems play in sample-accurate WebAudio sync, "Send Feedback to Studio" writes ${feedbackName} straight to the workspace for read_feedback, and "Open in LMMS" opens the linked project.`
          : 'Open the page through library-server.mjs or from disk, then pass feedback JSON to read_feedback.',
      };
    },
  );
}

