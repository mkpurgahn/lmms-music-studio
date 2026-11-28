// Checks what `npm pack` would publish: no audio, projects, tests or private files, and the files the server needs are there.
// Run: node .github/scripts/check-pack.mjs
import { execFileSync } from 'node:child_process';

const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
const files = JSON.parse(output)[0].files.map(file => file.path);
const unwanted = files.filter(file => /\.(wav|ogg|flac|mmp|mmpz|pyc|pyo)$|\.test\.mjs$|(^|\/)test_.*\.py$|(^|\/)__pycache__\/|^output\/|(^|\/)\.env|(^|\/)\.mcp\.json$|(^|\/)\.vscode\/mcp\.json$|(^|\/)skills\/lmms-music-studio\//i.test(file));
const needed = ['server.mjs', 'library-server.mjs', 'verify-studio-e2e.mjs', 'tools/workspace-config.mjs', 'tools/installer-config.mjs', 'tools/logger.mjs', 'tools/fs-atomic.mjs', 'tools/provenance.mjs', 'tools/lmms-sync.mjs', 'tools/cinema-fx.mjs', 'tools/studio-ui/api.mjs', 'tools/studio-ui/timeline.js', 'tools/studio-ui/audition.js', 'tools/studio-ui/studio.css', 'tools/sf2-builder.mjs', 'tools/soundfont-pack.mjs', 'skills/make-music/SKILL.md', 'skills/make-music/producer-tool-reference.md', '.github/skills/make-music/SKILL.md', '.github/skills/make-music/producer-tool-reference.md', 'install-windows.ps1', 'AGENTS.md', '.mcp.example.json', '.vscode/mcp.example.json', 'licences.json', 'soundfont-lock.json', 'sound-catalogue.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
const missing = needed.filter(file => !files.includes(file));
if (!files.some(file => file.startsWith('tools/') && file.endsWith('.mjs'))) missing.push('tools/*.mjs');
if (unwanted.length || missing.length) {
  if (unwanted.length) console.error('Unexpected files in the package: ' + unwanted.join(', '));
  if (missing.length) console.error('Missing from the package: ' + missing.join(', '));
  process.exit(1);
}
console.log(`Package holds ${files.length} files`);
