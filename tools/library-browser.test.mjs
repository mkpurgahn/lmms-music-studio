import test from 'node:test';
import assert from 'node:assert/strict';
import { guessRole, fileUrl, relativeUrl, sampleItems, presetItems, browserHtml } from './library-browser.mjs';

test('roles are guessed from the words in a path', () => {
  assert.equal(guessRole('drums/kick_hard01.ogg'), 'kick');
  assert.equal(guessRole('drums/hihat_closed02.ogg'), 'hat');
  assert.equal(guessRole('latin-perc/Conga_HitN_v2_rr1_Sum.wav'), 'percussion');
  assert.equal(guessRole('SplendidGrandPiano/Samples/FF A3.flac'), 'piano');
  assert.equal(guessRole('VSCO2-trumpet/Sum_SHTrumpet_stac_A#3_v1_rr1.wav'), 'brass');
  assert.equal(guessRole('basses/rave_bass01.ogg'), 'bass');
  assert.equal(guessRole('misc/thing.ogg'), 'other');
});

test('file URLs survive spaces, # and Windows separators', () => {
  assert.equal(fileUrl('C:\\Program Files\\LMMS\\data\\samples\\drums\\kick01.ogg'), 'file:///C:/Program%20Files/LMMS/data/samples/drums/kick01.ogg');
  assert.equal(fileUrl('C:/lib/Trumpet/stac_A#3.wav'), 'file:///C:/lib/Trumpet/stac_A%233.wav');
  assert.equal(fileUrl('/usr/share/lmms/samples/a b.ogg'), 'file:///usr/share/lmms/samples/a%20b.ogg');
  assert.equal(relativeUrl('latin perc\\Conga #1.wav'), 'latin%20perc/Conga%20%231.wav');
});

test('samples and presets become items with the fields the page filters on', () => {
  const [sample] = sampleItems([{ full: 'C:/s/drums/snare_rim01.ogg', relative: 'drums/snare_rim01.ogg' }], { type: 'stock', source: 'LMMS stock samples', url: f => fileUrl(f.full) });
  assert.deepEqual(sample, { t: 'stock', n: 'snare rim01', p: 'drums/snare_rim01.ogg', s: 'LMMS stock samples', c: 'drums', r: 'snare', g: ['ogg'], u: 'file:///C:/s/drums/snare_rim01.ogg' });
  const [preset] = presetItems({ 'ZynAddSubFX/Pads/0004-Analog Pad 2.xiz': { pitched: true, centroidHz: 879.4, attackMs: 180, sustainDb: 0, releaseMs: 170, role: 'pad', tags: ['sustained', 'warm'] } });
  assert.equal(preset.n, 'Analog Pad 2');
  assert.equal(preset.s, 'ZynAddSubFX');
  assert.equal(preset.c, 'Pads');
  assert.deepEqual(preset.m, [879, 180, 0, 170, 1]);
  assert.equal(preset.u, null);
});

test('the page embeds its data safely and has the controls', () => {
  const items = [{ t: 'stock', n: 'evil </script><script>alert(1)</script>', p: 'a/b.ogg', s: 'x', c: 'a', r: 'kick', g: [], u: 'file:///a/b.ogg' }];
  const html = browserHtml({ title: 'My <library>', items, generated: '2026-11-15', notes: ['One note.'] });
  assert.ok(html.includes('<title>My &lt;library&gt;</title>'));
  assert.equal(html.split('</script>').length, 3, 'only the two real script blocks close');
  const data = /<script id="data" type="application\/json">(.*?)<\/script>/s.exec(html)[1];
  assert.deepEqual(JSON.parse(data).items, items);
  for (const id of ['q', 'source', 'role', 'sort', 'playable', 'starred', 'types', 'tags', 'list', 'copy']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'no network references');
});

test('workspace files are sorted into tracks, stems and samples, and tracks find their mixer page', async () => {
  const { classifyWorkspace, auditionFor, waveformPeaks } = await import('./library-browser.mjs');
  assert.deepEqual(classifyWorkspace('il-montuno-club.wav'), { type: 'track', source: 'My tracks' });
  assert.deepEqual(classifyWorkspace('lh-andaluz-stems/3_Piano.wav'), { type: 'stem', source: 'Stems: lh-andaluz-stems' });
  assert.deepEqual(classifyWorkspace('il-montuno-ds/trumpets.wav'), { type: 'stem', source: 'Stems: il-montuno-ds' });
  assert.deepEqual(classifyWorkspace('stems2/1_Sax.wav'), { type: 'stem', source: 'Stems: stems2' });
  assert.deepEqual(classifyWorkspace('latin-perc/Conga_HitN_v2_rr1_Sum.wav'), { type: 'workspace', source: 'Workspace: latin-perc' });
  const pages = new Set(['il-montuno-audition.html', 'il-montuno-v2-audition.html', 'lh-andaluz-audition.html']);
  assert.equal(auditionFor('il-montuno-v2-club.wav', pages), 'il-montuno-v2-audition.html');
  assert.equal(auditionFor('il-montuno-club.wav', pages), 'il-montuno-audition.html');
  assert.equal(auditionFor('lh-andaluz-synth.wav', pages), 'lh-andaluz-audition.html');
  assert.equal(auditionFor('quarter-past-blue.wav', pages), null);
  const n = 48000, quietThenLoud = Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? 0.1 : 0.8) * Math.sin(i / 5));
  const peaks = waveformPeaks({ sampleRate: 48000, channels: [quietThenLoud] }, 20);
  assert.equal(peaks.length, 20);
  assert.ok(peaks[2] < 20 && peaks[15] > 90 && Math.max(...peaks) === 100, peaks.join(','));
  assert.deepEqual(waveformPeaks({ sampleRate: 48000, channels: [new Float32Array(100)] }, 10), Array(10).fill(0));
});

test('the page has a player, a waveform, clear filters and the track types', () => {
  const html = browserHtml({ title: 'L', items: [{ t: 'track', n: 'Song', p: 'song.wav', s: 'My tracks', c: '', r: 'track', g: ['wav'], u: 'song.wav', f: [10, 100, 50], l: 99, a: 'song-audition.html', e: 5 }], generated: '2026-11-15' });
  for (const id of ['prev', 'toggle', 'next', 'seek', 'time', 'loop', 'auto', 'vol', 'wave', 'clear']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("track:'My tracks'") && html.includes("stem:'Stems'"));
  assert.ok(html.includes('value="newest"'));
  assert.ok(!html.includes('id="stop"'));
});

test('a track also finds its timeline page', async () => {
  const { auditionFor } = await import('./library-browser.mjs');
  const pages = new Set(['il-montuno-v3-timeline.html', 'il-montuno-audition.html']);
  assert.equal(auditionFor('il-montuno-v3-club.wav', pages, '-timeline.html'), 'il-montuno-v3-timeline.html');
  assert.equal(auditionFor('il-montuno-club.wav', pages, '-timeline.html'), null);
  assert.equal(auditionFor('il-montuno-v3-club.wav', pages), 'il-montuno-audition.html');
});
