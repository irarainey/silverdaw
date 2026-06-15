# Silverdaw — Technical Design & Implementation Plan

## 1. Product Scope

A Windows desktop DAW with an Electron frontend and a JUCE audio backend, aimed
at bedroom DJs, producers, and mixers who want to create mixes and mashups
easily. It is a studio creation tool, not a live-performance instrument. Focused
on:

- Remixing and mashup production
- Sample and loop-based workflows
- Stem separation and harmonic matching
- Fast import-to-arrangement pipeline

**Explicitly deprioritised:** notation, live DJ performance.

---

## 2. UX Principles

The target is radical, beginner-friendly simplicity. These principles govern every feature and UI decision:

- **No unnecessary questions** — sensible defaults throughout; BPM and key detected automatically, warp applied on drop. Users adjust after the fact, not before.
- **Obvious affordances** — if a core action requires reading documentation, the UI has failed.
- **No modal dialogs for common actions** — inline editing, contextual panels, and right-click menus over popups wherever possible.
- **Progressive disclosure** — basic controls always visible; advanced options (warp mode, slice settings, routing) revealed on demand without cluttering the default view.
- **Immediate feedback** — waveforms render as files load, analysis results appear as they complete. Nothing blocks the UI.
- **Drag and drop everywhere** — from browser to timeline, between tracks, for reordering clips. Drag is the primary way to place and move audio.

---

## 3. Technology Stack

### Application Architecture

Silverdaw is split into two processes that communicate over a local WebSocket connection:

| Process               | Role                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| **Electron frontend** | All UI rendering, user interaction, drag and drop                      |
| **JUCE backend**      | Audio engine, DSP, file I/O, project state — runs headless (no window) |

The Electron process launches the JUCE backend as a child process on startup and terminates it on close.

### Frontend Stack

| Layer              | Choice                 | Rationale                                                                           |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------- |
| Shell              | Electron               | Native desktop integration, file system access, process management                  |
| Build tool         | electron-vite          | Electron + Vite + Vue preconfigured, HMR in development                             |
| UI framework       | Vue 3 + TypeScript     | Approachable, Composition API suits reactive audio state                            |
| State management   | Pinia                  | Vue's official store; clean API, TypeScript-first                                   |
| Timeline rendering | PixiJS                 | WebGL-accelerated; handles many clips and 60fps playhead without performance issues |
| Waveform display   | Custom PixiJS renderer | Draws peaks data supplied by backend; no additional library needed                  |
| Styling            | TailwindCSS            | Utility-first; fast to build consistent dark UI                                     |

### Backend Stack

| Layer           | Choice                      | Rationale                                                       |
| --------------- | --------------------------- | --------------------------------------------------------------- |
| Language        | C++17                       | Performance, JUCE compatibility                                 |
| Framework       | JUCE (headless)             | Audio I/O, plugin hosting, project state — UI subsystems unused |
| Communication   | IXWebSocket loopback server | Low-latency local IPC                                           |
| Target platform | Windows (x64)               | Initial focus; JUCE enables macOS port later                    |

### Backend External Libraries

| Need                         | Library / approach                    | Status and notes                                                                                                                                              |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beat / tempo detection       | BTrack                                | Implemented. A patched vendored copy lives under `backend/third_party/btrack/`; it runs offline BPM and beat analysis on the existing worker pool.            |
| Audio resampling             | libsamplerate 0.2.2                   | Implemented via CMake `FetchContent`; used to convert analysis audio to BTrack's expected 44.1 kHz input.                                                     |
| Key detection                | Renderer Web Audio analysis           | Implemented. The renderer decodes audio, builds a chroma profile and stores detected keys on library items.                                                   |
| FFT                          | KISS FFT                              | Implemented as part of the BTrack vendor copy. No FFTW dependency.                                                                                            |
| Time-stretch / pitch shift   | Rubber Band Library                   | Implemented for real-time per-clip warp / pitch-shift playback.                                                                                               |
| Stem separation              | Demucs v4 (htdemucs-ft) via ONNX Runtime | Implemented; see Section 6. CPU by default, optional DirectML GPU acceleration. Model weights downloaded on first use.                                       |
| Decoding unsupported formats | Renderer Web Audio + temp WAV today; ffmpeg later | Web Audio covers many unsupported-by-JUCE formats today. ffmpeg is a later compatibility / robustness upgrade, not a core workflow blocker. |

> **Note:** JUCE UI subsystems (`Component`, `AudioThumbnail`, `OpenGLContext`) are not used. All rendering is handled by the Electron frontend.

---

## 4. Communication Layer

### Transport

WebSocket on `ws://127.0.0.1:<port>` (loopback only). Electron main picks a free
port in `[8765, 8784]`, starts the JUCE backend with `--port`, and exposes the
chosen port plus a per-session AUTH token to the renderer over IPC. The renderer
connects directly; the backend gates every connection on the AUTH token.

The bridge is **text-only**: every envelope is a JSON `{ type, payload }` frame. There is no binary frame plane. Bulk data (waveform peaks today; stems / previews later) goes via disk — the backend writes to a known cache location and sends a small "ready" envelope pointing at the path; the renderer reads the file via main's IPC. This sidesteps the I/O-loop starvation issues a single-threaded WS server (IXWebSocket) hits when bulk frames compete with control traffic, and aligns with how the same plan already treats audio files, stems and mixdowns.

### Message Protocol

The wire-protocol contract lives in
[`frontend/src/shared/bridge-protocol.ts`](../frontend/src/shared/bridge-protocol.ts).
Inbound (backend → renderer) payloads are defined as `zod` schemas with the
TypeScript types derived via `z.infer<typeof XPayloadSchema>` so the schema is
the single source of truth; each `isXxxPayload` guard is a one-line
`safeParse(value).success` wrapper. Outbound (renderer → backend) payloads are
plain TypeScript interfaces in the same file (producer-side, compile-checked at
every `send<K>()` call site). Vitest round-trip coverage exercises every guard.
The catalogue below illustrates the shape — see the TS file for the canonical,
type-checked list of every currently-defined envelope.

```jsonc
// Renderer → Backend (commands)
{ "type": "AUTH", "payload": { "token": "<hex>" } }
{ "type": "TRANSPORT_PLAY" }
{ "type": "TRANSPORT_SEEK", "payload": { "positionMs": 4000 } }
{ "type": "TRACK_ADD", "payload": { "trackId": "t1", "name": "Track 1" } }
{ "type": "TRACK_GAIN", "payload": { "trackId": "t1", "gain": 0.8 } }
{ "type": "CLIP_ADD", "payload": { "trackId": "t1", "clipId": "c1", "libraryItemId": "l1", "positionMs": 0, "inMs": 0, "durationMs": 8000, "colorIndex": 3 } }
{ "type": "CLIP_MOVE", "payload": { "clipId": "c1", "positionMs": 2000, "trackId": "t2" } }
{ "type": "CLIP_TRIM", "payload": { "clipId": "c1", "startMs": 1000, "inMs": 500, "durationMs": 4000 } }
{ "type": "CLIP_COLOR", "payload": { "clipId": "c1", "colorIndex": 5 } }
{ "type": "CLIP_REBIND", "payload": { "clipId": "c1", "libraryItemId": "l2" } }
{ "type": "LIBRARY_ITEM_RELINK", "payload": { "itemId": "l1", "filePath": "..." } }
{ "type": "TRACK_SET_HEIGHT", "payload": { "trackId": "t1", "heightPx": 180 } }
{ "type": "TRACK_REORDER", "payload": { "trackId": "t1", "newIndex": 2 } }
{ "type": "LIBRARY_ADD", "payload": { "itemId": "l1", "filePath": "...", "key": "Bb minor" } }
{ "type": "LIBRARY_REANALYSE", "payload": { "itemId": "l1", "filePath": "..." } }
{ "type": "PROJECT_MARKER_ADD", "payload": { "markerId": "m1", "positionMs": 4000 } }
{ "type": "WAVEFORM_REQUEST", "payload": { "clipId": "c1" } }
{ "type": "CLIP_EDITOR_PEAKS_REQUEST", "payload": { "libraryItemId": "l1", "peaksPerSecond": 2000 } }
{ "type": "PROJECT_SAVE_AS", "payload": { "filePath": "..." } }
{ "type": "PROJECT_SET_VIEW", "payload": { "pxPerSecond": 80.0, "scrollX": 1240 } }

// Backend → Renderer (state updates and events)
{ "type": "READY", "payload": { "version": "1.0.0" } }
{ "type": "PROJECT_STATE", "payload": { "filePath": null, "name": "Untitled",
  "bpm": 100, "projectLengthMs": 0, "viewPxPerSecond": 60,
  "viewScrollX": 0, "playheadMs": 0,
  "library": [{ "id": "l1", "filePath": "...", "key": "Bb minor", "bpm": 124.37, "beats": [0.487, 0.972], "variableTempo": false }],
  "markers": [{ "id": "m1", "positionMs": 4000 }],
  "tracks": [{ "id": "t1", "name": "Track 1", "gain": 1.0, "heightPx": 180,
    "clips": [{ "id": "c1", "libraryItemId": "l1", "offsetMs": 0, "inMs": 0, "durationMs": 8000, "colorIndex": 3, "unresolved": false }] }] } }
{ "type": "PLAYHEAD_UPDATE", "payload": { "positionMs": 4250, "isPlaying": true } }
{ "type": "CLIP_ADDED", "payload": { "trackId": "t1", "clipId": "c1", "ok": true } }
{ "type": "LIBRARY_ITEM_ANALYSIS", "payload": { "itemId": "l1", "bpm": 124.37, "beats": [0.487, 0.972], "beatAnchorSec": 0.487, "variableTempo": false, "playbackFilePath": "..." } }
{ "type": "WAVEFORM_READY", "payload": { "clipId": "c1", "cachePath": "C:/Users/.../Silverdaw/peaks/<hash>.peaks", "peakCount": 158310, "peaksPerSecond": 501.13, "sampleRate": 44100, "laneCount": 3 } }
{ "type": "CLIP_EDITOR_PEAKS_READY", "payload": { "libraryItemId": "l1", "cachePath": "C:/Users/.../Silverdaw/peaks/<hash>.peaks", "peakCount": 633240, "peaksPerSecond": 2004.54, "sampleRate": 44100, "laneCount": 3 } }
{ "type": "PROJECT_SAVED", "payload": { "filePath": "...", "ok": true } }
{ "type": "PROJECT_DIRTY", "payload": { "dirty": true } }
```

### Data over WebSocket vs disk

**WebSocket carries:** commands, state updates, metadata, progress events, and `*_READY` notifications pointing at on-disk artefacts.

**Disk only:** audio files, peak caches, rendered stems, exported mixdowns, project files. The backend writes them to a stable location and sends the path; the renderer reads them via main-process IPC. No bulk bytes ever cross the WebSocket.

`WAVEFORM_READY` / `CLIP_EDITOR_PEAKS_READY` include the actual peak rate used
for the cached peak array. This can differ slightly from the requested nominal
rate (for example 500 peaks/sec) because waveform buckets contain a whole
number of source samples. The renderer uses the reported rate for timeline
waveform indexing so transients stay aligned with beat markers over long clips.
They also carry `laneCount`: stereo sources cache three channel-major lanes
(`[summary, left, right]`, `laneCount = 3`); mono / >2-channel sources cache the
summary lane only (`laneCount = 1`). The **Waveform display** preference selects
whether the renderer draws the single summary lane or the stacked L/R lanes.

### Responsibility split

| Concern                                     | Owner                                           |
| ------------------------------------------- | ----------------------------------------------- |
| Timeline layout and clip positions (visual) | Electron / Pinia store                          |
| Playhead position display                   | Electron (driven by `PLAYHEAD_UPDATE` at ~60Hz) |
| Waveform drawing                            | PixiJS (using peaks arrays from backend)        |
| Drag and drop                               | Electron / Vue                                  |
| Audio playback                              | JUCE backend                                    |
| Per-track FX, mixer routing                 | JUCE backend (per-track Tone EQ + filters, sends, pan, and Leveler shipped) |
| Warping and pitch shift                     | JUCE backend (Rubber Band)                      |
| BPM / beat detection                        | JUCE backend (BTrack)                           |
| Key detection                               | Electron renderer (Web Audio chroma analysis)   |
| Stem separation                             | JUCE backend (ONNX Runtime / Demucs), model download in Electron main |
| File reading / writing                      | JUCE backend                                    |
| Project state (source of truth)             | JUCE backend (ValueTree)                        |
| UI state (zoom, selections, scroll)         | Electron / Pinia                                |

---

## 5. System Architecture

### Backend

```
JUCEBackend (headless)
│
├── BridgeServer                — IXWebSocket loopback + AUTH gate; text-only JSON
│
├── AudioEngine
│   ├── topMixer                — combines `master` and `previewVoice.transport`
│   │   ├── master              — project transport (mixer → per-track clip sources)
│   │   └── previewVoice        — independent Clip Editor preview voice
│   ├── per-track clip sources  — non-destructive source windows
│   ├── master transport clock  — play / pause / seek / playhead position
│   └── AudioDeviceManager      — output device + lazy first scan via callAsync
│
├── PeaksCache                  — disk-backed waveform peak cache
│
├── BpmDetector                 — BTrack + libsamplerate import analysis
│
├── DecodedCache                — decoded playback WAV cache for analysis/import reuse
│                                  (non-WAV sources only; WAV sources play directly)
│
└── ProjectState
    ├── ValueTree               — all clip, track, library, marker data
    └── UndoManager             — undo/redo stack, surfaced via EDIT_UNDO / EDIT_REDO
```

### Frontend

```
Electron Shell
│
├── Main process
│   ├── Launches SilverdawBackend as child process (bridge port + token via env)
│   ├── Native file dialogs, app menu, preferences.json persistence,
│   │   metadata + peaks-cache IPC, autosave directory management,
│   │   recent-projects MRU
│   └── App lifecycle (quit → terminate backend cleanly,
│       single-instance lock with cold-launch file-path hand-off)
│
└── Renderer process (Vue 3 app)
    │
    ├── Pinia stores
    │   ├── projectStore        — tracks, clips, markers, project identity (mirrors backend state)
    │   ├── transportStore      — playhead position, play/pause state, bridge status
    │   ├── uiStore             — zoom, scroll, panel sizes, clip-editor-open
    │   ├── libraryStore        — project-scoped library (sources + saved clips)
    │   ├── previewStore        — Clip Editor preview voice state + endedCount
    │   ├── audioDeviceStore    — current output device + scanInProgress flag
    │   ├── appStore            — startup flow state + recents MRU mirror
    │   └── notificationsStore  — transient toast queue
    │
    ├── Bridge service          — sends commands, dispatches events to stores
    │
    └── Vue components
        ├── StartupScreen       — unified boot+landing overlay (no separate splash)
        ├── TimelineView        — PixiJS canvas (tracks, clips, playhead, grid)
        ├── LibraryPanel        — source + saved-clip tiles, metadata, drag source
        ├── ClipEditorDialog    — full-waveform clip editor with preview voice
        ├── TransportBar        — play/pause, BPM, position, audio-device chip
        ├── PreferencesDialog   — General / Project / Audio / Developer tabs
        ├── RecoveryDialog      — autosave restore picker on launch
        └── ClipContextMenu     — edit actions, relink entry and colour swatches
```

---

## 6. Stem Separation — Demucs Integration

**Model:** htdemucs fine-tuned (Demucs v4), **4-stem** — separates a stereo track
into vocals, drums, bass and other. The chosen weights are the MIT-licensed
community ONNX export `StemSplitio/htdemucs-ft-onnx` (a "bag" of four specialist
models, one per source — so 4-stem is native, not derived). They are downloaded
on first use and the stem-separation UI stays disabled until the model is
present.

**Integration:** ONNX Runtime C++ API. The runtime dependencies that ship beside
`SilverdawBackend.exe` are the `.onnx` model files, `onnxruntime.dll`, and — for
the default DirectML build — `DirectML.dll`. GPU acceleration via the DirectML
execution provider on Windows is **implemented**: the bundled ONNX Runtime is a
DirectML build (a CPU+GPU superset — a single `onnxruntime.dll` serves both EPs),
and the renderer threads a `useGpu` flag through to the backend's session options
so the DirectML EP is appended when the user opts in. The GPU runtime is bundled
by default, but **using** the GPU is opt-in: the `stems.useGpu` preference
defaults off and is honoured only when a compatible adapter is detected (gated in
the renderer and surfaced in Preferences ▸ Stems).

| Approach          | Pros                                      | Cons                                  |
| ----------------- | ----------------------------------------- | ------------------------------------- |
| ONNX Runtime ✓    | Self-contained, no Python, ships as a DLL | Requires ONNX model export            |
| Python subprocess | Quick to prototype                        | Fragile, slow to invoke, hard to ship |
| LibTorch          | Faithful to original weights              | ~500MB, complex build                 |

**Dependency acquisition (implemented):** ONNX Runtime is pulled in entirely
through CMake — no DLL is vendored into the source tree. By default
(`SILVERDAW_ONNXRUNTIME_DIRECTML=ON`) `backend/CMakeLists.txt` fetches the
DirectML-capable ONNX Runtime from NuGet (the DirectML EP is not in the GitHub CPU
release) plus the `Microsoft.AI.DirectML` package it depends on; setting that
option `OFF` falls back to the official prebuilt `onnxruntime-win-x64` GitHub
archive (CPU-only). Either way the fetch is at configure time via `FetchContent`
(pinned versions + SHA-256 integrity checks, behind the
`SILVERDAW_ENABLE_STEM_SEPARATION` option, default `ON`), exposed as an `IMPORTED`
target, with `SILVERDAW_STEM_SEPARATION=1` defined for the backend core. This
mirrors how JUCE, IXWebSocket and Rubber Band are already obtained.

**Packaging (implemented):** A CMake `POST_BUILD` step copies `onnxruntime.dll`
(and, for the DirectML build, `DirectML.dll`) next to `SilverdawBackend.exe`, and
`frontend/electron-builder.yml` ships them as `extraResource`, so the installer
carries everything required to run — ONNX Runtime and DirectML are MIT-licensed,
which permits redistribution alongside the app. The ~1.2 GB model weights are kept
out of the installer and downloaded on first use.

**Model store (implemented):** The model files are fetched on first use by the
Electron main process (the headless backend has no network stack —
`JUCE_USE_CURL=0`) into the user's app-data directory. `src/main/stems/` holds
the pinned manifest (`htdemucsModel.ts`) and a dependency-injected `ModelStore`
(`modelStore.ts`) that checks presence, downloads missing files with progress,
verifies each file's SHA-256 + byte size, commits atomically, and records the
manifest revision in an `.installed` sentinel so later launches skip re-hashing.
The backend loads the ONNX sessions from the resolved model directory.

**Target UX:** Separation runs on a background thread and never touches the audio
callback. Progress is emitted as `STEM_PROGRESS` events and shown in a
non-blocking progress dialog; the audio engine keeps playing during separation.
Stems appear **incrementally**: the backend emits a `STEM_PARTIAL` envelope the
instant each stem's WAV is written, so its track lands on the timeline while the
remaining stems are still separating — the user sees steady progress rather than
a single batch at the end. The final `STEM_READY` lists every stem and backfills
any not already placed (a per-job set dedupes the two paths). Each of the four
stems is added to its own new track beneath the
source clip's track, non-destructively — the original clip and its source file
are left untouched. Each stem is **also** added to the library as a new `stem`
item nested under its source group (alongside any saved clips), so the library
mirrors the timeline; stem rows carry a distinct marker and the source group's
collapse header summarises its children (e.g. "4 stems · 2 saved clips"). Stem
library items persist with the project (kind `stem` + a `derivedFrom` pointer to
the source) and reload like standalone files, and a stem cannot be removed from
the library while its timeline clip is still present.

**Inference (implemented):** Each specialist `.onnx` takes a fixed-length 7.8 s
(343 980-sample) stereo segment and emits all four demucs sources
(`[1, 4, 2, segment]`, source order drums/bass/other/vocals); the backend keeps
only the source each model is fine-tuned for. A full track is processed
demucs-style — per-track mean/standard-deviation normalisation, fixed segments
with a quality-selectable window overlap, and triangular-window weighted
overlap-add reconstruction (`OnnxStemSeparator.cpp`). The stem dialog exposes a
**Fast / Balanced / Best** quality preset that the renderer sends as
`quality` on `STEM_SEPARATE`; the backend maps it to the inference overlap
(0.10 / 0.25 / 0.50, balanced being the long-standing default and the fallback
for an absent value). The segmentation, layout and source-index handling
were validated against the real htdemucs-ft weights. When all four stems are
requested the backend skips the `other` model run and synthesises
`other = mixture − (vocals + drums + bass)` (a mixture-consistency residual that
is mathematically identical to adding the full residual to the model's `other`,
captures any energy the three specialists miss, and runs ~25 % faster).

**On-disk layout & sidecar (implemented):** Each separation writes its WAVs into a
folder named after the source — `Stems\<sourceName>-stems` beside the saved project
file (or the temporary workspace `<temp>/Silverdaw/Stems` when the project has not
been saved yet, migrated into the project folder on the first save), with a `-2`/`-3`…
suffix when a folder for that source already
exists, so repeat separations never collide. Keeping stems inside the project folder
lets the whole project travel with them when the folder is moved or synced. Because
separated WAVs carry no tags and the original source can later be removed from the
library, the renderer also writes a `metadata.json` + `cover.<ext>` **sidecar** into
that folder (via guarded main-
process IPC scoped to the stems directory). On reload the stem items re-read the
sidecar, so they keep the source's tags and artwork even after the source item is
gone — the metadata is **copied, not merely referenced**.

**Naming & analysis reuse:** Stem WAV files and their tracks are named from the
source's friendly library name (e.g. "Song - Vocals" / "Vocals — Song"), never the
internal decoded-cache hash — the renderer sends `sourceName` in `STEM_SEPARATE`
and the backend prefers it (falling back to the clip name, then the raw source
basename). Because each stem is sample-aligned with its source, stems **inherit**
the source's analysis (BPM, beat grid, anchor, key, variable-tempo flag)
instead of being re-analysed — applied on both the renderer (so the stem clip
auto-warps to the project grid the moment it is placed) and the backend (so its
persisted/playback state matches). This is instant and avoids the sparse-stem
mis-detection a fresh analysis would produce. A stem does **not** carry its own
sample/music (low-confidence) flag: it has no independent confidence measurement,
so its classification defers to the source via `derivedFrom`. Marking the source
as **music** therefore reveals the beat grid on every derived stem clip.

**Future:** an optional experimental 6-stem model (adds guitar + piano) and an
fp16 GPU compute path (prototyped) once the shipped 4-stem pipeline is proven.

---

## 7. Core Feature Areas

### 7.1 Warp Engine
The warp engine is implemented as per-clip Rubber Band processors managed by
the backend and driven from the shared master transport clock.

- **Modes:** rhythmic (drums/percussion), tonal (melodic material), complex (mixed)
- **Real-time mode** for playback; offline render remains future work for export and stem processing
- Pitch and tempo adjusted independently, non-destructively (per-clip semitone + cents)
- Warp settings stored in `ValueTree`; never baked into audio files
- Auto-warp can match newly dropped/imported clips to the current project BPM,
  including late activation after BPM analysis finishes
- Multi-track sync via shared master transport clock with per-track latency compensation

### 7.2 Sample Creation from Clip
Users turn a timeline clip or a saved-clip library item into a reusable sample in
one action (region-to-sample arrives with the selection primitive in §7.2.1):

- Select a timeline clip or saved-clip library tile → right-click → "Save as sample"
- Backend writes a WAV slice to a `Samples` folder under the project directory
  (or the temporary workspace for unsaved projects, migrated on first save)
- Browser updates immediately on receipt of `SAMPLE_SAVED` event
- Non-warped clips: sliced directly from source file, no render required
- Warped clips: offline Rubber Band render before write so the WAV matches the
  clip's tempo/pitch state
- File names use `<base>-sample-001.wav`, incrementing for duplicate base names
- Phase 8 alternative flow: drag a selected region from the timeline directly into the sample browser panel

### 7.2.1 Region Selection on a Clip
The selection primitive that drives Save-as-Sample, cropping, splitting, region-specific volume / effects, and pitch on a sub-range. Two complementary input modes — both produce the same selection model:

- **Drag-select** — click-drag across the waveform inside a clip block to paint a start→end region. Snaps to the project sub-beat by default; modifier overrides snap.
- **Mark-points** — pick a start point at the playhead (key: `[`), pick an end point (key: `]`). Easier on touchpads and for sample-accurate marks driven by the transport.

A region is a sub-range of a single clip with the clip's `clipId`, a `startMs`, and an `endMs`. Saved selections are first-class for: Save as Sample, Crop to Region, Split at Playhead, Apply effect to region, Volume-envelope edits.

### 7.3 Drag and Drop
The primary interaction model for placing and organising audio:

- **Browser → timeline:** creates a clip at the drop position; dropping on empty space auto-creates a new track
- **Clip reordering:** drag clips along the timeline or between tracks
- **Region → browser:** Phase 8 shortcut for dragging a selected region into the browser to save it as a sample
- Clips snap to beat grid by default; modifier key overrides snapping
- All drag operations handled in Electron; resulting state changes sent to backend as commands

### 7.4 Beat & Key Detection
Runs automatically on every import, in the background:

- BTrack: BPM and beat-position markers, refined by a least-squares period+anchor
  fit and an onset-detection-function (ODF) autocorrelation pass. A guarded,
  robust phase-correction step then nudges the beat anchor onto the true onsets
  (median offset to nearby ODF peaks, applied only when consistent, plausible,
  significant and enough beats match) so the rigid grid lands on the beats rather
  than inheriting BTrack's causal lag.
- Renderer Web Audio analysis: root note and mode
- Sample rate is read from the file header on import and stored on the clip; no detection needed (always exact)
- Results are merged into library metadata and stored in `ValueTree`
- **Confidence ≠ sample.** Low tempo confidence no longer reclassifies a track as
  a non-musical "sample" — it shows the grid as **tempo-unverified** (visible,
  warpable) instead of hiding it. Only an explicit per-source **Auto / Music /
  Sample** override marks a true sample.
- **Manual fallback.** The user can set a BPM by hand on a source (rigid-metronome
  grid) and **slide the grid over the waveform** in the Clip Editor to correct its
  phase (`LIBRARY_ITEM_SET_MANUAL_TEMPO`). Manual values are treated as verified
  music with the grid shown and warp enabled.
- User can override BPM / key in the clip inspector
- **Project BPM bootstrap:** when the *first* clip is added to an empty project, the detected BPM seeds the project BPM (one-shot — subsequent imports don't change it). User can override later via the transport bar.

### 7.5 Clip Editing Primitives
Non-destructive clip operations on the timeline. Each operation mutates the `ValueTree` (so undoable) but never touches the underlying audio file — they're just changes to in/out points and clip references.

- **Crop** — trim a clip's `inMs` / `outMs` to a selected region. Underlying file untouched.
- **Split** — slice a clip at the playhead (or at every selected mark) into N adjacent clips that together reference the same file. Cheap: O(1) ValueTree edits, zero audio I/O.
- **Duplicate** — clone a clip at a chosen offset (commonly drag with `Alt` or right-click → "Duplicate to Beat Grid"). Both clips reference the same file; the duplicate gets its own clip id so it can be edited independently.
- **Repeat-to-loop** — a special-case duplicate that fills a region with N copies of a clip at clip-length spacing; ideal for looping a short sample across a section.
- **Lock / Unlock** — `Ctrl+L` or right-click ▸ Lock freezes a single clip against accidental move / trim / split. Locked clips show a padlock badge on the title strip, refuse drag-move and edge-trim gestures silently, and surface a toast if Split-at-playhead is invoked on them. Double-click still opens the Clip Editor so warp / pitch / crop remain editable via that surface. The lock is per-clip — linked-saved-clip siblings stay independently lockable — and persisted on the clip's `locked` ValueTree property (absent == unlocked).
- **Reverse** — right-click ▸ Reverse (a checkmarked toggle) or the **Reverse** toggle in the Clip Editor toolbar plays the clip's source window back-to-front. It is non-destructive: the source file is never rewritten — the audio engine reads the clip window in reverse. From the context menu the toggle propagates to every linked-saved-clip sibling; in the Clip Editor it is part of the transactional draft, previewed live, and committed on **Save** following the same scope as the other draft edits. Persisted on the clip's `reversed` ValueTree property (absent == forward) via `CLIP_SET_REVERSED` / `PREVIEW_SET_REVERSED`.

### 7.6 Loop Slicing
- Slice on BTrack transient positions, beat grid divisions, or manual markers
- Slices are sub-regions of the parent clip — no audio copying
- Slices can be laid back on the timeline as individual clips or saved as samples

### 7.7 Stem Separation
- Triggered from the clip context menu (**Separate Stems**) or a library audio-file's context menu; a one-time model download is offered on first use
- A stem picker is shown first (vocals / drums / bass / other, all ticked by default) — only the chosen stems are separated, which proportionally shortens the run
- Progress shown in a non-blocking dialog driven by `STEM_PROGRESS` events; the counter reflects the selected stems
- Stems are imported to the library as a nested **stem** clip type under their source. When started from a timeline clip they are also placed on new tracks (one per stem), each aligned to the source clip's start. When started from a library source they are imported to the library only — adding them to the timeline is a manual step
- Source preserved untouched (non-destructive); stems inherit the source's beat grid, key, and sample/music classification

### 7.8 Harmonic Matching
- Detected key displayed on every clip in the timeline
- Clip-level pitch shift via Rubber Band, applied non-destructively (controlled from the clip inspector / context menu — semitone field + cents trim)
- Phase 8 visual indicators can flag harmonically compatible clip pairs once
  the core key display and pitch controls are stable

### 7.9 Mixer & Routing

Silverdaw's mixing surface is deliberately **not** a traditional channel-strip
mixer view. The product audience is the non-pro remixer, and "open the mixer"
is a friction step that beginner-friendly tools avoid. The
sound-shaping surfaces are instead split across three locations that match
how a beginner actually thinks about the work:

- **Per clip** — "fix this one bit" → the Volume Shape envelope on the clip
  itself, which also covers fade-in / fade-out (see §7.11).
- **Per track** — "shape this instrument" → a small set of always-the-same
  controls (Tone, Leveler, Reverb amount, Delay amount) in the new **Track FX**
  tab of the bottom panel (see §7.12).
- **Per project** — "the song's space" → one shared Reverb and one shared
  Delay for the whole project, with character set once.

User-facing language favours familiar, DAW-standard terms — **Reverb**,
**Delay**, **Pan**, **Bass / Mid / Treble** — so the app reads the way users
expect across tools, while still avoiding the most technical jargon
(no "low shelf / parametric peak / high shelf", and **Volume Shape** rather than
"automation / envelope"). The implementation names inside the codebase keep the
matching technical terms (`reverb*`, `delay*`).

#### 7.9.1 Engine architecture (Phase 5 foundation)

The current engine stores `AudioEngine::tracks` keyed by **clip id**, with
one `AudioTransportSource` per clip mixed straight into the top
`MixerAudioSource`. That topology is fine for "tracks are buckets for
clips" but cannot support per-track DSP — adjacent clips on the same UI
track would each get their own Leveler/Tone state, which is wrong (a
compressor's detector resetting mid-track would thump). The first
Phase 5 deliverable is therefore an engine refactor; **no Phase 5 FX
ship until this lands**.

The new topology introduces two runtime objects:

- **`TrackRuntime`** — one per UI track, **independent of clip count**.
  Owns a stable per-track output buffer at the engine's nominal block
  size + channel count, the per-track **`TrackChain`** of DSP processors
  (Tone, Leveler, gain/mute/solo, pan), and the per-track send scalars
  (`reverbSend`, `delaySend`). Clips on this track feed their pre-FX
  audio into this buffer.
- **`BusGraph`** — one per engine. Replaces `MixerAudioSource` as the
  root pull source. Owns block lifecycle deterministically and runs the
  signal flow in a strict order each block (see §7.9.2 below). Pulls
  each `TrackRuntime` exactly once per block; pulls the shared Reverb and
  Delay processors exactly once per block; sums into the master bus;
  hands off to `MeteringSource`.

This deliberately avoids the full `juce::AudioProcessorGraph` migration
(Phase 8) — `BusGraph` is a small purpose-built custom mixer, not a
general routing engine. It handles every Phase 5 effect including
shared sends, and the canonical `TrackChain` abstraction is consumed
identically by `AudioEngine` and `MixdownEngine` so live and offline
render share one DSP path.

**`BusGraph` invariants (must hold every block, audio-thread):**

- All scratch buffers (per-`TrackRuntime` output, shared Reverb input,
  shared Delay input, master accumulator) are owned by `BusGraph` and
  **preallocated in `prepareToPlay`** sized for the prepared
  `maxExpectedBlock × maxExpectedChannels`. **No allocation, no
  resize, no lock acquisition** inside `getNextAudioBlock`. If the
  device requests a larger block than prepared, `BusGraph` **chunks**
  the callback through the preallocated max-size scratch (running
  the full graph N times for N = `ceil(requestedBlock / preparedMax)`
  sub-blocks) so audio output is uninterrupted; the host triggers a
  re-prepare on the message thread to right-size for subsequent
  callbacks. Zero-fill is a last-resort hard failure, only used when
  the chunked path itself faults, and is logged once.
- Every scratch buffer is **cleared at the start of the block** before
  any pull, so a stale tail from the previous block can never sneak
  into a fresh dry sum.
- Each `TrackRuntime` is pulled **exactly once** per block; each shared
  FX is pulled **exactly once** per block; nothing is pulled twice.
- Processor state on the shared FX **resets on transport stop and on
  `setNextReadPosition` seeks** (live or mixdown). A reverb tail is
  only valid relative to the dry input that fed it; seeking into the
  middle of a tail would synthesise audio with no real input history
  and is not reconstructible, so the policy is "seeks flush FX state;
  tails are only generated from future dry input". Live and mixdown
  follow the identical rule.
- Channel handling: every track runs as stereo internally (mono clips
  pan-law spread). Multichannel ≥3 is deferred to Phase 8.

**Preview routing preserved.** The current engine has a top mixer
combining project playback with Clip Editor / Library **preview**
audio before metering. The Phase 5 refactor **replaces the current
`mixer` (the inner `MixerAudioSource` child of `MasterClockSource`)
with `BusGraph`** but **keeps the existing `topMixer`** as the
project+preview summing seam before `MeteringSource`. Preview audio
does not flow through `BusGraph` — it remains a fully independent
top-mixer input that bypasses track FX, project FX, and sends. This
preserves "click a sample in the Library, hear it instantly"
behaviour and avoids preview audio accidentally ringing the shared
Reverb.

#### 7.9.2 Signal order

The signal path for every block, top-down:

```
clips[clipId]
  → OffsetSource (per clip: warp, in/out window, volume-shape envelope §7.11)
  → AudioTransportSource (read-ahead in live; direct read in mixdown)
  → TrackRuntime.preBuffer  (sum of all clips on this track)
  → TrackChain:
      Tone (3-band EQ)
      Filter (bipolar LPF↔HPF sweep)
      Leveler (Compressor)
      gain
      mute / solo gate
  → SEND TAP (pre-pan, post everything above)
      → wet ⊕= reverbSend × signal  → shared Reverb input bus
      → wet ⊕= delaySend  × signal  → shared Delay   input bus
  → pan (equal-power)
  → BusGraph.dryBus
  ┌───────────────────────────────────────┐
  │ Shared Reverb (pulled once)           │
  │ Shared Delay   (pulled once, BPM-sync) │
  └───────────────────────────────────────┘
  → wet returns ⊕= dryBus → master mix
  → MeteringSource (master gain + peak meter)
  → device output  /  mixdown writer
```

Sends are taken **pre-pan** so the shared FX see the centred, gain-
normalised, gated signal: this is a deliberate "simple cohesive room"
choice, **not** a claim that pre-pan is technically more correct than
post-pan. A pre-pan send means a hard-left guitar and a hard-right
synth both contribute to a centred Reverb — the room itself stays
spatially neutral and acts as glue across the whole mix. A post-pan
send would preserve each source's pan in the wet image, which can
sound more "realistic" but tends to muddy beginner mixes (the wet
chases the dry around the stereo field). The pre-pan choice is the
beginner-friendly default. Post-pan / per-track-insert reverb is
deferred to Phase 8 if users ask for it. Sends are **post-mute/solo
gate** so muting a track also kills its contribution to Reverb/Delay,
which is what users expect.

#### 7.9.3 Per-track controls (Phase 5 scope)

- `gain` (shipped) — linear, presented in dB via `lib/audio/db.ts`, range
  `-∞..+6 dB`.
- **Tone** — 3-band fixed-frequency shelving / bell EQ (Bass low-shelf,
  Mid peak, Treble high-shelf). Each band is `-15..+15 dB` with a 0 dB detent.
  No sweepable Q, no band count toggle.
- **Filter** — a single bipolar DJ-style sweep in `[-1, +1]` (0 = off /
  centre detent). Left of centre engages a 4th-order (24 dB/oct) low-pass
  (High Cut) gliding its corner down to ~250 Hz; right of centre engages a
  4th-order high-pass (Low Cut) gliding its corner up to ~2 kHz. A single
  continuous drag performs the classic LPF→HPF transition. Implemented by the
  same `ToneEq` cut stages, driven from one control.
- **Leveler** — single "Amount" knob (0..100 %) driving a curated path
  through a hand-rolled stereo-linked soft-knee compressor, with a
  deterministic static makeup-gain map (no live loudness analysis — see §7.10).
- **Reverb amount** — send into the one shared project reverb (0..100 %).
- **Delay amount** — send into the one shared project delay (0..100 %).
- **mute** / **solo** — surfaced on the track header.
- **pan** — equal-power, surfaced in the Track FX tab. In the **stereo**
  waveform display the timeline reflects pan per channel: each channel's
  lane height and opacity scale with its normalised equal-power pan gain,
  so a hard-panned channel collapses to a faint near-flat lane while the
  other stays full (a centred track leaves both lanes full).

#### 7.9.4 Project-level shared effects (Phase 5 scope)

- **Reverb** — `juce::Reverb` (the Freeverb implementation in
  `juce_audio_basics`, used directly so the backend keeps its single-module,
  no-`juce_dsp` build). Project-level parameters: Size, Decay, Tone, Mix.
- **Delay** — a hand-rolled integer-sample stereo delay
  (independent L/R lines, one-pole tone filter in the feedback path). Time set
  as a note value (1/4, 1/8, 1/8T,
  1/16) plus feedback amount; resolves to milliseconds via project BPM.
  **BPM-change policy:** the new delay time is staged on a parameter
  change but does **not** mutate the live delay line; it takes effect at
  the next transport start. This is deliberately the cheapest correct
  behaviour — live time changes would either cause pitch glides
  (single-head ramp) or require dual-head crossfading, neither of which
  is worth the implementation cost for a Phase 5 effect that's almost
  always set once per project. If real usage shows users sweeping BPM
  during playback we'll revisit in Phase 8.

Putting reverb/delay on a **shared instance with per-track send amounts**
(rather than per-track inserts) is a deliberate ethos call:

- One reverb of CPU instead of one per track.
- Coherent mix — every track is in the same room by default, which is how
  beginner-made mixes actually want to sound.
- Two-level mental model — "the song's room" is one thing you tweak once;
  "how wet each instrument is" is per-track.
- "Reverb on only the vocals" remains trivially achievable: set every
  other track's reverb send to 0.

The cost is that you cannot have **two genuinely different reverbs** at the
same time (e.g. cathedral on vocals + tight room on drums). That use case
is deferred to **Phase 8 per-track insert reverb / delay** if and when users
ask for it.

#### 7.9.5 Master bus

Stereo peak meter + dB fader in the transport bar (range `-∞..0 dB`, no
boost) backed by `PROJECT.masterVolume` / `PROJECT_SET_MASTER_VOLUME`;
same gain is applied to live playback and the mixdown render so the
exported file matches what the user hears. LUFS / RMS readouts and a
master Limiter are deferred to Phase 8.

#### 7.9.6 Live / mixdown render parity

The doc previously claimed "byte-equivalent". That overstates what is
achievable across live vs offline render (different read-ahead, device
resampling, encoder paths). The accurate guarantee, with all five
conditions met, is **sample-equivalent at the internal master float
bus**:

1. Both paths use the same `TrackChain` / `BusGraph` instances of the
   canonical chain, with identical parameter snapshots captured at
   render start.
2. Identical reset state — every DSP processor (shared Reverb, shared
   Delay, per-track Tone filters, per-track Leveler detector, master
   meter smoother) is reset to its prepared/initial state before the
   first block on both paths.
3. Smoothed parameters (master gain, Tone coefficients, pan law) have
   already settled to their targets before block 0 — at render start
   the smoother's current value is forced equal to its target, so
   first-block ramp state is not a divergence source.
4. Identical block partitioning — same `samplesPerBlock`, same
   alignment to the project timeline, no resampler read-ahead
   priming difference (live `AudioTransportSource` is allowed
   read-ahead in steady state but block 0 is forced to start from a
   primed-then-drained state matching mixdown's direct read).
5. No time-varying parameter edits during the render, no encoder, no
   dither randomness, no live device path.

When any condition is violated, the paths diverge in a bounded,
documented way (e.g. parameter edit mid-render is allowed in live but
not in mixdown; the encoded export is post-encoder, not master-bus).

**Regression harness:** pre/post-refactor mixdown of fixed test
projects must be sample-equivalent (tolerance `< 0.5 LSB at 32-bit
float`). Test matrix explicitly covers:

- First block (initialisation state divergence).
- Non-4096 block sizes — 256, 512, 4096.
- Projects that exercise smoothed parameters (master gain ≠ unity,
  non-flat Tone, panned tracks).
- Render starting at a **non-zero timeline position** that lands
  **mid-block** (not just at a block boundary).
- **Clips that start and end mid-block** (no alignment to block grid).
- **Envelope ramp crossing a block boundary** — a breakpoint segment
  split across two callbacks.
- **Breakpoints exactly at clip start and clip end**
  (boundary-of-segment math).
- **Adjacent clips on the same track** — back-to-back, no gap.
- **Overlapping clips on the same track** — both contributing
  simultaneously to `TrackRuntime.preBuffer`.

Without all of the above the harness can pass while live still
diverges from mixdown in real conditions.

#### 7.9.7 Deferred to Phase 8

- `juce::AudioProcessorGraph` migration of the engine core.
- Mixer view in the traditional sense (vertical channel strips).
- Bus / send routing UI as a first-class surface.
- Sidechain routing: any track can feed a sidechain input to any Leveler.
- Per-track insert reverb / delay (alternative to the shared sends above).
- VST3 plugin hosting via JUCE `AudioPluginHost` — track-vs-clip scope
  decided in Phase 8 once we've lived with the per-track model.
- Saturator and Utility (gain / phase / mono) effects — only added if real
  usage shows the need; the simple ethos is to ship fewer, well-explained
  effects.
- Master Limiter + LUFS / RMS readouts.
- Live delay-time changes during playback (BPM sweep).

**Status today:** per-track linear `gain` is shipped; master meter + fader
is shipped; mixdown export is shipped (see Phase 5 checklist). The
engine refactor (`TrackRuntime` + `BusGraph` + canonical `TrackChain`),
Tone, Leveler, Reverb / Delay sends, shared Reverb / Delay, pan / mute /
solo, and the per-clip Volume Shape are all Phase 5 work.

### 7.10 Effects (Built-in)

Minimum viable set, all implemented in the JUCE backend, intentionally small
and tuned to the non-pro audience. User-facing labels in **bold**, internal
DSP class in `code`.

**Per-track (one of each, baked into every Track):**

- **Tone** — 3-band fixed-frequency EQ: Bass (low shelf @ ~250 Hz),
  Mid (peak @ ~1 kHz, fixed Q), Treble (high shelf @ ~4 kHz), each
  `-15..+15 dB`.
- **Filter** — one bipolar DJ-style sweep in `[-1, +1]` (0 = off). Left of
  centre is a 4th-order **low-pass** (High Cut, 24 dB/oct) whose corner
  glides down to ~250 Hz; right of centre is a 4th-order **high-pass**
  (Low Cut, 24 dB/oct) whose corner glides up to ~2 kHz. Implementation:
  three biquad sections per channel for the shelves/peak + two cascaded
  biquads each for the high-pass and low-pass; the single Filter control maps
  exponentially to whichever corner is active while the other parks at
  identity. Coefficient updates use smoothed parameter changes on the audio
  thread to avoid zipper noise.
- **Leveler** — gentle dynamics control with one user-facing **Amount**
  knob (0..100 %) that drives a curated path through a hand-rolled
  stereo-linked soft-knee compressor (the engine carries no `juce_dsp`,
  so the compressor is written by hand) plus
  a **deterministic static makeup gain map** keyed off Amount only (no
  live loudness analysis, no perceived-loudness promise — the map is
  tuned by ear so the perceived level stays roughly comparable across
  the knob range, but it is not measured-and-compensated at run time).
  At 0 % the effect is bypassed entirely (a bit-exact passthrough); at
  100 % it is obviously squashed but remains clean. A planned **Advanced**
  disclosure would expose the four classic knobs (threshold,
  ratio, attack, release) plus an explicit makeup-gain field for users
  who know what they want; the shipped control is Amount-only. Detector
  state lives on the `TrackRuntime`
  (one per UI track), runs continuously during playback and resets only
  on transport stop — **never** at clip boundaries, which would cause
  audible thumps on adjacent clips on the same track. This is only
  achievable because `TrackRuntime` is decoupled from clips (§7.9.1).

**Project-level (one of each, shared by every track):**

- **Reverb** — `juce::Reverb` (Freeverb, `juce_audio_basics`). Parameters: Size,
  Decay, Tone, Mix. Each track contributes via its **Reverb amount** send (§7.9).
- **Delay** — hand-rolled integer-sample stereo delay (independent L/R lines +
  feedback + one-pole tone filter). Time is a note value (1/4, 1/8, 1/8T, 1/16);
  feedback,
  tone, and overall mix are independent. Each track contributes via its
  **Delay amount** send (§7.9).

**Per-clip (one of each, per Clip — see §7.11):**

- **Volume Shape** — breakpoint gain envelope edited on top of the clip
  waveform in the Clip Editor. Fade-in / fade-out are expressed by
  dragging the end breakpoints down to silence (there is no separate
  fade feature).

**Tail-render policy.** After every dry track has gone silent the
`BusGraph` keeps pulling the shared Reverb and Delay processors with zero
dry input so their tails ring out. The two FX use **different
termination detectors** because their tail shapes are fundamentally
different — a single rule cannot serve both without either truncating
Delay between repeats or running Reverb far past audibility.

- **Reverb** — monotonically-decaying dense tail. Independent
  safety cap **8 s**. Early termination when **post-processor stereo
  RMS** is below `-60 dBFS` for `N` consecutive blocks
  (`N = ceil(50 ms / blockMs)`), with **+3 dB hysteresis** (a tail that
  rose above `-57 dBFS` after starting to terminate restarts the
  count). RMS is computed once per block as
  `sqrt(mean((L² + R²) / 2))` over the whole block, stored in a small
  per-FX accumulator on `BusGraph`.
- **Delay** — sparse, repeating, gaps between hits routinely
  ≥250 ms and can exceed 1 s on long synced times. A 50 ms RMS rule
  would cut between repeats. Independent safety cap **4 s**.
  Feedback is **clamped to `[0, 0.95]`** in both the UI and the
  backend setter so the loop gain is always strictly less than unity
  (no self-oscillation; `log(feedback)` is always strictly negative
  and finite). Termination is **repeat-aware**:
  - **Hold window** = `delayTimeMs + 50 ms`. RMS-below-threshold must
    persist for the hold window (not just `N` blocks) before the FX
    can terminate. This guarantees the next repeat has had time to
    arrive.
  - **Analytic floor** (belt-and-braces) — at render start the engine
    computes the number of repeats `n` needed for the loop gain to
    fall below the linear amplitude threshold `T = 10^(-60/20) =
    0.001` from a reference initial repeat amplitude of `1.0`:
    `n = ceil(log(T) / log(feedback))` (with feedback clamped as
    above). The analytic tail length is `tailLenMs = n × delayTimeMs`.
    The FX cannot terminate before `tailLenMs` has elapsed since the
    last dry input, even if RMS reads silent (covers the case where
    a single quiet repeat dips below threshold mid-pattern). For
    stereo cross-fed delay topologies the implementation uses the
    spectral-radius / max-loop-gain of the feedback matrix instead of
    the scalar feedback in the same formula — never a per-channel
    scalar that ignores cross-feed.
  - The 4 s safety cap is the absolute upper bound; a runaway
    high-feedback echo at `feedback = 0.95` and a long delay time
    would be forcibly truncated there with a logged warning, not
    silently.

**Transport-aware behaviour.** Tail rendering kicks in only when the
dry input has actually gone silent. Live transport rules:

- **Playing past the last clip:** the transport keeps running and the
  shared FX tails ring out under the same termination rule used in
  mixdown. Once both FX have terminated, `BusGraph` outputs digital
  silence — the transport does not auto-stop.
- **Pause:** processors are **not reset**. Pulling stops mid-block,
  resume continues from the same processor state. Tails do not ring
  out during pause (no blocks are being pulled).
- **Stop:** processors **are reset** (Reverb reverb tank cleared, Delay
  delay line zeroed, Leveler detector zeroed). A subsequent Play
  starts from cold state.
- **Seek (`setNextReadPosition`)** in live or mixdown: processors are
  reset for the same reason — a tail is only valid relative to the
  dry history that fed it, and a seek invalidates that history.

**Mixdown loop invariant.** The mixdown render loop runs until
`(timelineDone && allSharedFxTerminated && addedSilenceDone)` is true.
`timelineDone` = the project's last clip has finished its dry output.
`allSharedFxTerminated` = both Reverb and Delay have hit either their
detector-based termination or their safety cap. `addedSilenceDone` =
the user's "silence tail" knob's frame count has been written after
FX termination. A **hard fail-safe cutoff** at
`projectEnd + max(roomCap, echoCap) + userTail` guarantees the loop
exits even if both detectors malfunction. The user-facing "silence
tail" knob in the Export dialog is **additive** on top of whatever
the FX tail produced — set it to 0 and the file ends the moment FX
tails terminate; set it to 2 s and you get FX tail + 2 s of digital
silence.

**UI surfaces.** Where each effect lives in the renderer:

- **Per-clip Volume Shape** — a breakpoint gain envelope edited directly on
  the clip waveform in the **Clip Editor**, toggled by the canvas toolbar's
  **Volume** button (see §7.11). There is no separate fade control, no
  timeline drag handles, and no standalone dialog; on the timeline the
  envelope is reflected in the waveform's height rather than as an overlay.
- **Per-track Tone / Leveler / Reverb amount / Delay amount** — surfaced
  in a new **Track FX** tab of the bottom panel (shares its space with
  the Library; tabbed surface with optional split view — see §7.12).
- **Project Reverb / Delay** — a small **Project FX** subtab within the
  same bottom panel area, or pinned at the top of the Track FX tab so
  it is always reachable. (Final placement decided during
  `tabbed-library-panel` work.)

**Deferred to Phase 8** (and explicitly NOT in Phase 5):

- VST3 plugin hosting via JUCE `AudioPluginHost`. Hosting scope
  (per-track vs per-clip) is decided in Phase 8 once the per-track
  model has shipped.
- Per-track insert reverb / delay (so a single track can have its own
  unique room without the shared one).
- Sidechain compression.
- Saturator and Utility (gain / phase / mono).
- Master Limiter.

### 7.11 Clip Volume Shape

Per-clip volume tailoring via the **Volume Shape** breakpoint envelope —
the **single** per-clip volume mechanism. The word "automation" never
appears in the UI. (A previously separate Fade In / Fade Out feature was
removed entirely; a fade-in / fade-out is now made by dragging the first /
last breakpoint down to silence. All `fadeInMs` / `fadeOutMs` storage, the
`CLIP_SET_FADES` / `PREVIEW_SET_FADES` / `CLIP_FADES_APPLIED` bridge
messages, the backend fade DSP, and the fade overlays are gone; legacy
project files load cleanly because the fade attributes are stripped on
load.)

Coordinates are in **timeline milliseconds relative to clip start** at
the project rate (post-warp, post-resample), not source-file time — so
the visible shape on a warped clip matches what the user hears. The
envelope is a list of `(clipTimeMs, gainDb)` breakpoints on the clip,
with the first and last breakpoints pinned to clip start / end. The
default envelope is two endpoints at 0 dB (unity). Interpolation is
**linear in dB** between adjacent breakpoints (linear in dB ≈ exponential
in gain, which is what "ramp down to silence" looks musically right), with
a smooth ramp into a true-silence breakpoint.

**Edit surface.** The envelope is edited directly on the clip waveform in
the **Clip Editor** (§7.14), in the cropped Clip view:

- A faint envelope line is **always drawn** over the waveform as read-only
  context.
- The canvas toolbar's **Volume** toggle turns that line into a breakpoint
  editor: click the curve to add a breakpoint, drag a breakpoint to move it,
  and `Alt`-click or right-click a breakpoint to remove it. The pinned start
  / end breakpoints keep their times and cannot be removed.
- Breakpoint placement is **freehand by default** so the shape can be as
  gradual or as sharp as the user wants; holding `Shift` while adding or
  dragging snaps the breakpoint to the nearest source beat.
- The **Silence** and **Full** toolbar buttons act as a **region gate**:
  with a sub-selection active they flatten that range to silence or full
  volume with **hard step edges**, leaving the rest of the shape untouched.
  This is the quickest way to chop a clean, non-fading section. The **S** and
  **F** keys are shortcuts for the same gate, so a selection can be silenced or
  restored without drawing the envelope.
- The breakpoint time axis spans the whole (cropped) clip, so it is obvious
  which part of the audio each breakpoint affects.
- In the **stereo** waveform display the single envelope line is mirrored
  and kept in sync across both channel lanes — editing a breakpoint in
  either lane edits the one shared shape, which the engine applies equally
  to both channels.

Edits commit transactionally on the Clip Editor's **Save** alongside the
other clip drafts (trim / warp / pitch); **Cancel** discards them. There is
no separate fades control and no standalone volume dialog — the on-waveform
editor is the only surface. While previewing inside the Clip Editor, draft
edits are auditioned live via a throttled `PREVIEW_SET_ENVELOPE` message so
the change is heard immediately.

**Backend (audio-thread data model).** The renderer holds the editable
breakpoint list; the backend stores it on the clip's `ValueTree` and
compiles it into an immutable **`EnvelopeSnapshot`**
(`backend/src/dsp/EnvelopeSnapshot.h`): a sorted flat array of
`(timeMs, gainLinear, gainDb)` points, built off the audio thread whenever
the points change. A snapshot with fewer than two points is treated as "no
envelope", so the common no-shape path is bit-identical to pre-envelope
output.

**Publication is a lock-free raw-pointer swap, not
`std::atomic<std::shared_ptr<…>>`** (which on MSVC may fall back to a mutex
and does refcount work on `load()` — both real-time violations). The owning
`Track` keeps the live `std::unique_ptr<EnvelopeSnapshot>`; the clip's
`OffsetSource` holds a non-owning `std::atomic<const EnvelopeSnapshot*>`.
The message thread builds the new snapshot, stores the pointer with
`std::memory_order_release`, and the audio thread loads it with
`std::memory_order_acquire` inside `applyEnvelopeGain`.

**Reclamation mirrors the `WarpProcessor` retire discipline.** A replaced
snapshot is pushed onto a per-track `retiredEnvelopes` vector rather than
freed inline — the audio thread may have just loaded the old raw pointer.
That vector is drained only at **quiescent windows** (transport pause / stop
and clip unload), when the audio thread is guaranteed not to be inside the
source, so no snapshot is freed while a callback could still be reading it.
There is no refcount, lock, or allocation / free on the audio thread.

The envelope gain is applied **inside `OffsetSource`** — the per-clip stage
that already owns the warp / offset read — using **clip-local post-warp
milliseconds**, so the breakpoint times line up with what the user sees and
hears on a warped clip. `applyEnvelopeGain` multiplies the same gain into
every channel and bails immediately when no snapshot is installed. Mixdown
applies the identical stage so live and offline outputs match.

**Bridge envelopes:** `CLIP_SET_ENVELOPE { clipId, points: [{timeMs, gain}] }`
(`gain` is linear in `[0, 4]`, `1.0` = unity). _(The historical
`CLIP_SET_FADES` envelope was removed along with the fade feature.)_

- **Drag-time granularity.** While the user is dragging a handle or
  breakpoint, the renderer emits throttled updates at **~25 Hz** (and
  always on the final pointer-up) so live audio scrubs continuously
  without melting the bridge. The renderer mints a fresh
  **`gestureId`** on pointer-down and tags every message in the
  gesture with it; pointer-up sends a final message with a
  `gestureEnd: true` flag. The backend coalesce key is
  `(messageType, targetId, gestureId)`: while a gesture is open all
  messages with that key fold into a single
  `UndoManager::beginNewTransaction` block; the `gestureEnd` message
  closes the transaction. **Recovery from lost `gestureEnd`:** if no
  message for an open `gestureId` arrives for **1 s**, the backend
  auto-closes the transaction (covers dropped IPC frames). On bridge
  disconnect / session reset, all open gestures are force-closed.
  When `gestureId` is absent (e.g. a numeric field commit in the
  dialog) the backend falls back to the existing time-window
  coalescing in `BridgeDispatch.cpp` for backward compatibility — one undo
  step per gesture, regardless of how many intermediate messages
  flowed.
- `CLIP_SET_ENVELOPE` is registered in the hardcoded undoable type list
  and the coalesce-key map. `PREVIEW_SET_ENVELOPE` is preview-only —
  applied directly to the Clip Editor preview voice, never undoable and
  never persisted.

**Persistence.** The envelope is suppressed from the saved `.silverdaw`
JSON when at its default (two pinned end points at unity gain) so
existing project files remain bit-clean. The
`ProjectStateClipSchema` (`bridge-protocol.ts`) and
`ProjectState::tracksAsJson` are explicitly extended to round-trip the
`envelopePoints` field — without this, undo/redo soft-replace and
reconnect would silently drop it.

**PixiJS rendering.** There is no always-on per-clip envelope overlay on
the timeline (no polyline, no breakpoint handles). Instead the clip's
volume envelope is **reflected in the waveform itself**: each rendered
column's height is scaled by the envelope gain sampled at that column's
point in time (clip-local post-warp ms), so a fade-out visibly tapers
toward nothing and a dip shows as a notch. This applies to both the single
summary lane and the stereo lanes (composing on top of the per-channel pan
scaling — see §7.9.3), and to mono and stereo sources alike. Unity gain
renders identically to an unenveloped clip, and greater-than-unity boosts
are clamped to the lane so the waveform never spills outside the clip
block; the clamped excursion maths is the pure, unit-tested
`waveformColumnExcursion` helper (`frontend/.../lib/timeline/waveformColumn.ts`).
No extra Pixi children are mounted for this — the existing per-column
min/max scan is scaled in place — so it stays cheap at zoomed-out views
with many clips. The editable envelope line and breakpoint handles live
only in the **Clip Editor**, drawn over its waveform.

**Deferred to Phase 8:** pan envelopes, send-level envelopes, plugin
parameter envelopes — all built on top of the same `EnvelopeSnapshot`
primitive once it has shipped.

### 7.12 Sample Browser & Library
- Current implementation is a project-scoped **LibraryPanel** of imported audio items and **saved clips**; user-scoped folder scanning is deferred to Phase 8
- Preview playback through the Clip Editor preview voice is implemented for any library tile; preview-at-project-BPM is deferred to Phase 8
- Displays duration, detected key, stable/variable BPM badges and coloured key badges per file
- **Drag-to-timeline** creates a clip at the drop position; auto-warp can match
  eligible clips to the project BPM when the preference is enabled
- **Saved clips** — right-click a timeline clip → **Save clip to library** turns its trim window into a reusable library entry. Saved clips are non-destructive references back into their source file (same audio, same WAV cache, same BPM/key) and preserve the clip's warp defaults, grouped underneath the source they came from with a disclosure chevron whose open/closed state persists with the project. Dragging a saved-clip tile onto a track creates a **linked timeline clip**: it stores the saved-clip's library id, shows a small chain badge in its title strip and is blocked from edge-resize on the timeline. The Clip Editor's **Apply trim** propagates the new window to every linked timeline instance atomically (collision-checked per track). Right-click ▸ **Unlink from library** rebinds the instance to the underlying audio-file item, preserving its current window. Saved-clip removal silently unlinks every dependent timeline clip first — the audio plays on as an independent clip referencing the underlying source file. The Clip Editor's **Save as new clip** is the second producer of saved clips.
- **Tile images:** library tiles can show embedded cover art or the fallback audio icon; this is toggleable via the persisted `uiStore.showLibraryTileImages` preference. List view is deferred to Phase 8.
- **Inline rename:** single-click the name on any library tile (or pick **Rename…** from the right-click menu) edits it inline. Saved clips inherit a sensible default name from their source + offset.
- **Vertical scroll:** virtualised list once item count exceeds visible height; library never overflows the panel.
- **Tags:** Phase 8 chip-input on each card, stored on library items.
- **Search & filter:** Phase 8 debounced text search across filename / tags / detected key. Quick filters by tag chip; sort by name / BPM / duration / date added.
- **Library item information dialog:** pick **Show information** from a library tile's right-click context menu (double-clicking the tile opens the Clip Editor instead) → opens a non-blocking dialog with file path, decoded cache path, sample rate, channel count, duration, detected BPM / key, embedded metadata (artist / title / cover art), and a list of every track on the timeline where this file is currently placed. Tag editing and jump-to-clip links are Phase 8 polish.
- Rendered in Vue (panel) + Pixi (waveform thumbnails); no Pixi for the list cards.

### 7.13 Project Save / Load

Projects are persistent on disk as a single `.silverdaw` JSON file. The current
implementation round-trips the backend-owned project tree plus selected view
state; user preferences such as panel sizes remain in `preferences.json`.

- **Format:** versioned JSON serialisation of the backend's `ValueTree`.
  Each node maps to an object such as
  `{ "$type": "TRACK", "id": "...", "$children": [] }`. Saves are atomic:
  the backend writes a sibling `.tmp` file and renames it into place.
  Audio imports are currently referenced by absolute path; project-local
  captured assets remain future sample-creation work.
- **What is saved:**
  - **Project metadata** — schema version, app version, saved-at timestamp,
    project name, BPM and project length.
  - **Tracks** — id, name, gain, `heightPx` (when explicitly set) and ordering.
  - **Clips** — id, `libraryItemId` (clips reference their audio via the
    library, not a raw file path), timeline `offsetMs`, source `inMs`,
    `durationMs`, optional per-clip `colorIndex`, optional `clipName`
    override, optional `locked` flag (per-clip — see §7.5), and owning
    track by placement in the `TRACK` node.
  - **Master volume** — linear gain in `[0, 1]` on the PROJECT root as
    `masterVolume`; absent == unity (and suppressed from save when at
    unity to keep older projects bit-clean). UI presents it in dB via
    the shared `lib/audio/db.ts` taper.
  - **Mixdown export settings** — a single opaque `exportSettingsJson`
    string on the PROJECT root (capped 64 KB) holding the last-used
    Export Mixdown dialog choices (format, sample rate, bit depth,
    bitrate / quality, dither, tail, loudness mode + target, tags,
    output path). Parsed with field-level whitelist / clamp /
    schema-version guards. Edits don't enter the undo history (only
    mark dirty) so re-exports don't pollute it.
  - **Transport / view state** — playhead position, horizontal zoom and
    horizontal scroll. View-state-only saves do not mark the project dirty.
  - **Library catalogue** — every library item with id, kind
    (`audio-file` / `saved-clip`), name, source path, detected BPM/key,
    beat positions, beat anchor, variable-tempo flag, decoded playback
    cache path, duration, channel count, sample rate, and (for saved
    clips) `derivedFrom` source-window pointers. Cover art and tag
    metadata are not serialised inline; they are re-read async from the
    source file on load via `audio:readMetadata`.
  - **Timeline markers** — marker id and absolute project position.
- **What is NOT saved:** undo history (always empty on load),
  `PROJECT_STATE` reconnect tokens, audio engine caches (peaks cache lives
  in `%APPDATA%`), cover art, in-flight import progress, selection state,
  library search / sort state.
- **File validity on load:** the backend walks every referenced file and
  `stat()`s it. Missing files mark their clips and library items as
  "unresolved" (rendered greyed-out, audio silent for that clip) and the
  renderer surfaces a single grouped toast listing them with a "Locate
  files…" button that opens a per-file relink dialog.
- **Dirty tracking:** every mutation to the `ValueTree` flips an
  `isDirty` flag on the backend; the bridge mirrors it to the renderer.
  The title bar shows the project name with a leading `•` when dirty.
- **Auto-save / crash recovery:** implemented. A dirty project is silently
  snapshotted into `%APPDATA%/Silverdaw/autosave/<projectId>/` every
  30 s (user-configurable in Preferences ▸ Project ▸ Autosave). On launch
  the **RecoveryDialog** offers to restore any project whose autosave is
  newer than its backing file (or whose backing file is missing /
  untitled). Choosing **Don't save** in the unsaved-changes prompt
  clears the project's autosave bucket before the app exits so a
  conscious discard isn't resurrected as crash recovery on the next
  launch.
- **Recent projects:** implemented as an MRU list (max 10, case-
  insensitive dedupe) persisted in `preferences.json`, surfaced under
  `File ▸ Recent Projects ▸` and on the Start Screen list.
- **Unsaved-changes guard:** `File > New`, `File > Open…`, and quit all
  prompt to save the current project if `isDirty`.
- **New project flow:** `File > New Project` creates an empty in-memory
  project with the default `Untitled` name; it isn't bound to a file path
  until first save.
- **Bridge envelopes:** `PROJECT_NEW`, `PROJECT_SAVE { filePath? }` (no
  path = save to current), `PROJECT_SAVE_AS { filePath }`, `PROJECT_LOAD
  { filePath }`, plus acks `PROJECT_SAVED { filePath, ok }`,
  `PROJECT_LOAD_FAILED { error }`, and a `PROJECT_DIRTY { dirty }`
  notification driven by `ValueTree` listener callbacks.

### 7.14 Clip Editor Window

Implemented. Opens from any library tile via double-click or right-click
→ **Open in editor…**. Wired up via a backend **preview voice** that
sits in its own branch of `AudioEngine.topMixer`, independent of the
project transport.

- Full-source waveform at the renderer's px-per-second scale for
  audio-file items, zoomed-to-fit for saved-clip items. Adaptive time
  ruler with relative-to-clip labels.
- Beat lines extrapolated from the source's detected BPM + beat
  anchor across the whole view (so split / trim sub-clips stay in
  lockstep).
- Zoom (1×–64×) + horizontal scroll: `+` / `-` / `0`, mouse-wheel
  anchored at the pointer, `Shift+wheel` to pan, plus a click-and-drag
  scrubbable scrollbar. The dialog opportunistically requests a
  hi-res (2000 peaks/sec) peaks rendering for the active library item
  via `CLIP_EDITOR_PEAKS_REQUEST` / `CLIP_EDITOR_PEAKS_READY` once the
  user zooms past where the default 500 peaks/sec cache stops looking
  crisp; the hi-res cache is keyed on `(filePath, peaksPerSecond)`
  so it sits alongside the default cache on disk rather than evicting
  it.
- Independent transport (Skip-to-start / Play-Pause / Skip-to-end),
  `Space` scoped to the dialog while it's open.
- Click on waveform → seek the preview playhead. Drag → mark a
  sub-selection. Selection-bounded playback: with a selection set,
  Play starts from the selection start and stops (or loops) at the
  selection end. The selection edges carry triangular handles for
  fine-tuning that drag just the matching edge.
- **Source / Clip view toggle** lets the user widen the working range
  beyond a saved clip's current bounds (Source) or narrow back to the
  cropped range (Clip). Switching back from Source carries the
  current selection across so a coarse range painted on the full
  source can be tightened at clip-level zoom.
- **Crop** narrows the in-dialog view to the current selection
  non-destructively (no project mutation). Ctrl+Z / Ctrl+Y inside the
  dialog walk a Crop-only undo stack scoped to the dialog itself —
  the project-level undo history is untouched until the user
  explicitly commits via Apply trim or Save as new.
- Keyboard selection via Shift+Arrow uses a text-editor-style
  anchor model: first press anchors at the playhead (or the opposite
  edge of an existing narrowing selection); subsequent presses move
  the playhead and grow / shrink the selection. `Alt` modifier swaps
  beat-snap for 1 ms steps. Any non-shift seek clears the anchor.
- Loop toggle (`L`): loops the current selection — or the whole
  saved clip if no selection is set. Source files only loop when an
  explicit selection is set (the source file itself is immutable).
- Smooth ease-in catch-up follow during playback, matching the main
  timeline's behaviour.
- **Volume Shape editor.** In the cropped **Clip** view a faint volume
  envelope is always drawn over the waveform; the canvas toolbar's
  **Volume** toggle makes it editable — click the curve to add a
  breakpoint, drag to move one, `Alt`-click / right-click to remove
  (pinned start / end breakpoints stay). Placement is freehand by
  default; hold `Shift` to snap to the nearest source beat. The
  **Silence** / **Full** buttons gate the current selection to a flat
  level with hard edges. In the **stereo** waveform
  display the single shape is mirrored and kept in sync across both
  channel lanes. Edits commit on **Save** with the other drafts and are
  auditioned live in the preview voice via `PREVIEW_SET_ENVELOPE` (see
  §7.11).
- **Waveform display** honours the `ui.waveformDisplayMode` preference:
  a single summary waveform or stacked left / right lanes for stereo
  sources, matching the timeline.
- **Save as new clip** writes a new saved-clip entry to the library.
- **Apply trim** (saved clips only) updates the saved-clip's
  `derivedFrom` window in place AND propagates the new window to
  every linked timeline clip atomically. The push is collision-
  checked against each linked clip's track — refused with a toast
  naming the offending track(s) if the new range would clash with a
  neighbour, leaving the user to resolve (or unlink) before retrying.
- Linked-clip model: clips dropped from a saved-clip tile remember
  the link via `clip.libraryItemId === savedClipItemId`. Linked
  clips show a chain badge on the timeline title strip and are
  blocked from edge-resize (`hitTestClipEdge` returns null when the
  clip is linked) so an in-place trim can't desync a sibling. Right-
  click ▸ **Unlink from library** rebinds the instance to the
  underlying audio-file item — the trim window is preserved exactly
  by the rebind — so the user can freely resize a single instance.
  Saved clips can also be removed from the library while still in
  use: the remove silently unlinks every dependent timeline clip via
  the same rebind, no destructive prompt needed.
- Bridge envelopes: inbound `PREVIEW_LOAD` / `PREVIEW_PLAY` /
  `PREVIEW_PAUSE` / `PREVIEW_STOP` / `PREVIEW_SEEK` / `PREVIEW_UNLOAD`
  / `PREVIEW_SET_ENVELOPE` / `CLIP_EDITOR_PEAKS_REQUEST` / `CLIP_REBIND`
  / `CLIP_SET_ENVELOPE`; outbound
  `PREVIEW_STATE` / `PREVIEW_POSITION` / `PREVIEW_ENDED` /
  `CLIP_EDITOR_PEAKS_READY`. A monotonic `generation` counter on the
  preview voice silently drops stale events for a preview the user
  has already closed.
- The Clip Editor opens from a timeline clip too — double-click a clip
  body (off the title strip) on the timeline (see the keyboard & mouse
  reference in the developer guide). Trim / warp / pitch / volume-shape
  edits are held as a draft until **Save**, whose scope follows the
  clip's linked / unlinked state.

### 7.15 Audio Format Support
- JUCE-native formats (WAV / AIFF / FLAC + MP3/WMA on Windows) decode directly on the backend.
- Unsupported formats that Web Audio can decode currently route through the
  renderer's Web Audio + temp-WAV detour.
- Later ffmpeg support can move unsupported-format decoding out of the
  renderer and improve codec coverage, producing a WAV in the transcode cache
  that the backend can load. It is deferred until after core DAW workflows
  because the current Web Audio + temp-WAV path already serves playback when
  Web Audio can decode the file.

---

## 8. Implementation Plan

### Agreed near-term sequence

The current focus order, ahead of the longer phase list below:

1. **Finish Phase 5 mixing & core effects** — building on the shipped Tone
   controls, Volume Shape, Reverb + Delay, mute/solo/pan, and the per-track
   Leveler. **Clip transitions (§12.1) are pulled in as part of this work**, since
   they build directly on the per-clip Volume Shape, Tone EQ and the shared Delay.
2. **Fast import-to-arrangement (§12.6)** — promoted up the list as a core remix
   accelerator, tackled once the core effects are in place.
3. **Stem support (Phase 6)** — the next major focus after the above.

MIDI/scratch (§12.9) and recording (§12.8) remain high-interest but sit after
this near-term sequence. Final ordering beyond this is still under review.

### Phase 1 — Backend Foundation & Bridge

**Goal:** JUCE backend plays audio. Electron connects, controls transport, sees the playhead move.

**JUCE backend:**
- [x] Headless JUCE application skeleton (no UI components)
- [x] `AudioEngine`: master transport clock + per-track latency-compensation plumbing (current implementation uses `MixerAudioSource`; `AudioProcessorGraph` migration deferred to Phase 5 alongside mixer/effects work)
- [x] File import pipeline: `AudioFormatManager`, basic clip player
- [x] `ValueTree` project state and `UndoManager`
- [x] WebSocket server: loopback bind, dynamic port, AUTH handshake, text-only JSON
  control plane, command handling and event broadcast
- [x] `PLAYHEAD_UPDATE` emitter at 60Hz during playback
- [x] `WAVEFORM_READY` emitter backed by an on-disk `PeaksCache`; the renderer
  reads the cache file through main-process IPC instead of receiving peak bytes
  over WebSocket

**Electron frontend:**
- [x] electron-vite scaffold: Electron + Vue 3 + TypeScript + Pinia
- [x] WebSocket client service: fetches port/token from Electron main, authenticates
  with the backend and dispatches text JSON envelopes to Pinia stores
- [x] `transportStore` and `projectStore` skeleton, library + notifications stores
- [x] Transport bar UI: play/pause, BPM display, position counter
- [x] PixiJS canvas mounted in `TimelineView`: grid, beat markers, header column, scrollbars
- [x] Playhead rendering in PixiJS, driven by `PLAYHEAD_UPDATE`
- [x] Clip blocks rendered in PixiJS with waveform peaks overlay
- [x] Unified `StartupScreen` overlay blocks UI input until backend + `PROJECT_STATE` are live; bridge-failure timeout (30 s) flips it to a Quit-only error mode

**Phase 1 closeout:**
- [x] Master transport clock + latency compensation
- [x] Backend `ValueTree` + `UndoManager` + `PROJECT_STATE` on connect
- [x] Backend-emitted waveform peaks (now: text `WAVEFORM_READY` envelope + on-disk cache file read by the renderer via the `peaks:readCacheFile` IPC; binary frames retired)
- [x] Library analysis flow: current implementation uses `LIBRARY_ITEM_ANALYSIS` for BPM/beat/cache metadata and renderer key detection persisted on `LIBRARY > ITEM.key`
- [x] Clip context menu (delete, duplicate, split, colour, save clip, save as sample, warp settings; placeholder for transpose)
- [x] Alt-modifier to bypass snap during drag/drop (Alt-click on ruler, Alt-drag clips, Alt-arrow for 1-px playhead nudges)

### Phase 2 — Clips & Drag and Drop

**Goal:** Import a file, see it on the timeline, drag it around, hear it play.

- [x] File drop onto timeline: sends `CLIP_ADD`, renders clip on `CLIP_ADDED`
- [x] Clip drag-and-drop in PixiJS: move along timeline and between tracks
- [x] Beat grid snapping in frontend (quantise position before sending command)
- [x] Project-scoped library panel: imported-item tiles with duration, detected key and BPM display *(tags / list view / search are deferred to Phase 8 unless needed sooner)*
- [x] Drag from library panel to timeline
- [x] Vertical scrollbar in the library panel; never overflows
- [x] Analysis metadata is item-scoped rather than clip-scoped: library items receive BPM/beat/key metadata and clips render source beat markers from that data
- [x] Clip context menu: delete + save as sample + warp settings, with transpose placeholder

### Phase 3 — Project Save / Load

**Goal:** Users can save, reopen and recover full project state — including
library, transport, UI layout and per-clip edits — from a single
`.silverdaw` file.

**File format & I/O:**
- [x] `.silverdaw` file format: versioned **JSON** serialisation of the
  `ValueTree` (each node mapped to `{ "$type": "TRACK", id: "...", $children: [ … ] }`
  via the generic `ValueTreeJson` converter). Atomic save via sibling
  `.tmp` + rename. Audio files referenced by absolute path; a separate
  generated sample WAVs are written under a `Samples` folder by the
  sample-export flow.
- [x] Schema version marker + forward-compatible "ignore unknown nodes"
  loader; load aborts cleanly on a too-new schema with a user-facing toast
- [x] `PROJECT_NEW`, `PROJECT_SAVE`, `PROJECT_SAVE_AS`, `PROJECT_LOAD`
  envelopes; acks `PROJECT_SAVED`, `PROJECT_LOAD_FAILED`
- [x] OS open / save-as dialogs in Electron main; `*.silverdaw` filter;
  default project folder preference (`<home>/Music/Silverdaw/`)
- [x] Path tracking on the backend (`ProjectSession::currentPath`)
  drives title bar + "Save" vs "Save As" behaviour

**State coverage:**
- [x] Persist track structural fields (id, name, gain, mute, solo) and clip
  fields (id, source path, offsetMs, inMs, durationMs, colorIndex). Mute/solo
  are stored on the track node and serialised with the project tree
  (`ProjectState::setTrackMuted` / `setTrackSoloed`; suppressed when false).
- [x] Persist transport playhead position; loop region + metronome flag
  deferred until those features exist.
- [x] Persist project metadata: name (with rename), BPM (2 d.p.), project
  length, savedAt ISO timestamp. Time signature is fixed 4/4 today.
- [x] Persist library catalogue as a `LIBRARY > ITEM[...]` sub-tree
  of `PROJECT`, including id, source path, display file name, duration,
  sample rate, channel count, detected key, decoded playback cache path,
  BPM, beat positions, beat anchor and variable-tempo flag. Cover art /
  ID3 tags re-fetch async on load via existing `audio:readMetadata` IPC.
- [x] Persist manual timeline markers as `MARKERS > MARKER[id, positionMs]`
  and restore them through `PROJECT_STATE`.
- [x] Persist view state: zoom (`viewPxPerSecond`), scroll position
  (`viewScrollX`) and playhead (`playheadMs`) without marking the
  project dirty. Selection and library view mode + sort/filter remain
  deferred to the Phase 8 library-browser polish pass; panel sizes live
  in user preferences.

**Dirty tracking & lifecycle:**
- [x] `ProjectState` listener marks the project dirty on any mutation;
  view-state property setters suppress the transition.
- [x] `PROJECT_DIRTY { dirty }` notification + renderer mirror in
  `projectStore.isDirty`
- [x] Title bar shows project name + leading `•` when dirty
- [x] `File > New`, `File > Open…`, app quit prompt to save when dirty

**Auto-save & recovery:**
- [x] Auto-save every N seconds while dirty (default 30 s, user-configurable
  in Preferences → Project → Autosave; clamped 5..600 s) to
  `%APPDATA%/Silverdaw/autosave/<projectId>/`
- [x] Final auto-save flush on `before-quit`
- [x] On launch: if any autosave is newer than its backing file, the
  `RecoveryDialog` lists every recoverable entry and offers to Restore
  (load the autosave and mark dirty so the user must explicitly Save)
  or Skip

**Recent projects & start screen:**
- [x] MRU list (up to 10, case-insensitive dedupe on Windows) persisted
  in `preferences.json`
- [x] `File > Open Recent ▸` submenu populated from the MRU (top 5 in the
  menu; full list in the start screen)
- [x] Unified `StartupScreen` overlay: mounts on app boot, walks an
  inline status row ("Waiting for backend → Connecting to audio
  engine → Scanning audio devices → Checking for recovered projects →
  ready"), shows logo + "New Project" / "Open Project…" / Recent
  Projects list once ready. On terminal bridge failure (30 s
  watchdog) the whole screen swaps to a focused error view with a
  single Quit action. `RecoveryDialog` stacks above it.

**Unresolved files & relink:**
- [x] On load, `stat()` every referenced clip + library path; missing
  files mark items unresolved (greyed-out clip block + red border,
  silent playback)
- [x] Auto-popping `RelinkDialog` listing every missing file with a
  *Locate file…* button per row; single info toast summarises the
  count. Right-click **Relink…** entry on unresolved clips re-enters
  the flow later.
- [x] `CLIP_RELINK { clipId, filePath }` envelope; backend updates the
  path in the `ValueTree`, re-creates the engine source, rebroadcasts
  `PROJECT_STATE` which clears `unresolved` on the relinked clip. Marks
  the project dirty as a normal property edit.

### Phase 4 — Analysis, Browser & Editing

**Goal:** Full import-to-arrangement pipeline works end to end with
detected BPM/key, warp, region selection, and a tag-aware library.

**Detection & warp:**
- [x] Rubber Band integration: per-clip real-time warp engine with rhythmic / tonal / complex modes and independent pitch controls
- [x] BTrack integration: BPM **and beat-position** detection on import (vendored at `backend/third_party/btrack/` with two MSVC-compatibility patches; runs on the existing peaks worker pool; reported BPM is derived from the median beat-interval for tight self-consistency, and a `variableTempo` flag is set when the per-beat tempo samples spread > 5 %)
- [x] Renderer key detection on import: Web Audio decode + chroma profile + major/minor templates; stored as `LIBRARY > ITEM.key` and shown on library tiles / info dialog with key-coloured badges
- [x] First-clip BPM seeds project BPM on an otherwise-empty project (no other clips on tracks and no other analysed library items — runs even for variable-tempo sources, with the user free to override later in the Transport bar)
- [x] Library tile shows detected key and BPM next to the duration with an amber `~ BPM` badge for variable-tempo sources; round-trips through `LIBRARY > ITEM[key, bpm, beats, beatAnchorSec, variableTempo, playbackFilePath]` on save/load
- [x] Beat markers drawn on the clip waveform — synthesised on a source-global beat grid (`beats[0] + N × 60/sourceBPM`) so split / duplicate / trim sub-clips stay in lockstep
- [x] Drag-snap on a clip uses the same source-global beat grid: the first source beat inside the clip snaps to the nearest project sub-beat (Alt to bypass for ms-precise drag)
- [x] Floating processing panel surfaces staged progress (preparing audio → analysing tempo → analysing beats → applying warp when needed) for both import and reanalysis; OS busy cursor stays in `progress` for the whole lifespan
- [x] Manual timeline markers: `M` toggles a marker at the nearest playhead grid point, double-clicking the ruler toggles at the nearest grid point, drag moves markers with grid snap, duplicate markers on the same grid point are refused, `Ctrl+←/→` jumps between markers and scrolls them into view, and markers persist as `MARKERS > MARKER[id, positionMs]`
- [x] Auto warp-to-project-BPM on clip drop/import, gated by the General preference and late-applied after BPM analysis when needed
- [x] Clip pitch shift UI: semitone field + cents trim in the Warp settings dialog / context menu

**Region selection + clip editing:**
- [x] Drag-select region on a clip (snap + Alt-bypass)
- [x] Mark-points selection (`[` / `]` at playhead)
- [x] Trim clip non-destructively by dragging either edge (ms-precise; updates `inMs` / `durationMs` atomically via `CLIP_TRIM`)
- [x] Crop clip to region (non-destructive: edit in/out points in ValueTree)
- [x] Split clip at playhead (`S` key + Edit menu + clip context menu — splits every clip whose timeline window straddles the playhead)
- [x] Duplicate clip (`D` key + Edit menu + clip context menu + right-click — lands immediately after the source, toast when no space)
- [x] Delete clip (`Delete` key + Edit menu + clip context menu)
- [x] Cut / Copy / Paste clips (`Ctrl + X` / `Ctrl + C` / `Ctrl + V`); paste lands after the source clip on its track, or at the playhead when pasting onto a different (selected) track; toast when the destination slot is occupied
- [x] Clip selection (thicker outline) + track selection (highlighted row border) — drives the Cut/Copy/Paste/Duplicate/Delete target
- [x] Per-clip colour override — right-click → inline 16-swatch palette, persisted as `colorIndex` on the clip and round-tripped via `CLIP_COLOR`
- [x] Cross-track clip drag — drag a clip into another row to re-parent it (extended `CLIP_MOVE { clipId, positionMs, trackId? }`)
- [x] No-overlap rule on same-track clip drag (magnetic edge snap so adjacent clips play seamlessly)

**Sample creation:**
- [x] `CLIP_SAVE_AS_SAMPLE` / `LIBRARY_ITEM_SAVE_AS_SAMPLE` → `SAMPLE_SAVED` writes a WAV under the project/default `Samples` folder and adds it to the browser as a normal audio-file item
- [x] Context-menu sample creation from timeline clips and saved-clip library tiles
- [x] Warped timeline clips and warped saved clips render through a fresh offline Rubber Band processor so the baked sample matches the clip's tempo/pitch state

**Library upgrades:**
- [x] Library item information dialog (double-click / context menu): file path, decoded cache path, sample rate, channel count, duration, detected BPM / key, embedded metadata, cover art and "used on" track list. Tag editor and jump links are deferred to Phase 8.

### Phase 5 — Mixing, Effects & Automation

**Goal:** A remix project sounds polished, using a deliberately small
set of well-explained effects in a UI that matches Silverdaw's
non-pro audience. See §7.9, §7.10, §7.11 for the user-facing design.

**Foundational work first.** The current `AudioEngine::tracks` map is
keyed by **clip id**, with one `AudioTransportSource` per clip mixed
straight into the top `MixerAudioSource`. Per-track DSP, shared sends,
and continuous Leveler state across clips on the same track are all
impossible against that topology. **Steps 1a–1d and step 2** below are
pure refactors (no user-visible features) that ship a new engine
shape which is sample-equivalent to the old one. They are split into
incremental commits so the engine remains playable after every commit.
Every later step builds on them.

**Build order** (each step ships independently and the engine remains
playable at every point — no broken-build day):

- [x] **1a. `TrackRuntime` passthrough adapter.** Introduce
  `TrackRuntime` (one per UI track, owns a stable per-track output
  buffer, independent of clip count). Add **separate**
  `trackId → TrackRuntime` and `clipId → TrackRuntime` indices on
  `AudioEngine`; **do not change the existing clip-keyed `tracks`
  map or any clip-keyed call sites yet** (in `AudioEngine.*` and the
  mixdown clip enumerations). `TrackRuntime` sums clip outputs
  into its per-track buffer and still pushes into the existing
  `MixerAudioSource`, taking over the role of being the thing the
  mixer pulls — individual clip transports are **no longer also
  pulled** by the top mixer (avoids double-pull). Pure runtime
  grouping change; **no on-disk format impact** — the persisted
  `.silverdaw` schema already stores `TRACK { CLIP }` nesting
  (`ProjectFile.h`), so this is **not** a schema migration.
  Acceptance: existing playback and mixdown are **sample-equivalent**
  to pre-change for fixed test projects (summing order may differ in
  the last bit of float math, so byte-identical is too strict; the
  parity harness tolerance is `< 0.5 LSB at 32-bit float`).
- [x] **1b. Canonical `TrackChain` (empty).** Define the
  `TrackChain` abstraction (Tone → Leveler → gain → mute/solo, all
  no-op for now) and run it inside `TrackRuntime` for every block.
  `MixdownEngine` is refactored to consume the same `TrackChain`.
  Acceptance: parity harness (§7.9.6 conditions a–d) passes — first
  block, non-4096 block sizes, smoothed-parameter projects, non-zero
  start positions.
- [x] **1c. `BusGraph` swap.** Replace `MixerAudioSource` as the root
  pull source. `BusGraph` owns block lifecycle, preallocates all
  scratch buffers in `prepareToPlay`, pulls each `TrackRuntime`
  exactly once and the (still empty) shared FX exactly once per block.
  Preview routing is preserved as a separate top-level mixer input
  alongside `BusGraph` (§7.9.1). Acceptance: parity harness still
  passes; live playback indistinguishable from pre-swap; preview
  audio still works.
- [x] **1d. Mixdown on the canonical chain.** Wire `MixdownEngine` to
  the same `TrackChain` and `BusGraph` topology with the new tail
  rule (§7.10) but no FX in the chain yet. Acceptance: pre/post
  refactor mixdown sample-equivalent at the master float bus for
  fixed test projects under the five conditions in §7.9.6.
- [x] **2. Bridge protocol no-op compatibility layer.** _(Landed
  incrementally alongside steps 3 / 6 rather than as one commit; the
  `TRACK_SET_PAN` envelope landed with step 9 and `TRACK_SET_MUTE_SOLO`
  ships as the existing `TRACK_MUTE` / `TRACK_SOLO` envelopes.)_
  Extend
  `ProjectStateClipSchema` (`fadeInMs`, `fadeOutMs`, breakpoints)
  and `ProjectStateTrackSchema` (`toneBassDb`, `toneMidDb`,
  `toneTrebleDb`, `toneFilter`, `levelerAmount`,
  `levelerAdvanced{…}`, `reverbSend`, `delaySend`, `pan`, `mute`,
  `solo`) plus `PROJECT_REVERB` / `PROJECT_DELAY` blocks **as
  optional fields with defaults**. Extend
  `ProjectState::tracksAsJson` and `applyProjectStateSnapshot` to
  read/write them with **default-suppression on save** (so projects
  that don't touch any Phase 5 field remain bit-identical on disk —
  no surprise rewrites of existing user projects). Add
  `BridgeOutboundMap` entries for every new envelope
  (`CLIP_SET_FADES`, `CLIP_SET_ENVELOPE`, `TRACK_SET_TONE`,
  `TRACK_SET_LEVELER`, `TRACK_SET_SENDS`, `TRACK_SET_PAN`,
  `TRACK_SET_MUTE_SOLO`, `PROJECT_SET_REVERB`, `PROJECT_SET_DELAY`)
  pointing at **inert backend handlers** that validate, persist to
  `ValueTree`, register undo entries, and acknowledge — but do **no
  DSP work**. Register each in the hardcoded undoable-types list and
  the coalesce-key map in `BridgeDispatch.cpp` with stable target keys
  (`clipId`, `trackId`, `"project"`) and the new
  `(messageType, targetId, gestureId)` coalesce key (§7.11). Add
  runtime-guard tests in `bridge-protocol.test.ts`. **No on-disk
  schema-version bump** — Phase 5 only adds optional fields with
  defaults; bump `schemaVersion` only when a genuinely incompatible
  field is added.
- [x] ~~**3. Per-clip fades** (`fadeInMs` / `fadeOutMs`).~~ **Removed.**
  Per-clip fades were implemented (triangular timeline handles + backend
  post-resample fade multiplier + `CLIP_SET_FADES`) and then **removed
  entirely** once the Volume Shape envelope (item 4) subsumed them — a
  fade-in / fade-out is now made by dragging the end breakpoints to
  silence. All fade storage, bridge messages, DSP, and overlays were
  deleted; legacy projects strip the attributes on load.
- [x] **4. Per-clip Volume Shape** (breakpoint envelope) per §7.11:
  the audio thread consumes a compiled immutable `EnvelopeSnapshot`
  published to `OffsetSource` via the lock-free `atomic<const T*>`
  scheme + message-thread retire queue (drained at pause/stop) —
  explicitly **not** `std::atomic<std::shared_ptr>`. The envelope gain
  is applied at the per-clip post-warp stage (`applyEnvelopeGain`), so
  live playback and mixdown export stay bit-identical. Interpolation is
  linear-in-dB with a smooth ramp to a
  true-zero breakpoint. Persisted as the optional `envelopePoints`
  clip property (normalised + restored on load), carried through
  `MixdownEngine` for export parity. Bridge `CLIP_SET_ENVELOPE`
  handler activated (gesture-coalesced).
  **Shipped as an interactive Volume Shape editor drawn directly over the
  Clip Editor waveform** (per §7.11's "single line drawn over the
  waveform"): a **Volume** toggle in the canvas toolbar turns the
  waveform into a breakpoint editor — click the curve to add, drag to
  bend, Alt-click / right-click to remove — so it is obvious which part
  of the audio each breakpoint affects. The envelope renders faint as
  read-only context when the toggle is off, and editing is limited to the
  cropped Clip view (the breakpoint time axis spans the whole clip).
  Edits commit transactionally on Save alongside the other Clip Editor
  drafts — _not_ the originally-specified separate "Volume & Fades…"
  dialog, and no longer the interim boxed SVG rack panel (removed in
  favour of the on-waveform surface). The envelope is the **only**
  per-clip volume mechanism — the previously separate raised-cosine fade
  feature has been removed (a fade-in / fade-out is made by dragging the
  end breakpoints to silence). Shared
  envelope math + edit helpers live in `frontend/.../lib/envelope.ts`
  (single source of truth, mirroring the backend snapshot); the canvas
  gain/time/pixel mapping + hit-testing live in the unit-tested
  `frontend/.../lib/clipEditor/volumeOverlay.ts`. The draft also auditions
  live in the Clip Editor preview voice via a throttled
  `PREVIEW_SET_ENVELOPE` bridge message (the preview `OffsetSource` reuses
  the same snapshot publication path), so edits are heard immediately
  while previewing.
- [x] **5. Tabbed bottom panel** (Library / Track FX / Project FX) inside
  `LibraryPanel`. The track header's **Fx** button switches the panel
  to the Track FX view (`TrackFxPanel`); whether an effects rack is open
  (vs the Library) is persisted in the project's view state (`fxPanelOpen`,
  round-tripped via `PROJECT_SET_VIEW`) so it survives Save / Load — note
  this is per-project memory, a deliberate deviation from the original
  `uiStore` (global-preference) plan. Which rack is showing — the per-track
  Track FX (Tone + Pan + Reverb/Delay) or the project-wide Project FX (shared
  Reverb + Delay) — is a UI-only `fxTab` selection that defaults back to Track FX on
  reload, keeping the per-track and project-scoped effects on clearly
  separate tabs rather than mixing both on one panel. The Library
  keeps its resizable `:height` / `@update:height` API.
  **Shipped as a one-at-a-time tab switch, _not_ the originally-
  specified side-by-side split-view.** The split-view + draggable
  splitter (and the related `v-show` / drag-source-cleanup machinery)
  was dropped as over-engineering for the non-pro ethos — browsing the
  Library and shaping a track read as sequential tasks, not
  simultaneous ones, so a single visible tab keeps the surface simpler.
  Because the inactive tab is `v-if`-unmounted rather than `v-show`-
  hidden, there is no mid-switch stale-drag-source hazard to guard
  against.
- [x] **6. Per-track Tone + Filter** — Tone is a 3-band fixed EQ (Bass /
  Mid / Treble); the bipolar **Filter** is a single DJ-style sweep (low-pass
  left, off centre, high-pass right). Three biquad sections for the
  shelves/peak + two cascaded biquads each for the 4th-order high-pass and
  low-pass, with smoothed coefficient updates. Bridge: `TRACK_SET_TONE`
  handler activated (carries `filter`).
- [x] **7. Shared project Reverb + Delay** with per-track send
  amounts (sends taken pre-pan, post-mute/solo per §7.9.2).
  Backend: one `juce::Reverb` (Freeverb, `juce_audio_basics`) and one
  tempo-synced stereo delay pulled by `BusGraph`; tail-render policy per §7.10
  (Reverb = RMS + hysteresis; Delay = repeat-aware hold + analytic
  floor; independent caps; transport stop/seek flushes FX state;
  mixdown loop invariant + hard fail-safe cutoff). Bridges:
  `PROJECT_SET_REVERB`, `PROJECT_SET_DELAY`, `TRACK_SET_SENDS`
  handlers activated. Live engine and offline mixdown consume the same
  `SharedFx` unit so the rendered export matches the live mix at mix=0
  bit-for-bit (§7.9.6 parity).
- [x] **8. Per-track Leveler** — _(shipped, Amount-only.)_ A hand-rolled
  stereo-linked feed-forward soft-knee compressor per `TrackChain` (the
  build carries no `juce_dsp`, so the compressor is hand-written like
  `ToneEq` / `SharedFx`), driven by a single **Amount** knob (`0..1`) with
  a deterministic static makeup-gain map (no live loudness analysis).
  Amount 0 is a bit-exact passthrough (§7.9.6 parity); the detector lives
  across the track's lifetime and resets on transport stop / seek,
  **never** at clip boundaries. Runs in `TrackChain` after Tone
  (Tone → Leveler) and is mirrored in the offline `MixdownEngine` for
  export parity. Bridge: `TRACK_SET_LEVELER` / `TRACK_LEVELER_APPLIED`
  activated end-to-end (engine push + persistence + renderer snapshot).
  The **Advanced** disclosure (threshold / ratio / attack / release /
  makeup) is deferred as a clean follow-up.
- [x] **9. mute / solo / pan.** _(mute / solo shipped via the existing
  `TRACK_MUTE` / `TRACK_SOLO` envelopes; **pan** now shipped.)_ Track
  header has mute/solo buttons; the Track FX tab carries an equal-power
  **pan** control (signed `[-1, 1]`, unity at centre so a centred track
  is bit-exact with the no-pan path). Pan is applied to the dry path
  AFTER the pre-pan send tap, so Reverb / Delay sends stay pre-pan, and is
  mirrored in the offline `MixdownEngine` for export parity (§7.9.6).
  Bridge: `TRACK_SET_PAN` handler / `TRACK_PAN_APPLIED` ack activated;
  `pan` persists through `tracksAsJson` and survives save / reload.
- [x] **10. Master bus metering.** Transport-bar stereo peak meter
  + dB master fader is *shipped* (`PROJECT_SET_MASTER_VOLUME`).
  LUFS / RMS readouts and a master Limiter are deferred to
  Phase 8.
- [x] **Export**: stereo mixdown via `MIXDOWN_START` /
  `MIXDOWN_PROGRESS` / `MIXDOWN_DONE` / `MIXDOWN_CANCEL` /
  `MIXDOWN_FAILED`. Formats: WAV (16 / 24 / 32-float), FLAC
  (16 / 24), AIFF (16 / 24), MP3 (128 / 192 / 320 kbps via
  bundled LAME). Optional TPDF dither
  for 16-bit targets, configurable silence tail (0..60 s),
  file-level tags (mapped per-format to ID3 / RIFF INFO /
  VORBIS_COMMENT / AIFF text chunks), and ITU-R BS.1770-4 loudness
  analysis with optional two-pass normalisation to a target LUFS /
  true-peak ceiling. Dialog choices (including output path) are
  persisted at the *project* level via a single
  `PROJECT.exportSettingsJson` blob (capped 64 KB, whitelist +
  clamp + schema-version guard on parse, no undo entries — only a
  dirty-mark). Once step 1 lands, mixdown pumps the same
  canonical chain the live engine uses
  (`OffsetSource → AudioTransportSource → per-clip volume shape →
  TrackRuntime → TrackChain (Tone → Leveler → gain → mute/solo) →
  pre-pan send tap → pan → BusGraph dryBus + shared Reverb/Delay →
  master meter → final-stage libsamplerate`) so warped / pitch-
  shifted / effected output is **sample-equivalent to live
  playback at the internal master float bus** under deterministic
  conditions (same project, fixed rate, fixed block size, no
  parameter edits during render). Encoded export output is not
  bit-equivalent to live device output — the parity guarantee
  stops at the internal master bus. The live transport is
  force-paused for the duration and `TRANSPORT_PLAY` is rejected.
- [x] **Render start bar + timeline bar numbering.** A project
  `barCounterStart` (default `1`, range `-64..1`) sets the number shown
  for the first timeline bar — leave it at `1` for `1, 2, 3, …` or set
  `0` or lower to reveal lead-in bars before bar one (edited in Project
  Properties via `PROJECT_SET_BAR_COUNTER_START`). The Export Mixdown
  dialog's **Start from bar** field (`mixdownStartBar`, default `1`,
  range `-64..4096`, `PROJECT_SET_MIXDOWN_START_BAR`) renders only from
  the chosen displayed bar onward — skipping
  `max(0, mixdownStartBar - barCounterStart)` bars of project time.
  Both persist independently on the `PROJECT` node, are suppressed from
  save at the default `1`, and changing one never moves the other.

**Explicitly deferred to Phase 8** (do not implement in Phase 5):

- `juce::AudioProcessorGraph` migration of the engine core
  (`BusGraph` is a custom mixer, not a general routing graph).
- Mixer view (vertical channel strips) as a first-class surface.
- Bus / send routing UI beyond the two shared sends in §7.9.
- Sidechain Leveler routing.
- Per-track insert reverb / delay.
- Saturator and Utility effects.
- VST3 hosting (scope decided then — per-track or per-clip).
- Master Limiter, LUFS / RMS readouts.
- Live delay-time changes during playback (BPM sweep).
- Pan / send / plugin-param envelopes (the breakpoint primitive
  shipped here is the foundation).

### Phase 6 — Stem Separation, Loop Slicing & Fine-Clip Editor

**Goal:** Users can separate stems, chop loops natively, and do sample-accurate clipping in a dedicated editor.

- [x] ONNX Runtime pulled in via CMake (`FetchContent`, SHA-256 pinned) and bundled in the installer
- [x] Model download on first use with SHA-256 + size verification (main-process `ModelStore`)
- [x] 4-stem htdemucs-ft inference pipeline on background thread (issue #15) — backend `StemSeparator` subsystem + ONNX session loading wired and unit-tested; segmented (343 980-sample, 25 % overlap) normalised overlap-add inference implemented and validated against the real model
- [x] `STEM_PROGRESS` / `STEM_READY` / `STEM_FAILED` handling; non-blocking separation progress dialog, plus a first-use model-download dialog gated on `stems:` IPC
- [x] Stem output as new tracks (one per stem) beneath the source — `STEM_READY` reuses the existing library-import / track-add / clip-add flows; each stem lands on its own new track aligned to the source clip start, non-destructively
- [x] Incremental placement — `STEM_PARTIAL` lands each stem the instant its WAV is written; `STEM_READY` backfills the rest (per-job dedupe)
- [x] Stems nested in the library as `stem` items under their source group; they inherit the source's analysis (BPM, beat grid, key, variable-tempo) instead of being re-analysed
- [x] Quality presets (**Fast / Balanced / Best** → inference overlap 0.10 / 0.25 / 0.50) sent as `quality` on `STEM_SEPARATE`
- [x] Mixture-consistency residual — when all four stems are requested, synthesise `other = mixture − (vocals + drums + bass)` and skip the `other` model run (~25 % faster)
- [x] DirectML GPU acceleration (issue tracked) — DirectML-build ONNX Runtime bundled (`onnxruntime.dll` + `DirectML.dll`); `useGpu` threaded to session options, opt-in and adapter-gated (Preferences ▸ Stems), TDR/timeout-recovery hardened
- [x] Per-separation stem folder `Stems\<sourceName>-stems` (disambiguated) beside the saved project file — written to a temporary workspace (`<temp>/Silverdaw/Stems`) for unsaved projects and migrated into the project folder on first save — with a `metadata.json` + `cover.<ext>` sidecar, so stems travel with the portable project folder and keep the source's tags/artwork after the source is removed
- [ ] Loop slicer: transient and grid markers in PixiJS
- [ ] Slice-to-timeline and slice-to-sample flows
- [x] Fine-clip editor — shipped as the in-app **Clip Editor** dialog (§7.14): full-source waveform, sample-accurate selection, looped audition through a backend preview voice, Save-as-new-clip and Apply-trim with linked-clip propagation, hi-res peaks on demand. A dedicated BrowserWindow surface remains a future option.

### Phase 7 — Polish, Performance & Packaging

**Goal:** The whole app feels effortless and solid, and we can ship it.

- [x] **Main timeline zoom cap raised to 600 %** (`MAX_PX_PER_SECOND = 600`) so the user can land fine edits without leaving the main view; the Clip Editor still goes to 6400 % for sample-level work.
- [x] **View-menu zoom controls** — **Zoom In** / **Zoom Out** / **Reset Zoom**
  (`Ctrl +` / `Ctrl -` / `Ctrl 0`, also on the mouse wheel) plus a **Zoom
  Presets** submenu (20% / 50% / 100% / 200% / 400%). Presets live once in
  `lib/timeline/zoomPresets.ts` as px-per-second multiples of the zoom step
  (so they survive snap-to-step) and feed both the menu and its handler. The
  global shortcut handler owns the keys; `menuShortcuts` skips binding the
  display-only accelerators to avoid a double-fire.
- [x] **Track row resize** — drag the bottom edge of any track
  header to change just that track's row height (clamp 60..400 px).
  Persisted with the project and undoable. `TRACK_SET_HEIGHT` bridge
  envelope; backend `setTrackHeightPx` clamps and writes to the
  Track ValueTree with `&undoManager` so each drag is one undo step.
- [x] **Track reordering** — drag the grip icon on a track header
  to move that track up or down in the stack. Live emerald drop
  indicator shows the target slot. `TRACK_REORDER { trackId, newIndex }`
  bridge envelope; backend `moveTrack` uses
  `juce::ValueTree::moveChild(..., &undoManager)` so each reorder
  joins the undo history as one "Reorder track" step.
- [x] **End-of-project auto-pause** — playback stops when the
  playhead reaches the project ruler's end. Play is disabled
  (button + spacebar shortcut) while the playhead is at the end so
  the user can't immediately re-trip the pause; skip-back to start
  re-arms playback.
- [x] **Edit ▸ Crop Project to Last Clip** — collapses the project
  length to the end of the latest clip on any track. No-op when
  there are no clips. Goes through the same `PROJECT_SET_LENGTH`
  envelope as the transport-bar length input so the undo label is
  the existing "Change project length".
- [x] **Project length minimum guard** — manual length edits in the
  transport bar clamp to the longest effective clip end (including
  warped clips) and show a toast when the requested length is too
  short.
- [x] Preferences panel: General (toasts, follow-playback, library
  tile imagery, previous/next button target, **waveform display** mode —
  single summary vs. stacked left/right channels), Project (default Save /
  Open / Import dirs + autosave config), **Audio** (output device selection +
  driver picker with Bluetooth-latency heuristic), Developer (separate
  diagnostic logging, log folder and DevTools toggles). Theme selection is
  deferred to Phase 8.
- [x] Undo/redo surfaced in the Edit menu (Ctrl+Z / Ctrl+Y). Each
  bridge envelope that mutates the ValueTree is wrapped in its own
  JUCE `UndoManager` transaction by `dispatchBridgeMessage`; drag
  streams (CLIP_MOVE / CLIP_TRIM / TRACK_GAIN / PROJECT_MARKER_MOVE)
  and typing in singleton fields (BPM / length / rename) coalesce
  same-target events within a 500 ms window. The backend broadcasts
  `EDIT_UNDO_STATE { canUndo, canRedo, undoLabel?, redoLabel? }` on
  AUTH-connect and after every mutating envelope; the renderer
  mirrors it into `projectStore.canUndo / canRedo` and the Edit menu
  greys items accordingly. Coverage today: clip add / move / trim /
  recolour / rename / delete / relink / rebind, track add / remove /
  rename / gain / **resize / reorder**, library add / remove /
  relink / reanalyse, marker add / move / remove, BPM, project
  length, project rename. View state (zoom, scroll, playhead) is
  intentionally outside the stack so navigation doesn't pollute
  history. The **Clip Editor Crop** workflow keeps a dialog-local
  undo stack so the user can experiment with crop windows without
  touching the project-level history; the change only lands in the
  main undo stack when the user clicks **Apply trim** or **Save as
  new**. Undo / redo themselves broadcast a `softReplace`-flagged
  `PROJECT_STATE` (replaces tracks / clips / markers / library
  wholesale without rotating projectId, marking clean, or clearing
  clipboard / selection) plus an explicit `PROJECT_DIRTY` so the
  title-bar indicator stays accurate. Compound operations (split /
  duplicate) currently produce multiple undo steps; bundling them
  via an `undoGroup` envelope field is a follow-up.
- [x] End-to-end performance telemetry in diagnostic logs: `perf.audio`
  callback budget heartbeat, `perf.bridge` WebSocket heartbeat/counters,
  and `perf.timeline` redraw duration + visible row/clip counts.
- [x] **Peaks LOD pyramid** — each library item carries a small ladder
  of pre-downsampled peak arrays alongside its base peaks. `drawClip`
  picks the LOD whose `peaksPerSecond` is closest to the current draw
  scale; the inner per-pixel min/max scan stays cheap when zoomed out
  and crisp when zoomed in. Auto-built on load for older projects that
  lack a stored pyramid.
- [x] **Hot-path lookup map adoption** — every `library.items.find(i =>
  i.id === X)` on the timeline render path goes through the
  `libraryStore.byId` Pinia getter (cached `Record<string, LibraryItem>`
  rebuilt only when the catalogue changes). `drawClip` resolves the
  parent library item + source BPM once and threads them into
  `drawClipHeader`. The per-clip per-redraw lookup cost dropped from
  ~4 × O(n) array scans to 2 × O(1) map reads.
- [x] **Beat-marker loop stride-stepping** — the timeline marker loop
  computes `beatStride = ceil(minMarkerSpacingPx / pxPerBeat)` up
  front and steps the loop by `beatSpacingMs * beatStride` instead of
  iterating every beat and skipping 95 % of them. A 5-minute clip at
  120 BPM zoomed out does roughly 600 × less work per redraw.
- [x] **Bridge protocol hardening** — inbound payloads are defined as
  `zod` schemas in `bridge-protocol.ts`; the TypeScript types are
  derived via `z.infer<typeof XPayloadSchema>` so the schema is the
  single source of truth (no separate hand-written interface to drift
  away from the runtime guard). Each `isXxxPayload` guard is a
  `safeParse(value).success` wrapper. On the backend, dispatch
  handlers extract string fields through `tryGetString` /
  `tryGetRequiredString` (in `PayloadHelpers.h`) which validate that
  the underlying `juce::var` actually holds a string instead of
  silently coercing objects / arrays / numbers via
  `juce::var::toString()`.
- [x] **60 Hz envelope logging cost** — `BridgeServer::broadcast`
  suppresses per-envelope log writes for both `PLAYHEAD_UPDATE` and
  `PREVIEW_POSITION` (the only 60 Hz envelopes). A playing transport
  no longer generates 60 log lines / second.
- [x] **Cross-process port + AUTH contract** — Electron main is the
  single source of truth for the bridge port: it probes a free
  loopback port at startup, spawns the JUCE backend with `--port <N>`,
  and exposes the same value to the renderer via the `bridge:getPort`
  IPC. The backend has no default and refuses to start without
  `--port` (exit code 2) so a missing argument is always a
  configuration bug rather than a silent fallback. AUTH stays a
  per-session random hex token: main passes it to the backend via the
  `SILVERDAW_BRIDGE_TOKEN` env var and to the renderer via the
  `bridge:getToken` IPC; the first envelope on every socket must be
  `AUTH { token }` matching the backend's expectation, otherwise the
  socket is closed without reply.
- [x] **Defence-in-depth window-open block** — the Electron main
  process installs `setWindowOpenHandler(() => ({ action: 'deny' }))`
  on the main window's `webContents` alongside the existing
  `will-navigate: preventDefault`. The renderer is a single-page app
  with no legitimate `window.open` use; without the handler, a
  `target=_blank` link or `window.open(...)` would spawn a fresh
  `BrowserWindow` with default `webPreferences` that does NOT inherit
  the renderer's meta-CSP.
- [x] **Observability migration** — the renderer no longer uses
  `console.*` for diagnostics; every log site goes through
  `lib/log.ts`, which writes structured rows to
  `debug/<session>/renderer.log` (dev) and is gated by a flag in
  release. An ESLint `no-console` rule scoped to `src/renderer/**`
  (ignoring `lib/log.ts`) keeps the migration enforced. The backend
  side routes through `silverdaw::log::warn` / `info` / `error`
  rather than raw `std::cerr` / `std::cout` (except for the
  log-init failure path and the JUCE entry banner).
- [x] Windows NSIS installer packaging for the Electron app + `SilverdawBackend.exe` + icons + licences + `.silverdaw` file association. The backend statically links the MSVC runtime, so the installer does not need to bootstrap the Visual C++ Redistributable. ffmpeg, ONNX Runtime and Demucs model bundling remain tied to their future feature work.

### Phase 8 — Post-Core Hardening & Compatibility Enhancements

**Goal:** After the core DAW workflow is complete, broaden compatibility,
reduce memory pressure, and add release-process hardening that improves
robustness without changing the core editing model.

- [ ] ffmpeg-based decoder for unsupported formats (AAC / M4A / Opus / …),
  replacing the Web Audio + temp-WAV detour where useful. This should reduce
  renderer memory pressure and make decoding more consistent across Windows
  machines.
- [ ] Renderer memory investigation: eliminate avoidable in-memory PCM
  retention per import and decide whether the backend's read-ahead buffer
  needs a bounded shared cache for many-track projects.
- [ ] User-scoped sample library folder scanning, beyond the current
  project-scoped imported-audio library.
- [ ] Drag selected timeline regions directly into the browser panel to save
  them as samples.
- [ ] Preview library tiles at project BPM where useful, reusing existing
  non-destructive warp settings rather than baking preview audio.
- [ ] Library list view, tags, search and sort refinements if they are still
  needed after core editing / mixing workflows settle. (issues #2, #21)
- [ ] Tag editing and jump-to-clip links in the Library Item Info dialog.
- [ ] Sidechain routing and advanced send/return refinements beyond the
  first mixer/effects pass.
- [ ] VST3 plugin scanning and hosting via a sandboxed child process. (issue #14)
- [ ] DirectML GPU acceleration for stem separation after the CPU 4-stem
  path is stable.
- [ ] Harmonic compatibility indicators between clips, beyond basic key
  display and manual pitch controls.
- [ ] Pan, send-level and plugin-parameter automation once clip volume
  envelope editing is stable.
- [ ] CI coverage gates and expanded Electron e2e smoke tests once the feature
  surface stabilises. (issue #17)

### Cross-cutting workstreams (run continuously, not phase-gated)

- **Testing:** Vitest currently covers renderer/shared TypeScript modules (the
  store, composables, the bridge-protocol zod schemas, the dB taper helpers,
  the Clip Editor viewport/warp-draft/target composables, and the clip-lock
  store actions). The backend ships with its own custom test harness (no Catch2
  dependency) wired into CTest as `SilverdawBackendTests` — 19 cases at the
  time of writing covering `ProjectState` (tracks / clips / dirty, view /
  library / markers / replaceTree, export-settings JSON round-trip, master
  volume round-trip, net-zero edits returning to clean, suppressed-property
  drift on undo, derived library metadata not marking dirty), `ProjectFile`,
  `PeaksCache`, `ValueTreeJson`, `BridgeAuth`, `WarpProcessor` (basic stretch +
  timeline duration mapping), the strict bridge payload validation helpers,
  the `AudioEngine::setPreviewWarp` audio-thread / message-thread race, and
  the `LoudnessAnalyzer` (silence, -23 LUFS sine target, gain-shift identity,
  sample-rate guard). Clip-lock currently lives in the frontend store /
  context-menu tests rather than a dedicated backend persistence case.
  Electron e2e tests and an enforced coverage floor remain planned hardening
  work.
- **CI:** planned GitHub Actions matrix — Windows MSVC and Linux Clang legs
  running, per push: backend `cmake --build`, `clang-tidy`, `ctest` (the
  custom `SilverdawBackendTests` harness); frontend `pnpm install`,
  `pnpm typecheck`, `pnpm lint`, `pnpm test`; Playwright smoke on Windows.
  Cache the JUCE / IXWebSocket FetchContent dirs and pnpm store.
- **Logging:** the cross-layer `debug/<session>/{main,backend,renderer}.log` infrastructure stays in dev builds and is conditionally enabled in release via a flag. Renderer code routes through `frontend/src/renderer/src/lib/log.ts` (enforced by an ESLint `no-console` rule scoped to `src/renderer/**`); the backend routes through `silverdaw::log` rather than raw `std::cerr` / `std::cout`.
- **Documentation:** the bridge protocol catalogue, ValueTree schema, and project file format live in `README.md` and the shared `bridge-protocol.ts` (the schema source of truth), updated as each phase adds envelopes.

---

## 9. Key Engineering Risks

| Risk                                        | Mitigation                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket latency for transport control     | Round-trip on localhost should be <2ms; playhead interpolation in frontend handles any jitter                                                     |
| Warp engine multi-track sync                | Master transport clock + per-track latency compensation landed in Phase 1                                                                         |
| Large bridge payloads stalling the I/O loop | The bridge is text-only. Bulk data uses disk caches plus small `*_READY` envelopes so IXWebSocket I/O threads never stream audio / peak payloads. |
| PixiJS performance with many clips          | Pool and recycle display objects; only render clips in the visible viewport                                                                       |
| Demucs model download UX                    | Stem features visibly disabled until model is present; clear download progress UI                                                                 |
| Memory pressure with many clips             | Stream audio from disk on the backend (`BufferingAudioSource`); defer renderer decode-memory reduction / ffmpeg work to post-core hardening      |
| Rubber Band real-time latency               | Real-time mode is implemented with preallocated buffers and explicit seek/reset handling; continue profiling under larger sessions                 |
| VST3 plugin crashes                         | Sandbox plugins via JUCE `AudioPluginHost` separate process                                                                                       |
| Backend crash recovery                      | Implemented: a main-process supervisor auto-respawns the backend on the same port / token, a renderer PING/PONG watchdog catches hangs, and the open project is reloaded into the fresh engine (see Developer Guide → Engine resilience and recovery)                |
| ffmpeg licensing / binary distribution      | Deferred to Phase 8; prefer a child-process LGPL build if/when wider codec support becomes necessary                                             |
| Project file forward/backward compat        | Versioned JSON with a schema-version field; backend reads any older version, writes the latest                                                    |
| Unresolved file references on load          | Backend marks affected clips `unresolved` (silent playback, greyed UI); user can re-link via a per-clip "Locate file" action                      |
| Per-clip envelope on the audio thread       | Breakpoint list double-buffered; the audio thread reads via a single atomic pointer swapped at edit time; no allocation in the hot path           |

---

## 10. Project Notes

- **Open source** — free and open source under AGPL-3.0-or-later; future
  third-party additions must remain licence-compatible
- **Arrangement view only** — traditional left-to-right timeline; no session/clip launcher
- **Desktop creation tool** — not for live DJ performance
- **Demucs** — htdemucs-ft 4-stem model (vocals/drums/bass/other), MIT-licensed ONNX export, downloaded on first use
- **JUCE is backend only** — no JUCE UI components used; all rendering is Electron + PixiJS
- **Cross-layer logging** — every session writes `debug/<stamp>/{main,backend,renderer}.log` with aligned ISO-millisecond timestamps for post-mortem analysis (dev builds; flag-gated in release)
- **Multiple clients on the bridge** — the WebSocket bridge supports multiple authenticated clients. A future Fine-Clip Editor window can use that capability as a second BrowserWindow talking to the same backend.

## 11. Open Decisions

- **Demucs download host** — GitHub Releases or CDN; checksum verification on download required
- **Key detection depth** — current Web Audio chroma matching gives root + mode; Camelot wheel support can be layered on later if needed
- **Undo scope** — whether undo covers UI-only state (zoom, selection) or backend audio state only
- **Project file compatibility** — versioned JSON is the chosen format; decide how
  much backward-migration logic is needed as schemas evolve.
- **ffmpeg integration** — link `libavformat`/`libavcodec` into the backend vs spawn `ffmpeg.exe` as a child process at import time; child-process is simpler to license / sandbox, in-process is faster for batch imports
- **Library scope** — is the library always project-scoped (current direction in §7.13) or also user-scoped (a "global samples" library shared across projects)? Project-scoped is simpler; user-scoped is friendlier for power users
- **Volume envelope on warped clips** — envelopes are time-based, warp changes the time mapping. Decide whether the envelope is anchored in clip-source time (moves with warp) or timeline time (stays put)

---

## 12. Feature Backlog (Candidate Enhancements)

This backlog collects features and ways-of-working that fit
Silverdaw's remix/mashup ethos. Every item below has been filtered against the
hard constraints in §1–§2 and §10 (radical, beginner-friendly simplicity;
no notation or live DJ performance; arrangement
view only). These are **candidates**, not
commitments — they slot into the existing phase plan rather than replacing it.

### 12.0 Guardrails (reframes applied during triage)

Three independent design critiques converged on the following constraints.
**Build the reframed version, not the literal feature:**

- **No arbitrary same-track clip overlap.** The strict no-overlap invariant
  (§7.5 magnetic edge snap) underpins collision checks, saved-clip propagation,
  paste/duplicate, hit-testing and render parity. Crossfades/transitions are
  modelled as an explicit **Transition Zone object between two adjacent clips**
  (A→B), which may render both clips for the overlap window, *not* as free clip
  stacking.
- **No non-linear "region playlist".** Reorderable section containers drift
  toward a second arrangement model / clip launcher (out of scope). Sections are
  **named timeline ranges** with destructive, undoable *Move / Duplicate / Delete
  section* edits only.
- **No persistent global "ripple mode" first.** Ship explicit commands
  (*Delete & close gap*, *Insert space*, *Move following clips*) before any
  always-on mode; per-track before all-tracks.
- **No live performance triggering.** Cue points are **library/song landmarks**
  (intro / verse / chorus / drop / outro) for navigation and drop-alignment, not
  performance hot-cue pads.
- **No master automation lane and no live sidechain.** "Fade out the ending"
  and "duck music under a vocal" are implemented as **generated, non-destructive
  volume shapes** on the affected clips (reusing the Phase 5 §7.11 breakpoint
  primitive), not as a master envelope or a realtime sidechain detector.

### 12.1 Transitions & blending — *part of the Phase 5 core-effects work (see near-term sequence)*

**Transition Zones** let the user drag one clip's edge over its neighbour to
create a bounded transition object that blends the two clips across their
overlap. Built-in recipes only at first: **Smooth blend**, **Bass swap**,
**Filter fade**, **Delay out**, **Fade out/in**, built on the existing per-clip
Volume Shape + per-track Tone EQ + shared Delay. Custom curves are a later
disclosure; a user-saved **preset browser is explicitly deferred** until the
recipe set proves stable.

**Architecture (validated across opus-4.8 + gpt-5.5 + gpt-5.3-codex).** A
transition is the single source of truth; its overlap REGION is derived from the
two clips' timeline geometry (never stored) so it cannot drift. The crossfade is
a **dedicated per-clip edge-fade gain stage** that *multiplies* with the user's
volume `EnvelopeSnapshot` — it never clobbers a user-drawn volume shape, and a
clip sandwiched between two transitions composes naturally (head fade-in × tail
fade-out). The edge fade works in **master-timeline samples** (no warp/tempo
conversion) and the "Smooth blend" recipe is an **equal-power** crossfade
(`cos`/`sin`, exact endpoints, no `-100 dB` floor artefact). The **backend owns
derivation**: transition mutations are discrete, single undoable transactions
that update both partner clips atomically and re-publish `PROJECT_STATE` (which
is also how backend-side reconciliation reaches the renderer). Collision logic
treats a sanctioned transition overlap as legal across move/drop/paste/trim while
still rejecting a third intruding clip; a reconciliation pass auto-deletes a
transition the moment its invariants break (partner removed / moved apart /
trimmed shorter than the overlap / a third clip intrudes).

Implementation increments (foundations first; each keeps build + tests green):

- [x] **A — Bridge contract.** `transitions` array (identity + discriminated-union
  recipe) on the track schema; `TRANSITION_CREATE / _DELETE / _SET_RECIPE`
  outbound messages; `PROJECT_STATE` carries reconciled state (no bespoke ack).
  Zod-guard round-trip tests.
- [x] **B1 — Edge-fade DSP primitive.** `EdgeFadeSnapshot` (RT-safe, immutable,
  equal-power, timeline-sample space) + custom-harness tests (endpoints,
  constant-power law, sandwiching, degenerate-span rejection).
- [x] **B2 — Audio wiring.** Publish the edge fade into each clip's `OffsetSource`
  (atomic pointer + retire queue, mirroring the envelope discipline); apply it
  multiplied with the volume envelope on the audio thread; mirror in
  `MixdownEngine` for live/offline parity.
- [x] **B3 — Persistence + derivation + reconciliation.** Store transitions in the
  ProjectState ValueTree (default-suppressed); derive each clip's edge-fade from
  the transition geometry; reconcile/auto-delete on clip remove/move/trim/warp.
  Round-trip + lifecycle tests.
- [x] **B4 — Transition handlers + undo.** `TRANSITION_*` handlers in a NEW
  translation unit (not `Main.cpp`), each a single undoable transaction mutating
  both partner clips atomically.
- [x] **C — Frontend store + collision.** Transitions in the project store;
  transition-aware `wouldClipOverlap` / `findClipSlot` so partners stay editable;
  reconciliation mirror on `PROJECT_STATE`.
- [x] **D — Creation gesture + rendering + recipe UI.** Edge-drag-into-neighbour
  creates a transition (single-adjacent-neighbour only); PixiJS crossfade-region
  rendering from transition state; remove-crossfade context-menu actions; Vitest.
- [x] **E — Second recipe + selection UI.** A second gain-law recipe, **Fade
  out/in** (`linear`), now reaches the audio thread: the recipe kind threads
  through `ProjectState` → `ClipEdgeFade` → `AudioEngine::setClipEdgeFade` →
  `EdgeFadeSnapshot` as a per-leg `EdgeFadeCurve` (`equalPower` | `linear`), so a
  clip sandwiched between two differently-recipe'd transitions composes the right
  law on each edge. Live and offline (`MixdownGraph`) paths share the curve. The
  timeline context menu lists one row per recipe (per transition side, current
  marked with a check) dispatching `setTransitionRecipe`. Custom-harness +
  Vitest coverage for the linear law, recipe→curve derivation, and the menu.
- [ ] **FX-based recipes** — **Bass swap**, **Filter fade**, **Delay out** still
  pending; they need per-clip EQ/filter/delay automation tied to the transition
  geometry (no gain-law shortcut exists). The recipe schema and selection UI are
  ready to host them once the DSP lands.
- [ ] **"Vocal Focus" ducking** — one action derives a ducking volume-shape on
  music clips/tracks under a selected vocal clip. Offline/precomputed, editable
  and undoable; **not** sidechain routing (that stays Phase 8).

### 12.2 Stem-driven mashup moves — *extends Phase 6*

- [ ] **Stem-swap commands** — after 4-stem separation lands as
  new tracks (§7.7), add *Use vocals only* / *Use instrumental only* /
  *Restore original* on the source clip. The headline mashup move: drop one
  song's vocal over another's instrumental. **Avoid** a per-clip multi-stem
  matrix UI in the first pass.
- [ ] **Stem-aware transitions** — once Transition Zones (§12.1) and
  stems both exist, allow the transition to act per-stem (e.g. swap drums first,
  then vocals). Disclosure feature, not default.

### 12.3 Arrangement & editing workflow — *Phase 7/8*

- [ ] **Gap commands, not ripple mode** — *Delete & close gap*,
  *Insert space at playhead*, *Move following clips on track*. Per-track first.
- [ ] **Selection group (move-only)** — link selected clips so they
  move/delete together (keeps a vocal + instrumental aligned). Grouped *trim/
  stretch* deferred; kept distinct from stem groups and library-linked clips.
- [ ] **Library cue / song landmarks** — mark intro / drop /
  chorus etc. on a library item; jump-to in the Clip Editor and on drop-align.
  Navigation only, no performance triggering.
- [ ] **Named section ranges** — name a timeline range; *Move /
  Duplicate / Delete section* as destructive timeline edits. Extends the existing
  project-wide markers.
- [ ] **Timeline loop / cycle playback** — loop a
  selected timeline range for auditioning (distinct from the existing Clip Editor
  audition loop). Decide FX-tail behaviour at loop wrap up front (flush vs let
  Reverb/Delay tails ring) — pick one intentionally.
- [ ] **Selection effects in the Clip Editor** (issue #43) — let the
  Clip Editor's region selection (§7.2.1 / §7.14) apply gain and simple
  effects rendered into a new clip/sample so the underlying source file stays
  intact. (Whole-clip **reverse** has shipped as a non-destructive per-clip
  `reversed` flag — timeline right-click ▸ Reverse and a Clip Editor toolbar
  toggle with live preview; see §7.5. Per-selection reverse remains future work.)

### 12.4 Tempo, beat-grid & harmonic — *Phase 4 polish / Phase 8*

- [ ] **Tap tempo** — inline transport-bar control to set/confirm
  project BPM as a fallback to detection. No dialog.
- [x] **Minimal beat-grid correction** — manual BPM override plus a slide-the-grid
  drag in the Clip Editor that re-anchors the first downbeat
  (`LIBRARY_ITEM_SET_MANUAL_TEMPO`), and a guarded detector phase-correction step.
  Deliberately **not** full variable-tempo maps, per-beat warp markers, or time
  signatures. The single authority is the source's `(bpm, beatAnchorSec)`, which
  the rigid project grid follows.
- [ ] **Phrase-aware snapping** — snap drops/moves to 1/2/4/8/16/32-bar
  phrase boundaries, not only beats. Big speed win for mashups.
- [ ] **Camelot / Open-Key display + compatibility badges** — convert existing root+mode detection to Camelot/Open-Key notation and
  flag harmonically compatible library items. This is the concrete form of the
  Phase 8 "harmonic compatibility indicators" — promote, don't duplicate.
- [ ] **Key-match action** — one-click *Pitch to compatible
  key* / *Pitch to match selected clip*, showing the resulting semitone shift,
  reusing the existing non-destructive Rubber Band pitch.
- [ ] **Manual beat-line editing** (issue #44) — drag individual detected beat
  lines (or slide the waveform under the grid) to correct mis-detection. This
  goes further than *Minimal beat-grid correction* above, so settle the single
  grid-vs-clip-anchor authority before exposing per-beat moves.

### 12.5 Loudness & gain — *Phase 5/8*

- [ ] **Clip gain assist (Match Loudness)** —
  one beginner-facing command that sets non-destructive clip gain toward a
  reference LUFS using the existing `LoudnessAnalyzer`. Applied as a visible,
  resettable **Auto Gain** badge after analysis completes; gated heuristics with
  an RMS/peak fallback for short clips and a capped adjustment range. Subsumes a
  separate "normalize clip" command (keep peak-normalize advanced/internal only).
- [ ] **Fade out the ending** — one action writes a volume-shape fade-out
  across clips crossing the project end. Implemented via §7.11 shapes, **not** a
  master automation lane.
- [ ] **Stereo channel control** (issue #45) — per-track control over the left
  and right channels: balance and independent channel level (and, later, basic
  mid/side width), so a clip's stereo image can be tweaked in the mixer.

### 12.6 Fast import-to-arrangement — *promoted: after core effects, before stems (see near-term sequence)*

These scored highest in triage as on-ethos remix accelerators:

- [ ] **In-context library audition at project BPM/key** — preview a
  loop/stem warped to the project tempo (and optionally pitched to a compatible
  key) *before* dragging it in, reusing existing non-destructive warp settings.
  Currently deferred in Phase 8 — **consider promoting** given remix speed is core.
- [ ] **Conform on drop** — a single drop optionally auto-warps to
  project BPM, anchors to the source downbeat, and suggests a key-shift. Bundles
  existing auto-warp + downbeat anchor + key-match behind one sensible default.
- [ ] **Multi-file import to rough arrangement** — drag several
  songs/loops in and auto-place them sequentially with optional default
  transitions, as a fast starting point.
- [ ] **Find compatible next clip / library filters** — filter/sort
  the library by BPM-near-project, compatible key, duration and tags. More
  on-ethos than generic FX-preset browsing; folds into the Phase 8 library polish.
- [ ] **Replace source, preserve edits** — swap a clip's underlying
  loop/sample while keeping timeline position, trim, volume shape, pitch and warp where
  compatible (extends the existing `CLIP_REBIND`).

### 12.7 Onboarding & simplicity — *cross-cutting*

- [ ] **Contextual Quick Help** — dismissible "what's this" tooltips
  and a light first-run guided overlay, focused on the genuinely novel surfaces
  (warp, stems, loudness, transitions). Must never block common actions; no
  blocking tutorial mode.

### 12.8 Recording & live input — *near-essential, prioritise*

Subsections 12.8–12.12 capture functionality requested via GitHub issues that
**intentionally extends beyond the original §1–§2 scope constraints** (pure
arrangement of existing audio). They are large, cross-layer efforts (engine,
bridge, UI). Rough relative priority is noted on each subsection heading; final
sequencing into the phase plan is still to be decided.

- [ ] **Record audio to a clip** (issue #35) — considered near-essential: the app
  should offer a **simple** way to record live input straight onto a new clip,
  without becoming a full recording studio. Record from any input device — vocals,
  an instrument or line input, music, or sound effects — while playing along with
  the selected existing tracks. Needs input-device selection, monitoring, a
  count-in and a record-enabled transport path; a finished take becomes a normal,
  non-destructive editable clip. Keep the surface deliberately minimal.

### 12.9 MIDI & DJ control — *prioritise — wanted fairly early*

- [ ] **MIDI DJ deck input** (issue #29) — support external MIDI controllers,
  specifically DJ decks/turntable controllers, as an input device. The primary
  use is driving the scratch authoring below; general MIDI mapping can follow.
- [ ] **Scratch authoring with on-screen decks** (issue #37) — a studio feature
  for **creating scratches of an audio clip to use in a mix**, not for live
  performance. Show an on-screen deck per track when a MIDI DJ deck is connected;
  a dedicated scratch editor **records the scratch movements performed on the
  deck** (or lets the user draw them by hand), replays them over the clip, and
  saves the result as a reusable **scratch clip** that drops onto the timeline
  like any other clip. Everything is authored, re-editable and non-destructive.

### 12.10 Sequence tracks & sequencing — *secondary focus, fills a gap*

- [ ] **Sequence tracks alongside audio tracks** (issue #23) — add a second track
  type next to the existing sample/audio tracks: a **sequence track** that
  triggers samples or an external/virtual MIDI device. This lets a connected
  device (e.g. a drum machine) or a virtual instrument be sequenced on the
  timeline alongside sampled audio. Should sit comfortably beside audio tracks,
  not become the application's main focus or a front-and-centre surface.
- [ ] **Drum / step sequencer on a sequence track** (issue #32) — the first
  concrete sequence-track use: lay out and trigger several drum sounds/samples on
  a shared step grid — effectively a small multitrack within one track — for
  building beats inline on the timeline without leaving the arrangement.

### 12.11 Integrations & sharing — *very low priority*

- [ ] **Upload exported mixes to external services** (issue #31) — connect to
  external platforms to ease uploading exported clips/mixes (e.g. Mixcloud,
  SoundCloud, YouTube). Very low priority — a convenience layer over the existing
  mixdown export, not a core feature.
- [ ] **Track lookup & purchase linking** (issue #36) — since audio cannot be
  pulled directly from a streaming service, instead let the user look a track up
  on a streaming service (e.g. Spotify) and link out to a store where a
  purchasable, downloadable copy can be obtained for import. Feasibility and the
  terms of service of each platform must be checked first.
- [ ] **Online sample/clip bank integration** (issue #36) — optionally connect to
  online services that host banks of samples/loops/clips, to browse and import
  them into the library.

### 12.12 Distribution & web presence — *low priority, post-MVP*

These are expected to land around MVP stage, not before — low priority relative
to the application itself.

- [ ] **Windows Store distribution** (issue #30) — package and submit the app to
  the Microsoft Store for one-click install, alongside the existing installer.
- [ ] **Product website** (issue #39) — a public marketing/landing site for the
  application.
- [ ] **Documentation site** (issue #40) — a **GitHub Pages** site driven by the
  Markdown files in `docs/`, presented as a simple, easy-to-follow user guide for
  the application.
