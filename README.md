# LMMS Music Studio

LMMS Music Studio is an AI-operated open-source Digital Audio Workstation (DAW) studio for Windows built on stock LMMS 1.2.2 and the Model Context Protocol (MCP).

Unlike black-box AI audio generators that output a flat, uneditable MP3 or WAV from a prompt, LMMS Music Studio creates real, multi-track `.mmp` and `.mmpz` DAW projects. You do not need to know music theory, piano-roll editing, or mixing consoles to produce a great song. If you know what sounds good by ear, you direct your AI producer in plain English while the server writes notes, chords, drum grooves, mixer automation, and effects, measures loudness and frequency balance objectively, and opens an interactive Browser Studio where you can solo stems, compare loudness-matched A/B mixes, leave bar-pinned notes, or open any project directly in Desktop LMMS with two-way sync.

---

## 1. Overview: What LMMS Music Studio Does

- **Real multi-track DAW projects, never a black box:** Every melody note, chord voicing, drum hit, SoundFont preset, mixer fader, and effect parameter is saved in standard LMMS `.mmp` or `.mmpz` files inside your workspace. Change the bassline in bar 9 without regenerating the piano or drums.
- **Native synthesis plus verified CC0-1.0 acoustic instruments:** Combine 16 built-in LMMS synthesizers and synthesized drum kits with deterministic, SHA-256-locked CC0-1.0 SoundFonts (upright piano, nylon and steel guitars, acoustic GM drum kit, strings, contrabass, French horn, flute, concert harp, timpani, and optional orchestral/jazz expansions).
- **Ear-directed Browser Studio review:** After rendering sample-aligned stems and a master mix, the server launches a hardened local loopback Studio UI (`http://127.0.0.1:18290/studio/...`) where you play stems in WebAudio sync, toggle Solo and Mute, loop sections, compare A/B mixes at matched loudness, and send bar-pinned feedback straight back to your AI assistant.
- **Two-way Desktop LMMS 1.2.2 sync:** Click `Open in LMMS` in the browser (or ask your AI) to inspect or tweak notes and knobs in Desktop LMMS. Save with `Ctrl+S`, then tell your AI to sync: your edits are adopted and protected against accidental overwrites.
- **Fail-closed copyright provenance:** `LMMS_STRICT_COPYRIGHT=1` is enabled by default, ensuring every project, stem, master, and game-audio export is backed by cryptographic SHA-256 provenance sidecars (`<file>.provenance.json`).

---

## 2. Requirements & One-Command Windows Setup

### System Requirements
- **Operating System:** 64-bit Windows 10 or Windows 11 (x64)
- **Node.js:** Version 20.0.0 or newer (`winget install OpenJS.NodeJS.LTS`)
- **Git:** Installed on `PATH` (`winget install Git.Git`)
- **Disk Space & Network:** At least 1.5 GB free on first install (downloads stock LMMS 1.2.2 and FFmpeg via WinGet if missing, plus ~80 MB of verified CC0-1.0 acoustic SoundFont sources)

### One-Command Turnkey Install

Open Windows PowerShell and run:

```powershell
git clone https://github.com/mkpurgahn/lmms-music-studio.git
cd lmms-music-studio
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

What `install-windows.ps1` does safely and idempotently:
1. Checks 64-bit Windows, `node` (`>= 20.0.0`), `npm`, `git`, and free disk space, printing exact `winget` commands if anything is missing.
2. Installs FFmpeg (`Gyan.FFmpeg`) and stock LMMS 1.2.2 (`LMMS.LMMS`) via `winget` if they are not already installed.
3. Runs `npm ci` so all runtime, test, and verification scripts are ready.
4. Creates your workspace folder (`%USERPROFILE%\Music\LMMS Music Studio` by default).
5. Downloads, verifies (`LICENSE` + `SHA-256`), and compiles the CC0-1.0 `core` SoundFont pack into `%LOCALAPPDATA%\lmms-music-studio\soundfonts`. Repeat runs verify `soundfont-lock.json` hashes in under a second without re-downloading.
6. Non-destructively merges `mcpServers["lmms-music-studio"]` into `.mcp.json` in the repository root (preserving any other MCP servers you already have configured). `.mcp.json` is gitignored so local machine paths are never committed; see `.mcp.example.json` for a portable template.
7. Installs the producer skill to `%USERPROFILE%\.copilot\skills\lmms-music-studio\SKILL.md` (touching only that subfolder) alongside the project skill at `.github\skills\lmms-music-studio\SKILL.md`.
8. Runs `node .github\scripts\smoke-server.mjs` and prints your ready summary.

### Optional Installer Flags

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 `
  -Workspace "D:\Music\My Studio" `
  -SoundfontsDir "D:\Music\SoundFonts" `
  -Packs core,upright-bass,meta-piano `
  -SkipUserSkill `
  -SkipSmokeTest
```

### Environment Variables

| Variable | Default on Windows | Purpose |
| --- | --- | --- |
| `LMMS_WORKSPACE` | `%USERPROFILE%\Music\LMMS Music Studio` | Folder where `.mmp`/`.mmpz` projects, stems, renders, feedback, and exports live |
| `LMMS_SOUNDFONTS` | `%LOCALAPPDATA%\lmms-music-studio\soundfonts` | Folder holding verified `.sf2` SoundFont banks and `soundfont-lock.json` |
| `LMMS_STRICT_COPYRIGHT` | `1` (enabled unless `"0"` or `"false"`) | Enforces pure-synthesis and locked CC0-1.0 / provenanced audio gate |
| `LMMS_EXECUTABLE` | `C:\Program Files\LMMS\lmms.exe` | Path to `lmms.exe` when installed in a custom location |
| `LMMS_FFMPEG` | `ffmpeg` on `PATH` | Path to `ffmpeg.exe` for SoundFont building and OGG Vorbis output |
| `LMMS_RENDER_TIMEOUT_SECONDS` | Scales automatically with song length (min 590 s) | Override maximum seconds allowed per LMMS render |
| `LMMS_PARALLEL_RENDERS` | `3` (range `1` to `4`) | Concurrent LMMS render workers for stems and adaptive game layers |
| `LMMS_ASCII_CACHE` | `C:\Users\Public\lmms-music-studio-cache` | Automatic ASCII staging cache when Windows user paths contain non-ASCII characters |

Note: Full-song multi-stem renders can take 30 to 120 seconds. Set your MCP client tool timeout to at least 300 seconds (5 minutes) if your client exposes a timeout setting.

---

## 3. Connecting Your AI Assistant

Running `.\install-windows.ps1` writes `.mcp.json` in your checkout root using your exact local paths (modeled on `.mcp.example.json`). Here is how to connect popular AI clients on Windows:

### GitHub Copilot App & GitHub Copilot CLI
- Open the `lmms-music-studio` repository folder in GitHub Copilot App or Copilot CLI.
- Copilot automatically reads `.mcp.json` for the `lmms-music-studio` MCP server and `.github\skills\lmms-music-studio\SKILL.md` for the producer workflow.
- Because `install-windows.ps1` also installs `%USERPROFILE%\.copilot\skills\lmms-music-studio\SKILL.md`, you can copy the `lmms-music-studio` server block from `.mcp.json` into any other project's `.mcp.json` and keep the same producer skill.

### Claude Desktop
Open `%APPDATA%\Claude\claude_desktop_config.json` (create it if it does not exist) and merge the `"lmms-music-studio"` entry generated in your repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "lmms-music-studio": {
      "command": "node",
      "args": [
        "C:\\path\\to\\lmms-music-studio\\server.mjs"
      ],
      "env": {
        "LMMS_WORKSPACE": "C:\\Users\\YOUR_USERNAME\\Music\\LMMS Music Studio",
        "LMMS_SOUNDFONTS": "C:\\Users\\YOUR_USERNAME\\AppData\\Local\\lmms-music-studio\\soundfonts",
        "LMMS_STRICT_COPYRIGHT": "1"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code
- When launched inside `lmms-music-studio`, Claude Code detects `.mcp.json` automatically (approve the project MCP server when prompted) and reads `AGENTS.md`.
- To install the skill in another project for Claude Code, copy `skills\lmms-music-studio` to `.claude\skills\lmms-music-studio`.

### OpenAI Codex CLI / App
Add the server to `%USERPROFILE%\.codex\config.toml` (using the exact paths printed by `install-windows.ps1`):

```toml
[mcp_servers.lmms-music-studio]
command = "node"
args = ["C:\\path\\to\\lmms-music-studio\\server.mjs"]
tool_timeout_sec = 300

[mcp_servers.lmms-music-studio.env]
LMMS_WORKSPACE = "C:\\Users\\YOUR_USERNAME\\Music\\LMMS Music Studio"
LMMS_SOUNDFONTS = "C:\\Users\\YOUR_USERNAME\\AppData\\Local\\lmms-music-studio\\soundfonts"
LMMS_STRICT_COPYRIGHT = "1"
```

For project-level skill discovery in Codex, copy `skills\lmms-music-studio` to `.agents\skills\lmms-music-studio`.

### VS Code & Cursor
- **Cursor:** Copy `.mcp.json` to `.cursor\mcp.json` in your workspace (or merge `mcpServers["lmms-music-studio"]` into `%USERPROFILE%\.cursor\mcp.json`).
- **VS Code (GitHub Copilot Agent Mode):** Create `.vscode\mcp.json` with a `"servers"` key containing the same `"lmms-music-studio"` command, `args`, and `env` block from `.mcp.json`.

---

## 4. How to Produce a Song by Ear

You never need to specify frequencies, MIDI numbers, or compressor ratios. Describe the mood, pace, and instruments you want, listen in your browser, and tell the AI what your ears notice.

### Step 1: Start a Song with Synths and CC0 Acoustic Instruments

Try a prompt like:

```text
Create a warm 96 BPM acoustic-electronic town theme in F major, 16 bars long, with an intro, main theme, and gentle ending. Use CC0 upright piano, nylon guitar, contrabass, acoustic drums, and a soft synth pad. Render the stems and master with a natural ring-out ending, check the mix and copyright provenance, and give me the Browser Studio Timeline link.
```

Behind the scenes, your AI calls `get_started`, `get_taste`, and `list_sf2_presets`, writes the `.mmp` project, checks note voice-leading with `lint_arrangement`, balances track levels with `auto_balance`, renders sample-aligned stems and master with `tail: "ring"`, verifies loudness and provenance (`analyze_audio`, `audit_copyright`), and calls `build_timeline_page`.

### Step 2: Listen in the Browser Studio Timeline & Pin Notes to Bars

Open the plain URL your AI returns (for example `http://127.0.0.1:18290/studio/timeline?session=town-theme-v1`):
- Press `Space` or click `Play` to hear all stems in sample-accurate WebAudio sync, or toggle `Master Mix` to hear the mastered stereo render.
- Click `S` (Solo) or `M` (Mute) on individual lanes (Piano, Nylon Guitar, Contrabass, Drums, Pad) to hear exactly what each part is doing.
- Drag or click a section header to loop that section.
- Click any bar on the timeline to pin a plain-English note (for example: `Display Bar 5: piano feels buried under the guitar, and the drums sound too stiff`). Rate each section from 1 to 5 stars, then click `Send Feedback to Studio`.

Then tell your AI:

```text
Read my Studio feedback, fix the issues I noted, and set up a loudness-matched A/B comparison between v1 and v2.
```

### Step 3: Compare Revisions Fairly with Loudness-Matched A/B

Human ears naturally perceive a louder mix as "better" even when the balance is worse. When your AI calls `build_audition_page` with `files: ["town-theme-v1.wav", "town-theme-v2.wav"]`, the Studio Audition player automatically trims louder versions down to match the quietest file's integrated LUFS.

Open the returned `http://127.0.0.1:18290/studio/audition?session=...` URL, switch seamlessly between `A` and `B` mid-phrase, and save lasting taste rules whenever you find a sound you love:

```text
Version B is much clearer. Remember in my taste profile that I like sparse piano melodies, gentle MPC swing on drums, and light reverb.
```

### Step 4: Open and Edit in Desktop LMMS with Two-Way Sync

Want to nudge a note on the piano roll or tweak a synth knob yourself?
1. Click `Open in LMMS` directly in the Browser Studio header, or tell your AI: `Open town-theme-v2.mmp in Desktop LMMS.`
2. Edit notes, mixer levels, or native synth controls in LMMS 1.2.2 and press `Ctrl+S` (saving either `.mmp` or compressed `.mmpz`).
3. Tell your AI:

```text
Sync my changes from Desktop LMMS, re-render the stems and master, and refresh the Studio Timeline.
```

LMMS Music Studio tracks the opened file's SHA-256 hash in `.studio-lmms-sync.json`. If you saved changes in Desktop LMMS and forgot to mention it, the MCP server blocks accidental AI overwrites until `sync_from_lmms` adopts and provenance-checks your edits.

---

## 5. Included Instruments

### Native LMMS Synthesizers & Drum Kits (Zero Downloads Required)
- **Quick pure-synth voices:** `pluck`, `bass`, `pad`, `kick`, `snare`, `hat`, `clap`
- **Ready synthesized drum kits (`create_drum_kit`):** `tight-synth` (dry studio Kicker + TripleOscillator kit), `house-synth` (warm 909-inspired kit), `electro-synth` (driven synthwave kit), `808-synth` (deep analog boom kit)
- **16 native pure-synthesis plugins:** `tripleoscillator`, `zynaddsubfx`, `monstro`, `lb302`, `kicker`, `opl2`, `opulenz`, `organic`, `watsyn`, `vibedstrings`, `malletsstk`, `bitinvader`, `nes`, `papu`, `sid`, `sfxr`
- **Concert-tuned factory patches (`search_sounds`):** Hundreds of measured `.xpf` and ZynAddSubFX `.xiz` presets automatically pitch-corrected to concert tuning (`A4 = 440 Hz`, `C4 = MIDI 60`)

### Core CC0-1.0 Acoustic SoundFont Pack (`core` - Installed by Default)

Installed automatically by `install-windows.ps1` into `%LOCALAPPDATA%\lmms-music-studio\soundfonts` and verified against `soundfont-lock.json`:

| SoundFont File (`.sf2`) | Bank | Patch | Preset Name | Upstream Source | License |
| --- | --- | --- | --- | --- | --- |
| `upright-piano-kw.sf2` | `0` | `0` | Upright piano KW | Gary Wolk / FreePats | `CC0-1.0` |
| `meta-guitars.sf2` | `0` | `0` | Meta Nylon Guitar | Meta Open Sound (`/systems/instruments/*`) | `CC0-1.0` |
| `meta-guitars.sf2` | `0` | `1` | Meta Steel Guitar | Meta Open Sound (`/systems/instruments/*`) | `CC0-1.0` |
| `virtuosity-drums.sf2` | `128` | `0` | Virtuosity Drums GM (`acoustic-cc0` kit) | Versilian Studios & Karoryfer Samples | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `0` | Violin Ensemble Sustain | Versilian Studios VSCO 2 CE | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `1` | Contrabass Sustain | Versilian Studios VSCO 2 CE | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `2` | French Horn Sustain | Versilian Studios VSCO 2 CE | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `3` | Flute Staccato | Versilian Studios VSCO 2 CE | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `4` | Concert Harp | Versilian Studios VSCO 2 CE | `CC0-1.0` |
| `vsco-orchestra-core.sf2` | `0` | `5` | Timpani | Versilian Studios VSCO 2 CE | `CC0-1.0` |

### Optional CC0-1.0 SoundFont Expansions

Ask your AI to run `install_soundfont_pack`, or run `.\setup-libraries-windows.ps1 -Pack <name>`:

| Pack Name | SoundFont File | Included CC0-1.0 Presets |
| --- | --- | --- |
| `upright-bass` | `upright-bass.sf2` | 1958 Otto Rubner Double Bass Pizzicato (`bank: 0, patch: 0`) by D. Smolken |
| `meta-piano` | `meta-piano.sf2` | Meta Open Sound Acoustic Piano (`bank: 0, patch: 0`) |
| `vsco-extended` | `vsco-orchestra-extended.sf2` | 11 articulations (`bank: 0, patches: 0..10`): Flute Sustain Vibrato, Clarinet Staccato, Cello Ensemble Spiccato, Contrabass Spiccato, Violin Ensemble Spiccato, Violin Ensemble Tremolo, Viola Ensemble Tremolo, Trumpet Staccato, Tuba Staccato, Solo Violin Tremolo, Solo Violin Pizzicato |

---

## 6. Ownership, Copyright & Provenance Scope

LMMS Music Studio is engineered so you know the exact technical origin of every sound in your project.

### What Is Enforced Deterministically
- **Strict Copyright Gate (`LMMS_STRICT_COPYRIGHT=1`):** Enabled by default. Every save, render, Desktop LMMS sync, and game-audio export inspects all tracks and audio clips before writing output.
- **Locked CC0-1.0 SoundFonts (`soundfont-lock.json` & `licences.json`):** SoundFont packs are built from pinned upstream Git commits and archives after verifying upstream `LICENSE` SHA-256 digests. For Meta Open Sound, sparse checkout is strictly confined to `/systems/instruments/*` and explicitly blocks `/corpora/oculus-audio-pack/`. Every compiled `.sf2` is verified by SHA-256 before LMMS loads it.
- **Blocked Ambiguous Assets:** Stock LMMS factory `.ogg`/`.wav` samples (`list_samples`), `CC-BY` or attribution-encumbered libraries, unverified workspace WAVs, `tripleoscillator` custom user wavefiles (`wavetype=7`), and external plugin hosts (`vestige`, `carlarack`, `patman`, `gigplayer`) are blocked in strict mode.
- **Hash-Bound Sidecars (`<file>.provenance.json`) & `audit_copyright`:** Every saved project, stem, master, MIDI file, and one-shot export receives a `<file>.provenance.json` sidecar binding its exact SHA-256 hash to its synthesis plugins and CC0 SoundFont hashes. Calling `audit_copyright` verifies these hashes on demand; tampering with a single byte invalidates the sidecar. Descriptive `.meta.json` tags written by `tag_sound` never grant provenance.

### Practical & Legal Scope Notes
- **Content ID & Distributor Disputes:** Cryptographic SHA-256 provenance records proving pure mathematical synthesis and public-domain (`CC0-1.0`) multi-samples give you concrete technical evidence that your audio contains zero third-party sample-pack loops.
- **Microphone Recordings in Mix Desk (`user-attested-mic-take`):** When you record your own voice or instrument live through the browser Visual Mix Desk (`http://127.0.0.1:18290/mix-desk/`), the take is stamped as `user-attested-mic-take` (`hasUserAttestedTakes: true` in `audit_copyright`). The system verifies file integrity from the moment of capture, while you attest that what you performed into the microphone is your own non-infringing material.
- **Human Creative Direction & Authorship:** Clean upstream sample licensing prevents third-party infringement, while copyright registration and authorship of AI-assisted works depend on your jurisdiction and the degree of human creative selection, arrangement, ear-directed revision, or live performance. This documentation describes technical provenance guarantees and is not legal advice.

---

## 7. Verification & Troubleshooting

### Automated Verification Commands

Run these commands from the repository root (`F:\projects\lmms-music-studio` or your clone directory):

```powershell
# Run the full unit and studio integration test suite
npm test

# Verify MCP stdio startup, tool schemas, and get_started workflow references
node .github\scripts\smoke-server.mjs

# Verify npm package contents (no stray audio, tests, or .mcp.json)
node .github\scripts\check-pack.mjs

# Run end-to-end LMMS 1.2.2 rendering and game-audio verification suites
npm run verify
```

### Troubleshooting

- **"LMMS was not found at C:\Program Files\LMMS\lmms.exe":** Run `winget install --id LMMS.LMMS --exact --version 1.2.2 --accept-source-agreements --accept-package-agreements`, or set `LMMS_EXECUTABLE` in `.mcp.json` to your `lmms.exe` path.
- **"OGG output needs ffmpeg" or `ffmpeg` not found after install:** Close and reopen PowerShell so Windows refreshes `PATH`, or re-run `.\install-windows.ps1`.
- **"Un-synced Desktop LMMS edits detected":** You saved changes in Desktop LMMS after `open_in_lmms`. Ask your AI to run `sync_from_lmms` on that project so your edits are adopted instead of overwritten.
- **Windows username contains accents or non-ASCII characters:** LMMS 1.2.2 has legacy C++ path limitations with non-ASCII paths; LMMS Music Studio automatically stages affected SoundFonts and renders through `C:\Users\Public\lmms-music-studio-cache` (configurable via `LMMS_ASCII_CACHE`).
- **Browser Studio port busy:** The Studio HTTP server automatically scans `127.0.0.1` ports `18290` through `18299` (and falls back to an ephemeral port if all ten are occupied), returning the exact `studioUrl` in every `build_timeline_page` and `build_audition_page` response.

### Further Reference Docs in This Repository
- Producer and contributor guide: `AGENTS.md`
- Copilot / agent skill definition: `skills\lmms-music-studio\SKILL.md`
- Browser timeline & stem player details: `docs\timeline.md`
- Audition player, A/B loudness matching, & taste memory: `docs\audition.md`
- Musical blueprints & motif development: `docs\blueprints.md`
- Arrangement linter & quality scoring: `docs\arranger-lint.md`
- Stem auto-balance & reference comparison: `docs\balance.md`
- Visual 8-channel Mix Desk: `docs\mix-desk.md`
- Game loop preparation & loop-point metadata: `docs\loop-prep.md`

## License

MIT License (see `LICENSE`). Stock LMMS 1.2.2 is distributed separately under its upstream GPLv2 license, and CC0-1.0 SoundFont sources are documented with upstream commit hashes and license digests in `licences.json` and `soundfont-lock.json`.

