// Unit tests for tools/loop-points.mjs on synthetic files. Run: node --test tools/loop-points.test.mjs
// Everything is verified by parsing the written bytes back; no audio is played.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import * as dsp from '../audio.mjs';
import { applyLoop, buildSmplBody, buildVorbisComment, lacing, oggCrc, oggInfo, oggPage, parseOggPages, parseSmpl, parseVorbisComment, readOggLoop,
  register, resolveLoop, riffChunks, setOggLoop, setWavLoop, sidecarFor, wavInfo } from './loop-points.mjs';

const run = promisify(execFile);
const sine = (frames, sampleRate = 48000, hz = 440, channels = 1) => ({ sampleRate,
  channels: Array.from({ length: channels }, () => Float32Array.from({ length: frames }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / sampleRate))) });

// A tiny fake Ogg Vorbis stream: three header packets, then `audioPages` pages of audio with known granules.
function fakeOgg({ vendor = 'test vendor', comments = ['TITLE=Forest'], audioPages = 4, framesPerPage = 1024, setupSize = 3000, sampleRate = 44100, channels = 2 } = {}) {
  const id = Buffer.alloc(30);
  id.write('\x01vorbis', 0, 'latin1'); id.writeUInt32LE(0, 7); id.writeUInt8(channels, 11); id.writeUInt32LE(sampleRate, 12); id.writeUInt8(1, 29);
  const comment = buildVorbisComment({ vendor, comments });
  const setup = Buffer.alloc(setupSize, 7); setup.write('\x05vorbis', 0, 'latin1');
  const serial = 0x1234abcd, pages = [oggPage({ headerType: 2, serial, seq: 0, segments: lacing(id.length), body: id })];
  const segments = [...lacing(comment.length), ...lacing(setup.length)], body = Buffer.concat([comment, setup]);
  let seq = 1, taken = 0;
  for (let s = 0; s < segments.length; s += 255) {
    const slice = segments.slice(s, s + 255), size = slice.reduce((a, b) => a + b, 0);
    pages.push(oggPage({ headerType: s ? 1 : 0, serial, seq: seq++, segments: slice, body: body.subarray(taken, taken + size) }));
    taken += size;
  }
  const audio = [];
  for (let p = 0; p < audioPages; p++) {
    const packet = Buffer.alloc(200 + p, p + 1); // a different packet on every page, so copying is checkable
    audio.push(packet);
    pages.push(oggPage({ headerType: p === audioPages - 1 ? 4 : 0, granule: BigInt((p + 1) * framesPerPage), serial, seq: seq++, segments: lacing(packet.length), body: packet }));
  }
  return { ogg: Buffer.concat(pages), audio, frames: audioPages * framesPerPage };
}

test('Ogg CRC matches a known value (CRC-32/MPEG-2-style, no reflection)', () => {
  // The standard check string "123456789" gives 0x89a1897f for this variant (poly 0x04c11db7, init 0, no xorout).
  assert.equal(oggCrc(Buffer.from('123456789')), 0x89a1897f);
});

test('WAV smpl chunk: body layout, write and read back, end is exclusive in and out', () => {
  const body = buildSmplBody({ sampleRate: 48000, startFrame: 100, endFrame: 4100 });
  assert.equal(body.length, 60);
  assert.equal(body.readUInt32LE(8), Math.round(1e9 / 48000));
  assert.equal(body.readUInt32LE(28), 1);
  assert.equal(body.readUInt32LE(44), 100);
  assert.equal(body.readUInt32LE(48), 4099, 'the chunk stores the inclusive last frame');
  const wav = dsp.encodeWav(sine(5000));
  const tagged = setWavLoop(wav, { startFrame: 100, endFrame: 4100 });
  const smpl = parseSmpl(tagged);
  assert.deepEqual(smpl.loops.map(({ startFrame, endFrame, type, playCount }) => ({ startFrame, endFrame, type, playCount })), [{ startFrame: 100, endFrame: 4100, type: 0, playCount: 0 }]);
  assert.equal(tagged.readUInt32LE(4), tagged.length - 8, 'RIFF size is fixed up');
  assert.deepEqual(wavInfo(tagged), wavInfo(wav));
  assert.deepEqual(dsp.decodeWav(tagged).channels[0], dsp.decodeWav(wav).channels[0], 'the audio data is unchanged');
});

test('WAV: re-tagging replaces the old smpl chunk, other chunks survive in order, odd chunks are padded', () => {
  const wav = dsp.encodeWav(sine(2000));
  const withList = Buffer.concat([wav, Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
  withList.writeUInt32LE(withList.length - 8, 4);
  const once = setWavLoop(withList, { startFrame: 0, endFrame: 2000 });
  const twice = setWavLoop(once, { startFrame: 10, endFrame: 1500 });
  assert.deepEqual(riffChunks(twice).map(c => c.id), ['fmt ', 'data', 'LIST', 'smpl']);
  assert.equal(riffChunks(twice).filter(c => c.id === 'smpl').length, 1);
  assert.deepEqual(parseSmpl(twice).loops.map(l => [l.startFrame, l.endFrame]), [[10, 1500]]);
  const list = riffChunks(twice).find(c => c.id === 'LIST');
  assert.equal(twice.toString('latin1', list.body, list.body + 3), 'abc');
  assert.equal(twice.length % 2, 0);
  assert.equal(twice.readUInt32LE(4), twice.length - 8);
});

test('WAV: a loop beyond the file, an empty loop and non-integer frames are refused', () => {
  const wav = dsp.encodeWav(sine(1000));
  assert.throws(() => setWavLoop(wav, { startFrame: 0, endFrame: 1001 }), /only 1000 frames/);
  assert.throws(() => buildSmplBody({ sampleRate: 48000, startFrame: 5, endFrame: 5 }), /startFrame < endFrame/);
  assert.throws(() => buildSmplBody({ sampleRate: 48000, startFrame: 0.5, endFrame: 9 }), /whole frames/);
  assert.throws(() => setWavLoop(Buffer.from('not a wav at all'), { startFrame: 0, endFrame: 1 }), /RIFF/);
});

test('resolveLoop: defaults to the whole file, converts seconds, refuses mixed or bad input', () => {
  const base = { sampleRate: 48000, frames: 96000 };
  assert.deepEqual(resolveLoop(base), { startFrame: 0, endFrame: 96000 });
  assert.deepEqual(resolveLoop({ ...base, startSeconds: 0.5, endSeconds: 1.5 }), { startFrame: 24000, endFrame: 72000 });
  assert.deepEqual(resolveLoop({ ...base, startFrame: 10 }), { startFrame: 10, endFrame: 96000 });
  assert.throws(() => resolveLoop({ ...base, startFrame: 1, endSeconds: 2 }), /not both/);
  assert.throws(() => resolveLoop({ ...base, startFrame: 50, endFrame: 50 }), /start < end/);
  assert.throws(() => resolveLoop({ ...base, endFrame: 96001 }), /only 96000 frames/);
  assert.throws(() => resolveLoop({ ...base, startFrame: 1.5 }), /whole numbers/);
});

test('Vorbis comment header: build and parse round trip, including non-ASCII text', () => {
  const packet = buildVorbisComment({ vendor: 'Lavf', comments: ['TITLE=Wald ünd Nacht', 'ARTIST=A'] });
  assert.deepEqual(parseVorbisComment(packet), { vendor: 'Lavf', comments: ['TITLE=Wald ünd Nacht', 'ARTIST=A'] });
  assert.equal(packet[packet.length - 1], 1, 'framing bit is set');
  assert.throws(() => parseVorbisComment(Buffer.from('\x01vorbis....')), /Not a Vorbis comment/);
});

test('OGG: loop tags are written, other comments kept, audio packets and granules untouched, CRCs valid, sequence contiguous', () => {
  const { ogg, audio, frames } = fakeOgg();
  const out = setOggLoop(ogg, { startFrame: 1000, endFrame: 3500 });
  assert.deepEqual(readOggLoop(out), { LOOPSTART: '1000', LOOPEND: '3500', LOOPLENGTH: '2500' });
  const info = oggInfo(out);
  assert.deepEqual([info.sampleRate, info.channels, info.frames, info.vendor], [44100, 2, frames, 'test vendor']);
  assert.ok(info.comments.includes('TITLE=Forest'));
  const pages = parseOggPages(out);
  pages.forEach((page, i) => {
    assert.equal(page.seq, i, 'page sequence numbers are contiguous');
    const copy = Buffer.from(out.subarray(page.offset, page.end));
    copy.writeUInt32LE(0, 22);
    assert.equal(oggCrc(copy), out.readUInt32LE(page.offset + 22), `page ${i} CRC`);
  });
  assert.equal(pages[0].headerType & 2, 2, 'first page is still BOS');
  assert.equal(pages.at(-1).headerType & 4, 4, 'last page is still EOS');
  const audioPages = pages.slice(-audio.length);
  audioPages.forEach((page, i) => { assert.deepEqual(page.body, audio[i]); assert.equal(page.granule, BigInt((i + 1) * 1024)); });
  assert.ok(new Set(pages.map(p => p.serial)).size === 1);
});

test('OGG: tagging twice replaces the tags (no duplicates, case-insensitive), and a large comment header spreads over pages', () => {
  const many = Array.from({ length: 2000 }, (_, i) => `NOTE${i}=${'x'.repeat(40)}`);
  const { ogg } = fakeOgg({ comments: ['loopstart=1', 'LoopLength=2', 'TITLE=T', ...many], setupSize: 600 });
  const once = setOggLoop(ogg, { startFrame: 5, endFrame: 20 });
  const twice = setOggLoop(once, { startFrame: 6, endFrame: 30 });
  const comments = oggInfo(twice).comments;
  assert.equal(comments.filter(c => /^loop/i.test(c)).length, 3);
  assert.deepEqual(readOggLoop(twice), { LOOPSTART: '6', LOOPEND: '30', LOOPLENGTH: '24' });
  assert.equal(comments.length, 3 + many.length + 1, 'every unrelated comment was kept');
  assert.ok(parseOggPages(twice).length > 6, 'the headers needed several pages');
  assert.equal(oggInfo(twice).frames, 4096);
});

test('OGG: a packet whose size is a multiple of 255 gets its terminating zero lacing value', () => {
  assert.deepEqual(lacing(510), [255, 255, 0]);
  assert.deepEqual(lacing(0), [0]);
  assert.deepEqual(lacing(300), [255, 45]);
  const { ogg } = fakeOgg({ setupSize: 765 });
  assert.equal(oggInfo(setOggLoop(ogg, { startFrame: 0, endFrame: 10 })).frames, 4096);
});

test('OGG: non-Vorbis streams and damaged files are refused with a plain message', () => {
  const opus = Buffer.concat([oggPage({ headerType: 2, serial: 1, seq: 0, segments: lacing(19), body: Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]) }),
    oggPage({ serial: 1, seq: 1, segments: lacing(12), body: Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(4)]) })]);
  assert.throws(() => setOggLoop(opus, { startFrame: 0, endFrame: 5 }), /three Vorbis headers|Only Ogg Vorbis/);
  assert.throws(() => parseOggPages(Buffer.from('definitely not ogg data here, nope')), /Not a valid Ogg/);
  const { ogg } = fakeOgg();
  assert.throws(() => parseOggPages(ogg.subarray(0, ogg.length - 10)), /truncated/);
});

test('applyLoop: WAV and OGG report what they now say, and refuse a loop past the end', () => {
  const wav = applyLoop(dsp.encodeWav(sine(4800)), 'wav', { startSeconds: 0.01, endSeconds: 0.09 });
  assert.deepEqual([wav.startFrame, wav.endFrame], [480, 4320]);
  assert.equal(parseSmpl(wav.buffer).loops[0].endFrame, 4320);
  const ogg = applyLoop(fakeOgg().ogg, 'ogg', { endFrame: 4000 });
  assert.deepEqual([ogg.startFrame, ogg.endFrame, ogg.info.sampleRate], [0, 4000, 44100]);
  assert.throws(() => applyLoop(fakeOgg().ogg, 'ogg', { endFrame: 99999 }), /only 4096 frames/);
});

test('sidecar: frames, seconds, exclusive end, embedded tags per format', () => {
  const wav = sidecarFor({ file: 'a-loop.wav', kind: 'wav', sampleRate: 48000, channels: 2, frames: 96000, startFrame: 0, endFrame: 96000, sha: 'abc' });
  assert.deepEqual(wav.loop, { startFrame: 0, endFrame: 96000, lengthFrames: 96000, startSeconds: 0, endSeconds: 2, endIsExclusive: true });
  assert.equal(wav.embedded.smpl.endFrameInclusive, 95999);
  const ogg = sidecarFor({ file: 'a-loop.ogg', kind: 'ogg', sampleRate: 44100, channels: 2, frames: 88200, startFrame: 100, endFrame: 88200, sha: 'def' });
  assert.deepEqual(ogg.embedded.vorbisComments, { LOOPSTART: '100', LOOPEND: '88200', LOOPLENGTH: '88100' });
});

// ---------- the tool, against a temporary workspace ----------
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-points-'));
  const tools = {}, moduleGuidance = [];
  register({
    tool: (name, description, schema, handler) => { tools[name] = { schema: z.object(schema), handler }; },
    z,
    root,
    moduleGuidance,
    env: { LMMS_STRICT_COPYRIGHT: '0' },
  });
  const call = (name, args) => tools[name].handler(tools[name].schema.parse(args));
  return { root, call, moduleGuidance, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('write_loop_points: needs output or inPlace, never overwrites by default, writes a sidecar and a tagged copy', async () => {
  const w = await workspace();
  try {
    const wav = dsp.encodeWav(sine(9600));
    await writeFile(path.join(w.root, 'theme.wav'), wav);
    await assert.rejects(w.call('write_loop_points', { audio: 'theme.wav' }), /output.*inPlace/);
    const result = await w.call('write_loop_points', { audio: 'theme.wav', output: 'theme-tagged.wav', startFrame: 480, endFrame: 9600 });
    assert.equal(result.files[0].lengthFrames, 9120);
    assert.deepEqual(await readFile(path.join(w.root, 'theme.wav')), wav, 'the source is untouched');
    assert.deepEqual(parseSmpl(await readFile(path.join(w.root, 'theme-tagged.wav'))).loops.map(l => [l.startFrame, l.endFrame]), [[480, 9600]]);
    const sidecar = JSON.parse(await readFile(path.join(w.root, 'theme-tagged.loop.json'), 'utf8'));
    assert.equal(sidecar.loop.endFrame, 9600);
    assert.equal(sidecar.sha256, result.files[0].sha256);
    await assert.rejects(w.call('write_loop_points', { audio: 'theme.wav', output: 'theme-tagged.wav' }), /EEXIST|exists/i);
    await assert.rejects(w.call('write_loop_points', { audio: 'theme.wav', output: 'x.ogg' }), /same type/);
    await assert.rejects(w.call('write_loop_points', { audio: 'theme.wav', manifest: 'a.manifest.json', output: 'b.wav' }), /either audio or manifest/);
    await assert.rejects(w.call('write_loop_points', { audio: 'theme.wav', inPlace: true, startFrame: 0, endFrame: 20000 }), /only 9600 frames/);
    assert.deepEqual(await readFile(path.join(w.root, 'theme.wav')), wav, 'a refused loop leaves the file as it was');
    assert.deepEqual((await readdir(w.root)).filter(f => f.startsWith('.')), [], 'no temp files are left behind');
  } finally { await w.cleanup(); }
});

test('write_loop_points: inPlace replaces atomically; OGG in a sub-folder works; sidecar can be switched off', async () => {
  const w = await workspace();
  try {
    await mkdir(path.join(w.root, 'game'));
    const { ogg } = fakeOgg();
    await writeFile(path.join(w.root, 'game', 'a.ogg'), ogg);
    const result = await w.call('write_loop_points', { audio: 'game/a.ogg', inPlace: true, startSeconds: 0.01, sidecar: false });
    assert.equal(result.files[0].startFrame, 441);
    assert.deepEqual(readOggLoop(await readFile(path.join(w.root, 'game', 'a.ogg'))), { LOOPSTART: '441', LOOPEND: '4096', LOOPLENGTH: '3655' });
    assert.deepEqual((await readdir(path.join(w.root, 'game'))).sort(), ['a.ogg']);
  } finally { await w.cleanup(); }
});

test('write_loop_points: manifest mode tags the WAV and its OGG twin, clamps a few missing OGG frames, refreshes the manifest', async () => {
  const w = await workspace();
  try {
    await mkdir(path.join(w.root, 'out'));
    const wav = dsp.encodeWav(sine(4200, 44100, 440, 2));
    await writeFile(path.join(w.root, 'out', 'a-loop.wav'), wav);
    await writeFile(path.join(w.root, 'out', 'a-loop.ogg'), fakeOgg({ audioPages: 4, framesPerPage: 1024 }).ogg); // 4096 frames: 104 short
    const manifest = { name: 'a', sampleRate: 44100, loop: { file: 'a-loop.wav', startFrame: 0, endFrame: 4200, seamless: true },
      files: [{ file: 'a-loop.wav', ogg: 'a-loop.ogg', role: 'loop', frames: 4200, sha256: 'old' }] };
    await writeFile(path.join(w.root, 'out', 'a.manifest.json'), JSON.stringify(manifest));
    const result = await w.call('write_loop_points', { manifest: 'out/a.manifest.json' });
    assert.deepEqual(result.files.map(f => [f.file, f.startFrame, f.endFrame]), [['out/a-loop.wav', 0, 4200], ['out/a-loop.ogg', 0, 4096]]);
    assert.match(result.notes[0], /104 fewer/);
    const written = await readFile(path.join(w.root, 'out', 'a-loop.wav'));
    assert.deepEqual(parseSmpl(written).loops.map(l => [l.startFrame, l.endFrame]), [[0, 4200]]);
    assert.deepEqual(readOggLoop(await readFile(path.join(w.root, 'out', 'a-loop.ogg'))), { LOOPSTART: '0', LOOPEND: '4096', LOOPLENGTH: '4096' });
    const after = JSON.parse(await readFile(path.join(w.root, 'out', 'a.manifest.json'), 'utf8'));
    assert.equal(after.files[0].sha256, result.files[0].sha256, 'the manifest checksum follows the tagged WAV');
    assert.notEqual(after.files[0].sha256, 'old');
    assert.equal(after.loopPoints.endIsExclusive, true);
    assert.ok(existsSidecar(await readdir(path.join(w.root, 'out'))));
    await assert.rejects(w.call('write_loop_points', { manifest: 'out/a.manifest.json', inPlace: true }), /in place/);
  } finally { await w.cleanup(); }
});
const existsSidecar = names => names.includes('a-loop.loop.json') && names.includes('a-loop.loop.json');

test('write_loop_points: guidance is registered for agents', async () => {
  const w = await workspace();
  try { assert.match(w.moduleGuidance[0], /write_loop_points/); } finally { await w.cleanup(); }
});

// A real ffmpeg-made Vorbis file, when ffmpeg is installed: the same code must cope with a real encoder's page layout.
test('OGG from a real ffmpeg encode: tags are written and the file still decodes to the same length', async t => {
  const ffmpeg = process.env.LMMS_FFMPEG ?? 'ffmpeg';
  if (!(await run(ffmpeg, ['-version'], { windowsHide: true }).then(() => true, () => false))) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-points-ff-'));
  try {
    await writeFile(path.join(dir, 'in.wav'), dsp.encodeWav(sine(48000 * 2, 48000, 330, 2)));
    await run(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'in.wav'), '-c:a', 'libvorbis', '-q:a', '4', path.join(dir, 'a.ogg')], { windowsHide: true });
    const ogg = await readFile(path.join(dir, 'a.ogg'));
    const before = oggInfo(ogg);
    const tagged = setOggLoop(ogg, { startFrame: 4800, endFrame: before.frames });
    assert.deepEqual(readOggLoop(tagged), { LOOPSTART: '4800', LOOPEND: String(before.frames), LOOPLENGTH: String(before.frames - 4800) });
    await writeFile(path.join(dir, 'b.ogg'), tagged);
    // ffmpeg accepts it and reads the tags back with ffprobe-style metadata output; the decode is clean and the same length.
    const { stderr } = await run(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'b.ogg'), '-f', 'null', '-'], { windowsHide: true });
    assert.equal(stderr.trim(), '', 'ffmpeg decoded the re-paged stream without a warning');
    const probe = process.env.LMMS_FFPROBE ?? 'ffprobe';
    const probed = await run(probe, ['-v', 'error', '-show_entries', 'stream_tags', '-of', 'json', path.join(dir, 'b.ogg')], { windowsHide: true }).then(r => r.stdout, () => null);
    if (probed) {
      const tags = Object.fromEntries(Object.entries(JSON.parse(probed).streams[0].tags ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
      assert.deepEqual([tags.LOOPSTART, tags.LOOPEND, tags.LOOPLENGTH], ['4800', String(before.frames), String(before.frames - 4800)], 'ffprobe reads the tags the tool wrote');
    }
    const decoded = await run(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'b.ogg'), '-f', 'f32le', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 28 });
    const original = await run(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'a.ogg'), '-f', 'f32le', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 28 });
    assert.deepEqual(decoded.stdout, original.stdout, 'the audio decodes bit for bit the same');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- the loop-join click check (audio.mjs), which flagged loops that start on a drum hit ----------
function randomSource(seed) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 31 - 1; }; }
const joinNotes = audio => dsp.advise(dsp.analyze(audio), { loop: true }).filter(note => /loop point/.test(note));
test('loop join: a loop that starts on a drum hit is not called a click, a real discontinuity still is', () => {
  const sampleRate = 48000, frames = sampleRate, random = randomSource(3);
  // Drum loop: a noise burst with a decay at sample 0 (the hit), quiet tail of the previous hit at the end.
  const hit = new Float32Array(frames);
  for (let i = 0; i < 4800; i++) hit[i] = 0.8 * random() * Math.exp(-i / 1200);
  for (let i = frames - 2400; i < frames; i++) hit[i] = 0.02 * random();
  const report = dsp.analyze({ sampleRate, frames, channels: [hit] });
  assert.ok(report.loop.boundaryJumpDbfs > -30, 'the first and last samples do differ by a lot (this is what used to warn)');
  assert.equal(dsp.loopJoinClicks(report.loop), false);
  assert.deepEqual(joinNotes({ sampleRate, frames, channels: [hit] }), []);
  // A slow sine cut a quarter cycle in: first sample 0, last sample near full amplitude, and a gentle slope: a real click.
  const cut = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 50.25 * i / sampleRate)); // 50.25 cycles: ends near a peak
  const clicking = dsp.analyze({ sampleRate, frames, channels: [cut] });
  assert.equal(dsp.loopJoinClicks(clicking.loop), true);
  assert.equal(joinNotes({ sampleRate, frames, channels: [cut] }).length, 1);
  // A whole number of cycles wraps cleanly: no warning.
  const wrapped = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 50 * i / sampleRate));
  assert.deepEqual(joinNotes({ sampleRate, frames, channels: [wrapped] }), []);
});
test('loopJoinClicks: reports from before boundaryStepDbfs existed keep the plain -30 dBFS rule', () => {
  assert.equal(dsp.loopJoinClicks({ boundaryJumpDbfs: -12 }), true);
  assert.equal(dsp.loopJoinClicks({ boundaryJumpDbfs: -40 }), false);
  assert.equal(dsp.loopJoinClicks({ boundaryJumpDbfs: null }), false);
  assert.equal(dsp.loopJoinClicks({ boundaryJumpDbfs: -12, boundaryStepDbfs: null }), true);
});
