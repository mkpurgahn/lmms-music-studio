// Loop points for game engines. write_loop_points puts the loop start and end into the audio file itself (a WAV `smpl`
// chunk, Vorbis comments LOOPSTART, LOOPEND and LOOPLENGTH in an OGG file) and writes a JSON sidecar, so an engine
// that reads loop metadata loops the file without a separate manifest.
//
// All frame numbers are sample frames. loopEnd is EXCLUSIVE (the first frame after the loop), the same as `endFrame` in
// the manifests of prepare_loop and export_game_audio. The WAV `smpl` chunk stores an INCLUSIVE last frame, so the
// chunk holds loopEnd - 1. LOOPLENGTH = loopEnd - loopStart, and LOOPSTART + LOOPLENGTH = loopEnd.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAudioFileProvenance, writeDerivedAudioProvenance } from './provenance.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const loopTags = ['LOOPSTART', 'LOOPEND', 'LOOPLENGTH'];

// ---------- WAV: RIFF chunks and the `smpl` chunk ----------
// Walk the chunks of a RIFF/WAVE file. Chunks are padded to an even size; the pad byte is not part of `size`.
export function riffChunks(wav) {
  if (wav.length < 12 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    // A truncated final chunk (data size larger than the file) is clamped, as most readers do.
    if (offset + 8 + size > wav.length) size = wav.length - offset - 8;
    chunks.push({ id, offset, size, body: offset + 8 });
    offset += 8 + size + (size & 1);
  }
  return chunks;
}

// Sample rate, channels and frame count of a PCM or float WAV, without decoding it.
export function wavInfo(wav) {
  const chunks = riffChunks(wav);
  const fmt = chunks.find(c => c.id === 'fmt '), data = chunks.find(c => c.id === 'data');
  if (!fmt || fmt.size < 16) throw new Error('The WAV has no fmt chunk');
  if (!data) throw new Error('The WAV has no data chunk');
  const channels = wav.readUInt16LE(fmt.body + 2), sampleRate = wav.readUInt32LE(fmt.body + 4), blockAlign = wav.readUInt16LE(fmt.body + 12);
  if (!channels || !blockAlign) throw new Error('The WAV header is not valid');
  return { sampleRate, channels, frames: Math.floor(data.size / blockAlign) };
}

// The 60-byte body of a `smpl` chunk with one forward loop. `endFrame` is exclusive, the chunk stores it inclusive.
export function buildSmplBody({ sampleRate, startFrame, endFrame, midiUnityNote = 60 }) {
  if (!(Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame > startFrame)) throw new Error('A loop needs 0 <= startFrame < endFrame, in whole frames');
  if (endFrame - 1 > 0xFFFFFFFF) throw new Error('A WAV smpl chunk cannot hold a loop beyond 2^32 frames');
  const body = Buffer.alloc(36 + 24);
  body.writeUInt32LE(0, 0);                                         // manufacturer
  body.writeUInt32LE(0, 4);                                         // product
  body.writeUInt32LE(Math.round(1e9 / sampleRate), 8);              // sample period in nanoseconds
  body.writeUInt32LE(midiUnityNote, 12);
  body.writeUInt32LE(0, 16);                                        // pitch fraction
  body.writeUInt32LE(0, 20);                                        // SMPTE format
  body.writeUInt32LE(0, 24);                                        // SMPTE offset
  body.writeUInt32LE(1, 28);                                        // one loop
  body.writeUInt32LE(0, 32);                                        // no sampler data
  body.writeUInt32LE(0, 36);                                        // cue point id
  body.writeUInt32LE(0, 40);                                        // type 0: forward loop
  body.writeUInt32LE(startFrame, 44);
  body.writeUInt32LE(endFrame - 1, 48);                             // inclusive last frame
  body.writeUInt32LE(0, 52);                                        // fraction
  body.writeUInt32LE(0, 56);                                        // play count 0: loop forever
  return body;
}

// Read the loops of a `smpl` chunk, with `endFrame` converted back to exclusive. Null when there is no smpl chunk.
export function parseSmpl(wav) {
  const smpl = riffChunks(wav).find(c => c.id === 'smpl');
  if (!smpl || smpl.size < 36) return null;
  const count = wav.readUInt32LE(smpl.body + 28), sampleDataSize = wav.readUInt32LE(smpl.body + 32);
  const loops = [];
  for (let i = 0; i < count; i++) {
    const at = smpl.body + 36 + i * 24;
    if (at + 24 > smpl.body + smpl.size) break;
    loops.push({ id: wav.readUInt32LE(at), type: wav.readUInt32LE(at + 4), startFrame: wav.readUInt32LE(at + 8),
      endFrame: wav.readUInt32LE(at + 12) + 1, playCount: wav.readUInt32LE(at + 20) });
  }
  return { midiUnityNote: wav.readUInt32LE(smpl.body + 12), samplePeriodNs: wav.readUInt32LE(smpl.body + 8), loops, sampleDataSize };
}

// A copy of the WAV with its `smpl` chunk replaced (or added after the last chunk). Every other chunk is kept byte for
// byte, in order, and the RIFF size is fixed up.
export function setWavLoop(wav, { startFrame, endFrame, midiUnityNote }) {
  const info = wavInfo(wav);
  if (endFrame > info.frames) throw new Error(`The loop ends at frame ${endFrame} but the file has only ${info.frames} frames`);
  const parts = [wav.subarray(0, 12)];
  for (const chunk of riffChunks(wav)) {
    if (chunk.id === 'smpl') continue;
    const header = Buffer.alloc(8);
    header.write(chunk.id, 0, 'latin1');
    header.writeUInt32LE(chunk.size, 4); // a truncated final chunk is written with its real size
    parts.push(header, wav.subarray(chunk.body, chunk.body + chunk.size));
    if (chunk.size & 1) parts.push(Buffer.alloc(1)); // chunks are padded to an even size
  }
  const body = buildSmplBody({ sampleRate: info.sampleRate, startFrame, endFrame, midiUnityNote: midiUnityNote ?? parseSmpl(wav)?.midiUnityNote ?? 60 });
  const header = Buffer.alloc(8);
  header.write('smpl', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  parts.push(header, body);
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// ---------- OGG Vorbis: pages, packets and the comment header ----------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0; table[i] = r >>> 0; }
  return table;
})();
// Ogg's CRC: polynomial 0x04c11db7, no reflection, zero start, no final xor, computed with the CRC field zeroed.
export function oggCrc(buffer) {
  let crc = 0;
  for (let i = 0; i < buffer.length; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ buffer[i]) & 0xFF]) >>> 0;
  return crc >>> 0;
}
const noGranule = 0xFFFFFFFFFFFFFFFFn;

// Serialise one Ogg page. `segments` are the lacing values; their sum must equal body.length.
export function oggPage({ headerType = 0, granule = 0n, serial, seq, segments, body }) {
  if (segments.length > 255) throw new Error('An Ogg page holds at most 255 segments');
  const page = Buffer.alloc(27 + segments.length + body.length);
  page.write('OggS', 0, 'latin1');
  page.writeUInt8(0, 4);
  page.writeUInt8(headerType, 5);
  page.writeBigUInt64LE(BigInt.asUintN(64, BigInt(granule)), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(seq, 18);
  page.writeUInt8(segments.length, 26);
  Buffer.from(segments).copy(page, 27);
  body.copy(page, 27 + segments.length);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}
// Lacing values of one packet: runs of 255, then a final value under 255 (0 when the size is a multiple of 255).
export const lacing = length => { const out = Array(Math.floor(length / 255)).fill(255); out.push(length % 255); return out; };

export function parseOggPages(ogg) {
  const pages = [];
  let offset = 0;
  while (offset < ogg.length) {
    if (offset + 27 > ogg.length || ogg.toString('latin1', offset, offset + 4) !== 'OggS') throw new Error(`Not a valid Ogg stream (no page at byte ${offset})`);
    const count = ogg.readUInt8(offset + 26);
    const segments = Array.from(ogg.subarray(offset + 27, offset + 27 + count));
    const size = segments.reduce((a, b) => a + b, 0), start = offset + 27 + count;
    if (start + size > ogg.length) throw new Error('The Ogg stream is truncated');
    pages.push({ offset, end: start + size, headerType: ogg.readUInt8(offset + 5), granule: ogg.readBigUInt64LE(offset + 6), serial: ogg.readUInt32LE(offset + 14),
      seq: ogg.readUInt32LE(offset + 18), segments, body: ogg.subarray(start, start + size) });
    offset = start + size;
  }
  return pages;
}

// The first three packets (the Vorbis identification, comment and setup headers), and the index of the page holding
// the end of the third. A Vorbis stream puts the first audio packet on a fresh page, so every page after that index is
// audio and can be copied unchanged apart from its sequence number and CRC.
function vorbisHeaders(pages) {
  const packets = [];
  let current = [], lastHeaderPage = -1;
  for (let p = 0; p < pages.length && packets.length < 3; p++) {
    const page = pages[p];
    let at = 0;
    for (let s = 0; s < page.segments.length && packets.length < 3; s++) {
      current.push(page.body.subarray(at, at + page.segments[s]));
      at += page.segments[s];
      if (page.segments[s] < 255) {
        packets.push(Buffer.concat(current)); current = [];
        if (packets.length === 3) { lastHeaderPage = p; if (s !== page.segments.length - 1) throw new Error('The setup header shares a page with audio; this Ogg layout is not supported'); }
      }
    }
  }
  if (packets.length < 3) throw new Error('The Ogg stream ends before its three Vorbis headers');
  const [id, comment, setup] = packets;
  if (id.toString('latin1', 0, 7) !== '\x01vorbis') throw new Error('Only Ogg Vorbis files are supported (this is another codec)');
  if (comment.toString('latin1', 0, 7) !== '\x03vorbis' || setup.toString('latin1', 0, 7) !== '\x05vorbis') throw new Error('The Ogg Vorbis headers are not in the expected order');
  return { id, comment, setup, lastHeaderPage };
}

export function parseVorbisComment(packet) {
  if (packet.toString('latin1', 0, 7) !== '\x03vorbis') throw new Error('Not a Vorbis comment header');
  let at = 7;
  const vendorLength = packet.readUInt32LE(at); at += 4;
  const vendor = packet.toString('utf8', at, at + vendorLength); at += vendorLength;
  const count = packet.readUInt32LE(at); at += 4;
  const comments = [];
  for (let i = 0; i < count; i++) {
    const length = packet.readUInt32LE(at); at += 4;
    comments.push(packet.toString('utf8', at, at + length)); at += length;
  }
  return { vendor, comments };
}
export function buildVorbisComment({ vendor, comments }) {
  const vendorBytes = Buffer.from(vendor, 'utf8');
  const entries = comments.map(c => Buffer.from(c, 'utf8'));
  const out = Buffer.alloc(7 + 4 + vendorBytes.length + 4 + entries.reduce((sum, e) => sum + 4 + e.length, 0) + 1);
  out.write('\x03vorbis', 0, 'latin1');
  let at = 7;
  out.writeUInt32LE(vendorBytes.length, at); at += 4;
  vendorBytes.copy(out, at); at += vendorBytes.length;
  out.writeUInt32LE(entries.length, at); at += 4;
  for (const e of entries) { out.writeUInt32LE(e.length, at); at += 4; e.copy(out, at); at += e.length; }
  out.writeUInt8(1, at); // framing bit
  return out;
}

// Sample rate, channels, total frames (from the last page's granule position) and comments of an Ogg Vorbis file.
export function oggInfo(ogg) {
  const pages = parseOggPages(ogg);
  const { id, comment } = vorbisHeaders(pages);
  const last = [...pages].reverse().find(p => p.granule !== noGranule);
  return { channels: id.readUInt8(11), sampleRate: id.readUInt32LE(12), frames: last ? Number(last.granule) : 0, ...parseVorbisComment(comment) };
}
export function readOggLoop(ogg) {
  const { comments } = oggInfo(ogg);
  const tags = {};
  for (const entry of comments) {
    const eq = entry.indexOf('=');
    if (eq > 0 && loopTags.includes(entry.slice(0, eq).toUpperCase())) tags[entry.slice(0, eq).toUpperCase()] = entry.slice(eq + 1);
  }
  return tags;
}

// A copy of the Ogg Vorbis file with LOOPSTART, LOOPEND and LOOPLENGTH set in its comment header. Other comments and the
// vendor string are kept; the audio pages are not touched except for their sequence numbers and CRCs.
export function setOggLoop(ogg, { startFrame, endFrame }) {
  if (!(Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame > startFrame)) throw new Error('A loop needs 0 <= startFrame < endFrame, in whole frames');
  const pages = parseOggPages(ogg);
  const { id, comment, setup, lastHeaderPage } = vorbisHeaders(pages);
  const info = parseVorbisComment(comment);
  const kept = info.comments.filter(entry => !loopTags.includes(entry.split('=')[0].toUpperCase()));
  const newComment = buildVorbisComment({ vendor: info.vendor, comments: [...kept, `LOOPSTART=${startFrame}`, `LOOPEND=${endFrame}`, `LOOPLENGTH=${endFrame - startFrame}`] });
  const serial = pages[0].serial;
  const out = [oggPage({ headerType: 0x02, granule: 0n, serial, seq: 0, segments: lacing(id.length), body: id })];
  // Comment and setup headers: one run of segments, split into pages of at most 255 segments.
  const segments = [...lacing(newComment.length), ...lacing(setup.length)], body = Buffer.concat([newComment, setup]);
  let seq = 1, taken = 0;
  for (let s = 0; s < segments.length; s += 255) {
    const slice = segments.slice(s, s + 255), size = slice.reduce((a, b) => a + b, 0);
    out.push(oggPage({ headerType: s === 0 ? 0 : 0x01, granule: 0n, serial, seq: seq++, segments: slice, body: body.subarray(taken, taken + size) }));
    taken += size;
  }
  for (const page of pages.slice(lastHeaderPage + 1)) {
    const copy = Buffer.from(ogg.subarray(page.offset, page.end));
    copy.writeUInt32LE(seq++, 18);
    copy.writeUInt32LE(0, 22);
    copy.writeUInt32LE(oggCrc(copy), 22);
    out.push(copy);
  }
  return Buffer.concat(out);
}

// ---------- shared logic ----------
// Turn what the caller gave (frames or seconds, or nothing for the whole file) into whole frames, and check them.
export function resolveLoop({ sampleRate, frames, startFrame, endFrame, startSeconds, endSeconds }) {
  const gaveFrames = startFrame !== undefined || endFrame !== undefined, gaveSeconds = startSeconds !== undefined || endSeconds !== undefined;
  if (gaveFrames && gaveSeconds) throw new Error('Give the loop in frames or in seconds, not both');
  let start = 0, end = frames;
  if (gaveFrames) { start = startFrame ?? 0; end = endFrame ?? frames; }
  else if (gaveSeconds) { start = Math.round((startSeconds ?? 0) * sampleRate); end = endSeconds === undefined ? frames : Math.round(endSeconds * sampleRate); }
  if (!(Number.isInteger(start) && Number.isInteger(end))) throw new Error('Loop frames must be whole numbers');
  if (start < 0 || end <= start) throw new Error(`The loop must satisfy 0 <= start < end (got ${start} to ${end})`);
  if (end > frames) throw new Error(`The loop ends at frame ${end} but the file has only ${frames} frames`);
  return { startFrame: start, endFrame: end };
}
const round = (value, places = 4) => Number(value.toFixed(places));
export function sidecarFor({ file, kind, sampleRate, channels, frames, startFrame, endFrame, sha, source }) {
  return {
    file, format: kind, sampleRate, channels, frames, durationSeconds: round(frames / sampleRate),
    loop: { startFrame, endFrame, lengthFrames: endFrame - startFrame, startSeconds: round(startFrame / sampleRate), endSeconds: round(endFrame / sampleRate), endIsExclusive: true },
    embedded: kind === 'wav'
      ? { smpl: { loops: 1, startFrame, endFrameInclusive: endFrame - 1 } }
      : { vorbisComments: { LOOPSTART: String(startFrame), LOOPEND: String(endFrame), LOOPLENGTH: String(endFrame - startFrame) } },
    sha256: sha, ...(source ? { source } : {}),
  };
}

// Write `buffer` to `file`: a new file (fails when it exists) or replace `file` through a temp file in the same folder.
async function save(file, buffer, replace) {
  if (!replace) { await writeFile(file, buffer, { flag: 'wx' }); return; }
  const temp = path.join(path.dirname(file), `.loop-${randomBytes(4).toString('hex')}.tmp`);
  try { await writeFile(temp, buffer, { flag: 'wx' }); await rename(temp, file); } catch (error) { await rm(temp, { force: true }); throw error; }
}

// Apply a loop to one file's bytes. Returns the new bytes and what the file now says.
export function applyLoop(buffer, kind, request) {
  if (kind === 'wav') {
    const info = wavInfo(buffer), loop = resolveLoop({ ...info, ...request });
    const out = setWavLoop(buffer, loop);
    const check = parseSmpl(out).loops[0];
    if (check.startFrame !== loop.startFrame || check.endFrame !== loop.endFrame) throw new Error('The smpl chunk did not read back as written');
    return { buffer: out, info, ...loop };
  }
  const info = oggInfo(buffer);
  if (!info.frames) throw new Error('The Ogg file has no audio frames');
  const loop = resolveLoop({ ...info, ...request });
  const out = setOggLoop(buffer, loop);
  const tags = readOggLoop(out);
  if (tags.LOOPSTART !== String(loop.startFrame) || tags.LOOPEND !== String(loop.endFrame)) throw new Error('The Vorbis comments did not read back as written');
  return { buffer: out, info, ...loop };
}

// ---------- tool ----------
export function register({ tool, z, root, moduleGuidance, env = process.env }) {
  const file = z.string().regex(/^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][\w ().,'&-]{0,149}\.(wav|ogg)$/i)
    .describe('A workspace WAV or OGG Vorbis file. It may sit one folder down.');
  const manifestName = z.string().regex(/^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][\w ().,'&-]{0,149}\.manifest\.json$/i)
    .describe('A manifest written by prepare_loop or export_game_audio, one folder down at most.');
  moduleGuidance.push('For game engines, write_loop_points puts the loop start and end inside a WAV (smpl chunk) or OGG (LOOPSTART, LOOPEND, LOOPLENGTH tags) and writes a .loop.json sidecar. Pass manifest to tag the loop files a prepare_loop or export_game_audio manifest lists.');

  const kindOf = name => name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'wav';
  const frameArgs = {
    startFrame: z.number().int().min(0).optional().describe('First loop frame. Default 0.'),
    endFrame: z.number().int().min(1).optional().describe('First frame after the loop (exclusive). Default: the end of the file.'),
    startSeconds: z.number().min(0).optional(), endSeconds: z.number().min(0).optional(),
  };

  tool('write_loop_points', 'Write loop points into a game-ready audio file: a WAV smpl chunk or OGG Vorbis LOOPSTART, LOOPEND and LOOPLENGTH comments, plus a .loop.json sidecar, so engines that read loop metadata loop it without a manifest. Give audio with explicit loop frames or seconds (default: the whole file, right for a prepared loop), or give a manifest from prepare_loop or export_game_audio to tag its loop files, WAV and OGG, in place. The audio itself is never changed. endFrame is exclusive; the smpl chunk stores the last frame, endFrame - 1.', {
    audio: file.optional(), manifest: manifestName.optional(), ...frameArgs,
    output: file.optional().describe('Write the tagged copy to this new workspace file. With audio, give output or inPlace.'),
    inPlace: z.boolean().default(false).describe('Replace the audio file with the tagged copy (audio data is unchanged).'),
    sidecar: z.boolean().default(true).describe('Also write <name>.loop.json next to each file.'),
  }, async args => {
    const { audio, manifest, output, inPlace, sidecar } = args;
    if (!audio === !manifest) throw new Error('Give either audio or manifest');
    const request = { startFrame: args.startFrame, endFrame: args.endFrame, startSeconds: args.startSeconds, endSeconds: args.endSeconds };
    const results = [], notes = [];

    const tag = async (relative, target, replace, source, clamp = false) => {
      const absolute = path.join(root, relative);
      if (!existsSync(absolute)) throw new Error(`File not found: ${relative}`);
      const inputCheck = await verifyAudioFileProvenance(absolute, { workspaceDir: root, env });
      const kind = kindOf(target);
      if (kindOf(relative) !== kind) throw new Error('The output must have the same type (WAV or OGG) as the audio');
      const buffer = await readFile(absolute);
      let asked = request;
      if (clamp && kind === 'ogg') { // an encoder may end a few frames short of the WAV it was made from
        const { frames } = oggInfo(buffer);
        if (request.endFrame > frames && request.endFrame - frames <= 4096) {
          asked = { ...request, endFrame: frames };
          notes.push(`${target} holds ${frames} frames, ${request.endFrame - frames} fewer than the WAV loop; its loop end was clamped to the end of the file.`);
        }
      }
      const done = applyLoop(buffer, kind, asked);
      const targetFull = path.join(root, target);
      await save(targetFull, done.buffer, replace);
      await writeDerivedAudioProvenance(targetFull, [inputCheck], {
        workspaceDir: root,
        generatorTool: 'write_loop_points',
      });
      const entry = { file: target, format: kind, sampleRate: done.info.sampleRate, channels: done.info.channels, frames: done.info.frames,
        startFrame: done.startFrame, endFrame: done.endFrame, lengthFrames: done.endFrame - done.startFrame, sha256: sha256(done.buffer) };
      if (sidecar) {
        const name = target.replace(/\.[^.]+$/, '') + '.loop.json';
        const text = JSON.stringify(sidecarFor({ file: path.basename(target), kind, ...done.info, startFrame: done.startFrame, endFrame: done.endFrame, sha: entry.sha256, source }), null, 2) + '\n';
        await save(path.join(root, name), Buffer.from(text), existsSync(path.join(root, name)));
        entry.sidecar = name;
      }
      results.push(entry);
    };

    if (audio) {
      if (output && inPlace) throw new Error('Give output or inPlace, not both');
      if (!output && !inPlace) throw new Error('Give output (a new file) or inPlace: true. The audio is never overwritten by default.');
      if (output && !output.toLowerCase().endsWith(path.extname(audio).toLowerCase())) throw new Error('The output must have the same type (WAV or OGG) as the audio');
      await tag(audio, output ?? audio, inPlace);
      return { files: results, ...(notes.length ? { notes } : {}), note: 'Verified by reading the written bytes back. Engines differ: Unity and FMOD read smpl, some read LOOPSTART and LOOPLENGTH; test in yours.' };
    }

    // Manifest mode: tag the loop file and its OGG twin where they exist, in place, and refresh the manifest checksums.
    const manifestPath = path.join(root, manifest);
    if (!existsSync(manifestPath)) throw new Error(`File not found: ${manifest}`);
    if (output || inPlace) throw new Error('With manifest the loop files are tagged in place; leave out output and inPlace');
    const json = JSON.parse(await readFile(manifestPath, 'utf8'));
    const folder = path.posix.dirname(manifest) === '.' ? '' : path.posix.dirname(manifest) + '/';
    const loopFile = json.loop?.file ?? json.files?.find(f => f.role === 'loop')?.file;
    if (!loopFile) throw new Error('The manifest lists no loop file');
    const targets = [loopFile];
    const entry = json.files?.find(f => f.file === loopFile);
    if (entry?.ogg) targets.push(entry.ogg);
    else if (existsSync(path.join(root, folder + loopFile.replace(/\.wav$/i, '.ogg')))) targets.push(loopFile.replace(/\.wav$/i, '.ogg'));
    // Default to the loop region the manifest records (whole loop file), unless the caller gave one.
    const given = Object.values(request).some(v => v !== undefined);
    if (!given && json.loop?.startFrame !== undefined && json.loop?.endFrame !== undefined) { request.startFrame = json.loop.startFrame; request.endFrame = json.loop.endFrame; }
    for (const name of targets) await tag(folder + name, folder + name, true, manifest, true);
    const wav = results.find(r => r.format === 'wav');
    if (wav && entry) entry.sha256 = wav.sha256;
    json.loopPoints = { writtenBy: 'write_loop_points', startFrame: results[0].startFrame, endFrame: results[0].endFrame, endIsExclusive: true,
      embedded: results.map(r => ({ file: r.file.slice(folder.length), format: r.format, sha256: r.sha256 })) };
    await save(manifestPath, Buffer.from(JSON.stringify(json, null, 2) + '\n'), true);
    return { manifest, files: results, ...(notes.length ? { notes } : {}), note: 'Loop files were tagged in place and the manifest now records the loop points and the new checksums.' };
  });
}
