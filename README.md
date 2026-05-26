<div align="center">
  <img src="images/logo-small.png" alt="Silverdaw logo" width="160">

  # Silverdaw

  An open-source Digital Audio Workstation (DAW) for remixing, mashups, and sample-driven music making.
</div>

## Architecture

Silverdaw is a digital audio workstation built with a headless JUCE 8 audio engine and an Electron 31 + Vue 3 UI, linked by a per-session-authenticated localhost WebSocket bridge.

- **Backend** (`backend/`) — A headless C++17 / JUCE 8 binary (`SilverdawBackend`) that owns the
  audio device, mixer, timeline, project `ValueTree` and `UndoManager`. It exposes its state and
  commands over an [IXWebSocket](https://github.com/machinezone/IXWebSocket) server bound to
  `127.0.0.1` and gated by a per-session AUTH token.
- **Frontend** (`frontend/`) — An Electron 31 + Vue 3 (Composition API, `<script setup>`) app
  built with electron-vite. The renderer talks to the bridge directly; the main process owns the
  OS dialogs, native menu, persisted preferences and backend spawn.

```text
+---------------------------+        ws://127.0.0.1:<port>      +-----------------------------+
|  Electron renderer (Vue)  |  <----------------------------->  |  SilverdawBackend (JUCE)    |
|  + Electron main (IPC)    |       text JSON envelopes         |  AudioEngine + ProjectState |
+---------------------------+                                   +-----------------------------+
            ^                                                                    |
            |   bulk data (peaks, future stems) on disk                          |
            +--------------------- %APPDATA%/Silverdaw/peaks/ <------------------+
```

Main picks a free port in `[8765, 8784]` at startup so leftover Silverdaw processes can't lock
new instances out, then hands the value to both the backend (via `--port`) and the renderer
(via a `bridge:getPort` IPC).

Threading invariants:

- **Audio thread**: no allocations, no locks, no exceptions. Mutated state is reached via
  `std::atomic` (master clock, OffsetSource).
- **JUCE message thread**: owns every mutation of `AudioEngine`, `ProjectState`, the project
  `ValueTree`, and the audio source graph. The bridge marshals every incoming envelope onto this
  thread via `juce::MessageManager::callAsync`.
- **IXWebSocket I/O threads**: parse JSON, gate AUTH, then callAsync to the message thread.
- **Peaks worker pool**: `juce::ThreadPool` of 4 workers computes / loads waveform peaks off the
  message thread, writes them to disk in the cache, and emits a small `WAVEFORM_READY` envelope.

## Project layout

```text
backend/                 JUCE audio engine + WebSocket bridge (C++17, CMake)
  src/
    AudioEngine.*        Master transport clock, mixer, per-track audio sources
    BridgeServer.*       IXWebSocket loopback server + AUTH + text-frame broadcast
    Main.cpp             Entry point, message dispatch, PlayheadEmitter, peaks ThreadPool
    PeaksCache.*         Disk-backed peaks cache (%APPDATA%/Silverdaw/peaks/)
    ProjectFile.*        .silverdaw JSON save / load (versioned ValueTree serialisation)
    ProjectState.*       juce::ValueTree wrapper + UndoManager + dirty tracking
    ValueTreeJson.*      Generic juce::ValueTree ↔ juce::var converter (used by ProjectFile)
    Waveform.*           Min/max peak computation
  CMakeLists.txt         FetchContent for JUCE + IXWebSocket
frontend/                Electron + Vue 3 app (TypeScript, electron-vite, pnpm)
  resources/icons/       Multi-resolution .ico + PNG set (consumed by main + renderer)
  src/
    main/                Electron main process (window, menu, IPC, prefs, backend spawn)
    preload/             contextBridge surface exposed as window.silverdaw
    renderer/src/        Vue 3 SPA (Composition API, Pinia, PixiJS, Tailwind v4)
    shared/              Bridge wire-protocol catalogue + runtime guards (also TS-tested)
  electron-builder.yml   Windows NSIS installer config
scripts/                 Dev-shell / build / clang-tidy helpers (PowerShell)
.github/instructions/    Copilot/AI agent guidance per file type
```

## Current status and roadmap

Silverdaw currently supports the core arrangement workflow:

- Import audio into a project-scoped library and drag it onto the timeline.
- Play, pause, seek, move, split, duplicate, cut, copy, paste, trim, delete and colour clips.
  Clip moves and non-linked edge trims snap to the beat grid by default; holding
  `Alt` switches either drag to freeform 1 ms placement.
- Move clips across tracks with grid snapping, source-beat snapping and `Alt` bypass.
- Analyse imported audio for key, BPM, beat positions and variable-tempo status.
- Non-destructive per-clip warp and pitch settings via Rubber Band. Dropped
  clips can auto-match the project tempo, late auto-warp engages after BPM
  analysis if needed, and warped clips show a visible **WARP** badge or
  pending spinner on the timeline.
- Resize any track row by dragging its bottom edge in the track-header column
  (clamped 60..400 px). Reorder tracks by grabbing the 6-dot grip icon next to
  a track name and dragging up or down; an emerald drop indicator shows where
  the track will land. Both are persisted with the project and undoable.
- Edit track gain with the slider or double-click the gain number to type a
  bounded percentage value directly (0..150).
- **End-of-project playback** stops automatically: when the playhead reaches the
  project ruler's end, the renderer sends `TRANSPORT_PAUSE` and parks the playhead
  there. The Play button (and the Spacebar shortcut) is disabled while the
  playhead sits at the end — skip back to the start to re-arm playback.
- **Edit ▸ Crop Project to Last Clip** collapses the project length to the end of
  the latest clip on any track. Manual project-length edits are also clamped so
  the ruler cannot be shortened below the longest clip's effective end.
- Save reusable saved clips to the library from any timeline clip; saved clips are
  grouped under their source file and can be dragged back to the timeline as a clip
  with the same source window. **Linked saved-clips**: clips dropped from a saved-clip
  library tile remember that link; the Clip Editor's **Crop** previews a new window
  inside the dialog only, while **Apply trim** propagates the new window to every
  linked timeline instance in lockstep, unless a collision would result (in which
  case the user is prompted and the edit is rejected). Linked clips show a small
  chain badge in their title strip and are locked against edge-resize on the timeline
  — to free a single instance for per-clip trim use right-click ▸ **Unlink from
  library**. Removing a saved clip from the library is always allowed: every
  dependent timeline clip is silently unlinked first so the audio plays on as an
  independent clip referencing the underlying source file.
- Bake timeline clips or saved-clip library items into new WAV samples with
  **Save as sample…**. The generated file is written under a `Samples` folder
  and added back to the library as a normal audio-file item. Warped clips are
  rendered through Rubber Band so the baked sample matches the current
  tempo/pitch state.
- Inline rename for library items (single-click into the name) and timeline clips
  (double-click the clip title). Renames persist with the project; if the renamed
  clip is saved to the library, the library entry inherits the same name.
- Save and reopen `.silverdaw` projects with tracks, clips (referencing library
  items by id), library catalogue, markers, view state and dirty-state prompts.
- Background autosave + crash recovery: a dirty project is silently snapshotted
  every 30 s (user-configurable in Preferences → Autosave) into
  `%APPDATA%/Silverdaw/autosave/<projectId>/`; on the next launch the Recovery
  dialog offers to restore any project whose autosave is newer than its backing
  file (or whose backing file is missing / was untitled). Restored projects
  always reopen marked dirty so the user is steered to File > Save.
- Recent Projects MRU (up to 10) persisted in `preferences.json`, surfaced as a
  `File > Recent Projects ▸` submenu and as the Start Screen list shown on first
  launch or after File > New on a fresh install.
- Relink a missing source file at the **library item** level — every clip
  referencing that item picks up the new file automatically. The Relink dialog
  groups missing references by file path so the same broken path used by ten
  clips is fixed with a single Locate File click.
- Choose any installed audio output device or stay on the system default;
  hot-swap from the transport bar without leaving the timeline. The selection
  is persisted, removable devices (USB, Bluetooth) fall back to default when
  unplugged, and the saved choice is honoured again as soon as the device
  reappears. Bluetooth output is auto-detected and the visible playhead
  compensates for radio-and-headset latency so it stays in sync with what you
  hear (~250 ms for A2DP, ~400 ms for HFP).
- Package a Windows NSIS installer with the backend, icons, licences and `.silverdaw`
  file association. The backend is statically linked against the MSVC runtime, so
  a clean Windows install does not need a separate Visual C++ Redistributable.
- Undo / redo (Ctrl+Z / Ctrl+Y) any project-mutating edit. Covers
  clip add / move / trim / recolour / rename / delete / relink / rebind, track
  add / remove / rename / gain / **resize / reorder**, library
  add / remove / relink / reanalyse, marker add / move / remove, BPM,
  project length, and project rename. Drag streams (clip move / trim /
  track gain / marker move) coalesce same-target events within 500 ms
  into a single undo step; track resize and reorder commit a single
  step on `pointerup`; everything else gets its own step. View state
  (zoom, scroll, playhead) is intentionally outside the undo stack
  so navigating around doesn't pollute the history. The **Clip Editor
  Crop** workflow keeps a dialog-local undo stack so the user can
  tweak a crop with Ctrl+Z/Y inside the dialog without touching the
  project-level history; only when the user clicks **Apply trim** or
  **Save as new** does the change land in the main undo stack.
  Compound operations like clip split / duplicate currently emit
  multiple undo steps; bundling them is a follow-up.

Playback is always served from the decoded WAV cache; original compressed sources
(MP3, M4A, …) are only used to generate that cache. This keeps the read-ahead
buffer's latency-hiding contract intact at clip boundaries so back-to-back loops
play seamlessly.

The main remaining roadmap areas are region selection on timeline clips, library
search / tags / list view, ffmpeg-backed decoding for unsupported formats,
mixer / effects / automation, mixdown export, stem separation, loop slicing, a
timeline-clip entry point into the Clip Editor (today the editor opens from
library items only), grouping compound operations (split / duplicate) into a
single undo step, and a CI matrix that enforces a coverage floor over the
existing backend and frontend test suites.

## Bridge protocol

The bridge is **text only**. Every envelope is a JSON `{ type, payload }` frame:

```json
{ "type": "TRANSPORT_PLAY" }
{ "type": "CLIP_ADD", "payload": { "trackId": "...", "clipId": "...", "libraryItemId": "...", "positionMs": 0 } }
{ "type": "WAVEFORM_REQUEST", "payload": { "clipId": "..." } }
```

Clips reference their audio via `libraryItemId` — the source file path lives only on the
library item itself. The backend resolves the actual on-disk file (always preferring the
decoded-WAV cache) at the time it loads the clip's audio source.

- `type` is an UPPER_SNAKE_CASE discriminator.
- `payload` is a JSON object or omitted.
- Every connection's first envelope must be
  `{ "type": "AUTH", "payload": { "token": "<hex>" } }` — the renderer fetches the token from
  Electron main (it's a per-session random string passed via `SILVERDAW_BRIDGE_TOKEN` env var on
  backend spawn). Wrong / missing token closes the socket.
- After AUTH succeeds the backend sends `PROJECT_STATE` exactly once (full snapshot: tracks,
  clips, library, markers, file path and project name). The renderer treats it as the canonical
  truth; on a load (`reset=true`) it wipes optimistic local state first, on the connect path it
  merges additively.

**Bulk data goes via disk, never via the socket.** When the backend has fresh waveform peaks
ready it sends a `WAVEFORM_READY { clipId, cachePath, peakCount, peaksPerSecond, sampleRate }`
envelope. The cache file at `cachePath` (under `%APPDATA%/Silverdaw/peaks/`) holds the peaks
themselves; the renderer reads it via main's `peaks:readCacheFile` IPC and parses the 24-byte
header + float32 payload locally. This mirrors how the same architecture treats audio files,
project files, and (future) stems / mixdowns — the WebSocket carries the control plane, the
filesystem carries bulk data. Keeps the IXWebSocket I/O loop on the lightweight text-only path
it was designed for.

The full envelope catalogue lives in
[`frontend/src/shared/bridge-protocol.ts`](frontend/src/shared/bridge-protocol.ts) with TS
discriminated unions and runtime guards. The renderer dispatches inbound messages in
[`frontend/src/renderer/src/lib/bridgeService.ts`](frontend/src/renderer/src/lib/bridgeService.ts);
the backend dispatches in [`backend/src/Main.cpp`](backend/src/Main.cpp)
(`dispatchBridgeMessage`).

## Project state model

`ProjectState` (C++) wraps a `juce::ValueTree`:

```text
PROJECT[name, bpm, projectLengthMs, viewPxPerSecond, viewScrollX, playheadMs]
  TRACK[id, name, gain, heightPx?]
    CLIP[id, libraryItemId, offsetMs, inMs, durationMs, colorIndex?, clipName?,
         warpEnabled?, warpMode?, tempoRatio?, semitones?, cents?, pendingAutoWarp?]
  LIBRARY
     ITEM[id, kind, filePath, fileName?, displayName?, durationMs,
          sampleRate, channelCount, key?, bpm?, beats?, beatAnchorSec?,
          playbackFilePath?, variableTempo?, collapsed?,
          sourceItemId?, sourceClipId?, sourceInMs?, sourceDurationMs?,
          warpEnabled?, warpMode?, tempoRatio?, semitones?, cents?]
  MARKERS
    MARKER[id, positionMs]
```

`CLIP` references the audio it plays via `libraryItemId`; the underlying source file path
lives only on the library item. `offsetMs` is the timeline start, `inMs` is where in the
source file playback begins (≥ 0), and `durationMs` is how long the clip plays for from
that point. Split, duplicate and edge-drag trim all manipulate this window without ever
re-decoding the source — peaks are computed once per file and the renderer windows into
them at draw time. Warp fields are non-destructive: `tempoRatio` pins a ratio when set,
otherwise a warped clip follows `projectBpm / sourceBpm`; pitch is stored as semitone
and cent offsets. `colorIndex` is an optional 0..15 per-clip palette override; when
absent the clip inherits its host track's colour. `clipName` is an optional user-set
display name for the clip (double-click the clip's title strip to rename).

`ITEM.kind` is either `audio-file` (a normal imported source) or `saved-clip` (a
reusable region derived from a timeline clip). Saved-clip items share `filePath` with
their parent audio-file item and carry `sourceItemId` / `sourceClipId` / `sourceInMs` /
`sourceDurationMs` describing the trim window into the source. `displayName` is the
user-facing name shown on library tiles. `collapsed` is a per-source UI flag that hides
the saved-clip sub-list under a parent source. `ITEM.key`, `ITEM.bpm`, `ITEM.beats`,
`ITEM.beatAnchorSec` and `ITEM.variableTempo` hold the BTrack analysis output (see
[Audio analysis](#audio-analysis) below). `ITEM.playbackFilePath` is the on-disk path
of the decoded-WAV cache the audio engine reads from. The durable library fields are
stored once and round-tripped through save/load so a reopened project doesn't have to
re-analyse every imported file. Timeline markers are stored as `MARKER` children with
absolute project positions in milliseconds, round-trip through `PROJECT_STATE`, and
mark the project dirty when added, moved or removed.

Track names are persisted as track properties and round-trip through `PROJECT_STATE`.
Per-track row height (`heightPx`, in CSS pixels, clamped backend-side to 60..400) is
likewise persisted on the `TRACK` node and is undoable in the same project undo
history. Track order is the child order of `TRACK` nodes under `PROJECT` and is
preserved by save/load and by drag-reorder (`juce::ValueTree::moveChild` with the
project's `UndoManager`).
The view-state properties (`viewPxPerSecond`, `viewScrollX`, `playheadMs`) bypass the
dirty-flag listener via a `suppressDirtyTransitions` guard inside their setters — zooming,
scrolling, or moving the playhead doesn't prompt an unsaved-changes dialog. Meaningful
project edits (BPM, project length, marker add/move/remove, clip add/move/remove/rename,
gain changes, library import/remove/rename/relink, etc.) still mark the project dirty as
normal property edits.

The `LIBRARY` sub-tree carries the user's imported-but-not-yet-placed samples *and* every
saved clip so the catalogue survives save / load. Durable library fields are persisted: id,
kind, source path, display file name, display name override, duration, sample rate, channel
count, detected key, cached playback path, BPM, beat positions, beat anchor, variable-tempo
flag, collapse state, saved-clip warp defaults and (for saved clips) the source-window pointers. Cover art, ID3 tags,
waveform peaks and playable bytes are not written into the project file; they are re-fetched
or served from cache on load.

**Save / load** is via `.silverdaw` files — a versioned JSON serialisation. A small outer
object carries `schemaVersion`, `appVersion`, and an ISO `savedAt` timestamp; the `project`
field holds the entire `PROJECT` `ValueTree` mapped through
[`ValueTreeJson`](backend/src/ValueTreeJson.h) (each node becomes
`{ "$type": "TRACK", id: "...", $children: [ … ] }`). Atomic save (write `<file>.tmp` then
rename) and forward-compatible load (unknown keys are ignored). Normal Save / Save As writes
the full project tree. Before leaving a clean project, the renderer sends
`PROJECT_SAVE_VIEW_STATE`; the backend updates only `viewScrollX` and `playheadMs` in the
existing `.silverdaw` file, so view state survives reopen without saving unrelated unsaved
project edits or changing the dirty flag. Logic lives in
[`backend/src/ProjectFile.cpp`](backend/src/ProjectFile.cpp).

**Missing files** — on every `tracksAsJson` / `libraryAsJson` call, the backend resolves
each clip's library item and stat()s the underlying source path. Anything that's gone
gets an `unresolved: true` flag in the `PROJECT_STATE` snapshot. The renderer:

- Draws affected clips in a muted grey fill + red border so they're visibly broken.
- Auto-pops the **RelinkDialog** listing each missing clip with a *Locate file…* button.
  Each successful pick emits `LIBRARY_ITEM_RELINK { itemId, filePath }`; the backend
  updates the library item's filePath, clears its cached WAV path (so the new source
  gets re-decoded) and rebuilds every clip referencing that item against the new file,
  then rebroadcasts `PROJECT_STATE` which clears the `unresolved` flag on each clip.
- Surfaces a single info toast summarising the count.
- Lets the user re-enter the relink flow later via the **Relink…** entry on any
  unresolved clip's right-click menu.

**Dirty tracking** is content-based. `ProjectState` snapshots its `ValueTree` on
construction, after `markClean()` and after `replaceTree()` (load). A
`juce::ValueTree::Listener` fires on every mutation and compares the live tree against
the clean snapshot via `isEquivalentTo`. If they match — for example after a sequence
that nets to zero (add a library item, then remove it) — the project returns to clean.
Otherwise it's dirty. Changes are broadcast as `PROJECT_DIRTY { dirty }` envelopes. The
renderer mirrors it as `projectStore.isDirty`, shows a leading `•` next to the project
name in the title bar when dirty, and intercepts **File → New / Open / Exit** and the
window close button to prompt with **Save / Don't save / Cancel** before discarding
work. When the project is clean, those same leave-project paths silently flush view
state only.

On every connect the backend sends a `PROJECT_STATE` snapshot. The renderer:

- Reconstructs any track / clip / library item the backend knows but it doesn't (e.g. after a
  renderer reload).
- Sends `WAVEFORM_REQUEST` for every clip lacking peaks.
- Re-fetches embedded metadata and technical file metadata via `audio:readMetadata` IPC for
  reconstructed library items. Older projects that predate persisted library duration fall
  back to a renderer decode if metadata cannot provide a duration.
- Restores persisted zoom, horizontal scroll, BPM, project length, playhead position, and
  timeline markers from the snapshot.

`PROJECT_STATE` is purely additive on the connect path — it never deletes optimistic state the
user just created, so a race between an early user action and the snapshot arriving doesn't
lose work. On a load / new-project the same envelope carries `reset: true` and the renderer
wipes its mirror before applying.

Until the first `PROJECT_STATE` arrives, an inline splash inside `index.html` (then the Vue
`StartupScreen` once it mounts) blocks all input so the user can't act on state that
hasn't been reconciled yet. `StartupScreen` is the single boot-and-landing surface — it
mounts at app boot (before the bridge is up) and stays visible until the project becomes
non-empty (file path, tracks, or library items) or the user explicitly dismisses it via
**New Project**. An inline status row walks the boot phases ("Waiting for the backend
to start…", "Connecting to audio engine…", "Scanning audio devices…", "Checking for
recovered projects…") and hides once everything is ready. New / Open / Recent buttons
disable while loading, then enable. On a terminal bridge failure the whole screen
swaps to a focused error view with a single Quit action; project actions are hidden
because they cannot recover the app. A 30-second timeout fires the failure path if the
bridge handshake never completes. The `RecoveryDialog` stacks above the StartupScreen
via z-index when crash-recovery autosaves are available.

## Audio formats

The JUCE backend decodes formats supported by its `AudioFormatManager`: WAV, AIFF, FLAC, Ogg
Vorbis, MP3, and the Windows Media family (WMA / WMV / ASF / WM) via the Windows Media Format
SDK that ships with JUCE.

Other formats (notably **AAC / M4A / MP4**, which JUCE doesn't decode out of the box on
Windows) currently round-trip through the renderer's Web Audio decoder:
`AudioContext.decodeAudioData` decodes the file, the resulting PCM is shipped to main via
`audio:writeTempWav` which writes a 32-bit float WAV into `%TEMP%/silverdaw-transcode-cache/`
(keyed by a hash of source path + sample rate + channel count + length). The cached WAV path
is what goes on the wire as `CLIP_ADD.filePath`.

The relevant code is in
[`audio.ts`](frontend/src/renderer/src/lib/audio.ts),
[`importAudio.ts`](frontend/src/renderer/src/lib/importAudio.ts) and the `audio:writeTempWav`
handler in [`main/index.ts`](frontend/src/main/index.ts).

## Peaks cache

Waveform peaks (mono-mixed `min, max` float32 pairs) are computed once per source
file and persisted under `%APPDATA%/Silverdaw/peaks/<hash>.peaks`. The default
requested resolution is **500 peaks/sec** — enough detail to keep the main
timeline crisp at 600 % zoom without ballooning the cache. Because peak buckets
contain a whole number of source samples, the backend reports the **actual**
peak rate it used in `WAVEFORM_READY`; the renderer uses that rate for
timeline indexing so long clips do not visually drift against beat markers. The
Clip Editor opportunistically requests a higher requested **2000 peaks/sec**
rendering for the item currently on screen via `CLIP_EDITOR_PEAKS_REQUEST` /
`CLIP_EDITOR_PEAKS_READY`; that hi-res cache lives next to the default one on
disk (the cache key uses the requested `peaksPerSecond`) and is held in
renderer memory only while the dialog is open. The cache key is a 64-bit hash of
`(filePath | mtime | size | requestedPeaksPerSecond)` — any change to the file
or requested resolution invalidates the entry automatically. The on-disk format
is a 24-byte header (magic, version, requested peaksPerSecond, peakCount,
sampleRate) followed by `peakCount × 2 × float32` little-endian peak values.
Versioned so a future format change is detected as a miss rather than a
corrupted read; the same layout is what the renderer reads via the
`peaks:readCacheFile` IPC.

The cache survives backend restarts.

## Audio analysis

Every imported audio file is automatically analysed for musical key, tempo and
beat positions. The key and BPM are shown on the library tile. A stable-tempo
file shows a badge such as `124.37 BPM`; a variable-tempo file shows an amber
`~ 124.37 BPM` badge. Beat analysis drives faint vertical beat markers on the
clip waveform and — on the first import into a project — seeds the project
tempo so the timeline grid lines up with the source.

### Key detection

Key detection runs in the renderer immediately after Web Audio decodes the file.
`detectMusicalKey` in [`audio.ts`](frontend/src/renderer/src/lib/audio.ts)
downmixes up to the first 120 seconds, builds a chroma profile with Goertzel
magnitude sampling, and compares that profile against major/minor key templates.
If the top candidate is not clearly ahead of the next candidate, the key is left
unset. Detected keys use display casing such as `Bb minor`, are merged into the
library item's metadata, are shown on the tile and in the info dialog, and are
persisted as `LIBRARY > ITEM.key`.

### BPM and beat detection

- **Library**: [BTrack](https://github.com/adamstark/BTrack) (Stark / Davies / Plumbley,
  Queen Mary University of London) — a causal beat-tracking algorithm with offline
  tempo estimation. GPL-3.0, compatible with Silverdaw's AGPL-3.0 stance. A patched
  copy lives at `backend/third_party/btrack/` — see
  [`PATCHES.md`](backend/third_party/btrack/PATCHES.md) for the two MSVC-compatibility
  changes (the patches are mechanical: `_USE_MATH_DEFINES` for `M_PI` and a handful of
  VLA → `std::vector` substitutions).
- **Resampler**: [libsamplerate](https://github.com/libsndfile/libsamplerate) 0.2.2
  (BSD-2-Clause), pulled in via FetchContent. Used to one-shot convert decoded mono
  audio to BTrack's expected 44.1 kHz.
- **FFT**: [KISS FFT](https://github.com/mborgerding/kissfft) 1.3.0 (BSD), bundled in
  the BTrack vendor copy. No FFTW dependency.

The detector lives in [`backend/src/BpmDetector.cpp`](backend/src/BpmDetector.cpp) and
runs on the same `juce::ThreadPool` that produces peaks — kicked off from both the
`LIBRARY_ADD` and `CLIP_ADD` dispatch handlers (whichever arrives first wins; the
helper `ensureBpmDetection` is idempotent and won't re-analyse a file the library
already has a BPM for). The library tile context menu can also send
`LIBRARY_REANALYSE`, which clears the current tempo/beat fields, recreates the
decoded-WAV cache, and reruns detection from the current source file. Worker thread
→ decode the file via JUCE → downmix to mono → resample to 44.1 kHz with
libsamplerate → feed BTrack frame-by-frame at hop=512 recording every
`beatDueInCurrentFrame()` event. Analysis is capped at the first 60 seconds of audio;
estimates outside `[40, 240]` BPM are dropped as implausible.

The reported BPM is derived from the **median of beat-to-beat intervals** (not from
BTrack's running tempo estimate, which can drift a fraction of a BPM from the
implied beat spacing). This guarantees the project grid we later seed lines up
exactly with the source's beats. A `variableTempo` flag is also computed by
checking the spread of per-beat tempo samples (after a short settling period) — if
it's > 5 % of the mean, the library tile shows the amber `~ BPM` warning badge.

When detection finishes the worker `MessageManager::callAsync`s back to the JUCE
message thread to write `bpm`, `beats`, `beatAnchorSec`, `variableTempo`, and the
decoded playback cache path onto the matching `LIBRARY > ITEM` node and broadcast
`LIBRARY_ITEM_ANALYSIS { itemId, bpm, beatAnchorSec, beats, variableTempo,
playbackFilePath }`. If the project has no other clips on tracks yet AND no other
library item has been analysed, the project BPM is seeded too and a
`PROJECT_BPM_APPLIED { bpm }` envelope is broadcast — the renderer mirrors both
into `libraryStore` and `transportStore`. The seed runs even for variable-tempo
sources (an approximate tempo is more useful than the default 100); the user can
fine-tune from the Transport bar afterwards.

### Beat markers and source-beat snap

The renderer overlays faint white vertical lines on every clip at the source's
detected beats. The markers are **synthesised on a source-global beat grid**
anchored on `beats[0]` and spaced by `60 / sourceBPM`, not on each raw detected
position. This makes them survive a split / duplicate / trim without drifting —
both halves of a split clip share one coordinate system, so the markers stay in
lockstep across the split point.

Drag-snap on a clip with a known source tempo locks onto the same grid: instead
of snapping the clip's left edge to the project sub-beat, it snaps the first
source beat inside the clip's window. With the project BPM seeded to the source
BPM (the common case), every subsequent marker on the clip then lines up exactly
with a project grid sub-beat. Drag with `Alt` for the legacy 1 ms unsnapped
behaviour.

Non-linked edge-trim drags use the same project grid by default, snapping the
dragged edge as the source window changes. Hold `Alt` while trimming for
freeform 1 ms edge placement. Linked saved-clip instances do not expose timeline
edge-resize handles; edit their shared window in the Clip Editor or unlink the
instance first.

### Processing progress panel

A floating panel in the bottom-right shows each in-flight import or reanalysis
job with three sequential stages so the long-tail analysis isn't invisible:

1. **Preparing audio…** — renderer is decoding the file's bytes.
2. **Analysing tempo…** — backend's BTrack job (the long stage on long files).
3. **Analysing beats…** — brief flash while the renderer applies the beat array
   and the markers paint on the clip.
4. **Applying warp…** — shown when a track import is waiting for late
   auto-warp after analysis.

The OS busy cursor stays in its `progress` state through these stages.

## Library panel

The bottom library panel stores imported audio files and saved clips as draggable tiles.
Tiles wrap to the available width and the panel scrolls vertically when there are more
tiles than fit; it does not expose a horizontal scrollbar. Each source tile shows
duration, detected key and detected BPM when those fields are available.

**Saved clips** — right-click a timeline clip and choose **Save clip to library** to
turn its trim window into a reusable library entry. Saved clips are non-destructive
references back into their source file (same audio, same WAV cache, same BPM / key)
and are grouped underneath the source they came from. Each source group has a
disclosure chevron that hides / shows its saved-clip list; the open/closed state
persists with the project. Adding a new saved clip auto-expands the group so the new
clip is immediately visible. Dragging a saved-clip tile onto a track creates a
timeline clip with the same source window and non-destructive warp defaults the
saved clip describes.

**Samples** — right-click a timeline clip or a saved-clip library tile and choose
**Save as sample…** to bake a new WAV. Silverdaw writes the file to
`Samples\<name>-sample-001.wav` under the current project folder, or under the
default project folder when the project has not been saved yet. The numeric
suffix increments for duplicate base names. The baked WAV is added as a normal
audio-file library item; deleting that library item removes the reference from
the project but leaves the WAV file on disk. Warped clips are rendered through
Rubber Band during the bake so the sample sounds like the clip did on the
timeline.

**Renaming** — single-click the name on any library tile (or pick **Rename…** from
the right-click menu) to edit it inline. Saved clips inherit a sensible default name
based on their source and offset; renaming is the same flow.

Double-click a tile to open the **Clip Editor** (see below). To view the read-only
information dialog instead — file details, technical audio details, detected
BPM/beat/key metadata, tag metadata, cover art and which tracks currently use the
library item — pick **Show information** from the tile's right-click context menu.
The right-click context menu also includes **Reanalyse file** (audio-file items
only), which refreshes the decoded cache, BPM/beat analysis and musical key, and
**Remove**. Saved-clip tiles also include **Save as sample…**. Removal is gated
for audio-file source items while they're in use by a timeline clip; saved-clip
items can always be removed (every linked timeline clip is silently unlinked
first and continues playing from the underlying source).

**Clip Editor** — double-click a library tile (or pick **Open in editor…** from its
right-click menu) to open the **Clip Editor** dialog. The dialog renders the source
waveform with an adaptive time ruler, faint beat lines extrapolated from the
detected BPM, and zoom + horizontal scroll (`+` / `-` / `0`, mouse-wheel anchored at
the pointer, `Shift+wheel` to pan; capped at **64× / 6400 %** so even narrow saved
clips can be inspected sample-precise). Once zoom or selection narrows past a
threshold the dialog opportunistically requests a **2000 peaks/sec** rendering for
the item on screen so the waveform stays crisp at deep zoom; the request is
keyed on the library item id and cached on disk alongside the default 500 peaks/sec
cache. Audio-file items open at the same px-per-second scale as the main timeline;
saved clips open zoomed to fit the cropped range and the bottom-left toggle flips
between **Clip** view (cropped) and **Source** view (full source for extending the
window). Warped saved clips show a **WARP** pill in the editor header; the
playhead is shown at the start of the view immediately, and Play becomes
available once the backend preview voice is ready. Auditioning runs through an
independent **backend preview voice**
(`PREVIEW_LOAD` / `PREVIEW_PLAY` / `PREVIEW_PAUSE` / `PREVIEW_STOP` /
`PREVIEW_SEEK` / `PREVIEW_UNLOAD` → `PREVIEW_STATE` / `PREVIEW_POSITION` /
`PREVIEW_ENDED`) so the main transport is unaffected. A monotonic `generation`
counter on the preview voice means stale events for a preview the user has already
closed are silently dropped. While playing the canvas follows the playhead with
the same smooth ease-in catch-up the main timeline uses.

Within the dialog:

- **Transport**: Skip-to-start, Play / Pause, Skip-to-end — the same three icons
  as the main TransportBar. `Space` toggles play / pause and is captured by the
  dialog while it's open (`uiStore.clipEditorOpen` defers the global handler).
- **Click** anywhere on the waveform to seek the playhead.
- **`←` / `→`**: snap the playhead to the previous / next beat on the
  source-BPM grid. **`Alt+←` / `Alt+→`**: 1 ms nudge.
- **`Shift+←` / `Shift+→`** (with or without `Alt`): extend a keyboard
  selection using a text-editor-style anchor — the first press anchors at
  the playhead (or the opposite edge of an existing narrowing selection), each
  subsequent press moves the playhead while the selection grows or shrinks to
  match. Any non-shift seek clears the anchor.
- **Loop (`L`)**: when on, playback loops the current selection — or the whole
  saved clip if no selection is set. Source files only loop when an explicit
  selection is set (the source file itself is immutable).
- **Selection-bounded playback**: with a selection set, Play starts from the
  selection start and stops (or loops) at the selection end. The skip-to-start
  / skip-to-end buttons honour the selection bounds.
- **Selection edges** carry triangular handles at the top and bottom for
  fine-tuning. Drag a handle to adjust just that edge of the selection without
  redrawing the whole range.
- **Crop** (`Crop` button) narrows the in-dialog view to the current selection
  without writing anything to the project — purely a non-destructive preview
  zoom. Ctrl+Z / Ctrl+Y inside the dialog walk a dialog-local Crop history so
  the user can experiment freely. **Source** / **Clip** toggle flips between
  full-source view (so the window can be extended beyond the saved clip's
  current bounds) and the cropped view; switching back from Source carries the
  most recently selected range with you so a wider selection on the source
  can be tightened up at clip-level zoom.
- **Save as new clip**: writes a new saved-clip entry to the library from the
  current selection.
- **Apply trim** (saved clips only): updates the saved-clip's `derivedFrom`
  window in place and pushes the new trim to every linked timeline clip
  atomically. Refused with a toast if the new window would cause one of the
  linked clips to collide with a neighbour on its track — the user resolves
  the collision (or unlinks the offending clip) and retries.

## Preferences

User preferences are persisted as JSON at `%APPDATA%/silverdaw/preferences.json`
and edited via the in-app **Edit → Preferences…** dialog. The dialog is
**transactional**: every field is held in a local working copy until you click
**Save**; **Cancel** (and `Esc`) discard pending edits without touching the
engine or the file. The settings are organised into four tabs on a left-hand
sidebar:

- **General** — toast notifications, follow-playback auto-scroll, library tile
  imagery.
- **Project** — default Save / Open / Import directories and background autosave
  configuration.
- **Audio** — output device selection (see below).
- **Developer** — diagnostic logging, log folder and DevTools access.

Persisted fields:

- Window bounds + maximised state.
- Panel sizes (track-header column width, library panel height).
- **Follow playback** — continuous-follow auto-scroll. When on, the timeline scrolls so the
  playhead stays near the centre of the viewport during playback (default). Off pins the
  view in place. Toggleable in the transport bar (chevron-in-circle icon) and the
  Preferences dialog.
- **Show images on library tiles** — controls whether library tiles show embedded cover
  art or the fallback audio icon. Off makes the library tiles text-only.
- **Show toast notifications** — pop transient feedback (errors, save acks) in the
  bottom-right. Off silences them; the underlying events still go to the log when
  diagnostic logging is enabled.
- **Default project folder** — used as the starting directory for File → Save / Save As /
  Open. Defaults to `<home>/Music/Silverdaw/`, which is created on first launch.
- **Default clip folder** — starting directory for Add Track from File / library Import.
  Defaults to `<home>/Music/`. After every successful open it remembers the folder you
  browsed to **for the rest of the session**; on next launch it resets to this default.
- **Autosave** — enable / disable plus tick interval (clamped 5..600 s, default 30 s).
- **Audio output device** — persisted `{ typeName, deviceName }` pair, both `null` for
  "System default". The backend receives the pair as `SILVERDAW_OUTPUT_DEVICE_TYPE` /
  `SILVERDAW_OUTPUT_DEVICE_NAME` env vars at spawn time.
- **Recent Projects** MRU (max 10, head = most recent, case-insensitive dedupe on Windows).
- **Write diagnostic logs** — enables the cross-layer file logger. When on,
  the next launch writes a per-session timestamped folder containing
  `{main,backend,renderer}.log` with aligned millisecond timestamps. The
  **Log folder** field lets the user choose the parent folder; by default this
  is the `debug` folder beside the application, and blank entries are normalised
  back to that default.
- **Show Developer Tools** — gates the visibility of the **Debug** menu and
  DevTools shortcuts independently of file logging.

QoL settings take effect on **Save**; developer settings require a restart and
the dialog surfaces that explicitly.

### Audio output device

Pick where Silverdaw sends audio in **Preferences → Audio**, or switch live from the
chip on the left of the transport bar without leaving the timeline. Devices are
**deduplicated across backends** — the same physical Speakers exposed by both Windows
Audio and DirectSound shows up as a single row in both surfaces, with the most-friendly
backend auto-picked (Windows Audio first, falling back to DirectSound, then the rest).

Advanced users can override the backend via the collapsed **Audio driver ▸** disclosure
in Preferences (hidden until you've picked a non-default device). Each backend carries a
plain-English description — e.g. *"Recommended. Modern Windows audio path; reliable
latency and shares the device with other apps."* / *"ASIO — Lowest latency, but requires
a vendor-supplied ASIO driver."* — so no outside docs are needed.

Robustness:

- **Removable devices** (USB / Bluetooth headphones) — when the saved device isn't
  present at launch the backend silently falls back to system default and the renderer
  pops a one-shot toast. The persisted preference is kept so re-plugging works next
  launch.
- **Live unplug** — JUCE's `audioDeviceListChanged` callback fires; the backend reopens
  the system default automatically so audio keeps flowing. A fresh `AUDIO_DEVICES_LIST`
  goes out to the renderer in the same round-trip.
- **Fast startup** — the first full device-type scan (the slow step on
  machines with ASIO drivers — typically 100–400 ms) is deferred via
  `juce::MessageManager::callAsync` and runs *after* the bridge has shipped
  its initial response. The renderer's first `AUDIO_DEVICES_LIST` arrives
  immediately with the current device + its type; the post-scan envelope
  follows when the scan completes. The pre-scan envelope carries a
  `scanInProgress: true` flag that the startup screen surfaces as
  "Scanning audio devices…" so the user knows what's happening. The
  user-initiated **Rescan devices** button stays synchronous (the user is
  explicitly waiting on it).

Latency compensation:

- The backend tracks effective output latency = `juce::AudioIODevice::getOutputLatencyInSamples()`
  + a **Bluetooth heuristic baseline**. Conservative name-match on the active device
  (`bluetooth`, `airpods`, `hands-free`, `wireless headphones`, `earbuds`, `a2dp`, `hfp`,
  …); when matched, adds **250 ms** for A2DP (music profile) or **400 ms** for
  HFP / Hands-Free (call profile — the low-bitrate codec Windows often switches BT
  headsets into).
- The `PlayheadEmitter` subtracts this from the broadcast playhead position **while the
  transport is playing**. Paused / seek anchors stay raw so click-to-seek lands exactly
  where you click. There's a one-off ~latency-ms snap when you press Play / Pause,
  absorbed by the renderer's existing position smoothing.
- The transport-bar audio chip surfaces the effective latency (`~250 ms · BT`) when it's
  non-trivial. The Preferences Audio tab shows the same line with a Bluetooth caveat.

## Keyboard & mouse reference

The timeline accepts the following inputs. Modifiers behave **live** during drags — pressing
or releasing the modifier between frames switches mode without restarting the drag.

| Input | Effect |
|---|---|
| Click on **ruler** | Seek the playhead to the nearest sub-beat (1/16 at 4/4). |
| `Alt` + click on ruler | Seek to the exact pointer position (1 ms resolution, no snap). |
| Double-click on **ruler** | Toggle a marker at the nearest grid point. There can only be one marker on a grid point. |
| Drag a **marker** | Move the marker, snapping it to the timeline grid and refusing occupied grid points. |
| Click on **clip** (no drag) | Select the clip and its host track, and seek the playhead to the click position. |
| Click + drag on **clip body** | Move the clip; the clip's first detected source beat snaps to the project sub-beat grid (or the clip's left edge if the source has no detected beats yet). Drag across rows to move the clip to a different track. Clips can't overlap on a single track — they magnetically butt against neighbour edges instead. |
| `Alt` + drag on clip | Move with 1 ms resolution — the clip stays at the unsnapped position. |
| Click + drag on **clip edge** (~8 px hit zone) | Trim the clip from that edge, snapping the dragged edge to the project grid by default. Non-destructive — only the window over the source file changes. Disabled on clips linked to a saved-clip library item — right-click ▸ Unlink first, or use the Clip Editor to resize every linked sibling in lockstep. |
| `Alt` + drag on clip edge | Trim with 1 ms resolution — the dragged edge stays at the unsnapped position. |
| Drag the **bottom edge of a track header** (~5 px hit zone) | Resize that track row vertically (60–400 px). Each track's height is persisted with the project and undoable. |
| Drag the **grip icon** (6-dot handle next to the track name) | Reorder the track. A green drop indicator shows the target slot. Drop on the indicator commits one undoable reorder step. |
| Double-click a **track gain number** | Type a gain percentage directly. Values are constrained to 0..150, matching the slider range. |
| Click on **empty area of a track row** | Select that track (highlighted row border), deselect any clip. |
| Click on **inter-track gap** / below the last track | Deselect both clip and track. |
| `←` / `→` | Step the playhead one grid line (sub-beat). |
| `Alt` + `←` / `→` | Step the playhead by one pixel's worth of time (~16.7 ms at default zoom, finer when zoomed in). |
| `M` | Toggle a marker at the nearest grid point to the playhead. Markers are shown as emerald downward triangles on the ruler and are saved with the project. |
| `Ctrl` + `←` / `→` | Move the playhead to the previous or next marker, scrolling the timeline if needed. |
| `Ctrl` + `Shift` + `←` / `→` | Skip to the start or end of the project and jump the timeline viewport there. |
| Mouse wheel | Zoom the timeline (anchored on the pointer). |
| Two-finger horizontal swipe (trackpad) | Pan left/right. |
| `Shift` + mouse wheel | Pan left/right. |
| `Ctrl +` / `Ctrl =` | Zoom in 10% (anchored on the playhead). |
| `Ctrl -` | Zoom out 10%. |
| `Ctrl 0` | Reset zoom to 100% (100 px/s). |
| `Space` | Play / pause globally unless a text field or modal dialog is active. Disabled when the playhead is at the end of the project (skip back to start to re-arm). |
| `F2` | Rename project (also activates the title-bar rename input). |
| `S` | Split every clip whose timeline window straddles the playhead into two at that position. |
| `D` | Duplicate the selected clip. Repeated duplicates from the same source append after the last duplicate in that track until there is no free slot, then a toast is shown. |
| `Delete` | Delete the selected clip. |
| `Ctrl + X` / `Ctrl + C` | Cut / copy the selected clip into the local clipboard. |
| `Ctrl + V` | Paste the clipboard clip to the selected track at the playhead. A toast appears if the selected track has no space at that position. |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo any project-mutating edit (clip / track / library / marker / BPM / length / rename). Drag streams coalesce within 500 ms into one step. Compound ops (split / duplicate) emit multiple undo steps today. |
| **Right-click on a clip** | Open the context menu: **Delete**, **Duplicate**, **Split at playhead**, an inline 16-swatch **Colour** picker, **Save clip to library**, **Save as sample…**, **Warp** for BPM/time-stretch controls, and **Pitch** for semitone/cents tuning. Warp and Pitch dialogs are transactional: **Save** applies changes, **Cancel** / close discards them. Shows **Relink…** at the top when the clip is unresolved. |
| Double-click on a **clip title strip** (top of the clip block) | Inline-rename the clip. Enter commits, Escape cancels, clicking outside also commits. The name is shown on the clip and used as the default name when the clip is saved to the library. |
| Double-click a **library tile name** | Inline-rename the library item (same gesture as the project title). |
| Double-click a **library tile** (off the name) | Open the **Clip Editor** for that library item. Use **Show information** from the right-click menu for the read-only info dialog. |
| Right-click a **library tile** | Open the library tile context menu with **Show information**, **Rename…**, **Reanalyse file** (audio-file items only), **Save as sample…** (saved-clip items only), and **Remove**. Removal is gated only for audio-file sources that are still in use by a timeline clip; saved-clip removal silently unlinks dependent clips. |

### Clip Editor

When the Clip Editor dialog is open, the timeline shortcuts above are suspended
and the following set takes over instead:

| Input | Effect |
|---|---|
| `Space` | Play / pause the preview voice. |
| Click on waveform | Seek the preview playhead. |
| `←` / `→` | Snap the playhead to the previous / next beat on the source-BPM grid. |
| `Alt` + `←` / `→` | Nudge the playhead by 1 ms (unsnapped). |
| `Shift` + `←` / `→` | Extend a keyboard selection: first press anchors at the playhead (or the opposite edge of an existing narrowing selection); subsequent presses move the playhead and grow / shrink the selection. Combine with `Alt` for 1 ms steps. |
| `L` | Toggle loop mode. With loop on, playback loops the selection — or the whole saved clip if no selection is set. Source files only loop when a selection is set. |
| Drag on waveform | Mark a sub-selection. The selection drives Save-as-new and Apply-trim. |
| Drag on a selection handle | Fine-tune the selection edge. |
| Mouse wheel | Zoom (anchored on the pointer), capped at 64× / 6400%. |
| `Shift` + wheel | Pan left / right. |
| `+` / `-` / `0` | Zoom in / out / reset. |
| `Esc` | Close the dialog. |

Clicking **Skip to start** in the transport bar rewinds the playhead and returns the
timeline's horizontal scroll position to the start. **Skip to end** and the matching
keyboard shortcut seek to the project end and jump the viewport to the right edge.

The status bar shows the current zoom level (e.g. `🔍 150%`) next to the backend connection
indicator (plug-and-socket icon + green/grey dot). The **Pos**, **Bar**, **Length**, and
**BPM** readouts in the transport bar are greyed out until the project has at least one
track — empty-project edits to those fields would have no visible effect, so we hide
the affordance until it's meaningful.

### Selection model

A click selects two things at once: the **selected clip** (thick outline) is the target of
Cut, Copy, Duplicate, Delete, and Split-at-playhead shortcuts; the **selected track**
(highlighted row border) is the destination of Paste. Clicking a clip selects both the clip
and its host track. Clicking an empty area of a track row selects just that track. Clicking
between tracks clears both.

Copy/paste is target-driven: copy a clip, select the destination track, place the playhead,
then paste. The new clip lands on the selected track at the playhead. Overlap rules are
evaluated only on that destination; the source-track's clips don't constrain placement.

## Rendering performance

The timeline canvas is PixiJS. All world-space content (clip blocks, waveforms, grid lines,
ruler ticks) is drawn once at absolute world coordinates into a `tracksLayer` / `rulerTicksLayer`,
which are then translated by `-scrollX` / `-scrollY` on every scroll change. The result: scroll
and auto-follow during playback are O(1) layer translations — no clip iteration, no Graphics
allocation. A full repaint (`redraw()`) only fires on content change: track add/remove, clip
move, peaks arrival, zoom, BPM, project length, header-column resize.

The playhead Graphics is built once (vertical line + two triangular heads at local x = 0)
and re-positioned via `.x = viewportX` on every `requestAnimationFrame` tick. The visual
position mirrors `transport.positionMs` directly (no client-side interpolation), so the audio
engine's authoritative position is always what the user sees — no jumps on seek + play.

Auto-follow during playback uses a smooth catch-up:

- If the playhead is **before** the viewport centre (e.g. after the user clicks back to an
  earlier point), scroll holds — the playhead drifts right naturally until it reaches the
  centre, then normal follow takes over.
- If the playhead is **past** the viewport centre, scroll catches up at
  `max(3 × playback_rate, 5 × gap)` px / second. Large gaps close in ~½ second; once settled
  at steady-state the catch-up rate is 3× playback so the playhead visibly drifts within the
  scrolling waveform (matches Ableton-style follow).

## Prerequisites

Silverdaw is Windows-only. Developed in Visual Studio Code.

- **MSVC** — the standalone **Build Tools for Visual Studio** SKU with the *C++ build tools*
  workload is sufficient (it ships `cl.exe`, `link.exe`, the Windows SDK, `vswhere.exe` and the
  Developer Shell module that `scripts/Invoke-DevShell.ps1` relies on).
- **CMake** ≥ 3.22 and **Ninja**.
- **Node.js** ≥ 20. **pnpm** is activated via `corepack` (which ships with Node) — the version
  is pinned by `frontend/package.json`'s `packageManager` field; do not `npm i -g pnpm`.

JUCE 8.0.12 and IXWebSocket are fetched automatically by CMake `FetchContent`; nothing to
install by hand.

The PowerShell helpers under `scripts/` (`Invoke-DevShell.ps1`, `Invoke-ClangTidy.ps1`) and the
matching Visual Studio Code tasks import the Visual Studio Developer Shell so `cl.exe` /
`link.exe` are on `PATH`.

### One-shot setup (recommended)

`scripts/Setup-Dev.ps1` brings a fresh Windows machine to a buildable checkout in a single
command. It verifies each prerequisite, offers to install anything missing via `winget`,
activates `pnpm` via `corepack`, runs `pnpm install` in `frontend/`, and configures the
backend Debug CMake cache in `backend/build/` (CMake creates that directory itself — no
manual `mkdir` is required).

```powershell
# Interactive: prompts before each winget install
pwsh -NoProfile -File scripts/Setup-Dev.ps1

# Non-interactive: silently install missing prereqs and also build the Debug backend
pwsh -NoProfile -File scripts/Setup-Dev.ps1 -Yes -BuildBackend
```

The same flow is available as the VS Code `setup: dev` task. The script is idempotent —
re-running it on an already-configured machine is a no-op for anything already installed
and refreshes the frontend lockfile install + CMake cache.

### Manual prerequisite install

If you'd rather install the tools yourself, the canonical `winget` IDs are:

```powershell
# MSVC C++ Build Tools (provides cl.exe, link.exe, Windows SDK, vswhere)
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# CMake, Ninja, Node.js (LTS)
winget install --id Kitware.CMake
winget install --id Ninja-build.Ninja
winget install --id OpenJS.NodeJS.LTS

# Activate pnpm (corepack ships with Node >= 16.13)
corepack enable
corepack prepare pnpm@latest --activate
```

If you already have Visual Studio or Build Tools installed without the C++ workload, run the
Visual Studio Installer and **Modify** the install to add *C++ build tools* (Build Tools SKU)
or *Desktop development with C++* (full VS).

## Setup and run

After running `scripts/Setup-Dev.ps1` (or installing the prerequisites manually), from the
workspace root:

```powershell
# 1. Configure + build the backend (Debug) — Setup-Dev already ran the configure step
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake -S backend -B backend/build -G Ninja -DCMAKE_BUILD_TYPE=Debug"
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake --build backend/build --config Debug --parallel"

# 2. Install frontend dependencies — Setup-Dev already did this too
cd frontend
pnpm install

# 3. Start the Electron app (spawns the backend automatically)
pnpm dev
```

The same commands are also available as Visual Studio Code tasks (`setup: dev`,
`backend: configure`, `backend: build`, `frontend: install`, `frontend: dev`, plus the
composite `dev: all`).

The recommended dev path is **F5** in VS Code with the `Silverdaw (Dev)` launch configuration
selected — it has a `preLaunchTask: "backend: build"` so the Debug backend is always rebuilt
before the renderer starts.

`backend/build/` is the Debug cache used by VS Code; `backend/build-release/` is the Release
cache used by `scripts/Build-Release.ps1`. They're kept separate so a release build doesn't
reconfigure the Debug cache out from under your dev session (Ninja is single-config — sharing
one directory means whichever configure ran last silently wins, and `cmake --build … --config`
flags are ignored).

## Packaging a Windows installer

The `scripts/Build-Release.ps1` helper does the whole release pipeline end-to-end:

1. Configures + builds the JUCE backend (`SilverdawBackend.exe`) in **Release**.
2. Compiles the Electron main / preload / renderer bundles (`electron-vite build`).
3. Packages an **NSIS installer** with `electron-builder`, bundling the
   backend exe + icons + `LICENSE` + `THIRD_PARTY_LICENSES.md`. Publisher metadata is set to
   `Ira Rainey` in `electron-builder.yml`.

From the repository root:

```powershell
pwsh -NoProfile -File scripts/Build-Release.ps1
```

Outputs land in the repo-root `dist/` directory (gitignored except for a
`.gitkeep` marker):

- `dist/Silverdaw-Setup-1.0.0.exe` — the NSIS installer (~90 MB). Runs a
  standard wizard with branded header + sidebar artwork, an AGPL licence page,
  choose-directory step, and desktop + Start menu shortcuts. The installer
  also registers `.silverdaw` as a file association so double-clicking a
  project in Explorer launches Silverdaw and opens it (with a single-instance
  lock — a running Silverdaw receives the path instead of a second window
  starting up). The packaged backend is statically linked against the MSVC
  runtime, so users do not need to install the Visual C++ Redistributable
  separately.
- `dist/win-unpacked/Silverdaw.exe` — the unpacked app for local smoke
  testing without going through the installer.

The installer is **not** code-signed, so Windows SmartScreen will show an "Unknown publisher"
warning on first run even though the Publisher field is populated. Code-signing is a separate
follow-up that requires an Authenticode certificate.

### Installer artwork

`scripts/Build-InstallerArt.py` regenerates the NSIS banner BMPs
(`installerHeader.bmp`, `installerSidebar.bmp`, `uninstallerSidebar.bmp` —
the Silverdaw logo on black) and the `.silverdaw` document icon
(`resources/icons/silverdaw-file.ico` — white page + folded corner + logo)
from `frontend/resources/icons/256x256.png`. Re-run it whenever the source
logo changes; the outputs are checked into git so the normal release build
doesn't need Python on the PATH.

```powershell
pip install Pillow
python scripts/Build-InstallerArt.py
```

### One-time prerequisite

`electron-builder` extracts a `winCodeSign` archive on first use that contains
macOS symlinks; Windows refuses to create symlinks unless the process has the
right privilege. Enable **Developer Mode** once (Settings → System → For
developers → Developer Mode = On) and re-run the build. The extracted cache is
reused for every subsequent build, so this is a one-off setup.

You can also iterate on packaging without rebuilding the backend or running a
fresh `pnpm install` by passing the relevant skip flags:

```powershell
pwsh -NoProfile -File scripts/Build-Release.ps1 -SkipBackend -SkipFrontendInstall
```

Or run just the packaging step directly:

```powershell
cd frontend
pnpm dist        # full installer
pnpm dist:dir    # win-unpacked only, no NSIS step
```

## Quality gates

- **C++**: `clang-tidy` via `scripts/Invoke-ClangTidy.ps1` (`backend: lint` task), using
  `backend/.clang-tidy` (enables `modernize-*`, `bugprone-*`, `performance-*`,
  `readability-*`). Format with `clang-format` (`backend/.clang-format`). Backend unit
  tests are gated behind `-DSILVERDAW_BUILD_TESTS=ON`:

  ```powershell
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "cmake -S backend -B backend/build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DSILVERDAW_BUILD_TESTS=ON"
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "cmake --build backend/build --target SilverdawBackendTests --config Debug --parallel"
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "ctest --test-dir backend/build --output-on-failure"
  ```
  Backend coverage is available for Clang / GNU builds with
  `-DSILVERDAW_ENABLE_COVERAGE=ON`. It adds a `SilverdawBackendCoverage`
  target that runs the backend unit tests and writes reports under the
  build directory's `coverage/` folder. MSVC builds still run the tests,
  but do not provide native coverage reports through this CMake target.
- **TypeScript / Vue**: `pnpm typecheck` (`vue-tsc --noEmit -p tsconfig.web.json --composite false`),
  `pnpm lint` (ESLint flat config with `eslint-plugin-vue` and `@typescript-eslint`).
- **Tests**: `pnpm test` runs Vitest over the shared bridge-protocol guards,
  music-time helpers and Pinia stores. `pnpm test:coverage` runs the same
  suite with V8 coverage and writes text, HTML, lcov and JSON-summary reports
  under `frontend/coverage/`.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](LICENSE) for the full text. You are free to use,
study, modify, and redistribute it; any distributed or network-hosted modified
version must in turn be released under the AGPL with its source available to
users.

Third-party components (JUCE, IXWebSocket, Electron, Vue, etc.) retain their
own licences; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the
attribution notices required by those licences.
