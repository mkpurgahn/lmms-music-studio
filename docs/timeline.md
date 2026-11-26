# Timeline page

`build_timeline_page` writes one HTML page that shows a song the way a DAW would, for a person to listen to and comment on. It is a viewer: nothing in the project is changed from it.

## What it shows

- **Lanes.** Every WAV in a `render_stems` folder is a lane with its waveform. Lanes are ordered by the number at the start of the stem's file name and coloured by family: drums, bass, harmony, lead and texture. The family comes from the track's role when you pass `project`, otherwise from the lane name.
- **Bar ruler** across the top, from the `bpm` you give.
- **Sections** as blocks. Click one to jump to it, double-click to loop it.
- **DJ effects** as blocks, when you pass the same `effects` list that went to `dj_effects`.
- **The finished mix** as the top lane, when you pass `mix`.

## What the listener can do

- Play, pause and click anywhere to move the playhead. The left and right arrow keys move one bar.
- Mute, solo and set the volume of each lane.
- Switch between the stems and the finished mix with one button.
- Loop a section.
- Pin a note to the bar under the playhead with "Add note here" (or `n`), then click **Send Feedback to Studio** (which saves `<session>-feedback.json` directly to the workspace over the hardened Studio loopback server), **Save feedback**, or **Copy notes**. Both Timeline and Audition emit Unified Feedback v2 (`lmms-mcp/audition-feedback`, `version: 2`) recording both 0-based `bar` (for MCP tools) and 1-based `displayBar` (`bar + 1`), `beat`, `seconds`, `soloedLanes`, `mutedLanes`, `projectFile`, and `projectSha256`.
- Click **Open in LMMS** (or call `open_in_lmms` / `sync_from_lmms`) when a workspace `project` is linked to inspect or edit in Desktop LMMS with provenance verification and clobber protection.

## Example

```json
{
  "stems": "song-stems", "mix": "song-club.wav", "project": "song-bal.mmp",
  "title": "Song", "output": "song-timeline.html",
  "sections": [{ "name": "intro", "startBar": 0, "bars": 4 }, { "name": "drop", "startBar": 4, "bars": 8 }],
  "effects": [{ "type": "filter_sweep", "startBar": 0, "bars": 4, "filter": "lowpass" }]
}
```

When `project` is supplied, static `bpm` and `timeSignature` are derived automatically from `songInfo(doc)` (projects with dynamic `<bpm>` tempo automation are rejected clearly). `build_timeline_page` also auto-attaches or auto-spawns the Studio server on `127.0.0.1:18290..18299` (unless `LMMS_AUTO_SERVER=0`) and returns `studioUrl: "http://127.0.0.1:<port>/studio/timeline?session=<id>"`.

The library page links each of the listener's tracks to its timeline when a file named `<track>-timeline.html` exists in the workspace.

## Audio engine and limits

- Stems are isolated pre-master tracks (`"Stems (isolated pre-master tracks)"`), whereas toggling Master Mix plays `"Master Mix (authoritative post-master output)"`.
- Every loaded lane is scheduled on whole sample frames on a single shared WebAudio `AudioContext` (`AudioBufferSourceNode` + smooth `GainNode` faders), eliminating inter-stem drift.
- Decoded `AudioBuffer` RAM is bounded by a **512 MiB** budget (`MAX_DECODED_BYTES = 512 * 1024 * 1024`). Songs whose stems exceed 512 MiB keep excess stems lazy (`loaded: false`) and decode them on demand when soloed or unmuted, evicting muted stems in LRU order.
- Up to 64 lanes, and each WAV file up to 256 MiB.
