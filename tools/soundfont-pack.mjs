// CC0-1.0 Acoustic SoundFont Pack installer, verifier, and lockfile generator.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCommandSafe, writeFileAtomic } from './fs-atomic.mjs';
import { createLogger } from './logger.mjs';
import { compileSfzToSf2, parseSf2Buffer, parseSfzArticulation } from './sf2-builder.mjs';
import { resolveFfmpegExecutable, resolveSoundfontsDir } from './workspace-config.mjs';

const log = createLogger('soundfont-pack');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TRACKED_LOCK_PATH = path.join(REPO_ROOT, 'soundfont-lock.json');

export const CC0_CANONICAL_LICENSE_SHA256 = 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499';
export const VSCO2_CE_LICENSE_SHA256 = '4d2eef679d5faf924534bcc132646322e9a852ce50ae5616694e0b95f7b8275d';
export const UPRIGHT_PIANO_KW_SF2_SHA256 = 'cf2a98eb38a32c4954b4b6e2caae4112d62dd8e892eceefdd7942b0e7d01ac2f';

export const PACK_NAMES = Object.freeze([
  'core',
  'upright-bass',
  'meta-piano',
  'vsco-extended',
  'vsco-complete',
  'all',
]);

const lockFileCache = new Map();

export const SOUNDFONT_TARGETS = Object.freeze({
  'upright-piano-kw': {
    id: 'upright-piano-kw',
    pack: 'core',
    fileName: 'upright-piano-kw.sf2',
    licence: 'CC0-1.0',
    licenceRegistryId: 'upright-piano-kw',
    kind: 'archive-sf2',
    archiveUrl: 'https://freepats.zenvoid.org/Piano/UprightPianoKW/UprightPianoKW-small-SF2-20190703.7z',
    archiveEntry: 'UprightPianoKW-small-20190703.sf2',
    expectedSf2Sha256: UPRIGHT_PIANO_KW_SF2_SHA256,
    author: 'Gary Wolk (FreePats)',
    sourceUrl: 'https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html',
  },
  'meta-guitars': {
    id: 'meta-guitars',
    pack: 'core',
    fileName: 'meta-guitars.sf2',
    bankName: 'Meta Open Sound Guitars (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'meta-open-sound',
    kind: 'git-sfz',
    repoKey: 'meta-open-sound',
    repoUrl: 'https://github.com/facebookincubator/Meta-open-sound.git',
    commit: '514c926efecdb3c7812bf00eedf8e5c8d61dd681',
    licencePath: 'LICENSE',
    licenceSha256: CC0_CANONICAL_LICENSE_SHA256,
    allowedPathPrefixes: [
      'LICENSE',
      'systems/instruments/meta-nylon-guitar/',
      'systems/instruments/meta-steel-guitar/',
    ],
    forbiddenPathPrefixes: [
      'corpora/',
      'corpora/oculus-audio-pack/',
    ],
    initialSparsePaths: [
      '/LICENSE',
      '/systems/instruments/meta-nylon-guitar/LICENSE',
      '/systems/instruments/meta-nylon-guitar/SHA256SUMS',
      '/systems/instruments/meta-nylon-guitar/meta-nylon-guitar.sfz',
      '/systems/instruments/meta-steel-guitar/LICENSE',
      '/systems/instruments/meta-steel-guitar/SHA256SUMS',
      '/systems/instruments/meta-steel-guitar/meta-steel-guitar.sfz',
    ],
    sha256SumsFiles: [
      'systems/instruments/meta-nylon-guitar/SHA256SUMS',
      'systems/instruments/meta-steel-guitar/SHA256SUMS',
    ],
    presets: [
      {
        name: 'Meta Nylon Guitar',
        bank: 0,
        preset: 0,
        sfzRelPath: 'systems/instruments/meta-nylon-guitar/meta-nylon-guitar.sfz',
        subBoundaryRel: 'systems/instruments/meta-nylon-guitar',
        gainBoostDb: 15,
      },
      {
        name: 'Meta Steel Guitar',
        bank: 0,
        preset: 1,
        sfzRelPath: 'systems/instruments/meta-steel-guitar/meta-steel-guitar.sfz',
        subBoundaryRel: 'systems/instruments/meta-steel-guitar',
        gainBoostDb: 8,
      },
    ],
  },
  'virtuosity-drums': {
    id: 'virtuosity-drums',
    pack: 'core',
    fileName: 'virtuosity-drums.sf2',
    bankName: 'Virtuosity Drums GM (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'virtuosity-drums',
    kind: 'git-sfz',
    repoKey: 'virtuosity-drums',
    repoUrl: 'https://github.com/sfzinstruments/virtuosity_drums.git',
    commit: '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc',
    licencePath: 'LICENSE',
    licenceSha256: CC0_CANONICAL_LICENSE_SHA256,
    allowedPathPrefixes: [
      'LICENSE',
      'Programs/',
      'Samples/mid/kick/',
      'Samples/mid/snare/',
      'Samples/mid/hh/',
      'Samples/mid/ride/',
      'Samples/mid/crash/',
    ],
    initialSparsePaths: [
      '/LICENSE',
      '/Programs/**',
    ],
    presets: [
      {
        name: 'Virtuosity Drums GM',
        bank: 128,
        preset: 0,
        drumMode: true,
        sfzRelPath: 'Programs/06-mid-mic.sfz',
        allowedKeys: [36, 38, 42, 46, 49, 51],
        targetVelocity: 96,
      },
    ],
  },
  'vsco-orchestra-core': {
    id: 'vsco-orchestra-core',
    pack: 'core',
    fileName: 'vsco-orchestra-core.sf2',
    bankName: 'VSCO-2 CE Orchestra Core (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/ViolinEnsSusVib.sfz',
      '/ContrabassSusVB.sfz',
      '/FHornSus.sfz',
      '/FluteStac.sfz',
      '/Harp.sfz',
      '/Timpani.sfz',
    ],
    presets: [
      { name: 'Violin Ensemble Sustain', bank: 0, preset: 0, sfzRelPath: 'ViolinEnsSusVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Contrabass Sustain', bank: 0, preset: 1, sfzRelPath: 'ContrabassSusVB.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'French Horn Sustain', bank: 0, preset: 2, sfzRelPath: 'FHornSus.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Flute Staccato', bank: 0, preset: 3, sfzRelPath: 'FluteStac.sfz', targetVelocity: 90 },
      { name: 'Concert Harp', bank: 0, preset: 4, sfzRelPath: 'Harp.sfz', targetVelocity: 90, zoneStride: 3 },
      { name: 'Timpani', bank: 0, preset: 5, sfzRelPath: 'Timpani.sfz', targetVelocity: 90 },
    ],
  },
  'upright-bass': {
    id: 'upright-bass',
    pack: 'upright-bass',
    fileName: 'upright-bass.sf2',
    bankName: 'Rubner Upright Bass Pizzicato (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'dsmolken-double-bass',
    kind: 'git-sfz',
    repoKey: 'dsmolken-double-bass',
    repoUrl: 'https://github.com/sfzinstruments/dsmolken.double-bass.git',
    commit: 'c2985eb647109d2a8f30a70071e3e163339d7396',
    licencePath: 'LICENSE',
    licenceSha256: CC0_CANONICAL_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/d_smolken_rubner_bass_pizz.sfz',
    ],
    presets: [
      {
        name: 'Upright Bass Pizzicato',
        bank: 0,
        preset: 0,
        sfzRelPath: 'd_smolken_rubner_bass_pizz.sfz',
        keyFilter: { maxKey: 71 },
        targetVelocity: 90,
      },
    ],
  },
  'meta-piano': {
    id: 'meta-piano',
    pack: 'meta-piano',
    fileName: 'meta-piano.sf2',
    bankName: 'Meta Acoustic Piano (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'meta-open-sound',
    kind: 'git-sfz',
    repoKey: 'meta-open-sound',
    repoUrl: 'https://github.com/facebookincubator/Meta-open-sound.git',
    commit: '514c926efecdb3c7812bf00eedf8e5c8d61dd681',
    licencePath: 'LICENSE',
    licenceSha256: CC0_CANONICAL_LICENSE_SHA256,
    allowedPathPrefixes: [
      'LICENSE',
      'systems/instruments/meta-piano/',
    ],
    forbiddenPathPrefixes: [
      'corpora/',
      'corpora/oculus-audio-pack/',
    ],
    initialSparsePaths: [
      '/LICENSE',
      '/systems/instruments/meta-piano/LICENSE',
      '/systems/instruments/meta-piano/SHA256SUMS',
      '/systems/instruments/meta-piano/meta-piano.sfz',
    ],
    sha256SumsFiles: [
      'systems/instruments/meta-piano/SHA256SUMS',
    ],
    presets: [
      {
        name: 'Meta Acoustic Piano',
        bank: 0,
        preset: 0,
        sfzRelPath: 'systems/instruments/meta-piano/meta-piano.sfz',
        subBoundaryRel: 'systems/instruments/meta-piano',
      },
    ],
  },
  'vsco-orchestra-extended': {
    id: 'vsco-orchestra-extended',
    pack: 'vsco-extended',
    fileName: 'vsco-orchestra-extended.sf2',
    bankName: 'VSCO-2 CE Orchestra Extended (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/FluteSusVib.sfz',
      '/ClarinetStac.sfz',
      '/CelloEnsSpic.sfz',
      '/ContrabassSpic.sfz',
      '/ViolinEnsSpic.sfz',
      '/ViolinEnsTrem.sfz',
      '/ViolaEnsTrem.sfz',
      '/TrumpetStac.sfz',
      '/TubaStac.sfz',
      '/SViolinTrem.sfz',
      '/SViolinPizz.sfz',
    ],
    presets: [
      { name: 'Flute Sustain Vibrato', bank: 0, preset: 0, sfzRelPath: 'FluteSusVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Clarinet Staccato', bank: 0, preset: 1, sfzRelPath: 'ClarinetStac.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Cello Ensemble Spiccato', bank: 0, preset: 2, sfzRelPath: 'CelloEnsSpic.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Contrabass Spiccato', bank: 0, preset: 3, sfzRelPath: 'ContrabassSpic.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Violin Ensemble Spiccato', bank: 0, preset: 4, sfzRelPath: 'ViolinEnsSpic.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Violin Ensemble Tremolo', bank: 0, preset: 5, sfzRelPath: 'ViolinEnsTrem.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Viola Ensemble Tremolo', bank: 0, preset: 6, sfzRelPath: 'ViolaEnsTrem.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trumpet Staccato', bank: 0, preset: 7, sfzRelPath: 'TrumpetStac.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Tuba Staccato', bank: 0, preset: 8, sfzRelPath: 'TubaStac.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Solo Violin Tremolo', bank: 0, preset: 9, sfzRelPath: 'SViolinTrem.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Solo Violin Pizzicato', bank: 0, preset: 10, sfzRelPath: 'SViolinPizz.sfz', targetVelocity: 90, zoneStride: 2 },
    ],
  },
  'vsco-strings-complete': {
    id: 'vsco-strings-complete',
    pack: 'vsco-complete',
    fileName: 'vsco-strings-complete.sf2',
    bankName: 'VSCO-2 CE Strings Complete (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/ContrabassTrem.sfz',
      '/ContrabassPizz.sfz',
      '/ContrabassSusNV.sfz',
      '/CelloEnsTrem.sfz',
      '/CelloEnsSusVib.sfz',
      '/CelloEnsSusVib-Quiet.sfz',
      '/CelloEnsPizz.sfz',
      '/ViolaEnsSusVib.sfz',
      '/ViolaEnsSusVib-Quiet.sfz',
      '/ViolaEnsSpic.sfz',
      '/ViolaEnsPizz.sfz',
      '/ViolinEnsSusVib-Quiet.sfz',
      '/ViolinEnsPizz.sfz',
      '/SViolinVib.sfz',
      '/SViolinVib-Quiet.sfz',
      '/SViolinSpic.sfz',
    ],
    presets: [
      { name: 'Contrabass Tremolo', bank: 0, preset: 0, sfzRelPath: 'ContrabassTrem.sfz', targetVelocity: 90 },
      { name: 'Contrabass Pizz', bank: 0, preset: 1, sfzRelPath: 'ContrabassPizz.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Contrabass Non-Vib', bank: 0, preset: 2, sfzRelPath: 'ContrabassSusNV.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Cello Ens Tremolo', bank: 0, preset: 3, sfzRelPath: 'CelloEnsTrem.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Cello Ens Sustain', bank: 0, preset: 4, sfzRelPath: 'CelloEnsSusVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Cello Ens Quiet', bank: 0, preset: 5, sfzRelPath: 'CelloEnsSusVib-Quiet.sfz', targetVelocity: 32, zoneStride: 2 },
      { name: 'Cello Ens Pizzicato', bank: 0, preset: 6, sfzRelPath: 'CelloEnsPizz.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Viola Ens Sustain', bank: 0, preset: 7, sfzRelPath: 'ViolaEnsSusVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Viola Ens Quiet', bank: 0, preset: 8, sfzRelPath: 'ViolaEnsSusVib-Quiet.sfz', targetVelocity: 32, zoneStride: 2 },
      { name: 'Viola Ens Spiccato', bank: 0, preset: 9, sfzRelPath: 'ViolaEnsSpic.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Viola Ens Pizzicato', bank: 0, preset: 10, sfzRelPath: 'ViolaEnsPizz.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Violin Ens Quiet', bank: 0, preset: 11, sfzRelPath: 'ViolinEnsSusVib-Quiet.sfz', targetVelocity: 32, zoneStride: 2 },
      { name: 'Violin Ens Pizz', bank: 0, preset: 12, sfzRelPath: 'ViolinEnsPizz.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Solo Violin Vibrato', bank: 0, preset: 13, sfzRelPath: 'SViolinVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Solo Violin Quiet', bank: 0, preset: 14, sfzRelPath: 'SViolinVib-Quiet.sfz', targetVelocity: 32, zoneStride: 2 },
      { name: 'Solo Violin Spicc', bank: 0, preset: 15, sfzRelPath: 'SViolinSpic.sfz', targetVelocity: 90, zoneStride: 2 },
    ],
  },
  'vsco-brass-complete': {
    id: 'vsco-brass-complete',
    pack: 'vsco-complete',
    fileName: 'vsco-brass-complete.sf2',
    bankName: 'VSCO-2 CE Brass Complete (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/FHornMute.sfz',
      '/FHornStac.sfz',
      '/TromboneSus.sfz',
      '/TromboneVib.sfz',
      '/TromboneStac.sfz',
      '/TrumpetSus.sfz',
      '/TrumpetSusVib.sfz',
      '/TrumpetStraightMuteSus.sfz',
      '/TrumpetHarmonMuteSus.sfz',
      '/TubaSus.sfz',
    ],
    presets: [
      { name: 'French Horn Muted', bank: 0, preset: 0, sfzRelPath: 'FHornMute.sfz', targetVelocity: 90 },
      { name: 'French Horn Stacc', bank: 0, preset: 1, sfzRelPath: 'FHornStac.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trombone Sustain', bank: 0, preset: 2, sfzRelPath: 'TromboneSus.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trombone Vibrato', bank: 0, preset: 3, sfzRelPath: 'TromboneVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trombone Staccato', bank: 0, preset: 4, sfzRelPath: 'TromboneStac.sfz', targetVelocity: 90 },
      { name: 'Trumpet Sustain', bank: 0, preset: 5, sfzRelPath: 'TrumpetSus.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trumpet Sus Vibrato', bank: 0, preset: 6, sfzRelPath: 'TrumpetSusVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Trumpet Straight Mt', bank: 0, preset: 7, sfzRelPath: 'TrumpetStraightMuteSus.sfz', targetVelocity: 90 },
      { name: 'Trumpet Harmon Mute', bank: 0, preset: 8, sfzRelPath: 'TrumpetHarmonMuteSus.sfz', targetVelocity: 90 },
      { name: 'Tuba Sustain', bank: 0, preset: 9, sfzRelPath: 'TubaSus.sfz', targetVelocity: 90 },
    ],
  },
  'vsco-winds-complete': {
    id: 'vsco-winds-complete',
    pack: 'vsco-complete',
    fileName: 'vsco-winds-complete.sf2',
    bankName: 'VSCO-2 CE Woodwinds Complete (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/BassoonSus.sfz',
      '/BassoonVib.sfz',
      '/BassoonStac.sfz',
      '/ClarinetSus.sfz',
      '/OboeSusNV.sfz',
      '/OboeSusVib.sfz',
      '/OboeStac.sfz',
      '/FluteSusNV.sfz',
      '/FluteExpVib.sfz',
      '/PiccoloSus.sfz',
      '/PiccoloStac.sfz',
    ],
    presets: [
      { name: 'Bassoon Sustain', bank: 0, preset: 0, sfzRelPath: 'BassoonSus.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Bassoon Vibrato', bank: 0, preset: 1, sfzRelPath: 'BassoonVib.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Bassoon Staccato', bank: 0, preset: 2, sfzRelPath: 'BassoonStac.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Clarinet Sustain', bank: 0, preset: 3, sfzRelPath: 'ClarinetSus.sfz', targetVelocity: 90, zoneStride: 2 },
      { name: 'Oboe Sustain NonVib', bank: 0, preset: 4, sfzRelPath: 'OboeSusNV.sfz', targetVelocity: 90 },
      { name: 'Oboe Sustain Vib', bank: 0, preset: 5, sfzRelPath: 'OboeSusVib.sfz', targetVelocity: 90 },
      { name: 'Oboe Staccato', bank: 0, preset: 6, sfzRelPath: 'OboeStac.sfz', targetVelocity: 90 },
      { name: 'Flute Sus Non-Vib', bank: 0, preset: 7, sfzRelPath: 'FluteSusNV.sfz', targetVelocity: 90 },
      { name: 'Flute Espressivo', bank: 0, preset: 8, sfzRelPath: 'FluteExpVib.sfz', targetVelocity: 90 },
      { name: 'Piccolo Sustain', bank: 0, preset: 9, sfzRelPath: 'PiccoloSus.sfz', targetVelocity: 90 },
      { name: 'Piccolo Staccato', bank: 0, preset: 10, sfzRelPath: 'PiccoloStac.sfz', targetVelocity: 90 },
    ],
  },
  'vsco-percussion-keys': {
    id: 'vsco-percussion-keys',
    pack: 'vsco-complete',
    fileName: 'vsco-percussion-keys.sf2',
    bankName: 'VSCO-2 CE Mallets, Bells, Organ & Upright Piano (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/TimpaniRolls.sfz',
      '/TubularBells.sfz',
      '/Glockenspiel.sfz',
      '/Xylophone.sfz',
      '/Marimba.sfz',
      '/OrganLoud.sfz',
      '/OrganLoudPedal.sfz',
      '/OrganQuiet.sfz',
      '/UprightPiano.sfz',
    ],
    presets: [
      { name: 'Timpani Rolls', bank: 0, preset: 0, sfzRelPath: 'TimpaniRolls.sfz' },
      { name: 'Tubular Bells', bank: 0, preset: 1, sfzRelPath: 'TubularBells.sfz' },
      { name: 'Glockenspiel', bank: 0, preset: 2, sfzRelPath: 'Glockenspiel.sfz' },
      { name: 'Xylophone', bank: 0, preset: 3, sfzRelPath: 'Xylophone.sfz' },
      { name: 'Concert Marimba', bank: 0, preset: 4, sfzRelPath: 'Marimba.sfz' },
      { name: 'Pipe Organ Loud', bank: 0, preset: 5, sfzRelPath: 'OrganLoud.sfz', zoneStride: 2 },
      { name: 'Pipe Organ Pedal', bank: 0, preset: 6, sfzRelPath: 'OrganLoudPedal.sfz' },
      { name: 'Pipe Organ Quiet', bank: 0, preset: 7, sfzRelPath: 'OrganQuiet.sfz', zoneStride: 2 },
      { name: 'Vintage Upright Pno', bank: 0, preset: 8, sfzRelPath: 'UprightPiano.sfz', targetVelocity: 90, zoneStride: 2 },
    ],
  },
  'vsco-orch-perc': {
    id: 'vsco-orch-perc',
    pack: 'vsco-complete',
    fileName: 'vsco-orch-perc.sf2',
    bankName: 'VSCO-2 CE Orchestral Percussion Kit (CC0-1.0)',
    licence: 'CC0-1.0',
    licenceRegistryId: 'vsco-2-ce',
    kind: 'git-sfz',
    repoKey: 'vsco-2-ce',
    repoUrl: 'https://github.com/sgossner/VSCO-2-CE.git',
    branch: 'SFZ',
    commit: '6dd651d55dde97fd4028699be9d4481f26917891',
    licencePath: 'LICENSE',
    licenceSha256: VSCO2_CE_LICENSE_SHA256,
    initialSparsePaths: [
      '/LICENSE',
      '/GM-StylePerc.sfz',
    ],
    presets: [
      {
        name: 'VSCO Orch Perc Kit',
        bank: 128,
        preset: 0,
        drumMode: true,
        hiHatChoke: false,
        respectShortRelease: true,
        maxOneShotReleaseSeconds: 12,
        sfzRelPath: 'GM-StylePerc.sfz',
      },
    ],
  },
});

export function targetsForPack(packName) {
  if (packName === 'all') {
    return Object.values(SOUNDFONT_TARGETS);
  }
  const targets = Object.values(SOUNDFONT_TARGETS).filter(t => t.pack === packName);
  if (!targets.length) {
    throw new Error(`Unknown SoundFont pack "${packName}". Choose one of: ${PACK_NAMES.join(', ')}`);
  }
  return targets;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function verifyTextSha256(filePath, expectedSha256, label) {
  const raw = await readFile(filePath);
  const rawHex = createHash('sha256').update(raw).digest('hex');
  if (rawHex === expectedSha256) return expectedSha256;

  const text = raw.toString('utf8');
  const lfHex = createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
  if (lfHex === expectedSha256) return expectedSha256;

  const crlfHex = createHash('sha256').update(Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')).digest('hex');
  if (crlfHex === expectedSha256) return expectedSha256;

  throw new Error(`SHA-256 mismatch for ${label}: expected ${expectedSha256}, got ${rawHex}`);
}

async function directoryBytes(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(err => (err?.code === 'ENOENT' ? [] : Promise.reject(err)));
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      const info = await stat(full).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
      if (info) total += info.size;
    }
  }
  return total;
}

function escapeSparsePattern(relPosixPath) {
  const withSlash = relPosixPath.startsWith('/') ? relPosixPath : '/' + relPosixPath;
  if (withSlash.endsWith('/**')) return withSlash;
  return withSlash.replace(/([#[\]*?!])/g, '\\$1');
}

async function ensureSparseGitCheckout(repoDir, repoUrl, commit, sparsePatterns) {
  await mkdir(repoDir, { recursive: true });
  const gitDir = path.join(repoDir, '.git');
  if (!existsSync(gitDir)) {
    await runCommandSafe('git', ['init', '--quiet', repoDir], { timeoutMs: 30000 });
    await runCommandSafe('git', ['-C', repoDir, 'remote', 'add', 'origin', repoUrl], { timeoutMs: 15000 });
  }
  await runCommandSafe('git', ['-C', repoDir, 'config', 'core.autocrlf', 'false'], { timeoutMs: 15000 });
  await runCommandSafe('git', ['-C', repoDir, 'config', 'core.sparseCheckout', 'true'], { timeoutMs: 15000 });
  await runCommandSafe('git', ['-C', repoDir, 'config', 'core.sparseCheckoutCone', 'false'], { timeoutMs: 15000 });

  const infoDir = path.join(gitDir, 'info');
  await mkdir(infoDir, { recursive: true });
  const uniquePatterns = [...new Set(sparsePatterns)];
  await writeFileAtomic(path.join(infoDir, 'sparse-checkout'), uniquePatterns.join('\n') + '\n', { overwrite: true });

  const hasCommit = await runCommandSafe('git', ['-C', repoDir, 'cat-file', '-e', `${commit}^{commit}`], { timeoutMs: 15000 })
    .then(() => true, () => false);
  if (!hasCommit) {
    await runCommandSafe('git', ['-C', repoDir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit], {
      timeoutMs: 300000,
    });
  }
  await runCommandSafe('git', ['-C', repoDir, 'checkout', '--quiet', '--force', commit], { timeoutMs: 300000 });
  await runCommandSafe('git', ['-C', repoDir, 'read-tree', '-mu', 'HEAD'], { timeoutMs: 300000 });
}

function assertAllowedRepoPath(relPosixPath, target) {
  const clean = relPosixPath.replace(/^\/+/, '');
  for (const forbidden of target.forbiddenPathPrefixes ?? []) {
    if (clean === forbidden.replace(/\/$/, '') || clean.startsWith(forbidden)) {
      throw new Error(`Refusing forbidden path "${clean}" in ${target.id}`);
    }
  }
  if (target.allowedPathPrefixes?.length) {
    const allowed = target.allowedPathPrefixes.some(prefix =>
      prefix.endsWith('/') ? clean.startsWith(prefix) : clean === prefix);
    if (!allowed) {
      throw new Error(`Refusing path outside allowed sparse scope for ${target.id}: "${clean}"`);
    }
  }
}

async function verifyMetaSha256Sums(repoDir, sha256SumsRelPath, checkedFilesSet) {
  const sumsFullPath = path.join(repoDir, sha256SumsRelPath);
  const sumsBaseDir = path.dirname(sumsFullPath);
  const text = await readFile(sumsFullPath, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) map.set(m[2].replaceAll('\\', '/'), m[1].toLowerCase());
  }
  for (const fullFile of checkedFilesSet) {
    const rel = path.relative(sumsBaseDir, fullFile).replaceAll('\\', '/');
    if (rel.startsWith('..') || rel === 'SHA256SUMS') continue;
    const expected = map.get(rel);
    if (!expected) {
      throw new Error(`File "${rel}" is missing from ${sha256SumsRelPath}`);
    }
    const actual = await sha256File(fullFile);
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for "${rel}": expected ${expected}, got ${actual}`);
    }
  }
}

async function installArchiveTarget(target, { soundfontsDir, cacheDir }) {
  const archivesDir = path.join(cacheDir, 'archives');
  await mkdir(archivesDir, { recursive: true });
  const archiveName = path.basename(new URL(target.archiveUrl).pathname);
  const archivePath = path.join(archivesDir, archiveName);

  if (!existsSync(archivePath)) {
    log.info('Downloading CC0 SoundFont archive', { id: target.id, url: target.archiveUrl });
    const response = await fetch(target.archiveUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${target.archiveUrl}: HTTP ${response.status}`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) throw new Error(`Archive exceeded 64 MiB limit: ${target.archiveUrl}`);
      chunks.push(chunk);
    }
    await writeFileAtomic(archivePath, Buffer.concat(chunks, total), { overwrite: true });
  }

  const archiveBytes = (await stat(archivePath)).size;
  const archiveSha256 = await sha256File(archivePath);
  const extractDir = path.join(archivesDir, `${target.id}-extract`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'bsdtar';
  try {
    await runCommandSafe(tarCmd, ['-xf', archivePath, '-C', extractDir], { timeoutMs: 60000 });
  } catch (err) {
    throw new Error(`Failed to extract ${archiveName} via ${tarCmd}: ${err.message}`);
  }

  // Locate the extracted .sf2 entry (either directly or inside one top-level folder).
  const findExtracted = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === target.archiveEntry) return full;
      if (entry.isDirectory()) {
        const found = await findExtracted(full);
        if (found) return found;
      }
    }
    return null;
  };

  const extractedSf2 = await findExtracted(extractDir);
  if (!extractedSf2) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Archive ${archiveName} did not contain ${target.archiveEntry}`);
  }

  const sf2Bytes = await readFile(extractedSf2);
  await rm(extractDir, { recursive: true, force: true });

  const actualSha = createHash('sha256').update(sf2Bytes).digest('hex');
  if (actualSha !== target.expectedSf2Sha256) {
    throw new Error(`SHA-256 mismatch for ${target.archiveEntry}: expected ${target.expectedSf2Sha256}, got ${actualSha}`);
  }

  const parsed = parseSf2Buffer(sf2Bytes);
  const destPath = path.join(soundfontsDir, target.fileName);
  await mkdir(soundfontsDir, { recursive: true });
  await writeFileAtomic(destPath, sf2Bytes, { overwrite: true });

  return {
    id: target.id,
    pack: target.pack,
    fileName: target.fileName,
    licence: target.licence,
    licenceRegistryId: target.licenceRegistryId,
    sourceType: 'archive-sf2',
    sourceUrl: target.archiveUrl,
    archiveSha256,
    downloadBytes: archiveBytes,
    sf2Sha256: actualSha,
    sf2Bytes: sf2Bytes.length,
    inputSampleCount: parsed.samples.length,
    aggregateSampleSha256: actualSha,
    presets: parsed.presets.map(p => ({
      name: p.name,
      bank: p.bank,
      preset: p.preset,
    })),
  };
}

async function installGitSfzTarget(target, { soundfontsDir, cacheDir, ffmpeg }) {
  const repoDir = path.join(cacheDir, 'repos', target.repoKey);
  for (const pattern of target.initialSparsePaths) {
    if (!pattern.endsWith('/**')) {
      assertAllowedRepoPath(pattern, target);
    }
  }

  log.info('Syncing sparse SFZ metadata', { id: target.id, repo: target.repoUrl, commit: target.commit });
  await ensureSparseGitCheckout(
    repoDir,
    target.repoUrl,
    target.commit,
    target.initialSparsePaths.map(p => p.startsWith('/') ? p : '/' + p),
  );

  // Verify repository LICENSE SHA-256 before reading or downloading any audio blobs.
  const licenceFullPath = path.join(repoDir, target.licencePath);
  if (!existsSync(licenceFullPath)) {
    throw new Error(`Missing LICENSE file in ${target.id} checkout`);
  }
  const actualLicenceSha = await verifyTextSha256(licenceFullPath, target.licenceSha256, `${target.id} LICENSE`);

  // Parse SFZ articulations to compute the exact minimal set of audio sample files to checkout.
  const neededSampleRelPaths = new Set();
  const checkedFullFiles = new Set([licenceFullPath]);

  for (const preset of target.presets) {
    const sfzFull = path.join(repoDir, preset.sfzRelPath);
    checkedFullFiles.add(sfzFull);
    const boundary = preset.subBoundaryRel ? path.join(repoDir, preset.subBoundaryRel) : repoDir;
    const regions = await parseSfzArticulation(sfzFull, {
      boundaryDir: boundary,
      drumMode: Boolean(preset.drumMode || preset.bank === 128),
      hiHatChoke: preset.hiHatChoke ?? true,
      keyFilter: preset.keyFilter,
      allowedKeys: preset.allowedKeys,
      targetVelocity: preset.targetVelocity,
      zoneStride: preset.zoneStride ?? 1,
    });
    for (const reg of regions) {
      const relPosix = path.relative(repoDir, reg.samplePath).replaceAll('\\', '/');
      assertAllowedRepoPath(relPosix, target);
      neededSampleRelPaths.add(relPosix);
      checkedFullFiles.add(reg.samplePath);
    }
  }

  const allSparsePatterns = [
    ...target.initialSparsePaths.map(p => p.startsWith('/') ? p : '/' + p),
    ...[...neededSampleRelPaths].sort().map(escapeSparsePattern),
  ];

  log.info('Fetching exact sparse audio blobs', { id: target.id, sampleFiles: neededSampleRelPaths.size });
  await ensureSparseGitCheckout(repoDir, target.repoUrl, target.commit, allSparsePatterns);

  // Verify upstream SHA256SUMS manifests when provided (Meta-open-sound).
  for (const sumsRel of target.sha256SumsFiles ?? []) {
    const subPrefix = path.dirname(sumsRel).replaceAll('\\', '/');
    const scopedFiles = new Set(
      [...checkedFullFiles].filter(f => path.relative(repoDir, f).replaceAll('\\', '/').startsWith(subPrefix + '/')),
    );
    scopedFiles.add(path.join(repoDir, subPrefix, 'LICENSE'));
    await verifyMetaSha256Sums(repoDir, sumsRel, scopedFiles);
  }

  // Verify VSCO-2-CE SFZ hashes against tracked licences.json when applicable.
  if (target.licenceRegistryId === 'vsco-2-ce') {
    const licences = JSON.parse(await readFile(path.join(REPO_ROOT, 'licences.json'), 'utf8'));
    const recorded = licences['vsco-2-ce']?.files ?? {};
    for (const preset of target.presets) {
      const base = path.basename(preset.sfzRelPath);
      if (recorded[base]) {
        await verifyTextSha256(path.join(repoDir, preset.sfzRelPath), recorded[base], `VSCO-2-CE ${base}`);
      }
    }
  }

  let sourceSampleBytes = 0;
  for (const rel of neededSampleRelPaths) {
    sourceSampleBytes += (await stat(path.join(repoDir, rel))).size;
  }
  const gitObjectsBytes = await directoryBytes(path.join(repoDir, '.git', 'objects'));

  const destPath = path.join(soundfontsDir, target.fileName);
  await mkdir(soundfontsDir, { recursive: true });
  const compiled = await compileSfzToSf2({
    bankName: target.bankName,
    copyright: 'CC0-1.0',
    outputPath: destPath,
    ffmpeg,
    presets: target.presets.map(preset => ({
      name: preset.name,
      bank: preset.bank,
      preset: preset.preset,
      drumMode: preset.drumMode,
      hiHatChoke: preset.hiHatChoke ?? true,
      respectShortRelease: preset.respectShortRelease ?? false,
      maxOneShotReleaseSeconds: preset.maxOneShotReleaseSeconds ?? 8,
      gainBoostDb: preset.gainBoostDb ?? 0,
      sfzPath: path.join(repoDir, preset.sfzRelPath),
      boundaryDir: preset.subBoundaryRel ? path.join(repoDir, preset.subBoundaryRel) : repoDir,
      keyFilter: preset.keyFilter,
      allowedKeys: preset.allowedKeys,
      targetVelocity: preset.targetVelocity,
      zoneStride: preset.zoneStride ?? 1,
    })),
  });

  return {
    id: target.id,
    pack: target.pack,
    fileName: target.fileName,
    licence: target.licence,
    licenceRegistryId: target.licenceRegistryId,
    sourceType: 'git-sfz',
    repository: target.repoUrl,
     ...(target.branch ? { branch: target.branch } : {}),
    commit: target.commit,
    licenceSha256: actualLicenceSha,
    sourceSampleBytes,
    gitObjectsBytes,
    inputSampleCount: compiled.inputSampleCount,
    aggregateSampleSha256: compiled.aggregateSampleSha256,
    sf2Sha256: compiled.sha256,
    sf2Bytes: compiled.bytes,
    presets: compiled.presets.map(p => ({
      name: p.name,
      bank: p.bank,
      preset: p.preset,
    })),
  };
}

export async function loadSoundfontLock(lockPath = TRACKED_LOCK_PATH) {
  const resolved = path.resolve(lockPath);
  let info;
  try {
    info = await stat(resolved, { bigint: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      lockFileCache.delete(resolved);
      return null;
    }
    throw err;
  }
  if (!info.isFile()) return null;
  const stamp = `${info.mtimeNs}:${info.size}`;
  const cached = lockFileCache.get(resolved);
  if (cached && cached.stamp === stamp) {
    return cached.parsed;
  }
  const parsed = JSON.parse(await readFile(resolved, 'utf8'));
  lockFileCache.set(resolved, {
    stamp,
    mtimeMs: Number(info.mtimeMs),
    parsed,
  });
  return parsed;
}

export async function installSoundfontPack({
  pack = 'core',
  soundfontsDir = resolveSoundfontsDir(process.env),
  cacheDir,
  ffmpeg = resolveFfmpegExecutable(process.env),
  force = false,
  updateTrackedLock = false,
} = {}) {
  const resolvedSoundfontsDir = path.resolve(soundfontsDir);
  const effectiveCacheDir = path.resolve(cacheDir ?? path.join(path.dirname(resolvedSoundfontsDir), 'pack-cache'));
  await mkdir(resolvedSoundfontsDir, { recursive: true });
  await mkdir(effectiveCacheDir, { recursive: true });

  const existingTrackedLock = await loadSoundfontLock(TRACKED_LOCK_PATH).catch(() => null);
  const localLockPath = path.join(resolvedSoundfontsDir, 'soundfont-lock.json');
  const existingLocalLock = await loadSoundfontLock(localLockPath).catch(() => null);
  const mergedEntries = {
    ...(existingTrackedLock?.soundfonts ?? {}),
    ...(existingLocalLock?.soundfonts ?? {}),
  };

  const targets = targetsForPack(pack);
  const installed = [];

  for (const target of targets) {
    const destFile = path.join(resolvedSoundfontsDir, target.fileName);
    const knownLock = mergedEntries[target.id];
    if (!force && existsSync(destFile) && knownLock?.sf2Sha256) {
      const currentSha = await sha256File(destFile);
      if (currentSha === knownLock.sf2Sha256) {
        log.info('Reusing verified SoundFont', { id: target.id, fileName: target.fileName, sha256: currentSha });
        installed.push({ ...knownLock, reused: true });
        continue;
      }
    }

    const built = target.kind === 'archive-sf2'
      ? await installArchiveTarget(target, { soundfontsDir: resolvedSoundfontsDir, cacheDir: effectiveCacheDir })
      : await installGitSfzTarget(target, { soundfontsDir: resolvedSoundfontsDir, cacheDir: effectiveCacheDir, ffmpeg });

    mergedEntries[target.id] = built;
    installed.push({ ...built, reused: false });

    // Persist local lock incrementally after each compiled target so interrupted multi-target runs resume cleanly.
    const interimEntries = {};
    for (const key of Object.keys(SOUNDFONT_TARGETS)) {
      if (mergedEntries[key]) {
        const cleanEntry = { ...mergedEntries[key] };
        delete cleanEntry.reused;
        interimEntries[key] = cleanEntry;
      }
    }
    const interimLock = JSON.stringify({
      lockVersion: 1,
      licencePolicy: 'CC0-1.0-only',
      soundfonts: interimEntries,
    }, null, 2) + '\n';
    await writeFileAtomic(localLockPath, interimLock, { overwrite: true });
  }

  const allReused = installed.length > 0 && installed.every(item => item.reused);
  let archiveDownloadBytes = 0;
  let totalGitWireBytes = 0;

  if (allReused && !updateTrackedLock) {
    const seenRepoKeys = new Set();
    for (const item of installed) {
      if (item.sourceType === 'archive-sf2') {
        archiveDownloadBytes += item.downloadBytes ?? 0;
      } else if (item.sourceType === 'git-sfz') {
        const repoKey = SOUNDFONT_TARGETS[item.id]?.repoKey ?? item.repository ?? item.id;
        if (!seenRepoKeys.has(repoKey)) {
          seenRepoKeys.add(repoKey);
          totalGitWireBytes += item.gitObjectsBytes ?? 0;
        }
      }
    }
  } else {
    // Calculate exact wire/object bytes across unique repos + archives in this cache.
    const repoObjectSizes = {};
    const reposRoot = path.join(effectiveCacheDir, 'repos');
    if (existsSync(reposRoot)) {
      for (const entry of await readdir(reposRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          repoObjectSizes[entry.name] = await directoryBytes(path.join(reposRoot, entry.name, '.git', 'objects'));
        }
      }
    }
    archiveDownloadBytes = await directoryBytes(path.join(effectiveCacheDir, 'archives'));
    totalGitWireBytes = Object.values(repoObjectSizes).reduce((sum, n) => sum + n, 0);
  }

  const orderedLockEntries = {};
  for (const key of Object.keys(SOUNDFONT_TARGETS)) {
    if (mergedEntries[key]) {
      const cleanEntry = { ...mergedEntries[key] };
      delete cleanEntry.reused;
      orderedLockEntries[key] = cleanEntry;
    }
  }

  const lockPayload = {
    lockVersion: 1,
    licencePolicy: 'CC0-1.0-only',
    soundfonts: orderedLockEntries,
  };

  const serializedLock = JSON.stringify(lockPayload, null, 2) + '\n';
  const currentLocalLock = existsSync(localLockPath)
    ? await readFile(localLockPath, 'utf8').catch(() => null)
    : null;
  if (currentLocalLock !== serializedLock) {
    await writeFileAtomic(localLockPath, serializedLock, { overwrite: true });
  }
  if (updateTrackedLock) {
    await writeFileAtomic(TRACKED_LOCK_PATH, serializedLock, { overwrite: true });
  }

  const totalSf2Bytes = installed.reduce((sum, item) => sum + (item.sf2Bytes ?? 0), 0);

  return {
    pack,
    soundfontsDirectory: resolvedSoundfontsDir,
    installed,
    totalSf2Bytes,
    cacheDownloadSummary: {
      archiveBytes: archiveDownloadBytes,
      gitObjectsBytes: totalGitWireBytes,
      totalCachedDownloadBytes: archiveDownloadBytes + totalGitWireBytes,
    },
  };
}

export function register({ tool, z, paths, moduleGuidance }) {
  moduleGuidance.push('Use install_soundfont_pack to download and deterministically compile verified CC0-1.0 acoustic SoundFonts (core, upright-bass, meta-piano, vsco-extended, vsco-complete, or all) into LMMS_SOUNDFONTS.');

  tool('install_soundfont_pack', 'Download, verify (LICENSE + SHA-256), and deterministically compile a CC0-1.0 SoundFont pack into LMMS_SOUNDFONTS.', {
    pack: z.enum(PACK_NAMES).default('core').describe('SoundFont pack to install: core (<80 MB: upright piano, nylon/steel guitars, GM drums, orchestral strings/brass/winds/harp/timpani), upright-bass, meta-piano, vsco-extended, vsco-complete (full VSCO-2-CE strings, brass, woodwinds, mallets/bells/organ/upright piano, and orchestral percussion), or all.'),
    force: z.boolean().default(false).describe('Rebuild even if verified .sf2 files already match soundfont-lock.json.'),
  }, async ({ pack, force }) => {
    const sfDir = paths?.soundfonts ?? resolveSoundfontsDir(process.env);
    const ff = paths?.ffmpeg ?? resolveFfmpegExecutable(process.env);
    return installSoundfontPack({
      pack,
      soundfontsDir: sfDir,
      ffmpeg: ff,
      force,
      updateTrackedLock: false,
    });
  });
}

function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1).toLowerCase() === path.resolve(fileURLToPath(metaUrl)).toLowerCase();
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      pack: { type: 'string', default: 'core' },
      destination: { type: 'string' },
      cache: { type: 'string' },
      force: { type: 'boolean', default: false },
      'write-tracked-lock': { type: 'boolean', default: false },
    },
  });
  const packs = values.pack.split(',').map(s => s.trim()).filter(Boolean);
  let lastResult = null;
  for (const p of packs) {
    lastResult = await installSoundfontPack({
      pack: p,
      soundfontsDir: values.destination || resolveSoundfontsDir(process.env),
      cacheDir: values.cache,
      force: values.force,
      updateTrackedLock: values['write-tracked-lock'],
    });
  }
  process.stderr.write(JSON.stringify(lastResult, null, 2) + '\n');
}
