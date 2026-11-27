// End-to-end check of the audition tools through a real stdio connection and the installed LMMS.
// Run: node verify-audition.mjs
// If Google Chrome or Microsoft Edge starts headless here, the pages are also loaded through the DevTools protocol over a local
// HTTP server: they must decode every file, log nothing to the console and pass the page's own offline self-test of the
// intro to loop join. Set LMMS_AUDITION_BROWSER to a browser executable to choose one, or to "none" to skip that part.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DOMParser } from '@xmldom/xmldom';
import { decodeWav, encodeWav, slice } from './audio.mjs';
import { killProcessTreeByPid } from './tools/fs-atomic.mjs';

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-audition-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-audition-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace, LMMS_NO_GUI_LAUNCH: '1' },
}));
async function raw(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
}
async function call(name, args = {}) {
  const result = await raw(name, args);
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}
async function fails(name, args, pattern) {
  const result = await raw(name, args);
  assert.ok(result.isError, `${name} should have failed`);
  assert.match(result.content[0].text, pattern);
}
const step = label => console.log('ok', label);
// Parse strictly: xmldom's HTML mode throws on mismatched tags and reports other problems through onError.
function parseHtml(html) {
  const problems = [];
  const doc = new DOMParser({ onError: (level, message) => problems.push(`${level}: ${message}`) }).parseFromString(html, 'text/html');
  assert.deepEqual(problems, [], 'page parses as HTML without errors');
  return doc;
}
const configOf = html => JSON.parse(html.match(/<script type="application\/json" id="audition-config">([^<]*)<\/script>/)[1]);

const browserCandidates = () => (process.env.LMMS_AUDITION_BROWSER
  ? (process.env.LMMS_AUDITION_BROWSER === 'none' ? [] : [process.env.LMMS_AUDITION_BROWSER])
  : process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']).filter(candidate => existsSync(candidate));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Start a headless Chromium browser with the DevTools protocol on a free port (Node 22 has WebSocket built in).
// Returns null when the browser does not start headless.
async function launch(executable, profile) {
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await pause(100);
  if (!existsSync(portFile)) { child.kill(); return null; }
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map(), problems = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    const { method, params } = message;
    if (method === 'Runtime.consoleAPICalled') problems.push(`console.${params.type}: ${params.args.map(a => a.value ?? a.description).join(' ')}`);
    if (method === 'Runtime.exceptionThrown') problems.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    if (method === 'Log.entryAdded' && params.entry.level === 'error' && !/favicon\.ico/.test(params.entry.url ?? '')) problems.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
  };
  const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return {
    problems, evaluate,
    // Open a URL and wait until the expression returns something other than null or undefined.
    async open(url, until, timeoutMs = 90000) {
      problems.length = 0;
      await send('Page.navigate', { url });
      await pause(300);
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await pause(250)) {
        const value = await evaluate(until);
        if (value !== null && value !== undefined) return value;
      }
      throw new Error(`Timed out waiting for ${until} at ${url}. Status: ${await evaluate("document.getElementById('status')?.textContent")}`);
    },
    async close() {
      await Promise.race([send('Browser.close').catch(() => {}), pause(2000)]);
      try { socket.close(); } catch { /* ignore */ }
      if (child.pid) await killProcessTreeByPid(child.pid);
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}

let server;
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['build_audition_page', 'read_feedback', 'remember_taste', 'get_taste']) assert.ok(tools.includes(name), name);
  const started = await call('get_started');
  assert.ok(started.moduleGuidance.some(line => /get_taste/.test(line)) && started.moduleGuidance.some(line => /build_audition_page/.test(line)));
  step('audition tools listed and get_started carries their guidance');

  // 1. A short layered song exported for a game: 2 intro bars, 4 loop bars, two layers, one stinger.
  await call('create_project', { output: 'song.mmp', bpm: 120, lengthBars: 6, tracks: [
    { name: 'Kick', voice: 'kick', volume: 70, patterns: [{ name: 'Beat', bar: 0, bars: 6, steps: { grid: 'X---x---X-x-x---' } }] },
    { name: 'Bass', voice: 'bass', volume: 100, patterns: [{ name: 'Line', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C', style: 'bass' } }] },
    { name: 'Keys', voice: 'pad', volume: 45, patterns: [{ name: 'Chords', bar: 0, bars: 6, chords: { progression: 'Dm Bb F C' } }] },
    { name: 'Lead', voice: 'pluck', volume: 50, patterns: [{ name: 'Tune', bar: 2, bars: 4, melody: { line: 'D5:3 F5:3 A5:6 G5:2 F5:2' } }] },
  ] });
  await call('export_game_audio', { project: 'song.mmp', outputDirectory: 'game', name: 'theme', introBars: 2, targetLufs: -18,
    layers: [{ name: 'rhythm', tracks: ['Kick', 'Bass'] }, { name: 'tonal', tracks: ['Keys', 'Lead'] }],
    stingers: [{ name: 'win', startBar: 2, bars: 1 }] });
  const manifest = JSON.parse(await readFile(path.join(workspace, 'game', 'theme.manifest.json'), 'utf8'));
  step('export_game_audio wrote a layered export with an intro');

  // 2. A spectrogram to show under the player.
  await call('render_mix', { project: 'song.mmp', output: 'song.wav' });
  await call('analyze_audio', { audio: 'song.wav', spectrogram: 'song-spec.png' });

  // 3. The page for the game folder.
  const page = await call('build_audition_page', { folder: 'game', spectrogram: 'song-spec.png', title: 'Theme <check>',
    sections: [{ name: 'Intro', startBar: 0 }, { name: 'Groove', startBar: 2 }, { name: 'Turn', startBar: 4, bars: 2 }] });
  assert.equal(page.page, 'game/theme-audition.html');
  assert.equal(page.kind, 'game');
  assert.deepEqual(page.layers, ['rhythm', 'tonal']);
  assert.deepEqual(page.stingers, ['win']);
  assert.deepEqual(page.sections.map(s => [s.name, s.startBar, s.bars]), [['Intro', 0, 2], ['Groove', 2, 2], ['Turn', 4, 2]]);
  const pagePath = path.join(workspace, 'game', 'theme-audition.html');
  const html = await readFile(pagePath, 'utf8');
  parseHtml(html);
  assert.doesNotMatch(html, /https?:\/\/|<link |src="\/\//i, 'no network references');
  const config = configOf(html);
  // Every asset the page loads exists next to it.
  for (const asset of page.assets) assert.ok(existsSync(path.resolve(path.dirname(pagePath), asset)), `${asset} exists relative to the page`);
  assert.equal(config.spectrogram, '../song-spec.png');
  // The embedded loop and intro frames are the manifest's and the files' own.
  const loopWav = decodeWav(await readFile(path.join(workspace, 'game', manifest.loop.file)));
  const introWav = decodeWav(await readFile(path.join(workspace, 'game', manifest.intro.file)));
  assert.equal(config.loop.frames, manifest.loop.endFrame - manifest.loop.startFrame);
  assert.equal(config.loop.frames, loopWav.frames);
  assert.equal(config.loop.frames, 4 * 96000);
  assert.equal(config.intro.frames, introWav.frames);
  assert.equal(config.intro.frames, 2 * 96000);
  assert.equal(config.loop.startBar, 2);
  for (const layer of config.layers) assert.equal(decodeWav(await readFile(path.join(workspace, 'game', layer.src))).frames, config.loop.frames, `${layer.name} is loop length`);
  assert.equal(config.sampleRate, 48000);
  assert.equal(config.bpm, 120);
  step('game page is valid HTML, references files that exist and embeds the loop and intro frames');

  // 4. A/B two renders at matched loudness.
  await call('apply_edits', { project: 'song.mmp', output: 'loud.mmp', edits: [{ op: 'set_master', args: { volume: 160 } }] });
  await call('render_mix', { project: 'loud.mmp', output: 'loud.wav' });
  const ab = await call('build_audition_page', { files: ['song.wav', 'loud.wav'], bpm: 120, sections: [{ name: 'All', startBar: 0 }] });
  // A shorter take in a subfolder with the same file name, to check paths and padding.
  const songAudio = decodeWav(await readFile(path.join(workspace, 'song.wav')));
  await mkdir(path.join(workspace, 'take2'));
  await writeFile(path.join(workspace, 'take2', 'song.wav'), encodeWav(slice(songAudio, 0, 4 * 96000)));
  const uneven = await call('build_audition_page', { files: ['song.wav', 'take2/song.wav'], bpm: 120, output: 'uneven.html' });
  assert.deepEqual(uneven.compare.map(file => file.src), ['song.wav', 'take2/song.wav']);
  assert.equal(ab.page, 'song-ab-audition.html');
  const [a, b] = ab.compare;
  assert.ok(b.lufs > a.lufs + 2, `the louder render measures louder (${a.lufs} and ${b.lufs})`);
  assert.equal(a.gainDb, 0);
  assert.ok(Math.abs(b.lufs + b.gainDb - a.lufs) < 0.01, 'B is turned down to A');
  parseHtml(await readFile(path.join(workspace, ab.page), 'utf8'));
  await fails('build_audition_page', { files: ['song.wav'], sections: [{ name: 'X', startBar: 0 }] }, /need bpm/);
  await fails('build_audition_page', { folder: 'game', files: ['song.wav'] }, /either folder/);
  await fails('build_audition_page', { folder: 'missing' }, /not found/);
  await fails('build_audition_page', { files: ['../outside.wav'] }, /Invalid|match/i);
  step('A/B page matches loudness to the quieter render; bad input is refused');

  // 5. Feedback round trip: build the JSON the page writes from the page's own config, then read it back.
  const feedback = {
    schema: config.schema, version: config.version, title: config.title, source: config.source, page: config.pageName,
    files: page.assets.filter(asset => asset.endsWith('.wav')), bpm: config.bpm, timeSignature: config.timeSignature, introBars: config.intro.bars,
    savedAt: new Date().toISOString(),
    sections: config.sections.map((section, index) => ({ ...section, rating: [4, 2, null][index] })),
    notes: [
      { seconds: 5.1, bar: 2, beat: 3, section: 'Groove', text: 'Lead too busy', rating: 2, mode: 'layers',
        layers: { rhythm: { db: 0, muted: false, solo: false }, tonal: { db: -6, muted: false, solo: true } } },
      { seconds: 0.4, bar: 0, beat: 1, section: 'Intro', text: 'Good start', rating: null, mode: 'mix' },
    ],
  };
  await writeFile(path.join(workspace, 'game', config.feedbackName), JSON.stringify(feedback, null, 2));
  const read = await call('read_feedback', { file: `game/${config.feedbackName}` });
  assert.equal(read.noteCount, 2);
  assert.deepEqual(read.weakestSection, { name: 'Groove', rating: 2 });
  assert.equal(read.sections.find(s => s.name === 'Groove').notes[0].heard, 'solo tonal; tonal -6 dB');
  assert.deepEqual(read.byBar['2'], ['Lead too busy']);
  assert.ok(read.summary[0].startsWith('Intro (bars 0 to 1): rated 4/5'));
  const pasted = await call('read_feedback', { text: JSON.stringify(feedback) });
  assert.equal(pasted.noteCount, 2);
  await fails('read_feedback', { text: '{"schema":"x"}' }, /Expected schema/);
  step('feedback round-trips through a file and pasted text, grouped by section and bar');

  // 6. Taste memory.
  const first = await call('remember_taste', { text: 'Leads too busy; keep melodies sparse', area: 'lead', source: config.feedbackName });
  assert.equal(first.entry.id, 't1');
  await call('remember_taste', { text: 'Less reverb on drums', area: 'drums' });
  assert.equal((await call('remember_taste', { text: 'less reverb on drums.', area: 'drums' })).added, false);
  const taste = await call('get_taste', {});
  assert.equal(taste.count, 2);
  assert.deepEqual(taste.preferences.lead, [{ id: 't1', text: 'Leads too busy; keep melodies sparse' }]);
  assert.ok(existsSync(path.join(workspace, '.lmms-taste.json')));
  await call('remember_taste', { forget: ['t2'] });
  assert.deepEqual(Object.keys((await call('get_taste', {})).preferences), ['lead']);
  await fails('remember_taste', { forget: ['t9'] }, /No taste entry/);
  step('taste entries persist in .lmms-taste.json, deduplicate and can be forgotten');

  // 7. Optional: load the pages in a real headless browser through the DevTools protocol.
  let browser = null, used;
  const profile = await mkdtemp(path.join(scratchRoot, 'lmms-audition-browser-'));
  for (const candidate of browserCandidates()) {
    try { browser = await launch(candidate, path.join(profile, path.basename(candidate, path.extname(candidate)))); } catch { browser = null; }
    if (browser) { used = candidate; break; }
  }
  if (!browser) console.log('skip headless browser check (no Chrome or Edge that starts headless)');
  else {
    server = createServer((request, response) => {
      const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '');
      const full = path.resolve(workspace, relative);
      if (!full.startsWith(workspace + path.sep) || !existsSync(full)) { response.writeHead(404); response.end(); return; }
      const type = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png' }[path.extname(full)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': type });
      createReadStream(full).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
      const loader = key => `document.getElementById('loader').dataset.${key}`;
      const selftest = JSON.parse(await browser.open(base + 'game/theme-audition.html#selftest', loader('selftest')));
      assert.deepEqual(browser.problems, [], 'no console output or errors from the game page');
      assert.equal(await browser.evaluate(loader('ready')), 'yes', 'the game page decoded its audio');
      const frames = JSON.parse(await browser.evaluate(loader('frames')));
      assert.equal(frames['theme-loop.wav'], config.loop.frames, 'the browser decodes the loop at its exported length');
      assert.equal(frames['theme-intro.wav'], config.intro.frames);
      assert.equal(await browser.evaluate("document.getElementById('spec').naturalWidth > 0"), true, 'the spectrogram image loads');
      assert.ok(!selftest.error, selftest.error);
      assert.equal(selftest.sampleRate, 48000);
      assert.ok(selftest.introJoinMaxDiff < 1e-4, `intro to loop join matches the files joined end to end (max difference ${selftest.introJoinMaxDiff})`);
      assert.ok(selftest.loopSeamMaxDiff < 1e-4, `loop seam matches (max difference ${selftest.loopSeamMaxDiff})`);
      assert.ok(selftest.layersVsMixDb < -40, `layers summed in the browser match the mix (${selftest.layersVsMixDb} dB)`);
      // Press Play, then check the clock moves and a note pins to the current position.
      await browser.evaluate("document.getElementById('play').click()");
      await pause(800);
      const clock = await browser.evaluate("document.getElementById('clock').textContent");
      assert.notEqual(clock, '0:00.000', 'the clock moves after Play');
      await browser.evaluate("document.getElementById('notetext').value = 'Test note'; document.getElementById('addnote').click()");
      assert.equal(await browser.evaluate("document.querySelector('#notes li .text').textContent"), 'Test note');
      assert.match(await browser.evaluate("document.querySelector('#notes li .when').textContent"), /Bar 1\.\d/);
      assert.equal(await browser.open(base + ab.page, loader('ready')), 'yes');
      assert.deepEqual(browser.problems, [], 'no console output or errors from the A/B page');
      assert.equal(await browser.open(base + 'uneven.html', loader('ready')), 'yes');
      const played = JSON.parse(await browser.evaluate(loader('playFrames')));
      assert.deepEqual(played, { 'song.wav': songAudio.frames, 'take2/song.wav': songAudio.frames }, 'the shorter take is padded to the longer so A/B stays in step');
      assert.deepEqual(browser.problems, [], 'no console output or errors from the A/B page');
      const local = await browser.open('file:///' + pagePath.replaceAll('\\', '/'),
        "document.getElementById('picker').classList.contains('hidden') ? null : document.getElementById('status').textContent");
      assert.match(local, /Opened from disk/);
      assert.deepEqual(browser.problems, [], 'no console output or errors when opened from disk');
      step(`headless ${path.basename(used)}: pages load without console errors and Play runs (${clock}); join error ${selftest.introJoinMaxDiff}, seam error ${selftest.loopSeamMaxDiff}, layers vs mix ${selftest.layersVsMixDb.toFixed(1)} dB`);
    } finally {
      await browser.close();
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  console.log('All audition checks passed.');
} finally {
  server?.close();
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
