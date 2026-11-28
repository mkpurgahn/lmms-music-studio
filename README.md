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
6. Non-destructively merges `lmms-music-studio` into repo `.mcp.json` (GitHub Copilot CLI & Desktop App), repo `.vscode\mcp.json` (VS Code GitHub Copilot), and global `~/.copilot/mcp-config.json` (`%USERPROFILE%\.copilot\mcp-config.json`, skippable with `-SkipGlobalMcp`), preserving any existing servers or inputs. Both `.mcp.json` and `.vscode\mcp.json` are gitignored so local machine paths are never committed; see `.mcp.example.json` and `.vscode\mcp.example.json` for portable templates.
7. Installs the `/make-music` skill (`SKILL.md` and `producer-tool-reference.md`) to global `~/.copilot/skills/make-music` (`%USERPROFILE%\.copilot\skills\make-music\`) and `~/.agents/skills/make-music` (`%USERPROFILE%\.agents\skills\make-music\`) alongside the tracked repository skill in `.github\skills\make-music\SKILL.md` (and removes any legacy `lmms-music-studio` skill folder).
8. Runs `node .github\scripts\smoke-server.mjs` and prints your ready summary.

### Optional Installer Flags

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 `
  -Workspace "D:\Music\My Studio" `
  -SoundfontsDir "D:\Music\SoundFonts" `
  -Packs core,upright-bass,meta-piano `
  -SkipUserSkill `
  -SkipGlobalMcp `
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

Cloning the repository already includes `.github\skills\make-music\SKILL.md`, and running `.\install-windows.ps1` once wires up `.mcp.json` (Copilot CLI/App), `.vscode\mcp.json` (VS Code Copilot), global `~/.copilot/mcp-config.json`, and global `~/.copilot/skills/make-music` + `~/.agents/skills/make-music` so `/make-music` works across every GitHub Copilot environment. Here is how each AI client connects on Windows:

### GitHub Copilot Desktop App, GitHub Copilot CLI, & VS Code GitHub Copilot
- **Copilot Desktop App & Copilot CLI (any repository):** Running `.\install-windows.ps1` registers `mcpServers["lmms-music-studio"]` globally in `~/.copilot/mcp-config.json` (`%USERPROFILE%\.copilot\mcp-config.json`) as well as in repo `.mcp.json`, and installs `/make-music` (`SKILL.md` + `producer-tool-reference.md`) into both `~/.copilot/skills/make-music` and `~/.agents/skills/make-music`. Type `/make-music` (or `"let's make a song"`) in any Copilot Desktop App chat or Copilot CLI session across any repository.
- **VS Code GitHub Copilot:** Cloning the repo includes `.github\skills\make-music\SKILL.md`, and `.\install-windows.ps1` writes `.vscode\mcp.json` (`servers["lmms-music-studio"]` with `"type": "stdio"`, modeled on `.vscode\mcp.example.json`). Open the repository folder in VS Code and invoke `/make-music` in Copilot Chat.
- **Fallback coordinator routing (when `-SkipGlobalMcp` was used):** If you start `/make-music` from a general chat where MCP tools are not attached, the skill walks you through the 4 plain-English intake questions right there, coordinates an `lmms-music-studio` branch session automatically, and opens the Studio Player in Browser Canvas when ready.

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
- To install the `/make-music` skill in another project for Claude Code, copy `skills\make-music` to `.claude\skills\make-music`.

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

Running `.\install-windows.ps1` already installs `/make-music` globally to `~/.agents/skills/make-music` (`%USERPROFILE%\.agents\skills\make-music\`); for project-scoped discovery in another repository, copy `skills\make-music` to `.agents\skills\make-music`.

### Cursor
- **Cursor:** Copy `.mcp.json` to `.cursor\mcp.json` in your workspace (or merge `mcpServers["lmms-music-studio"]` into `%USERPROFILE%\.cursor\mcp.json`).

---

## 4. How to Produce a Song by Ear (`/make-music`)

You need **zero** knowledge of BPM, bars, musical keys, chord names, or audio stems. Just invoke `/make-music` (or describe a mood in everyday words), click through four plain-English choices, listen in the Studio Player, and react by ear.

### Step 1: Type `/make-music` (No Technical Terms Needed)

A complete beginner can literally just type:

```text
/make-music
```

or say in everyday English:

```text
let's make a song
```

```text
make something chill for a rainy night
```

The `/make-music` skill never asks for BPM, bars, keys, or stem flags. Instead, it walks you one question at a time through **4 plain-English multiple-choice decisions** (skipping any your prompt already answered, or picking cohesive defaults automatically if you say `"surprise me"` / `"pick for me"`):

1. **Vibe:** `Chill & atmospheric (rainy night, menu, focus) (Recommended)`, `Warm, emotional, or cinematic`, `Upbeat, driving, or energetic`, or `Dark, tense, or mysterious`
2. **Sounds:** `Mix of real instruments + synths (Recommended)`, `Mostly real instruments (piano, strings, guitar, real drums)`, or `Pure electronic & synths`
3. **Pace:** `Medium steady groove (Recommended)`, `Slow & spacious`, or `Fast & high-energy`
4. **Format:** `Complete piece with a natural fade/ring-out ending (Recommended)` or `Seamless background loop`

Behind the scenes, your AI translates those choices into chords, melodies, CC0-1.0 acoustic SoundFonts and native synthesizers, checks voice-leading with `lint_arrangement`, renders sample-aligned instrument tracks and a master mix, verifies clipping and copyright provenance (`analyze_audio`, `audit_copyright`), **opens the interactive Studio Player automatically in the Browser Canvas**, and prints the plain copyable URL (for example `http://127.0.0.1:18290/studio/timeline?session=rainy-night-v1`).

### Step 2: Listen in the Studio Player & Pick Plain-English Feedback

Inside the Studio Player in Browser Canvas (or at the plain `http://127.0.0.1:18290/studio/timeline?session=rainy-night-v1` URL):
- Press `Space` or click `Play` to hear all instruments in sample-accurate WebAudio sync, or toggle `Master Mix` to hear the stereo master.
- Click `S` (Solo) or `M` (Mute) on individual lanes (Piano, Strings, Sub Bass, Drums) to hear what each part is doing.
- Click a section header to loop that section, or click any bar on the timeline to pin a plain-English note (for example: `Display Bar 5: piano feels buried, and the drums sound too stiff`), rate sections from 1 to 5 stars, and click `Send Feedback to Studio`.

Right in chat, `/make-music` offers clickable plain-English reaction options so you never need mixing jargon:
- `"I pinned notes in Studio Player - apply my feedback"`
- `"Sounds muddy, boxy, or cluttered - clean up the mix"`
- `"Feels flat or repetitive - add movement and energy"`
- `"Good direction - make it longer or open in Desktop LMMS"`

Or simply describe what your ears notice in your own words:

```text
Sounds muddy in the middle, and the drums feel a little stiff.
```

### Step 3: Compare Revisions Fairly with Loudness-Matched A/B

Human ears naturally perceive a louder mix as "better" even when the balance is worse. Each revision saves a fresh version (`rainy-night-v2.mmp` and `rainy-night-v2.wav`) alongside `v1` and opens the Studio Audition player in Browser Canvas (`http://127.0.0.1:18290/studio/audition?session=rainy-night-ab`), automatically trimming louder renders down to match the quietest file's loudness.

Switch seamlessly between `A` and `B` mid-phrase, and tell your AI whenever you find preferences worth keeping for future songs:

```text
Version 2 sounds much cleaner. Remember that I like gentle piano, relaxed drums, and light room reverb.
```

### Step 4: Open and Edit in Desktop LMMS with Two-Way Sync

Want to nudge a note on the piano roll or turn a synth knob yourself?
1. Click `"Good direction - make it longer or open in Desktop LMMS"` in chat, click `Open in LMMS` in the Studio Player header, or say: `Open rainy-night-v2.mmp in Desktop LMMS.`
2. Edit notes, mixer levels, or native synth controls in LMMS 1.2.2 and press `Ctrl+S` (saving either `.mmp` or compressed `.mmpz`).
3. Tell your AI:

```text
Bring in the changes I saved in Desktop LMMS and update the Studio Player.
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
| `vsco-complete` | `vsco-strings-complete.sf2`, `vsco-brass-complete.sf2`, `vsco-winds-complete.sf2`, `vsco-percussion-keys.sf2`, `vsco-orch-perc.sf2` | 47 additional VSCO 2 CE orchestral presets: complete string sustains/quiet/tremolo/spiccato/pizzicato (`0..15`), muted/stopped/open brass (`0..9`), woodwinds from bassoon to piccolo (`0..10`), timpani rolls, tubular bells, glockenspiel, xylophone, marimba, gothic pipe organ + 32-ft pedal, vintage upright piano (`0..8`), and Bank 128 orchestral percussion (`GM-StylePerc`, MIDI `32..104`) |
| `all` | All 12 `.sf2` banks above | Convenience alias installing `core`, `upright-bass`, `meta-piano`, `vsco-extended`, and `vsco-complete` (70 verified CC0-1.0 presets total) |

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

Run these commands from your cloned repository root:

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
- Copilot `/make-music` skill & producer reference: `skills\make-music\SKILL.md` and `skills\make-music\producer-tool-reference.md`
- Browser timeline & stem player details: `docs\timeline.md`
- Audition player, A/B loudness matching, & taste memory: `docs\audition.md`
- Musical blueprints & motif development: `docs\blueprints.md`
- Arrangement linter & quality scoring: `docs\arranger-lint.md`
- Stem auto-balance & reference comparison: `docs\balance.md`
- Visual 8-channel Mix Desk: `docs\mix-desk.md`
- Game loop preparation & loop-point metadata: `docs\loop-prep.md`

## License

MIT License (see `LICENSE`). Stock LMMS 1.2.2 is distributed separately under its upstream GPLv2 license, and CC0-1.0 SoundFont sources are documented with upstream commit hashes and license digests in `licences.json` and `soundfont-lock.json`.

