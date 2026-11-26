---
name: lmms-music-studio
description: Use when producing, composing, arranging, mixing, auditing, or exporting songs, stems, or game audio with the LMMS Music Studio MCP server, translating listener ear feedback into musical or DSP edits, running loudness-matched A/B mix comparisons, or syncing edits with Desktop LMMS.
---

# LMMS Music Studio Producer Skill

## Overview

Operate stock LMMS 1.2.2 as an ear-directed, copyright-verified studio through the LMMS Music Studio MCP server. Every composition lives in an editable `.mmp` or `.mmpz` project with deterministic CC0-1.0 acoustic SoundFonts, native synthesis, measured audio analysis, browser stem review, and two-way Desktop LMMS sync.

## Producer Loop (Execute in Order)

1. **Discover setup and listener taste.** Call `get_started` and `get_taste` before composing or mixing. Call `list_sf2_presets` to inspect installed CC0-1.0 `.sf2` banks and patches, `list_drum_kits` for drum kits, and `search_sounds` for concert-tuned native synth presets.
2. **Compose with clean roles and motif development.**
   - One beat is `48` ticks, one 4/4 bar is `192` ticks, and project `bar` indices start at `0` (Studio UI displays 1-based `Display Bar = bar + 1`).
   - Declare `role` on every track (`drums`, `bass`, `harmony`, `lead`, `counter`, `texture`, `fx`). Keep at most one active `lead` and one `counter` at a time, and keep `bass` and `harmony` below the lead register.
   - Use `voice: "sf2"` with `sf2`, `bank`, and `patch` for acoustic instruments (`bank: 0` melodic, `bank: 128` GM drums such as `virtuosity-drums.sf2`), `kick`/`snare`/`hat`/`clap` or `create_drum_kit` (`tight-synth`, `house-synth`, `electro-synth`, `808-synth`, `acoustic-cc0`) for drums, and `pluck`/`bass`/`pad`/`preset` for synthesis.
   - Start from `create_project` or `create_from_blueprint` (always pass your own original `motif` and `progression` in strict mode). Vary sections with `develop_motif`, `write_melody`, `write_accompaniment`, `shape_performance`, and `replace_pattern`.
3. **Lint and balance before rendering.** Run `lint_arrangement` and fix every arrangement error (clashes, competing leads, register collisions). Apply mix passes with `apply_edits` and `auto_balance`.
4. **Render aligned stems and master.**
   - For full songs with natural endings, pass `tail: "ring"` (and optional `ringSeconds`, default `5`) to BOTH `render_stems` and `render_mix` so decay rings down to `-72 dBFS` (`+0.15 s` fade) with sample-exact frame alignment across every stem and master.
   - For seamless game loops, pass `tail: "wrap"` (or use `export_game_audio`) to fold reverb and delay tails across the loop seam.
5. **Verify metrics and provenance before human review.** Run `analyze_audio` (check LUFS, true peak, `clippedSamples === 0`, `stereoCorrelation >= 0.2`, 6-band balance, and bar energy) and `audit_copyright` (`compliant === true`).
6. **Publish to Browser Studio and iterate by ear.**
   - Multi-track review: call `build_timeline_page` (`stems`, `mix`, `project`, `sections`) and give the listener the plain `studioUrl` (`http://127.0.0.1:<port>/studio/timeline?session=<id>`).
   - Revision comparison: call `build_audition_page` with `files: [beforeWav, afterWav]` and `project` for loudness-matched A/B switching, and give the listener the plain `studioUrl` (`http://127.0.0.1:<port>/studio/audition?session=<id>`).
   - After the listener clicks `Send Feedback to Studio`, call `read_feedback` to apply Unified Feedback v2 bar-pinned notes (`bar`, `displayBar`, `beat`, soloed/muted lanes heard, section ratings, weakest section) and call `remember_taste` for lasting preferences.

## Ear-Directed Producer Protocol

Translate subjective listener complaints directly into concrete musical and DSP tool calls:

| Listener Complaint | Concrete Musical / DSP Action |
| --- | --- |
| "Too muddy" / "boomy low end" | Check `sub`, `bass`, and `lowMid` bands in `analyze_audio`. Raise chord/pad voicings out of the bass octave (`replace_pattern` with `octave: 4`), trim heavy low-mid tracks with `set_track_mix` or `auto_balance`, reduce `bassbooster` or `reverb` `size`/`wet` via `edit_effect`, add `eq`/`crossovereq` via `edit_effect` (or highpass filter via `automate_track` `cutoff`), and re-render. |
| "Melody feels repetitive" / "loop gets boring" | Call `develop_motif` (`sequence`, `inversion`, `fragment`, `extension`, `cadence`) and `replace_pattern` on later bars so phrases state, vary, and leave rests, or generate a multi-bar arc with `write_melody`. |
| "Drums feel stiff" / "robotic" | Apply swing and micro-timing with `apply_groove` (`mpc-swing-60`, `house-shuffle`, `ukg-shuffle`), `humanize`, `add_ghost_notes`, and `add_fills` (or pattern `swing` and `humanize`), and run `shape_performance` once on piano, guitar, or solo tracks. |
| "Piano is buried" / "lead gets lost" | Run `lint_arrangement` for `register.overlap` or competing melodies. Thin dense accompaniment on strong beats, pan supporting harmony left/right (`set_track_mix` `pan: -20` / `20`), set `set_track_role`, and rebalance with `auto_balance` or `set_track_mix`. |
| "Ending cuts off abruptly" / "reverb chops off" | Render both `render_stems` and `render_mix` with `tail: "ring"` (increase `ringSeconds` up to `20` for long orchestral halls or piano sustain) instead of `tail: "cut"`. Use `tail: "wrap"` only for seamless loops. |
| "Too harsh" / "piercing highs" | Darken `reverb` `dampingHz` via `edit_effect`, lower synth filter `cutoff` via `automate_track`, lower `fatten` `tiltDb`, or reduce upper-register note velocities. |
| "Clashing notes" / "sounds off-key" | Run `lint_arrangement` to pinpoint exact 0-based clash bars and tracks, then snap pitches with `scale_lock` or rewrite offending bars with `replace_pattern`. |

## Two-Way Desktop LMMS Safety

- Opening a project via `open_in_lmms` (or the Browser Studio `Open in LMMS` button) records its SHA-256 baseline in `.studio-lmms-sync.json`.
- Any MCP write (`apply_edits`, `replace_pattern`, `add_track`, `save_project_copy`) fails closed if the `.mmp` or a sibling `.mmpz` was modified in Desktop LMMS after `open_in_lmms`.
- **Mandatory rule:** Before mutating any project opened in Desktop LMMS, call `sync_from_lmms({ project })` first. It adopts user saves (including sibling `.mmpz` exports), re-verifies copyright provenance, updates `<project>.provenance.json`, and returns the updated track summary.

## Strict Copyright & Provenance Invariants

`LMMS_STRICT_COPYRIGHT=1` is active by default and fails closed on every save, render, sync, and export:

- **Use only:**
  1. Native pure-synthesis voices (`pluck`, `bass`, `pad`, `kick`, `snare`, `hat`, `clap`), synthesized drum kits (`tight-synth`, `house-synth`, `electro-synth`, `808-synth`), 16 pure-synth LMMS plugins, and clean factory `.xpf`/`.xiz` presets returned by `search_sounds`.
  2. Locked CC0-1.0 `.sf2` SoundFonts verified by SHA-256 against `soundfont-lock.json` (`upright-piano-kw.sf2`, `meta-guitars.sf2`, `virtuosity-drums.sf2`, `vsco-orchestra-core.sf2`, plus optional `install_soundfont_pack` packs `upright-bass`, `meta-piano`, `vsco-extended`).
  3. Workspace audio files with valid hash-bound `<file>.provenance.json` sidecars (MCP renders or live Mix Desk recordings classified as `user-attested-mic-take`).
- **Never attempt to use:** third-party loops, unverified workspace WAV/OGG/FLAC files, CC-BY or attribution-encumbered assets, stock LMMS factory `.ogg`/`.wav` samples (`list_samples` / `factorySample`), `tripleoscillator` user wavefiles (`wavetype=7`), or external plugin hosts (`vestige`, `patman`, `gigplayer`, `carlarack`, `carlapatchbay`). Descriptive `.meta.json` files from `tag_sound` never grant provenance.

## Red Flags - Stop and Correct Immediately

- Asking the listener to judge a single raw WAV path instead of building a `build_timeline_page` or loudness-matched `build_audition_page` session and sharing `studioUrl`.
- Running `apply_edits` on a project opened in Desktop LMMS without calling `sync_from_lmms` first.
- Rendering a non-looping song with `tail: "cut"` so final piano, string, or reverb notes chop off abruptly.
- Attempting to bypass `LMMS_STRICT_COPYRIGHT=1` or load unverified audio files.
