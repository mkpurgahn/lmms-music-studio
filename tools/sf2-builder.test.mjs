import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { encodeWav } from '../audio.mjs';
import { runCommandSafe } from './fs-atomic.mjs';
import {
  SF2_GENERATORS,
  SF2_GUARD_SAMPLES,
  SF2_SAMPLE_TYPES,
  buildSf2Buffer,
  compileSfzToSf2,
  parseSf2Buffer,
  parseSfzArticulation,
  parseSfzNote,
} from './sf2-builder.mjs';

function makeSineWav(sampleRate, hz, seconds, stereo = false, amp = 0.5) {
  const frames = Math.round(sampleRate * seconds);
  const left = Float32Array.from({ length: frames }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sampleRate));
  if (!stereo) return encodeWav({ sampleRate, frames, channels: [left] });
  const right = Float32Array.from({ length: frames }, (_, i) => amp * Math.cos(2 * Math.PI * hz * i / sampleRate));
  return encodeWav({ sampleRate, frames, channels: [left, right] });
}

test('parseSfzNote parses integers and SFZ note names including sharps, flats, and s-notation', () => {
  assert.equal(parseSfzNote('60'), 60);
  assert.equal(parseSfzNote('C4'), 60);
  assert.equal(parseSfzNote('f#3'), 54);
  assert.equal(parseSfzNote('Fs3'), 54);
  assert.equal(parseSfzNote('Bb4'), 70);
  assert.equal(parseSfzNote('A0'), 21);
});

test('SFZ parser expands #define before #include, supports inline #include, and enforces single-articulation rules', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lmms-sfz-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await mkdir(path.join(dir, 'samples'), { recursive: true });

  await writeFile(path.join(dir, 'macros.sfz'), [
    '#define $MAP_DIR sub',
    '#define $KICK_KEY 36',
    '#define $HH_KEY 42',
  ].join('\n'));

  await writeFile(path.join(dir, 'sub', 'kick_map.sfz'), [
    '<region> sample=kick_rr1.wav lovel=1 hivel=60 xfout_lovel=40 xfout_hivel=60 seq_length=2',
    '<region> sample=kick_rr2.wav lovel=1 hivel=60 seq_length=2 seq_position=2',
    '<region> sample=kick_vel2_rr1.wav lovel=40 hivel=127 xfin_lovel=40 xfin_hivel=60 seq_length=2 seq_position=1',
  ].join('\n'));

  await writeFile(path.join(dir, 'sub', 'hh_closed.sfz'), '<region> sample=hh_closed_rr1.wav\n<region> sample=hh_closed_rr2.wav seq_position=2\n');
  await writeFile(path.join(dir, 'sub', 'hh_half.sfz'), '<region> sample=hh_half.wav\n');
  await writeFile(path.join(dir, 'sub', 'hh_open.sfz'), '<region> sample=hh_open_rr1.wav\n');

  await writeFile(path.join(dir, 'kit.sfz'), [
    '#include "macros.sfz"',
    '<control>',
    'default_path=samples\\',
    'octave_offset=0',
    'note_offset=0',
    '<global>',
    'sw_lokey=24 sw_hikey=25 sw_default=24',
    'loop_mode=one_shot',
    '<master> lochan=1 hichan=1',
    '<group> sw_last=24 key=$KICK_KEY #include "$MAP_DIR/kick_map.sfz"',
    '<group> sw_last=25 key=$KICK_KEY',
    '<region> sample=wrong_keyswitch.wav',
    '<master> lochan=2 hichan=2',
    '<group> sw_last=24 key=$KICK_KEY',
    '<region> sample=wrong_channel.wav',
    '<master> lochan=1 hichan=1',
    '<group> sw_last=24 key=60 locc64=64',
    '<region> sample=pedal_resonance.wav',
    '<group> sw_last=24 key=60 on_locc64=64',
    '<region> sample=pedal_noise.wav',
    '<group> sw_last=24 key=60 lorand=0.5 hirand=1.0',
    '<region> sample=rand_rr2.wav',
    '<group> sw_last=24 key=$HH_KEY locc4=96 hicc4=127 #include "$MAP_DIR/hh_closed.sfz"',
    '<group> sw_last=24 key=$HH_KEY locc4=32 hicc4=95 #include "$MAP_DIR/hh_half.sfz"',
    '<group> sw_last=24 key=$HH_KEY locc4=0 hicc4=31 #include "$MAP_DIR/hh_open.sfz"',
    '<group> sw_last=24 key=84',
    '<region> sample=slap_fx.wav',
  ].join('\n'));

  const regions = await parseSfzArticulation(path.join(dir, 'kit.sfz'), {
    boundaryDir: dir,
    drumMode: true,
    keyFilter: { maxKey: 71 },
  });

  const summary = regions.map(r => ({
    sample: path.basename(r.samplePath),
    lokey: r.lokey,
    hikey: r.hikey,
    lovel: r.lovel,
    hivel: r.hivel,
    exclusiveClass: r.exclusiveClass ?? null,
  }));

  assert.deepEqual(summary, [
    { sample: 'kick_rr1.wav', lokey: 36, hikey: 36, lovel: 1, hivel: 50, exclusiveClass: null },
    { sample: 'kick_vel2_rr1.wav', lokey: 36, hikey: 36, lovel: 51, hivel: 127, exclusiveClass: null },
    { sample: 'hh_closed_rr1.wav', lokey: 42, hikey: 42, lovel: 0, hivel: 127, exclusiveClass: 1 },
    { sample: 'hh_open_rr1.wav', lokey: 46, hikey: 46, lovel: 0, hivel: 127, exclusiveClass: 1 },
  ]);
});

test('compileSfzToSf2 writes deterministic RIFF sfbk 2.01 with 46 guard samples, stereo links, OGG/FLAC decode, and Bank 128 drums', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lmms-sf2-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const monoWavPath = path.join(dir, 'kick.wav');
  const stereoWavPath = path.join(dir, 'piano_c4.wav');
  const stereoOggPath = path.join(dir, 'piano_c4.ogg');
  const monoFlacPath = path.join(dir, 'hh_closed.flac');
  const openWavPath = path.join(dir, 'hh_open.wav');

  await writeFile(monoWavPath, makeSineWav(48000, 60, 0.15, false));
  await writeFile(stereoWavPath, makeSineWav(44100, 261.63, 0.2, true));
  await writeFile(openWavPath, makeSineWav(48000, 5000, 0.2, false));

  await runCommandSafe('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', stereoWavPath, '-c:a', 'libvorbis', '-q:a', '6', stereoOggPath]);
  await runCommandSafe('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', monoWavPath, '-c:a', 'flac', monoFlacPath]);

  const pianoSfz = path.join(dir, 'piano.sfz');
  await writeFile(pianoSfz, [
    '<global> ampeg_release=0.6',
    '<region> key=60 sample=piano_c4.ogg',
  ].join('\n'));

  const drumSfz = path.join(dir, 'drums.sfz');
  await writeFile(drumSfz, [
    '<global> loop_mode=one_shot',
    '<region> key=36 sample=kick.wav',
    '<region> key=42 hicc4=31 sample=hh_closed.flac',
    '<region> key=42 locc4=96 sample=hh_open.wav',
  ].join('\n'));

  const outSf2 = path.join(dir, 'combined.sf2');
  const first = await compileSfzToSf2({
    bankName: 'Test Multi Bank',
    outputPath: outSf2,
    presets: [
      { name: 'Stereo OGG Piano', bank: 0, preset: 0, sfzPath: pianoSfz, boundaryDir: dir },
      { name: 'GM Test Kit', bank: 128, preset: 0, sfzPath: drumSfz, boundaryDir: dir },
    ],
  });
  const second = await compileSfzToSf2({
    bankName: 'Test Multi Bank',
    presets: [
      { name: 'Stereo OGG Piano', bank: 0, preset: 0, sfzPath: pianoSfz, boundaryDir: dir },
      { name: 'GM Test Kit', bank: 128, preset: 0, sfzPath: drumSfz, boundaryDir: dir },
    ],
  });

  // Exact byte-for-byte determinism.
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.buffer.compare(second.buffer), 0);
  assert.equal(first.buffer.length % 2, 0);

  const parsed = parseSf2Buffer(first.buffer, { includeSamples: true });
  assert.deepEqual(parsed.info.version, { major: 2, minor: 1 });
  assert.equal(parsed.info.isng, 'EMU8000');
  assert.equal(parsed.info.INAM, 'Test Multi Bank');
  assert.equal(parsed.info.ICOP, 'CC0-1.0');
  assert.equal(parsed.info.ISFT, 'lmms-music-studio');
  assert.deepEqual(parsed.terminals, { phdr: 'EOP', inst: 'EOI', shdr: 'EOS' });
  assert.deepEqual(parsed.pdtaChunkOrder, ['phdr', 'pbag', 'pmod', 'pgen', 'inst', 'ibag', 'imod', 'igen', 'shdr']);

  assert.deepEqual(parsed.presets.map(p => ({ name: p.name, bank: p.bank, preset: p.preset })), [
    { name: 'Stereo OGG Piano', bank: 0, preset: 0 },
    { name: 'GM Test Kit', bank: 128, preset: 0 },
  ]);

  // Stereo sample checks: L (type 2) + R (type 4) linked via wSampleLink, panned -500 / +500, sampleID (53) last in each zone.
  const pianoInst = parsed.instruments[0];
  assert.equal(pianoInst.zones.length, 2);
  for (const [idx, zone] of pianoInst.zones.entries()) {
    assert.equal(zone.generators[0].oper, SF2_GENERATORS.keyRange);
    assert.equal(zone.generators.at(-1).oper, SF2_GENERATORS.sampleID);
    const panGen = zone.generators.find(g => g.oper === SF2_GENERATORS.pan);
    assert.equal(panGen.i16, idx === 0 ? -500 : 500);
  }
  const leftSample = parsed.samples[0];
  const rightSample = parsed.samples[1];
  assert.equal(leftSample.sfSampleType, SF2_SAMPLE_TYPES.leftSample);
  assert.equal(rightSample.sfSampleType, SF2_SAMPLE_TYPES.rightSample);
  assert.equal(leftSample.wSampleLink, 1);
  assert.equal(rightSample.wSampleLink, 0);

  // Drum kit exclusiveClass=1 on keys 42 and 46, and sampleID last in every zone.
  const drumInst = parsed.instruments[1];
  assert.equal(drumInst.zones.length, 3);
  for (const zone of drumInst.zones) {
    assert.equal(zone.generators.at(-1).oper, SF2_GENERATORS.sampleID);
  }
  const hhClosedZone = drumInst.zones.find(z => z.generators[0].lo === 42 && z.generators[0].hi === 42);
  const hhOpenZone = drumInst.zones.find(z => z.generators[0].lo === 46 && z.generators[0].hi === 46);
  assert.ok(hhClosedZone && hhOpenZone);
  assert.equal(hhClosedZone.generators.find(g => g.oper === SF2_GENERATORS.exclusiveClass)?.u16, 1);
  assert.equal(hhOpenZone.generators.find(g => g.oper === SF2_GENERATORS.exclusiveClass)?.u16, 1);

  // Verify 46 zero int16 guard samples follow every sample in smpl.
  for (const sample of parsed.samples) {
    assert.ok(sample.dwEnd + SF2_GUARD_SAMPLES <= parsed.smplSamplePoints);
    for (let g = 0; g < SF2_GUARD_SAMPLES; g++) {
      const sampleVal = parsed.smplBuffer.readInt16LE((sample.dwEnd + g) * 2);
      assert.equal(sampleVal, 0, `Expected guard sample ${g} after ${sample.name} to be 0`);
    }
  }

  // Verify buildSf2Buffer validates empty input cleanly.
  assert.throws(() => buildSf2Buffer({ presets: [] }), /at least one preset/);
});
