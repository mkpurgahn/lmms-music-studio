// End-to-end check of the arrangement lint through a real stdio connection and the installed LMMS.
// Run: node verify-arranger-lint.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scratchRoot = fileURLToPath(new URL('./.test-scratch', import.meta.url));
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, 'lmms-arranger-lint-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-arranger-lint-check', version: '1' });
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

// A sensible game loop in D minor: drums, a walking bass in the tenor register, an arpeggiated seventh-chord harmony
// (a six-note cycle), a held pad, one lead with a varied motif that rests in the last bar, and a real counter line that
// answers the lead and takes over while it rests. Same as cleanSpecs in tools/arranger-lint.test.mjs.
const leadLine = 'D5:4 F5:2 A5:2 G5:4 F5:4 | D5:4 F5:2 Bb5:2 F5:4 D5:4 | C5:4 F5:2 A5:2 G5:4 F5:4 | ';
const clean = [
  { name: 'Kick', voice: 'kick', role: 'drums', volume: 60, patterns: [{ name: 'Beat', bar: 0, bars: 8, steps: { grid: 'X-------x-------' } }] },
  { name: 'Hat', voice: 'hat', role: 'drums', volume: 35, patterns: [{ name: 'Beat', bar: 0, bars: 8, steps: { grid: '--x---x---x---x-', length: 12 } }] },
  { name: 'Bass', voice: 'bass', role: 'bass', volume: 70, patterns: [{ name: 'Walk', bar: 0, bars: 4, melody: { line: 'D3:4 E3:4 F3:4 A3:4 | Bb2:4 C3:4 D3:4 F3:4 | F2:4 G2:4 A2:4 C3:4 | C3:4 D3:4 E3:4 G3:4', repeat: true } }] },
  { name: 'Arp', voice: 'pluck', role: 'harmony', volume: 30, patterns: [{ name: 'Broken', bar: 0, bars: 8, chords: { progression: 'Dm7 Bbmaj7 Fmaj7 C7', style: 'arp', order: 'updown', rate: 1, octave: 3, voiceLead: false } }] },
  { name: 'Pad', voice: 'pad', role: 'harmony', volume: 35, patterns: [{ name: 'Held', bar: 0, bars: 8, chords: { progression: 'Dm Bb F C', octave: 4 } }] },
  { name: 'Lead', voice: 'pluck', role: 'lead', volume: 60, patterns: [
    { name: 'A', bar: 0, bars: 4, melody: { line: leadLine + 'E5:4 G5:2 C6:2 G5:4 E5:4' } },
    { name: 'A2', bar: 4, bars: 4, melody: { line: leadLine + 'r:16' } },
  ] },
  { name: 'Counter', voice: 'pluck', role: 'counter', volume: 35, patterns: [{ name: 'Answer', bar: 0, bars: 8, melody: {
    line: 'r:16 | r:8 F4:2 G4:2 A4:2 F4:2 | r:16 | r:8 G4:2 A4:2 G4:2 E4:2 | r:16 | r:8 F4:2 G4:2 A4:2 F4:2 | r:16 | C5:4 Bb4:4 G4:4 E4:4' } }] },
];
// The failure agents produce: four tracks, each with its own busy melody.
const busy = [
  { name: 'Lead A', voice: 'pluck', role: 'lead', volume: 50, patterns: [{ name: 'A', bar: 0, bars: 4, melody: { line: 'D5:1 E5:1 F5:1 A5:1 G5:1 Bb5:1 A5:1 F5:1 E5:1 G5:1 F5:1 D5:1 C5:1 E5:1 G5:1 A5:1 | F5:1 D5:1 Bb4:1 C5:1 A5:1 G5:1 E5:1 C6:1 Bb5:1 G5:1 D5:1 F5:1 E5:1 A5:1 C5:1 D5:1 | A5:1 F5:1 G5:1 E5:1 D5:1 C6:1 Bb5:1 A5:1 G5:1 F5:1 E5:1 G5:1 Bb5:1 D5:1 F5:1 C5:1 | E5:1 C5:1 D5:1 G5:1 A5:1 F5:1 Bb5:1 E5:1 D6:1 C6:1 A5:1 G5:1 F5:1 D5:1 E5:1 A5:1' } }] },
  { name: 'Lead B', voice: 'pluck', role: 'lead', volume: 50, patterns: [{ name: 'B', bar: 0, bars: 4, melody: { line: 'A4:2 C5:2 Bb4:2 G4:2 F4:2 E4:2 D5:2 C5:2 | E4:2 G4:2 D5:2 A4:2 Bb4:2 F4:2 C5:2 E4:2 | G4:2 Bb4:2 E4:2 D5:2 A4:2 C5:2 F4:2 G4:2 | D5:2 F4:2 A4:2 E4:2 C5:2 G4:2 Bb4:2 D4:2' } }] },
  { name: 'Melody C', voice: 'pluck', role: 'counter', volume: 50, patterns: [{ name: 'C', bar: 0, bars: 4, melody: { line: 'F5:2 Eb5:2 G5:2 D5:2 C#5:2 A5:2 E5:2 F5:2 | B4:2 D5:2 G5:2 F#5:2 A5:2 E5:2 C5:2 Bb4:2 | C#5:2 E5:2 F5:2 A5:2 Ab4:2 G5:2 D5:2 B4:2 | G5:2 E5:2 C#5:2 F5:2 D5:2 A5:2 Eb5:2 F#5:2' } }] },
  { name: 'Melody D', voice: 'pluck', volume: 50, patterns: [{ name: 'D', bar: 0, bars: 4, melody: { line: 'C6:2 A5:2 F#5:2 B5:2 D6:2 G5:2 E6:2 C6:2 | A5:2 F5:2 D6:2 Bb5:2 G#5:2 E6:2 C6:2 A5:2 | B5:2 G5:2 E6:2 C#6:2 A5:2 F6:2 D6:2 Bb5:2 | G5:2 D6:2 B5:2 F6:2 E6:2 C6:2 A5:2 C#6:2' } }] },
];

try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['lint_arrangement', 'quality_report', 'create_project', 'apply_edits', 'add_track', 'export_game_audio']) assert.ok(tools.includes(name), name);
  const started = await call('get_started');
  assert.ok(started.moduleGuidance.some(line => /lint_arrangement/.test(line)), 'module guidance mentions lint_arrangement');
  step(`${tools.length} tools listed, guidance registered`);

  // 1. The clean arrangement: no hook warnings, lint passes, quality passes.
  const made = await call('create_project', { output: 'clean.mmp', bpm: 110, tracks: clean });
  assert.equal(made.arrangement, undefined, JSON.stringify(made.arrangement));
  const cleanLint = await call('lint_arrangement', { project: 'clean.mmp' });
  assert.equal(cleanLint.pass, true);
  assert.equal(cleanLint.counts.error, 0);
  assert.equal(cleanLint.counts.warning, 0, JSON.stringify(cleanLint.findings));
  assert.ok(['D minor', 'F major'].includes(cleanLint.key.name), cleanLint.key.name);
  assert.deepEqual(cleanLint.roles.map(r => r.role), ['drums', 'drums', 'bass', 'harmony', 'harmony', 'lead', 'counter']);
  assert.ok(cleanLint.melodicVoicesPerBar.every(n => n <= 2), 'walking bass and arpeggio are not counted as melodies');
  const givenKey = await call('lint_arrangement', { project: 'clean.mmp', key: 'D minor', strict: true });
  assert.equal(givenKey.pass, true);
  assert.equal(givenKey.key.source, 'given');
  step('clean arrangement: no hook warnings, lint passes with no errors or warnings, strict too');

  // 1b. The same arrangement with no roles: lint notes the missing roles, but saves stay quiet.
  const unroled = await call('create_project', { output: 'unroled.mmp', bpm: 110, tracks: clean.map(({ role, ...rest }) => rest) });
  assert.equal(unroled.arrangement, undefined, JSON.stringify(unroled.arrangement));
  const mixOnly = await call('apply_edits', { project: 'unroled.mmp', output: 'unroled-mix.mmp', edits: [{ op: 'set_track_mix', args: { trackName: 'Lead', volume: 55 } }] });
  assert.equal(mixOnly.arrangement, undefined);
  const unroledLint = await call('lint_arrangement', { project: 'unroled.mmp' });
  assert.equal(unroledLint.counts.error + unroledLint.counts.warning, 0, JSON.stringify(unroledLint.findings));
  assert.ok(unroledLint.findings.some(f => f.rule === 'role.missing'));
  step('unroled arrangement: roles noted by lint_arrangement only, no arrangement field on save');

  // 2. The busy arrangement: the hook warns without blocking, strict blocks and writes nothing, lint fails clearly.
  const messy = await call('create_project', { output: 'busy.mmp', bpm: 110, tracks: busy });
  assert.equal(messy.arrangement.blocking, true);
  assert.match(messy.arrangement.summary, /errors?.*Fix errors before export/);
  assert.ok(messy.arrangement.warnings.some(w => /melody\.competing/.test(w)), messy.arrangement.warnings.join('\n'));
  assert.ok(messy.arrangement.warnings.some(w => /Melody D \(counter\)/.test(w)), 'asks for a role on the unroled track');
  assert.ok(existsSync(path.join(workspace, 'busy.mmp')));
  await fails('create_project', { output: 'busy-strict.mmp', bpm: 110, tracks: busy, strict: true }, /Nothing was written \(strict\).*melody\.competing/);
  assert.equal(existsSync(path.join(workspace, 'busy-strict.mmp')), false);
  const busyLint = await call('lint_arrangement', { project: 'busy.mmp' });
  assert.equal(busyLint.pass, false);
  const competing = busyLint.findings.find(f => f.rule === 'melody.competing');
  assert.equal(competing.severity, 'error');
  assert.deepEqual(competing.bars, [0, 1, 2, 3]);
  assert.match(competing.message, /4 independent melodies/);
  assert.ok(busyLint.findings.some(f => f.rule === 'role.multiple-leads'));
  assert.ok(busyLint.findings.every(f => f.fix && f.tracks && f.bars));
  step('busy arrangement: hook warns, strict blocks without writing, lint reports competing melodies');

  // 3. Hooks on add_track and apply_edits.
  const second = { name: 'Lead 2', voice: 'pluck', role: 'lead', volume: 40, patterns: [{ name: 'X', bar: 0, bars: 8, melody: { line: 'A5:2 G5:2 F5:2 E5:2 D5:2 C5:2 Bb4:2 A4:2' } }] };
  const added = await call('add_track', { project: 'clean.mmp', output: 'two-leads.mmp', track: second });
  assert.ok(added.arrangement.warnings.some(w => /role\.multiple-leads/.test(w)), JSON.stringify(added.arrangement));
  await fails('add_track', { project: 'clean.mmp', output: 'two-leads-strict.mmp', track: second, strict: true }, /strict/);
  assert.equal(existsSync(path.join(workspace, 'two-leads-strict.mmp')), false);
  const fixed = await call('apply_edits', { project: 'two-leads.mmp', output: 'fixed.mmp', edits: [{ op: 'remove_track', args: { trackName: 'Lead 2' } }] });
  assert.equal(fixed.arrangement, undefined, JSON.stringify(fixed.arrangement));
  const roled = await call('apply_edits', { project: 'busy.mmp', output: 'busy-roled.mmp', edits: [{ op: 'set_track_role', args: { trackName: 'Melody D', role: 'texture' } }] });
  assert.equal(roled.arrangement.blocking, true);
  assert.ok(!roled.arrangement.warnings.some(w => /Melody D \(/.test(w)), 'role note gone after set_track_role');
  const edited = await call('set_track_mix', { project: 'busy.mmp', output: 'busy-mix.mmp', trackName: 'Lead A', volume: 40 });
  assert.equal(edited.arrangement, undefined, 'only checked edits attach arrangement warnings');
  step('add_track and apply_edits attach arrangement warnings; strict blocks; other edits stay quiet');

  // 3b. A check that throws never stops a save. A zero-beat bar makes the lint fail on this hand-written project.
  await writeFile(path.join(workspace, 'odd.mmp'), '<?xml version="1.0"?><!DOCTYPE lmms-project><lmms-project version="1.0" creator="LMMS" creatorversion="1.2.2" type="song">' +
    '<head bpm="120" mastervol="86" timesig_numerator="0" timesig_denominator="4"/><song><trackcontainer type="song">' +
    '<track muted="0" solo="0" type="0" name="Lead" mcp-role="lead"><instrumenttrack vol="60" pan="0" basenote="57" fxch="0"><instrument name="tripleoscillator"><tripleoscillator/></instrument></instrumenttrack>' +
    '<pattern name="p" pos="0" len="192" type="1" steps="16" muted="0"><note key="62" pos="0" len="48" vol="100" pan="0"/></pattern></track></trackcontainer></song></lmms-project>');
  await fails('lint_arrangement', { project: 'odd.mmp' }, /./);
  const survived = await call('apply_edits', { project: 'odd.mmp', output: 'odd-saved.mmp', strict: true, edits: [{ op: 'set_track_mix', args: { trackName: 'Lead', volume: 50 } }] });
  assert.match(survived.arrangement.summary, /An arrangement check failed/);
  assert.equal(survived.arrangement.blocking, false);
  assert.ok(existsSync(path.join(workspace, 'odd-saved.mmp')));
  step('a check that throws is reported as a warning and the save still happens, even with strict');

  // 4. Quality report with a real render, and the export gate.
  const render = await call('render_mix', { project: 'clean.mmp', output: 'clean.wav' });
  assert.ok(render.durationSeconds > 15);
  const quality = await call('quality_report', { project: 'clean.mmp', audio: 'clean.wav', loop: true });
  assert.equal(quality.pass, true, JSON.stringify(quality));
  assert.ok(quality.score >= 70 && quality.score <= 100);
  assert.equal(quality.audio.file, 'clean.wav');
  assert.ok(quality.audio.integratedLufs < 0);
  const busyQuality = await call('quality_report', { project: 'busy.mmp' });
  assert.equal(busyQuality.pass, false);
  assert.match(busyQuality.verdict, /^Fail: \d+ arrangement errors/);
  assert.equal(busyQuality.audio, null);
  assert.ok(busyQuality.reasons[0].penalty >= busyQuality.reasons.at(-1).penalty);
  step(`quality_report: clean ${quality.score}/100 with audio, busy ${busyQuality.score}/100 fails`);

  await fails('export_game_audio', { project: 'busy.mmp', outputDirectory: 'busy-out', name: 'busy', strict: true }, /Nothing was written \(strict\)/);
  assert.equal(existsSync(path.join(workspace, 'busy-out')), false);
  const exported = await call('export_game_audio', { project: 'busy.mmp', outputDirectory: 'busy-out', name: 'busy' });
  assert.equal(exported.arrangement.blocking, true);
  assert.ok(existsSync(path.join(workspace, 'busy-out', 'busy-loop.wav')));
  const cleanExport = await call('export_game_audio', { project: 'clean.mmp', outputDirectory: 'clean-out', name: 'clean' });
  assert.equal(cleanExport.arrangement, undefined);
  step('export_game_audio: strict blocks a failing arrangement before rendering, otherwise warns');

  console.log('All arranger lint checks passed.');
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  await rmdir(scratchRoot).catch(() => {});
}
