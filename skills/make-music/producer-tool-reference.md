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

Call `list_sf2_presets` first to confirm installed banks, or `install_soundfont_pack({ pack: "all" })` (PowerShell: `.\setup-libraries-windows.ps1 -Pack all`). Every preset below is locked by SHA-256 in `soundfont-lock.json` under `CC0-1.0`.

### Core, Piano, Guitar & Upright Bass Banks (`core`, `upright-bass`, `meta-piano`)

| Instrument Sound | `sf2` | `bank` | `patch` | MIDI Range / Notes |
|---|---|---|---|---|
| Kawai Upright Piano | `"upright-piano-kw.sf2"` | `0` | `0` | `21..108` — Warm acoustic upright piano |
| Meta Acoustic Piano | `"meta-piano.sf2"` | `0` | `0` | `21..108` — Studio concert/acoustic grand piano |
| Nylon Acoustic Guitar | `"meta-guitars.sf2"` | `0` | `0` | `40..88` — Fingerpicked chords and arpeggios |
| Steel Acoustic Guitar | `"meta-guitars.sf2"` | `0` | `1` | `40..88` — Bright acoustic strum and lead |
| Rubner Upright Bass Pizz | `"upright-bass.sf2"` | `0` | `0` | `28..71` — Plucked acoustic double bass |
| Violin Ensemble Sustain | `"vsco-orchestra-core.sf2"` | `0` | `0` | `55..86` — Lush orchestral strings |
| Contrabass Sustain | `"vsco-orchestra-core.sf2"` | `0` | `1` | `24..60` — Bowed orchestral low end (vibrato) |
| French Horn Sustain | `"vsco-orchestra-core.sf2"` | `0` | `2` | `33..77` — Cinematic warm brass |
| Flute Staccato | `"vsco-orchestra-core.sf2"` | `0` | `3` | `60..96` — Crisp woodwind staccato |
| Concert Harp | `"vsco-orchestra-core.sf2"` | `0` | `4` | `24..103` — Orchestral plucks and glissandi |
| Orchestral Timpani | `"vsco-orchestra-core.sf2"` | `0` | `5` | `36..60` — Tuned single timpani strikes |
| Virtuosity Drum Kit GM | `"virtuosity-drums.sf2"` | `128` | `0` | Kick `36`, Snare `38`, Closed Hat `42`, Open Hat `46` (chokes), Crash `49`, Ride `51` |

### VSCO-2-CE Extended Bank (`vsco-orchestra-extended.sf2`, `bank: 0`)

| `patch` | Preset Name | MIDI Range | Character |
|---|---|---|---|
| `0` | Flute Sustain Vibrato | `60..96` | Lyrical solo flute |
| `1` | Clarinet Staccato | `50..90` | Agile woodwind staccato |
| `2` | Cello Ensemble Spiccato | `36..77` | Driving low-string ostinato |
| `3` | Contrabass Spiccato | `24..60` | Heavy bowed bass ostinato |
| `4` | Violin Ensemble Spiccato | `55..86` | Crisp upper-string ostinato |
| `5` | Violin Ensemble Tremolo | `55..86` | Suspense high-string shimmer |
| `6` | Viola Ensemble Tremolo | `48..86` | Dark mid-register cluster tremolo |
| `7` | Trumpet Staccato | `52..84` | Heroic or sharp brass stabs |
| `8` | Tuba Staccato | `29..62` | Short sub-brass rhythmic punches |
| `9` | Solo Violin Tremolo | `55..96` | Fragile, tense bridge-edge solo tremolo |
| `10` | Solo Violin Pizzicato | `55..96` | Intimate plucked solo violin |

### VSCO-2-CE Complete Strings (`vsco-strings-complete.sf2`, `bank: 0`)

| `patch` | Preset Name | MIDI Range | Character |
|---|---|---|---|
| `0` | `Contrabass Tremolo` | `24..60` | Subterranean bowed bass shudder |
| `1` | `Contrabass Pizz` | `24..60` | Deep orchestral bass pluck |
| `2` | `Contrabass Non-Vib` | `24..60` | Cold, lifeless horror pedal drone |
| `3` | `Cello Ens Tremolo` | `36..77` | Dark turbulent low-mid tremolo |
| `4` | `Cello Ens Sustain` | `36..77` | Rich expressive cello section |
| `5` | `Cello Ens Quiet` | `36..77` | Ghostly `pp` cello section whisper |
| `6` | `Cello Ens Pizzicato` | `36..77` | Ensemble cello plucks |
| `7` | `Viola Ens Sustain` | `48..86` | Warm dark inner-voice strings |
| `8` | `Viola Ens Quiet` | `48..86` | Hushed `pp` viola section |
| `9` | `Viola Ens Spiccato` | `48..86` | Mid-string rhythmic bowing |
| `10` | `Viola Ens Pizzicato` | `48..86` | Ensemble viola plucks |
| `11` | `Violin Ens Quiet` | `55..86` | Fragile `pp` high-string veil |
| `12` | `Violin Ens Pizz` | `55..86` | Ensemble violin plucks |
| `13` | `Solo Violin Vibrato` | `55..96` | Expressive solo violin lead |
| `14` | `Solo Violin Quiet` | `55..96` | Haunting `pp` solo violin |
| `15` | `Solo Violin Spicc` | `55..96` | Crisp solo violin spiccato |

### VSCO-2-CE Complete Brass (`vsco-brass-complete.sf2`, `bank: 0`)

| `patch` | Preset Name | MIDI Range | Character |
|---|---|---|---|
| `0` | `French Horn Muted` | `46..77` | Stopped/muted horror horn snarl |
| `1` | `French Horn Stacc` | `33..77` | Short horn attacks |
| `2` | `Trombone Sustain` | `34..65` | Noble/menacing tenor trombone |
| `3` | `Trombone Vibrato` | `41..67` | Soloistic vibrato trombone |
| `4` | `Trombone Staccato` | `34..70` | Tight low-brass punches |
| `5` | `Trumpet Sustain` | `52..84` | Pure open concert trumpet |
| `6` | `Trumpet Sus Vibrato` | `52..84` | Expressive vibrato trumpet |
| `7` | `Trumpet Straight Mt` | `58..84` | Razor-sharp straight-mute horror brass |
| `8` | `Trumpet Harmon Mute` | `58..84` | Noir / eerie metallic harmon mute |
| `9` | `Tuba Sustain` | `29..62` | Massive sub-brass foundation |

### VSCO-2-CE Complete Woodwinds (`vsco-winds-complete.sf2`, `bank: 0`)

| `patch` | Preset Name | MIDI Range | Character |
|---|---|---|---|
| `0` | `Bassoon Sustain` | `34..75` | Hollow dark double-reed bass/tenor |
| `1` | `Bassoon Vibrato` | `36..72` | Plaintive solo bassoon |
| `2` | `Bassoon Staccato` | `34..72` | Dry skeletal woodwind pulse |
| `3` | `Clarinet Sustain` | `50..90` | Woody chalumeau-to-clarion sustain |
| `4` | `Oboe Sustain NonVib` | `58..89` | Stark,frozen pastoral/horror reed |
| `5` | `Oboe Sustain Vib` | `58..89` | Singing solo oboe |
| `6` | `Oboe Staccato` | `58..89` | Pointed oboe staccato |
| `7` | `Flute Sus Non-Vib` | `60..96` | Cold breathy non-vibrato flute |
| `8` | `Flute Espressivo` | `60..96` | Swelling expressive vibrato flute |
| `9` | `Piccolo Sustain` | `67..91` | Piercing upper-register wind |
| `10` | `Piccolo Staccato` | `70..94` | Crisp high woodwind sparks |

### VSCO-2-CE Mallets, Bells, Pipe Organ & Upright (`vsco-percussion-keys.sf2`, `bank: 0`)

| `patch` | Preset Name | MIDI Range | Character |
|---|---|---|---|
| `0` | `Timpani Rolls` | `36..60` | Recorded timpani rolls (`vel <= 80` soft, `vel >= 81` crescendo) |
| `1` | `Tubular Bells` | `60..79` | Cathedral / funeral chimes |
| `2` | `Glockenspiel` | `67..96` | Eerie horror music-box bells |
| `3` | `Xylophone` | `55..96` | Skeletal dry wooden mallets |
| `4` | `Concert Marimba` | `41..96` | Warm resonant rosewood bars |
| `5` | `Pipe Organ Loud` | `36..96` | Full gothic cathedral manuals |
| `6` | `Pipe Organ Pedal` | `36..66` | 32-ft shuddering sub-organ pedalboard |
| `7` | `Pipe Organ Quiet` | `36..96` | Hushed chapel flue pipes |
| `8` | `Vintage Upright Pno` | `21..108` | Intimate character upright piano |

### VSCO-2-CE Orchestral & Horror Percussion (`vsco-orch-perc.sf2`, `bank: 128`, `patch: 0`)

| MIDI Note(s) | Orchestral / Horror Instrument | Velocity / Articulation Notes |
|---|---|---|
| `32, 33, 34, 35` | Concert Bass Drum Friction Rubs 1-4 | Superball horror groan on Gran Cassa skin |
| `36` | Concert Bass Drum / Gran Cassa Hit | 7 velocity layers (`pp` rumble to `fff` cannon) |
| `37` | Orchestral Snare Taps | 4 velocity layers (`pp..ff`) |
| `38` | Orchestral Snare Hit (Snares On) | 5 velocity layers (`pp..fff`) |
| `39` | Orchestral Snare Roll (Snares On) | 3 velocity layers; gates cleanly on MIDI note-off |
| `40` | Orchestral Snare Hit (Snares Off) | 4 velocity layers (tom/field-drum tone) |
| `41` | Orchestral Snare Roll (Snares Off) | 3 velocity layers; gates cleanly on MIDI note-off |
| `42` | Gong / Tam-Tam Scrape | 2 velocity layers (`pp` / `mf` metal scrape; non-choking) |
| `46` | Tam-Tam / Large Gong Hit | 4 velocity layers (`p`, `mf`, `f`, `fff`; 8s+ ring; non-choking) |
| `47, 48, 50` | Suspended Cymbal Crescendo Rolls | `47` Short, `48` Medium, `50` Long swell |
| `49` | Piatti / Concert Crash Cymbal | 4 velocity layers (`pp..ff`) |
| `51` | Suspended Cymbal Mallet Hit | 4 velocity layers (`pp..fff`) |
| `53, 54, 55` | Orchestral Tambourine | `53` Shake, `54` Hit, `55` Gated Roll |
| `56` | Cowbell Hit | 4 velocity layers |
| `59` | Suspended Cymbal Stick Hit | 4 velocity layers (`pp..fff`) |
| `60..65` | Quinto (`60,61`), Conga (`62,63`), Tumba (`64,65`) | Tap + 3-velocity Open Hit |
| `67` | Anvil Hit | 3 velocity layers (industrial metallic strike) |
| `68` | Brake Drum Hammer | 3 velocity layers (piercing steel strike) |
| `69, 70, 71` | Orchestral Ratchet | `69` Single Crank, `70` Fast Roll, `71` Slow Roll |
| `72, 75` | Guiro Hit (`72`), Claves Hit (`75`) | Dry wood percussion |
| `76, 77` | Log Drum High (`76`) & Low (`77`) | 3 velocity layers each (hollow wood) |
| `78..81` | Triangles 3-in (`78,79`) & 6-in (`80,81`) | Muted (`78,80`) and Open (`79,81`) |
| `82` | Sleighbells | Metallic cluster shake |
| `83, 84, 85, 86` | Bell Tree Strokes 1-4 | Shimmering metallic glissando cascades |
| `88` | Bowed Metallic Alien FX | 2 velocity layers (`pp` / `ff` horror shriek) |
| `94` | Vibraslap Ring | Skeletal jawbone rattle |
| `101, 102, 103, 104` | Bowed Suspended Cymbal 1-4 | Authentic bowed-cymbal horror screeches |

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

### Physical-Modeled Cinema Horror Sound Design (`render_cinema_fx` / `tools/cinema-fx.mjs`)
Synthesizes 48 kHz stereo zero-DC WAVs with automatic `pure-synthesis` `.provenance.json` sidecars (ready for `voice: "sample"` tracks in `create_project` / `add_track`, or placed directly via `place`):
- `kind: "waterphone"`: 24-36 high-Q stainless-steel modes (`190-4800 Hz`), asymmetric water-slosh bend (`sloshDepthCents`), stick-slip bow friction (`bowPressure`), stereo cavern FDN (`cavernMix`).
- `kind: "heartbeat_arc"`: Physical skin-membrane `lub-dub` (`42-58 Hz` `membraneHz` + subtle `valveClick`) accelerating smoothly from `startBpm` to `endBpm` (`curve: "exponential" | "linear" | "panic"`).
- `kind: "dread_riser"`: Layered 16-voice bowed-metal/sul-ponticello cluster + torsional `baseHz` sub-growl + resonant pipe breath (zero white-noise EDM sweep) building to a razor-clean cutoff (`cutoffTailMs`) at `durationSeconds`.
- `kind: "seismic_impact"`: Concert Gran-Cassa + 24-mode delayed-bloom Tam-Tam (`tamTamLevel`) + `34 Hz` seismic sub boom (`subHz`) with natural dark hall decay (`hallDecay`).

```json
{
  "tool": "render_cinema_fx",
  "arguments": {
    "kind": "waterphone",
    "output": "act1-waterphone-v1.wav",
    "durationSeconds": 8,
    "modeCount": 30,
    "sloshDepthCents": 68,
    "bowPressure": 0.72,
    "seed": 1337
  }
}
```
```json
{
  "tool": "render_cinema_fx",
  "arguments": {
    "kind": "heartbeat_arc",
    "output": "act3-heartbeat-v1.wav",
    "durationSeconds": 16,
    "startBpm": 66,
    "endBpm": 162,
    "curve": "exponential",
    "membraneHz": 48,
    "place": {
      "project": "cathedral-dread-v1.mmp",
      "output": "cathedral-dread-v2.mmp",
      "bar": 16,
      "trackName": "Heartbeat Arc",
      "role": "fx",
      "volume": 92
    }
  }
}
```
Direct CLI fallback (writes to `LMMS_WORKSPACE` + `.provenance.json`):
```powershell
node tools\cinema-fx.mjs --kind dread_riser --output act3-riser-v1.wav --duration 8 --baseHz 46.25 --riseSemitones 13
node tools\cinema-fx.mjs --kind seismic_impact --output act4-impact-v1.wav --duration 6 --subHz 34 --tamTamLevel 0.72
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
