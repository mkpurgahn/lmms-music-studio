# Producer Tool Reference (`lmms-music-studio`)

## 1. Workspace Filenames & Revision Naming (Mandatory)

All `lmms-music-studio` MCP tools take **workspace-relative plain filenames**—NEVER absolute paths (`C:\...` or `F:\...` will fail schema validation!).
Because project and WAV writes fail closed (`wx`) if a file already exists, always increment version suffixes:
- Version 1: `project: "rainy-night-v1.mmp"`, `mix: "rainy-night-v1.wav"`, `stems: "rainy-night-v1-stems"`
- Version 2: `project: "rainy-night-v2.mmp"`, `mix: "rainy-night-v2.wav"`, `stems: "rainy-night-v2-stems"`
- HTML / Studio pages (`build_timeline_page`, `build_audition_page`) accept `overwrite: true`.

To discover existing files in an ongoing session when filenames aren't in context, inspect the workspace directory returned by `get_started` (`workspace` field) or check `list_sf2_presets` / `get_taste`.

---

## 2. Translating Plain-English Intake Slots Into Musical Parameters

| Intake Choice | Internal Studio Mapping |
|---|---|
| `Chill & atmospheric` | Minor / Dorian / Maj7 chords (`Dm9 Am7 Bbmaj7 C6` or `Em7 Bm7 Cmaj7 D6`), 8 bars, gentle dynamics, warm pad + reverb |
| `Warm, emotional, or cinematic` | Aeolian / Lydian / Major add9 (`Am F C G` or `Cm Ab Eb Bb`), 8-12 bars, expressive piano + strings swell |
| `Upbeat, driving, or energetic` | Punchy progression (`Fm Db Ab Eb` or `Am G F E7`), 8 bars, active 16th groove, crisp bass + drums |
| `Dark, tense, or mysterious` | Phrygian / Harmonic minor (`Dm Eb Gm A7` or `Cm Db Fm G7`), sparse low-register bass, tension motifs |
| `Slow & spacious` | `72-84` BPM |
| `Medium steady groove` | `94-108` BPM |
| `Fast & high-energy` | `124-138` BPM |
| `Complete piece with a natural fade/ring-out ending` | Pass `tail: "ring"`, `ringSeconds: 5` to BOTH `render_stems` and `render_mix` |
| `Seamless background loop` | Pass `tail: "wrap"` to BOTH `render_stems` and `render_mix` (or use `export_game_audio`) |

---

## 3. Verified CC0-1.0 Acoustic SoundFont Banks (`voice: "sf2"`)

Call `list_sf2_presets` first to confirm installed banks. Core CC0-1.0 pack:

| Instrument Sound | `sf2` | `bank` | `patch` | Notes |
|---|---|---|---|---|
| Kawai Upright Piano | `"upright-piano-kw.sf2"` | `0` | `0` | Warm acoustic piano |
| Nylon Acoustic Guitar | `"meta-guitars.sf2"` | `0` | `0` | Fingerpicked chords/arpeggios |
| Steel Acoustic Guitar | `"meta-guitars.sf2"` | `0` | `1` | Bright acoustic strum/lead |
| Violin Ensemble Sustain | `"vsco-orchestra-core.sf2"` | `0` | `0` | Lush orchestral strings |
| Contrabass Sustain | `"vsco-orchestra-core.sf2"` | `0` | `1` | Bowed orchestral low end |
| French Horn Sustain | `"vsco-orchestra-core.sf2"` | `0` | `2` | Cinematic warm brass |
| Flute | `"vsco-orchestra-core.sf2"` | `0` | `3` | Woodwind melody/counter |
| Concert Harp | `"vsco-orchestra-core.sf2"` | `0` | `4` | Plucks and arpeggios |
| Orchestral Timpani | `"vsco-orchestra-core.sf2"` | `0` | `5` | Cinematic low hits |
| Acoustic Drum Kit | `"virtuosity-drums.sf2"` | `128` | `0` | GM MIDI: Kick `36`, Snare `38`, Closed Hat `42`, Open Hat `46` (chokes!), Crash `49`, Ride `51` |

Pure-synthesis voices (`voice`): `"pluck"`, `"bass"`, `"pad"`, `"kick"`, `"snare"`, `"hat"`, `"clap"`, or `"preset"` (from `search_sounds`).
Drum kits (`create_drum_kit`): `"tight-synth"`, `"house-synth"`, `"electro-synth"`, `"808-synth"`, `"acoustic-cc0"`.

**Strict Copyright Rule (`LMMS_STRICT_COPYRIGHT=1`):** Never pass `factorySample` (`drums/*.ogg`), unverified WAVs, or `tag_sound({ licence: "own-recording" })`. Only native synths, locked CC0 `.sf2` banks, and MCP/Mix-Desk `.provenance.json`-verified WAVs are permitted.

---

## 4. Exact Core MCP Tool Call Signatures

### Setup & Desktop Sync
```json
{"tool": "get_started", "arguments": {}}
{"tool": "get_taste", "arguments": {}}
{"tool": "list_sf2_presets", "arguments": {}}
{"tool": "sync_from_lmms", "arguments": {"project": "rainy-night-v1.mmp"}}
{"tool": "open_in_lmms", "arguments": {"project": "rainy-night-v2.mmp"}}
```

### Create Project (1 bar = 192 ticks, 1 beat = 48 ticks, `bar` is 0-based)
**Section-pattern rule:** Author separate 4-bar patterns per section (`bar: 0, bars: 4` for Intro, `bar: 4, bars: 4` for Main) rather than one giant song-long clip, so `replace_pattern` can revise individual sections cleanly!
```json
{
  "tool": "create_project",
  "arguments": {
    "output": "rainy-night-v1.mmp",
    "bpm": 96,
    "lengthBars": 8,
    "tracks": [
      {
        "name": "Piano",
        "voice": "sf2",
        "sf2": "upright-piano-kw.sf2",
        "bank": 0,
        "patch": 0,
        "role": "harmony",
        "volume": 95,
        "pan": -12,
        "patterns": [
          {"name": "Intro Chords", "bar": 0, "bars": 4, "chords": {"progression": "Dm9 Am7 Bbmaj7 C6", "style": "arp", "order": "updown", "rate": 2, "octave": 4, "voiceLead": true}},
          {"name": "Main Chords", "bar": 4, "bars": 4, "chords": {"progression": "Dm9 Am7 Bbmaj7 C6", "style": "pulse", "octave": 4, "voiceLead": true}}
        ]
      },
      {
        "name": "Strings",
        "voice": "sf2",
        "sf2": "vsco-orchestra-core.sf2",
        "bank": 0,
        "patch": 0,
        "role": "lead",
        "volume": 88,
        "pan": 12,
        "patterns": [
          {"name": "Intro Theme", "bar": 0, "bars": 4, "melody": {"line": "A4:6 F4:2 D5:8 | C5:6 A4:2 G4:6 r:2"}},
          {"name": "Main Theme", "bar": 4, "bars": 4, "melody": {"line": "D5:4 F5:4 E5:6 C5:2 | D5:8 A4:6 r:2"}}
        ]
      },
      {
        "name": "Sub Bass",
        "voice": "bass",
        "role": "bass",
        "volume": 82,
        "pan": 0,
        "patterns": [
          {"name": "Intro Bass", "bar": 0, "bars": 4, "chords": {"progression": "Dm Am Bb C", "style": "bass", "figure": "whole", "octave": 2}},
          {"name": "Main Bass", "bar": 4, "bars": 4, "chords": {"progression": "Dm Am Bb C", "style": "bass", "figure": "syncopated", "octave": 2}}
        ]
      },
      {
        "name": "Kick",
        "voice": "sf2",
        "sf2": "virtuosity-drums.sf2",
        "bank": 128,
        "patch": 0,
        "role": "drums",
        "volume": 96,
        "patterns": [
          {"name": "Intro Kick", "bar": 0, "bars": 4, "steps": {"grid": "X-------X-------", "midi": 36, "length": 36}},
          {"name": "Main Kick", "bar": 4, "bars": 4, "steps": {"grid": "X---x---X---x-o-", "midi": 36, "length": 36, "swing": 0.12}}
        ]
      }
    ]
  }
}
```

### Inspect & Revise (`inspect_arrangement` + `apply_edits`)
Always call `inspect_arrangement` first before revising so you know exact `tracks[].name` and each pattern clip's 0-based start `bar` (`pos / 192` — `replace_pattern` requires an existing clip starting at `pattern.bar`!).
```json
{"tool": "inspect_arrangement", "arguments": {"project": "rainy-night-v1.mmp"}}
```
`apply_edits` applies multiple edits atomically and writes a new `-vN.mmp` file. Every entry in `edits` has `{ "op": "<editToolName>", "args": { ... } }`:
```json
{
  "tool": "apply_edits",
  "arguments": {
    "project": "rainy-night-v1.mmp",
    "output": "rainy-night-v2.mmp",
    "edits": [
      {
        "op": "set_track_mix",
        "args": {"trackName": "Piano", "volume": 90, "pan": -22}
      },
      {
        "op": "set_track_mix",
        "args": {"trackName": "Strings", "volume": 94, "pan": 22}
      },
      {
        "op": "edit_effect",
        "args": {"trackName": "Strings", "operation": "add", "plugin": "stereo", "wet": 0.45, "params": {"width": 85}}
      },
      {
        "op": "edit_effect",
        "args": {"trackName": "Piano", "operation": "add", "plugin": "reverb", "wet": 0.18, "params": {"size": 0.65, "dampingHz": 8500}}
      },
      {
        "op": "replace_pattern",
        "args": {
          "trackName": "Strings",
          "pattern": {"name": "Main Theme Lifted", "bar": 4, "bars": 4, "melody": {"line": "F5:3 G5:3 A5:6 E5:4 | F5:4 D5:4 C5:6 r:2"}}
        }
      },
      {
        "op": "automate_track",
        "args": {
          "trackName": "Sub Bass",
          "name": "Middle Filter Open",
          "control": "cutoff",
          "startTick": 768,
          "length": 768,
          "curve": "smooth",
          "points": [{"tick": 0, "value": 650}, {"tick": 384, "value": 1650}, {"tick": 767, "value": 900}]
        }
      },
      {
        "op": "shape_performance",
        "args": {"tracks": ["Piano", "Strings"], "dynamics": 0.25, "voicing": 0.15, "humanize": 0.04, "rubato": 0, "finalRitardando": 0, "pedal": "halfbar"}
      }
    ]
  }
}
```
Note: Keep `rubato: 0` and `finalRitardando: 0` on `shape_performance` whenever drums or bar-grid timeline sync must stay on a constant tempo grid.

### Verified `edit_effect` Plugins & Parameters (`effects.mjs`)
- `reverb`: `params: { size: 0..0.99, dampingHz: 100..15000, inputGainDb: -60..15, outputGainDb: -60..15 }`, plus `wet: 0..1`
- `delay`: `params: { time: "1/8d" | "1/4" | "1/8" | seconds(0.01..5), feedback: 0..0.95, outputGainDb: -60..20 }`, plus `wet: 0..1`
- `compressor`: `params: { thresholdDb: -30..0, ratio: 1..20, attackMs: 1.5..400, releaseMs: 2..800, kneeDb: 1..10, makeupDb: 0..24 }`
- `limiter`: `params: { ceilingDb: -20..0, inputGainDb: -20..20, releaseSeconds: 0.01..2 }` (great on `bus: "Master"`)
- `stereo`: `params: { width: 0..180 }`, plus `wet: 0..1`
- `bassbooster`: `params: { frequencyHz: 50..200, gain: 0.1..5, ratio: 0.1..10 }`
- `amplifier`: `params: { volume: 0..200, pan: -100..100 }`
- `eq` / `crossovereq`: flat defaults only (`params: {}` — do not pass custom param keys to `eq` or `crossovereq`; to clear mud/boxiness in MCP, shift chord octaves up, thin dense notes, pan wide, reduce `reverb` `size`/`wet` or `bassbooster`, and shape synth `cutoff` via `automate_track`, or run `auto_balance`).

### Open Browser Canvas & Prompt Listener Reaction (Runtime Tools)
```json
{
  "tool": "open_canvas",
  "arguments": {
    "canvasId": "browser",
    "instanceId": "music-studio-player",
    "input": {"url": "http://127.0.0.1:18290/studio/audition?session=rainy-night-ab", "title": "Rainy Night: v1 vs v2"}
  }
}
```
```json
{
  "tool": "ask_user",
  "arguments": {
    "question": "Have a listen in the Studio Player panel (hit Play, or switch between versions/tracks). How does it sound to your ear?",
    "choices": [
      "I pinned notes in Studio Player — apply my feedback",
      "Sounds muddy, boxy, or cluttered — clean up the mix",
      "Feels flat or repetitive — add movement and energy",
      "Good direction — make it longer or open in Desktop LMMS"
    ]
  }
}
```

### Lint, Render, Measure, & Audit
```json
{"tool": "lint_arrangement", "arguments": {"project": "rainy-night-v1.mmp"}}
{"tool": "render_stems", "arguments": {"project": "rainy-night-v1.mmp", "outputDirectory": "rainy-night-v1-stems", "tail": "ring", "ringSeconds": 5}}
{"tool": "render_mix", "arguments": {"project": "rainy-night-v1.mmp", "output": "rainy-night-v1.wav", "tail": "ring", "ringSeconds": 5, "targetLufs": -16}}
{"tool": "analyze_audio", "arguments": {"audio": "rainy-night-v1.wav", "bpm": 96, "sections": [{"name": "Intro", "startBar": 0, "bars": 4}, {"name": "Main", "startBar": 4, "bars": 4}]}}
{"tool": "audit_copyright", "arguments": {"project": "rainy-night-v1.mmp"}}
```

### Build Studio Player Pages & Read Pinned Feedback
```json
{
  "tool": "build_timeline_page",
  "arguments": {
    "stems": "rainy-night-v1-stems",
    "mix": "rainy-night-v1.wav",
    "project": "rainy-night-v1.mmp",
    "title": "Rainy Night (v1)",
    "sections": [{"name": "Intro", "startBar": 0, "bars": 4}, {"name": "Main", "startBar": 4, "bars": 4}],
    "output": "rainy-night-timeline.html",
    "overwrite": true
  }
}
```
```json
{
  "tool": "build_audition_page",
  "arguments": {
    "files": ["rainy-night-v1.wav", "rainy-night-v2.wav"],
    "project": "rainy-night-v2.mmp",
    "title": "Rainy Night: v1 vs v2 (Loudness Matched)",
    "sections": [{"name": "Intro", "startBar": 0, "bars": 4}, {"name": "Main", "startBar": 4, "bars": 4}],
    "output": "rainy-night-ab.html",
    "overwrite": true
  }
}
```
```json
{"tool": "read_feedback", "arguments": {"file": "rainy-night-timeline-feedback.json"}}
```
Note: UI displays 1-based `Display Bar` (`Bar 1`, `Bar 2`...), while `read_feedback` already converts `bar` to 0-based (`0`, `1`...) matching `read_pattern` / `replace_pattern`! Always check `staleProjectRevision` in `read_feedback` output.

---

## 5. Translating Everyday Listener Complaints Into Exact Studio Fixes

Always call `inspect_arrangement` first if you need exact track names, bar counts, or current mixer levels, and write edits to a new `-vN.mmp` file (`apply_edits` takes `{ project: "song-v1.mmp", output: "song-v2.mmp", edits: [...] }`).

| What the Listener Says | Diagnosis (`analyze_audio` / `lint_arrangement`) | Concrete Fix (`apply_edits` / Composition Tools) |
|---|---|---|
| `"Muddy"` / `"boomy"` / `"bass drowns everything"` | High `sub`/`bass`/`lowMid` energy or `register.overlap` | Move chord/pad voicings up (`octave: 4`), lower bass/pad volume (`set_track_mix`) or run `auto_balance`, raise synth filter `cutoff`, reduce `reverb` `wet`/`size` or `bassbooster`. |
| `"Boxy"` / `"muffled"` / `"cluttered in the middle"` | Excess `lowMid` (250-500 Hz) + narrow center panning | Spread harmony/strings left/right (`set_track_mix` `pan: -22` and `+22` + `stereo` `width: 85`), thin overlapping mid-register chord notes on strong beats (`replace_pattern` with `voicing: "open"`), and darken/reduce `reverb` `wet`. |
| `"Lifeless"` / `"flat"` / `"boring in the middle"` | Identical looped pattern + static velocity/levels across middle bars | Find middle bars via `inspect_arrangement`; call `develop_motif` (`sequence`/`inversion`/`extension`) + `replace_pattern`, run `shape_performance` on melodic/chord tracks, add `apply_groove` / `add_fills` on drums, and add a filter/volume swell (`automate_track`). |
| `"Drums sound robotic / stiff / fake"` | Unswung 16th grid at uniform velocity, or dry synth hit | Apply `apply_groove` (`mpc-swing-60` or `house-shuffle`), `add_ghost_notes`, `humanize`, or switch drum voice to `virtuosity-drums.sf2` (`bank: 128, patch: 0`). |
| `"Cheesy"` / `"sounds like a ringtone"` | Dry, unshaped melody with zero room or expression | Swap dry synth to `upright-piano-kw.sf2` / `vsco-orchestra-core.sf2` / `meta-guitars.sf2`, run `shape_performance`, add subtle `reverb` (`wet: 0.18`), and soften harsh highs (`dampingHz` / filter `cutoff`). |
| `"Lead/melody is buried"` | Competing `lead` tracks or loud accompaniment in same octave | Check `lint_arrangement`; keep one `lead`, pan accompaniment wide, lower harmony by 3-5 dB (`set_track_mix`), or run `auto_balance`. |
| `"Ending stops weird / cuts off abruptly"` | Rendered with `tail: "cut"` or short decay | Re-render BOTH `render_stems` and `render_mix` with `tail: "ring"` and `ringSeconds: 5` (up to `12` for long piano/strings). |
| `"Something clashes / sounds out of tune"` | Out-of-scale pitch or dissonant chord collision | Run `lint_arrangement` to find exact clashing 0-based bars/tracks, then apply `scale_lock` or `replace_pattern`. |
