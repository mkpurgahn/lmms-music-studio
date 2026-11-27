# AGENTS.md - LMMS Music Studio V3 Guide for AI Agents

This file defines both the **AI Music Producer Protocol** (when operating LMMS Music Studio MCP tools for a human listener) and the **Repository Engineering Rules** (when maintaining code or documentation in this repository).

Style rules across this repository:
- Use zero emojis or decorative Unicode symbols anywhere in code, UI, comments, documentation, or commit messages.
- Write plain, directly copyable Windows paths (for example `C:\Program Files\LMMS\lmms.exe`) and plain URLs (for example `http://127.0.0.1:18290/studio/timeline?session=song-v1`) rather than label-style Markdown hyperlinks.

---

## 1. Ear-Directed Producer Protocol (`/make-music`)

Most listeners direct music by ear rather than DAW terminology. The unified `/make-music` skill (`skills\make-music\SKILL.md` and `skills\make-music\producer-tool-reference.md`, mirrored in `.github\skills\make-music\`) guides complete beginners through 4 plain-English multiple-choice decisions (`Vibe`, `Sounds`, `Pace`, `Format` - one `ask_user` call per missing slot, never asking for BPM, bars, keys, or stem flags) and routes general-chat sessions into a coordinated `lmms-music-studio` branch session when MCP tools are not attached yet.

When MCP tools are present, begin every session by calling `get_started`, `get_taste`, and `list_sf2_presets` so stored preferences in `.lmms-taste.json` and installed SoundFont banks guide sound selection, arrangement density, and mix balance from bar 0.

Translate subjective listener feedback directly into deterministic musical and DSP tool calls:

| Listener Feedback | Musical Diagnosis | Concrete MCP Tool Calls |
| --- | --- | --- |
| "Too muddy" / "boomy" / "cloudy" | Excess energy in `sub`/`bass`/`lowMid` (60-500 Hz), chord voicings overlapping bass, or long bright reverb tails | Inspect bands with `analyze_audio`; move harmony/pads up an octave (`replace_pattern` with `octave: 4`); lower `bassbooster` or `reverb` `size`/`wet` via `edit_effect`; shape synth filter `cutoff` via `automate_track`; rebalance stems with `auto_balance` or `set_track_mix`. |
| "Melody feels repetitive" / "boring loop" | Identical 1-2 bar phrase tiled across sections with no contour change or breathing room | Generate variations with `develop_motif` (`sequence`, `inversion`, `fragment`, `extension`, `cadence`) and apply them to specific bars with `replace_pattern`, or compose a phrased arc with `write_melody` that states, answers, climaxes once, and rests. |
| "Drums feel stiff" / "robotic" / "mechanical" | Quantized step hits at uniform velocity and straight piano/guitar note onsets | Apply `apply_groove` (`mpc-swing-60`, `house-shuffle`, `ukg-shuffle`, `afro-clave`), `humanize`, `add_ghost_notes`, and `add_fills` (or set `swing` and `humanize` on `create_project` patterns); run `shape_performance` once on piano, guitar, or solo tracks for phrase dynamics, chord voicing, rubato, and pedal. |
| "Piano is buried" / "lead gets lost" | Mid-range masking from competing melodic lines or centered pads | Run `lint_arrangement` to catch `register.overlap` and competing leads; thin accompaniment on strong beats; pan supporting chords/guitars slightly left/right (`set_track_mix` with `pan: -20` and `20`); declare `set_track_role` and run `auto_balance` or raise the featured track with `set_track_mix`. |
| "Ending cuts off abruptly" / "reverb chops at the end" | Rendered with `tail: "cut"`, truncating final note release and reverb/delay decay at the final bar line | Re-render BOTH `render_stems` and `render_mix` with `tail: "ring"` (and `ringSeconds: 5` to `20`), which extends rendering, detects decay down to `-72 dBFS` (`+0.15 s` fade), and trims master and all stems to the exact same frame count. Use `tail: "wrap"` only for seamless loops. |
| "Too harsh" / "piercing" / "brittle" | Excess 2-10 kHz energy, bright synth cutoff, or undamped reverb | Lower `reverb` `dampingHz` via `edit_effect`, automate lower filter `cutoff` with `automate_track`, reduce `fatten` `tiltDb`, or soften high-register note velocities. |
| "Notes clash" / "sounds out of key" | Non-diatonic notes or minor-second/tritone collisions on strong beats | Run `lint_arrangement` to locate exact 0-based bars and tracks, then snap pitches with `scale_lock` or rewrite the bar with `replace_pattern`. |

### Core Timing, Naming, and Instrument Conventions
- **Workspace-relative revision filenames:** Always pass plain workspace filenames (`rainy-night-v1.mmp`, `rainy-night-v2.wav` - never absolute paths) and increment `-vN` suffixes on revisions because `.mmp` and `.wav` writes fail closed when a target file already exists (`build_timeline_page` and `build_audition_page` accept `overwrite: true`).
- **Ticks, bars, and 4-bar section clips:** One quarter-note beat is `48` ticks; one 4/4 bar is `192` ticks. MCP tools index bars starting at `0`, while the Browser Studio UI displays 1-based bar numbers (`displayBar = bar + 1`). Author separate 4-bar patterns per section (`bar: 0, bars: 4`, `bar: 4, bars: 4`, etc.) so `replace_pattern` can revise individual sections cleanly.
- **Acoustic CC0-1.0 SoundFonts:** Call `list_sf2_presets` to inspect installed `.sf2` files (`upright-piano-kw.sf2`, `meta-guitars.sf2`, `virtuosity-drums.sf2`, `vsco-orchestra-core.sf2`, and optional packs installed via `install_soundfont_pack`). Assign melodic instruments with `voice: "sf2"`, `bank: 0`, `patch: <n>` (or `set_sf2_instrument`). Assign GM acoustic drums with `voice: "sf2"`, `sf2: "virtuosity-drums.sf2"`, `bank: 128`, `patch: 0` (or `create_drum_kit` with `kit: "acoustic-cc0"`).
- **Synthesized drums and synths:** Use built-in pure-synth voices (`pluck`, `bass`, `pad`, `kick`, `snare`, `hat`, `clap`), `create_drum_kit` (`tight-synth`, `house-synth`, `electro-synth`, `808-synth`), or concert-tuned factory `.xpf` and ZynAddSubFX `.xiz` presets discovered via `search_sounds`.

---

## 2. A/B & Stem Review Loop

Never hand the listener a silent, clipped, or unverified render, and never ask them to compare two mixes at unmatched loudness.

1. **Lint arrangement:** Run `lint_arrangement` after composing or editing and resolve all errors (`blocking: true`) before rendering.
2. **Render stems and master together:** Call `render_stems` and `render_mix` with matching `tail` settings (`tail: "ring"` for standalone songs, `tail: "wrap"` for loops).
3. **Verify objective audio and provenance metrics:**
   - Call `analyze_audio` on the rendered master (and stems/sections when diagnosing balance). Fix clipping (`clippedSamples > 0`), phase cancellation (`stereoCorrelation < 0.2`), or unintended silent bars before sharing.
   - Call `audit_copyright` on the project or rendered master to confirm `compliant: true`.
4. **Open the Browser Studio review session:**
   - **First listen or stem inspection:** Call `build_timeline_page` with `stems`, `mix`, `project`, `sections`, `output`, and `overwrite: true`. When `open_canvas` is available, open `studioUrl` directly in Browser Canvas (`canvasId: "browser"`, `instanceId: "music-studio-player"`) AND print the plain `studioUrl` (`http://127.0.0.1:<port>/studio/timeline?session=<session>`), where the listener can play stems in sample-accurate WebAudio sync (within a 512 MiB decoded buffer budget), toggle Solo/Mute, switch to Master Mix, loop sections, and pin comments to exact bars and beats.
   - **Mix or arrangement revision:** Keep the previous render (`song-v1.wav`) and render the revision (`song-v2.wav`). Call `build_audition_page` with `files: ["song-v1.wav", "song-v2.wav"]`, `project: "song-v2.mmp"`, `output`, and `overwrite: true`. `build_audition_page` automatically gain-matches louder renders down to the quietest render so loudness never biases the A/B comparison. Open `studioUrl` in Browser Canvas (`open_canvas`) when available AND print the plain `studioUrl` (`http://127.0.0.1:<port>/studio/audition?session=<session>`).
   - **Prompt listener reaction in plain English:** Summarize changes in everyday listener words (no raw LUFS/dBTP dumps) and, in interactive sessions, offer plain-English `ask_user` choices (`"I pinned notes in Studio Player - apply my feedback"`, `"Sounds muddy, boxy, or cluttered - clean up the mix"`, `"Feels flat or repetitive - add movement and energy"`, `"Good direction - make it longer or open in Desktop LMMS"`).
5. **Read feedback and remember taste:**
   - When the listener clicks `Send Feedback to Studio`, call `read_feedback` to read Unified Feedback v2 JSON (`bar` 0-based, `displayBar` 1-based, `beat`, `heard` stem/mix context, section ratings, `weakestSection`, and `staleProjectRevision` checks).
   - Apply the requested bar-pinned changes into a new project revision, and call `remember_taste` whenever a comment states a durable preference (for example `"keep vocals/lead dry"` or `"prefer tight punchy kicks over boomy 808s"`).

---

## 3. Two-Way Desktop LMMS Safety

Listeners and producers can open any workspace `.mmp` or `.mmpz` in the Desktop LMMS 1.2.2 GUI at any time:

1. Calling `open_in_lmms` (or clicking `Open in LMMS` in the Browser Studio UI) verifies copyright provenance, records `openedSha256` in `.studio-lmms-sync.json`, and launches Desktop LMMS.
2. While tracked in `.studio-lmms-sync.json`, every MCP project-mutating tool (`apply_edits`, `replace_pattern`, `add_track`, `save_project_copy`, etc.) checks whether the `.mmp` or a sibling `.mmpz` changed on disk. If out-of-band Desktop LMMS saves exist, MCP writes fail closed rather than silently overwriting user work.
3. **Mandatory sync step:** Always call `sync_from_lmms({ project })` before making MCP edits to a project opened in Desktop LMMS. `sync_from_lmms` adopts user edits (including compressed `.mmpz` saves when `adoptCompressedCopy: true`), re-runs strict copyright provenance checks, refreshes `<project>.provenance.json`, updates `.studio-lmms-sync.json`, and returns a summary of tracks and notes.

---

## 4. Strict Copyright & Provenance Invariants

`LMMS_STRICT_COPYRIGHT=1` is enabled by default and enforced centrally by `tools/provenance.mjs` across `save`, `render_mix`, `render_stems`, `preview_sound`, `sync_from_lmms`, `export_game_audio`, `export_midi`, and `export_one_shots`.

- **Allowed sources:**
  - Native pure-synthesis LMMS plugins (`tripleoscillator` waveforms `0..6`, `kicker`, `lb302`, `monstro`, `opl2`, `opulenz`, `organic`, `sfxr`, `watsyn`, `vibedstrings`, `zynaddsubfx`, `bitinvader`, `nes`, `papu`, `sid`, `malletsstk`) and clean factory presets validated by `inspectPresetFile`.
  - Locked CC0-1.0 `.sf2` SoundFonts whose SHA-256 matches `soundfont-lock.json` (`upright-piano-kw`, `meta-guitars`, `virtuosity-drums`, `vsco-orchestra-core`, `upright-bass`, `meta-piano`, `vsco-orchestra-extended`).
  - Workspace audio files inside `LMMS_WORKSPACE` backed by an intact, SHA-256-matched `<file>.provenance.json` sidecar (`pure-synthesis`, `verified-cc0-sf2`, `hybrid-verified`, or live Mix Desk `user-attested-mic-take`).
- **Forbidden sources:**
  - Third-party loops, unverified WAV/OGG/FLAC files, and `CC-BY` or attribution-encumbered sample libraries.
  - Stock LMMS factory `.ogg`/`.wav` samples (`list_samples` / `factorySample`), `tripleoscillator` user wavefiles (`wavetype="7"` or `userwavefile`), and external plugin hosts (`vestige`, `patman`, `gigplayer`, `carlarack`, `carlapatchbay`).
  - Spoofed `.meta.json` sidecars: `tag_sound` writes descriptive library tags only and is ignored by provenance verification.

---

## 5. Repository Engineering & Verification Rules

When modifying code, scripts, or documentation in this repository:

- **Stdio discipline:** `server.mjs` communicates over MCP stdio (`stdout`). Never write logs or debug text to `stdout` (`console.log`) from server or tool modules; use `createLogger` from `tools/logger.mjs` (which writes structured JSON to `stderr`).
- **Atomic writes & safe processes:** Use `writeFileAtomic` and `runCommandSafe` from `tools/fs-atomic.mjs` for workspace/config writes and external process execution. Resolve paths through `tools/workspace-config.mjs` (including `ensureLmmsAsciiPath` for Windows non-ASCII user profile paths).
- **Headless verification only:** Run all tests headlessly (`LMMS_NO_GUI_LAUNCH=1` in tests). Never spawn visible GUI windows or headed test browsers during automated checks.
- **Required checks before committing:**
  - `npm test`
  - `node .github\scripts\smoke-server.mjs`
  - `node .github\scripts\check-pack.mjs` (keep `package.json` `files` updated whenever adding or renaming shipped files)
