---
name: make-music
description: Use when the user invokes /make-music or asks to make, produce, compose, arrange, mix, fix, or revise music, beats, songs, loops, or soundtracks on Windows, especially when directing by ear without music theory or DAW terminology.
---

# Make Music (Ear-Directed LMMS Studio)

Turn plain-English moods and listener ear feedback into copyright-verified songs, live WebAudio stem/A-B players, and editable Desktop LMMS projects via `F:\projects\lmms-music-studio` (`mkpurgahn/lmms-music-studio`)—no music theory or DAW terms required.

**Violating the letter of these rules is violating the spirit of these rules.**

## Phase 1: Jargon-Free Intake (New Songs)

1. State in 1 declarative sentence what the prompt already sets (never ask plain-text questions).
2. Ask missing Slots 1–4 in order, **one `ask_user` call per slot** (`(Recommended)` first). Never bundle questions, ask BPM/bars/keys/stems, or use `"Provide X"` choices. In autopilot mode or when told `"surprise me"` / `"pick for me"`, pick cohesive defaults and build immediately.

| Slot | Decision | `ask_user` Choices |
|---|---|---|
| 1 | Vibe | `Chill & atmospheric (rainy night, menu, focus) (Recommended)`, `Warm, emotional, or cinematic`, `Upbeat, driving, or energetic`, `Dark, tense, or mysterious` |
| 2 | Sounds | `Mix of real instruments + synths (Recommended)`, `Mostly real instruments (piano, strings, guitar, real drums)`, `Pure electronic & synths` |
| 3 | Pace | `Medium steady groove (Recommended)`, `Slow & spacious`, `Fast & high-energy` |
| 4 | Format | `Complete piece with a natural fade/ring-out ending (Recommended)`, `Seamless background loop` |

## Phase 2: Routing & Build

- **No `get_started` MCP tool here (General Chat / Coordinator):** Finish Phase 1 here, find `lmms-music-studio` via `list_repositories`, and call `create_session` (`project_id`, `workspace_type: "branch"`, `coordinate_with_creator: true`, `notify_on_idle: "once"`, `kickoff: { mode: "autopilot", prompt: "<Slot 1-4 brief; invoke make-music skill and return studioUrl, project, and mix>" }`). When that child reports back, run Phase 3 Steps 3–4 here and send follow-ups via `send_session_message({ session_id, mode: "autopilot", message })`.
- **`get_started` MCP tool present:** Read `producer-tool-reference.md` in this skill directory for schemas, `-v1`/`-v2` naming, CC0 `.sf2` banks, and ear-to-DSP fixes.
  1. If opened in Desktop LMMS, call `sync_from_lmms({ project })` before editing.
  2. First run: call `get_started`, `get_taste`, and `list_sf2_presets`.
  3. Use plain workspace filenames (`<slug>-v1.mmp`, `<slug>-v2.wav`—no paths; 4-bar section clips).
  4. Run `lint_arrangement`, render `render_stems` + `render_mix` (`tail: "ring"` for songs, `"wrap"` for loops), and verify `analyze_audio` (`clippedSamples === 0`) and `audit_copyright` (`compliant === true`).

## Phase 3: Player Launch & Iteration

1. **New song:** `build_timeline_page` (`stems`, `mix`, `project`, `sections`, `output`, `overwrite: true`).
2. **Revision:** `build_audition_page` (`files: ["<slug>-v1.wav", "<slug>-v2.wav"]`, `project: "<slug>-v2.mmp"`, `output: "<slug>-ab.html"`, `overwrite: true`).
3. Call `open_canvas` (`canvasId: "browser"`, `instanceId: "music-studio-player"`, `input: { url: studioUrl, title: "<Title>" }`) AND print plain `studioUrl` (no `[label](url)`).
4. Summarize changes in listener words (no LUFS/dBTP dumps, no plain-text questions). In interactive mode, call `ask_user` (`question: "How does this version sound to your ear?"`, `choices: ["I pinned notes in Studio Player — apply my feedback", "Sounds muddy, boxy, or cluttered — clean up the mix", "Feels flat or repetitive — add movement and energy", "Good direction — make it longer or open in Desktop LMMS"]`).

## Rationalizations Rejected

| Excuse | Reality |
|---|---|
| "No MCP tools here—tell user to switch sessions" | Finish Phase 1 here, then call `create_session` (`workspace_type: "branch"`). |
| "Ask vibe in text or ask BPM/key/bars" | Ask Slots 1–4 one-by-one via `ask_user` in listener words. |
| "Use full paths or overwrite `song-v1.mmp`" | MCP tools reject paths and require `-v2` increments. |
| "Just paste `studioUrl`" | Open `studioUrl` in `open_canvas` (`browser`) AND print the plain URL. |

## Red Flags - STOP

- Plain-text questions, bundled questions, or asking for BPM, bars, keys, or stem flags
- Asking the user to switch sessions, or omitting `workspace_type: "branch"` on `create_session`
- Passing full paths to MCP tools or editing a Desktop-opened project before `sync_from_lmms`
- Returning a raw WAV or bare URL without opening `studioUrl` in `open_canvas` (`browser`)
