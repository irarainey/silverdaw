# Silverdaw Developer Guide

This guide covers the architecture, internals, build process, and contributor
workflows for Silverdaw. For a general overview of what the application does and
who it is for, see the [README](../README.md). For the longer-term feature and
design roadmap, see the [Development Plan](development-plan.md).

## Contents

- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Current status and roadmap](#current-status-and-roadmap)
- [Bridge protocol](#bridge-protocol)
- [MIDI controller architecture](#midi-controller-architecture)
- [Engine resilience and recovery](#engine-resilience-and-recovery)
- [Project state model](#project-state-model)
- [Audio formats](#audio-formats)
  - [Internal signal format and bit depth](#internal-signal-format-and-bit-depth)
- [Peaks cache](#peaks-cache)
- [Audio analysis](#audio-analysis)
  - [Key detection](#key-detection)
  - [BPM and beat detection](#bpm-and-beat-detection)
  - [Confidence and audio type classification](#confidence-and-audio-type-classification)
  - [Beat markers and source-beat snap](#beat-markers-and-source-beat-snap)
  - [Processing progress panel](#processing-progress-panel)
- [Stem separation](#stem-separation)
- [Library panel](#library-panel)
- [Preferences](#preferences)
  - [MIDI controller preferences](#midi-controller-preferences)
  - [Audio output device](#audio-output-device)
- [Project properties](#project-properties)
- [Project sample rate](#project-sample-rate)
- [Keyboard & mouse reference](#keyboard--mouse-reference)
  - [Clip Editor](#clip-editor)
  - [Selection model](#selection-model)
- [Rendering performance](#rendering-performance)
- [Prerequisites](#prerequisites)
  - [One-shot setup (recommended)](#one-shot-setup-recommended)
  - [Manual prerequisite install](#manual-prerequisite-install)
- [Setup and run](#setup-and-run)
- [Packaging for Windows](#packaging-for-windows)
  - [Installing the signed sideload package](#installing-the-signed-sideload-package)
  - [Portable archive](#portable-archive)
  - [Microsoft Store package](#microsoft-store-package)
  - [Package artwork](#package-artwork)
  - [One-time signing setup](#one-time-signing-setup)
- [Quality gates](#quality-gates)
- [License](#license)

## Architecture

Silverdaw is a digital audio workstation built with a headless JUCE 8 audio engine and an Electron 42 + Vue 3 UI, linked by a per-session-authenticated localhost WebSocket bridge.

- **Backend** (`backend/`) — A headless C++17 / JUCE 8 binary (`SilverdawBackend`) that owns the
  audio device, mixer, timeline, project `ValueTree` and `UndoManager`. It exposes its state and
  commands over an [IXWebSocket](https://github.com/machinezone/IXWebSocket) server bound to
  `127.0.0.1` and gated by a per-session AUTH token.
- **Frontend** (`frontend/`) — An Electron 42 + Vue 3 (Composition API, `<script setup>`) app
  built with electron-vite. The renderer talks to the bridge directly; the main process owns the
  OS dialogs, native menu, persisted preferences and backend spawn.

```text
+---------------------------+        ws://127.0.0.1:<port>      +-----------------------------+
|  Electron renderer (Vue)  |  <----------------------------->  |  SilverdawBackend (JUCE)    |
|  + Electron main (IPC)    |       text JSON envelopes         |  AudioEngine + ProjectState |
+---------------------------+                                   +-----------------------------+
            ^                                                                    |
            |   bulk data (peaks, stems) on disk                                 |
            +--------------------- %APPDATA%/Silverdaw/peaks/ <------------------+
```

Main picks a free port in `[8765, 8784]` at startup so leftover Silverdaw processes can't lock
new instances out, then hands the value to both the backend (via `--port`) and the renderer
(via a `bridge:getPort` IPC). A supervisor in the main process then keeps the engine alive for
the rest of the session: if the backend exits unexpectedly it is respawned on the **same** port
and AUTH token, so the renderer's WebSocket reconnects transparently (see
[Engine resilience and recovery](#engine-resilience-and-recovery)).

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
    core/                Entry point (Main.cpp), logging + always-on crash reporter
    bridge/              IXWebSocket loopback server, AUTH, message dispatch,
                         payload helpers, playhead emitter
    commands/            Per-domain bridge command handlers (clips, tracks,
                         mixdown, undo, transport, library, …)
    midi/                JSON-profile loader, MIDI decoder, and output encoder
    engine/              Master transport clock, mixer / bus graph (incl.
                         equal-power pan), per-track audio sources, keep-alive
    dsp/                 Per-track DSP: Tone EQ, Leveler, pan / track chain,
                         shared Reverb + Delay, BPM + loudness, waveform peaks,
                         per-stem cleanup enhancers
    stems/               ONNX stem-separation orchestration (RoFormer + htdemucs
                         backup, GPU→CPU fallback); invokes the enhancers in dsp/
    mixdown/             Offline render + export / normalise / dither on the
                         same canonical chain as playback
    project/             juce::ValueTree state + UndoManager, .silverdaw save /
                         load, ValueTree↔JSON converter, peaks cache
  resources/
    midi-mappings/       Installed model aliases and MIDI input/output bindings
  tests/                 SilverdawBackendTests custom harness (wired into CTest)
  CMakeLists.txt         FetchContent for JUCE + IXWebSocket
frontend/                Electron + Vue 3 app (TypeScript, electron-vite, pnpm)
  resources/icons/       Multi-resolution .ico + PNG set (consumed by main + renderer)
  src/
    main/                Electron main process (window, menu, IPC, prefs, backend spawn + supervisor)
    preload/             contextBridge surface exposed as window.silverdaw
    renderer/src/        Vue 3 SPA (Composition API, Pinia, PixiJS, Tailwind v4); lib/ holds composables + audio/timeline helpers
    shared/              Bridge wire-protocol facade → bridge/inbound + bridge/outbound zod schemas (also TS-tested)
  electron-builder.yml   Windows packaging config (signed MSIX/AppX + portable zip)
  electron-builder.store.cjs  Store variant of the above (unsigned, Store identity)
scripts/                 Dev-shell / build / clang-tidy helpers (PowerShell)
.github/instructions/    Copilot/AI agent guidance per file type
```

## Current status and roadmap

Silverdaw currently supports the core arrangement workflow:

- Import audio into a project-scoped library (the panel's Import button, or **File ▸ Import to
  Library…** / `Ctrl+I`) and drag it onto the timeline. Dropping onto an existing track places the
  clip there; dropping onto the empty area below the tracks shows a "new track" drop lane and
  creates a fresh track for the clip (one undo step).
- Play, pause, seek, move, split, duplicate, cut, copy, paste, trim, delete and colour clips.
  Clip moves and non-linked edge trims snap to the beat grid by default; holding
  `Alt` switches either drag to freeform 1 ms placement.
- Enable a recognised MIDI deck controller from **Preferences ▸ MIDI** to drive
  transport, timeline and marker navigation, jog movement, clip browsing, and
  selected-track fader/Tone/Filter controls, plus master level where mapped.
  Unsupported MIDI devices remain visible but cannot be enabled. The complete
  model and capability matrix is in [MIDI deck controllers](midi-controllers.md).
- Select several clips at once — **Shift-click** a range on one track or **Ctrl-click**
  clips across tracks — then drag the whole group (relative offsets preserved, across
  tracks, applied atomically), nudge it with **Shift + ←/→**, or lock, colour, duplicate,
  delete, and cut/copy/paste the whole selection from a dedicated right-click menu. Each
  multi-clip edit is a single undo step.
- Split a stereo clip's **Left** and/or **Right** channel onto its own new track
  (right-click ▸ **Split Stereo Channels…**); each channel becomes a stereo clip carrying
  only that side, inheriting the source's grid and warping like a stem.
- Move clips across tracks with grid snapping, source-beat snapping and `Alt` bypass.
- Loop-slice a timeline clip into adjacent clips or saved samples: right-click ▸
  **Chop to Grid** (whole bar down to 1/32) for a quick grid chop, or open the Clip
  Editor's **Slice** mode for grid plus hand-placed markers.
- Analyse imported audio for key, BPM, beat positions and variable-tempo status.
- Non-destructive per-clip warp and pitch settings via Rubber Band. Dropped
  clips can auto-match the project tempo, late auto-warp engages after BPM
  analysis if needed, and warped clips show a visible **WARP** badge or
  pending spinner on the timeline.
- Resize any track row by dragging its bottom edge in the track-header column
  (clamped 60..400 px). Reorder tracks by grabbing the 6-dot grip icon next to
  a track name and dragging up or down; an emerald drop indicator shows where
  the track will land. Both are persisted with the project and undoable.
- Edit track gain with the fader or double-click the dB readout to type a value
  directly. Faders are tapered in dB (range `-∞..+6 dB`) with
  0 dB landing near the top of travel and a snap-to-`-∞` dead zone at the
  bottom. Typed input accepts forms like `-3`, `+1.5`, `0 dB`, `-inf` or `-∞`.
- Set track pan with the bipolar **Pan** slider directly below the gain fader in
  each track header — equal-power, signed `[-1, 1]` (`0` = centre), with a
  `C` / `L<n>` / `R<n>` readout and double-click to recentre. The backend
  [`BusGraph`](../backend/src/engine/BusGraph.h) applies the pan to the dry path
  after the pre-pan send tap.
- Master output volume in the transport bar: stereo peak meter (live + decayed
  hold) plus a tapered dB fader (`-∞..0 dB`, no boost). Double-click the dB
  readout to type a value. The master gain is persisted with the project,
  marks the project dirty and is applied to both live playback and mixdown
  export so the rendered file matches what the user hears.
- **Track & project effects.** The bottom panel has three tabs — **Library**,
  **Track FX**, and **Project FX**. The whole panel collapses / expands from its
  header, with `Ctrl+J`, or **View ▸ Toggle Library / FX Panel**. Each track header also has an **Fx** button
  (beside Mute / Solo) that opens **Track FX** for that track — expanding the
  panel first if it is minimised — (pressing it again collapses back to the
  Library). With no track selected the **Track FX** tab stays open and shows a
  centred "select a track" hint rather than silently bouncing to the Library, so
  the surface never feels broken. **Track FX** edits the selected track and hosts
  a **Tone** rack — a 3-band EQ (**Bass / Mid / Treble**) — a **Filter** rack
  (a single bipolar DJ-style sweep, low-pass at the left through off at centre
  to high-pass at the right), a **Compressor** (a single **Amount** knob `0..1`
  driving a hand-rolled stereo-linked soft-knee compressor; Amount 0 is a
  bit-exact passthrough; internal class `Leveler`), and a **Reverb & Delay** rack setting how much the
  track feeds the project-wide Reverb and Delay buses. **Project FX** hosts the
  shared, song-wide returns those amounts route into: a **Reverb** and a
  **Delay** (tempo-locked). All are edited live (slider drags coalesce into one undo
  step) and applied to both playback and mixdown. The DSP lives in
  [`ToneEq`](../backend/src/dsp/ToneEq.h) / [`Leveler`](../backend/src/dsp/Leveler.h) /
  [`TrackChain`](../backend/src/dsp/TrackChain.h)
  / [`BusGraph`](../backend/src/engine/BusGraph.h) (which applies pan to the dry path
  after the pre-pan send tap) and the shared-FX engine on the backend. The open
  FX tab and the selected track are project **view state**, round-tripped through
  `PROJECT_SET_VIEW` and saved in the `.silverdaw` file alongside mute / solo.
  The whole panel can also be **minimised to its tab strip** and expanded again
  via the tab-strip toggle (clicking any tab while minimised also expands it); a
  quick height-slide animates the change. That collapsed state
  (`ui.libraryPanelCollapsed`) is a UI preference persisted in `preferences.json`,
  so it survives relaunch without marking the project dirty.
- **Per-clip Volume Shape.** The Clip Editor draws an editable volume envelope
  directly over the clip waveform: a faint line is always shown, and the
  **Volume** toolbar toggle makes it editable so the user can add / drag
  breakpoints. A fade-in or fade-out is just the envelope's end breakpoints
  dragged down to silence (there is no separate fade control). Points are stored
  on the clip as `envelopePoints`, applied non-destructively to both live
  playback and mixdown export. In the stereo waveform display the single
  envelope line is mirrored and kept in sync across both channel lanes —
  editing a breakpoint in either lane edits the one shared shape (the engine
  applies that shape equally to both channels).
- **Reverse clip.** A clip can be played back-to-front non-destructively. The
  flag is set from the timeline clip's right-click ▸ **Reverse** entry (a
  checkmarked toggle) or from the **Reverse** toggle in the Clip Editor toolbar,
  where it is part of the transactional draft and previewed live. Reversal is a
  per-clip `reversed` flag — the source file is never rewritten; the audio engine
  reads the clip's source window in reverse. From the context menu the toggle
  propagates to every linked saved clip sibling; from the Clip Editor it follows
  the same save scope as the other draft edits. The flag round-trips through
  `PROJECT_STATE` and the `.silverdaw` file and is suppressed from save when off.
  A reversed clip is flagged on the timeline with a teal **REV** clip-header badge.
- **DJ turntable effects (brake & backspin).** Two non-destructive, per-clip
  "turntable" effects applied at a clip's **end**: a **Brake** (a vinyl
  record-stop — the clip decelerates to a halt; a varispeed where pitch and tempo
  fall together) and a **Backspin** (a reverse rewind that accelerates backwards
  then slows to a stop). A clip can have a **Brake or a Backspin, never both** —
  the two are mutually exclusive at the data level (setting one clears the other in
  the store, `ProjectState`, and the engine). The UI extends this to a three-way
  group with **Reverse**: in **both** the timeline right-click menu and the Clip
  Editor toolbar, each of Reverse / Brake / Backspin stays visible but is
  **disabled while another in the group is set** (and the engine only applies a tail
  to forward clips). Stored as suppressed-when-off per-clip booleans `brake` /
  `backspin` that, like reverse, **propagate across linked saved-clip siblings**.
  They apply
  to **live timeline playback and mixdown export**, and the **Clip Editor** exposes
  matching **Brake** / **Backspin** toolbar toggles that audition live on the
  preview voice, draw a matching tail overlay on the editor waveform, and commit
  on Save. The audio engine publishes an immutable
  `BrakeSnapshot` / `BackspinSnapshot`
  (`backend/src/dsp/`) lock-free to the audio thread and renders the tail as a
  varispeed directly from the source (cubic interpolation + a rate-keyed end
  fade) inside `OffsetSource`. **Forward clips only** (reverse is excluded), but
  they **compose with warp** — the clip is warped up to the effect trigger, then
  the tail bypasses the pitch-preserving stretcher (a record-stop *changes* pitch,
  so it cannot go through it) and reads the source directly, using the warp tempo
  ratio only to start at the right place and keep the clip length. A red **BRAKE**
  / violet **SPIN** clip-header badge and a red / violet tail overlay on the
  waveform mark the effect. Duration + curve / intensity come from a global app
  preference (**Preferences ▸ Effects**, below), pushed to the backend on save and
  on every reconnect and re-applied live to all affected clips.
- **Loop slicing.** Chop a clip into slices on a bar/beat grid (whole bar … 1/32)
  or with hand-placed markers, then commit them as **adjacent timeline clips** or
  **individual library samples**. The Clip Editor's **Slice** toolbar toggle
  (mutually exclusive with Volume mode) opens an on-waveform marker overlay plus a
  **Slice** panel (subdivision picker, **Generate to grid**, marker count, **Slice
  to timeline** / **Slice to samples**); a timeline right-click ▸ **Chop to Grid**
  submenu is the no-editor quick path. Slice-to-timeline reuses the client-side
  split (right→left, one **Slice clip** undo step, warp-aware) and inherits split's
  locked/linked guards; slice markers are transient Clip-Editor draft state and are
  never persisted. Slice points are derived purely from the source `bpm` +
  `beatAnchorSec`, so no backend round-trip is needed to place a grid.
- **Mixdown export** (File ▸ Export Mixdown…) renders the whole project to a
  single stereo file. Formats: WAV (16 / 24 / 32-float), FLAC (16 / 24), AIFF
  (16 / 24), MP3 (128 / 192 / 320 kbps, bundled LAME). Optional TPDF dither for
  16-bit targets, configurable silence tail, file-level tags (mapped per-format
  to ID3 / RIFF INFO / VORBIS_COMMENT / AIFF text chunks) and ITU-R BS.1770-4
  loudness analysis with optional two-pass normalisation to a target LUFS with
  true-peak ceiling. A **Start from bar** field renders only from a chosen bar
  onward (the displayed bar number, defaulting to `1`); earlier bars are skipped
  from the output. Dialog choices (format, sample rate, bit depth, bitrate /
  quality, dither, tail, loudness mode + target, tags, output path) are
  persisted at the *project* level via `PROJECT_SET_EXPORT_SETTINGS`, while the
  start bar persists separately as `PROJECT.mixdownStartBar`
  (`PROJECT_SET_MIXDOWN_START_BAR`), so a reopened project remembers how it was
  last exported. The live transport is
  force-paused and `TRANSPORT_PLAY` is rejected for the duration of a render.
  Export renders through the **same per-clip path as live playback** — warp /
  pitch, reverse, the volume-shape envelope and edge fades, and the turntable
  brake / backspin tails all bake into the mixdown identically (the offline
  graph builds the same `OffsetSource` snapshots), so what you hear is what you
  export.
- **Clip lock** (Ctrl+L or right-click ▸ Lock / Unlock) freezes a single
  timeline clip against accidental move / trim / split. Locked clips show a
  padlock badge in their title strip, refuse drag-move and edge-trim gestures
  silently, and surface a toast if the user tries Split-at-playhead on them.
  Double-click still opens the Clip Editor (so warp / pitch / trim remain
  editable through that surface). The flag is per-clip — locking one
  linked saved clip sibling does not lock the others — and is round-tripped
  through `PROJECT_STATE` and the `.silverdaw` file.
- **End-of-project playback** stops automatically: when the playhead reaches the
  project ruler's end, the renderer sends `TRANSPORT_PAUSE` and parks the playhead
  there. The Play button (and the Spacebar shortcut) is disabled while the
  playhead sits at the end — skip back to the start to re-arm playback.
- **Edit ▸ Trim Project to Last Clip** collapses the project length to the end of
  the latest clip on any track. Manual project-length edits are also clamped so
  the ruler cannot be shortened below the longest clip's effective end.
- Save reusable saved clips to the library from any timeline clip; saved clips are
  grouped under their source file and can be dragged back to the timeline as a clip
  with the same source window. **Linked saved clips**: clips dropped from a saved clip
  library tile remember that link; the Clip Editor batches trim, warp and pitch edits
  into a single transactional draft and the **Save** button propagates them to every
  linked timeline instance in lockstep, unless a collision would result (in which
  case the user is prompted and the edit is rejected). Linked clips show a small
  chain badge in their title strip and are locked against edge-resize on the timeline
  — to free a single instance for per-clip trim use right-click ▸ **Unlink from
  library**. Removing a saved clip from the library is always allowed: every
  dependent timeline clip is silently unlinked first so the audio plays on as an
  independent clip referencing the underlying source file.
- Bake timeline clips or library clip items into new WAV samples. Timeline clips
  use **Save as Sample…** to open the **Save as Sample** dialog, while library
  clips expose **Save as Sample (Music)** and **Save as Sample (Simple)** directly
  in their context menu. The generated file is written under a per-source subfolder of
  the `samples` folder and added back to the library as a sample item that
  inherits the source's cover art and tags. A **simple** (non-music) sample bakes
  the clip's warp/pitch through Rubber Band into a flat one-shot; a **music** sample
  keeps the source tempo/pitch and inherits its grid instead.
- Harvest a clip's slices straight to the library with the Clip Editor's **Slice
  to samples** (one WAV per slice, default **simple** one-shots, named per slice).
  The backend writes them in a single batch via `CLIP_SLICE_TO_SAMPLES`, and the
  renderer shows one summary toast for the whole run.
- **Split Stereo Channels…** on a stereo timeline clip (right-click; hidden when
  the source isn't 2-channel) opens a Left/Right picker. Each chosen channel is
  exported via `CLIP_SPLIT_CHANNELS` — the backend reuses the sample-export writer
  (`SampleExport.cpp`) with a channel-duplicate step (`ChannelSplitDsp.h`) to write
  a raw source-window WAV whose L and R both carry that one channel, under a
  per-source subfolder of the `channels` folder. The result is announced via
  `CHANNEL_SPLIT_READY` (or `CHANNEL_SPLIT_FAILED`); the renderer imports each file
  as a **stem**-kind library item (so cleanup and serialization are shared with
  stems) and drops it on its own new track aligned to the source clip, inheriting
  the source's grid and auto-warp exactly like a stem. No warp is baked. Runs on
  the export thread pool, so a long clip never blocks the bridge.
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
  launch or after File > New on a fresh install. Each MRU entry stores the
  project's display name alongside its path; the name is refreshed on every save
  (so a renamed project shows its new name) and legacy path-only entries fall
  back to the file name. Both surfaces label an entry by that name and keep the
  full path as the hover hint.
- Relink a missing source file at the **library item** level — every clip
  referencing that item picks up the new file automatically. The Relink dialog
  groups missing references by file path so the same broken path used by ten
  clips is fixed with a single Locate File click.
- Choose any installed audio output device — selection is always an explicit
  named device (there is no "System default" option); hot-swap from the
  transport bar without leaving the timeline. The selection
  is persisted, removable devices (USB, Bluetooth) fall back to the next
  available device when unplugged, and the saved choice is honoured again as soon as the device
  reappears. Bluetooth output is auto-detected and the visible playhead
  compensates for radio-and-headset latency so it stays in sync with what you
  hear (~250 ms for A2DP, ~400 ms for HFP).
- **Project Properties** dialog (File ▸ Project Properties…) edits project
  name, BPM, duration, per-project audio output device + driver, and
  per-project sample rate (44.1 / 48 kHz) as a transactional Save / Cancel
  dialog with field-level validation.
- **Per-project sample rate.** Projects can pin themselves to 44.1 or 48 kHz.
  Imports preflight every file's true header rate and prompt with three exit
  paths (Cancel / Convert to project rate / Switch project rate) when the
  source doesn't match. The transport bar's **RATE** column shows the
  effective project rate at all times. See [Project sample rate](#project-sample-rate).
- **Tempo confidence and audio type classification.** When BPM analysis comes back at
  low confidence the grid stays visible and warpable rather than hidden — there is
  no separate amber "unverified" marker on the BPM (the classification control still
  notes a low-confidence tempo in words). A track is only treated as a
  **simple** audio file (badges and beat markers hidden, auto-warp on drop
  skipped, project-BPM seed suppressed) through an explicit per-file
  **Auto-classify** / **Treat as Music** / **Treat as Simple** override from the
  library tile context menu or the Info dialog (saved clips inherit from their
  source). When detection is unsure
  the user can also set a BPM by hand and slide the beat grid over the waveform in
  the Clip Editor to line it up. Warp and Pitch dialogs work regardless for
  explicit speed / pitch changes.
- Package the app for Windows three ways from one release script — a signed
  MSIX/AppX sideload package, a portable zip, and an unsigned Microsoft Store
  package — bundling the backend, icons, licences and the `.silverdaw` file
  association. The backend is statically linked against the MSVC runtime, so
  a clean Windows install does not need a separate Visual C++ Redistributable.
- Undo / redo (Ctrl+Z / Ctrl+Y) any project-mutating edit. Covers
  clip add / move / trim / recolour / rename / delete / relink / rebind, track
  add / remove / rename / gain / **resize / reorder**, clip **lock / unlock**,
  clip **reverse / brake / backspin** (each toggle is its own undo step), library
  add / remove / relink / reanalyse, marker add / move / remove, BPM,
  project length, master volume and project rename. Drag streams (clip move / trim /
  track gain / marker move / master volume) coalesce same-target events within 500 ms
  into a single undo step; track resize and reorder commit a single
  step on `pointerup`; everything else gets its own step. View state
  (zoom, scroll, playhead) is intentionally outside the undo stack
  so navigating around doesn't pollute the history. The **Clip Editor
  Trim** workflow keeps a dialog-local undo stack so the user can
  tweak a trim with Ctrl+Z/Y inside the dialog without touching the
  project-level history; only when the user clicks **Save** or
  **Save Selection to Library** does the change land in the main undo stack.
  Compound operations like clip split, duplicate, and paste run inside an
  explicit undo group (`EDIT_GROUP_BEGIN` / `EDIT_GROUP_END`) so the whole action
  collapses to a single undo step.

Playback is always served from the decoded WAV cache; original compressed sources
(MP3, M4A, …) are only used to generate that cache. This keeps the read-ahead
buffer's latency-hiding contract intact at clip boundaries so back-to-back loops
play seamlessly.

The main remaining roadmap areas are region selection on timeline clips, library
search / tags / list view, and the
wider mixer / effects / automation work (a deeper per-clip processor chain —
saturation — applied both live and in mixdown, beyond the per-track Tone EQ +
Filter, the per-track Compressor, the project-wide Reverb and Delay sends,
the track effect automation lanes, the per-clip Volume Shape, and the per-clip
turntable Brake / Backspin tails that already ship).

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
  merges additively. After a mid-session backend respawn the reconnect lands on a fresh, **empty**
  engine — a reconnected socket is not yet a recovered session, so the renderer re-loads the
  user's project and waits for its `reset=true` snapshot before treating the session as restored
  (see [Engine resilience and recovery](#engine-resilience-and-recovery)).

**Bulk data goes via disk, never via the socket.** When the backend has fresh waveform peaks
ready it sends a `WAVEFORM_READY { clipId, cachePath, peakCount, peaksPerSecond, sampleRate, laneCount }`
envelope. The cache file at `cachePath` (under `%APPDATA%/Silverdaw/peaks/`) holds the peaks
themselves; the renderer reads it via main's `peaks:readCacheFile` IPC and parses the 28-byte
header + float32 payload locally. This mirrors how the same architecture treats audio files,
project files, stems and mixdowns — the WebSocket carries the control plane, the
filesystem carries bulk data. Keeps the IXWebSocket I/O loop on the lightweight text-only path
it was designed for.

The full envelope catalogue lives in
[`frontend/src/shared/bridge-protocol.ts`](../frontend/src/shared/bridge-protocol.ts).
Inbound (backend → renderer) payloads are defined as `zod` schemas; the
TypeScript types are derived via `z.infer<typeof XPayloadSchema>` so the schema
is the single source of truth — there is no separate hand-written interface to
drift away from the runtime guard. Each `isXxxPayload` guard is a one-line
wrapper around `schema.safeParse(value).success`. Outbound (renderer → backend)
payloads stay as plain TypeScript interfaces because every `send<K>()` call site
is type-checked at compile time. The renderer dispatches inbound messages in
[`frontend/src/renderer/src/lib/bridgeService.ts`](../frontend/src/renderer/src/lib/bridgeService.ts);
the backend dispatches in [`backend/src/bridge/BridgeDispatch.cpp`](../backend/src/bridge/BridgeDispatch.cpp)
(`dispatchBridgeMessage`). Inbound string / number payload fields on the
backend are extracted through the strict
[`backend/src/bridge/PayloadHelpers.h`](../backend/src/bridge/PayloadHelpers.h) helpers
(`tryGetString` / `tryGetRequiredString` / `tryGetNumber`) which reject
malformed values up front instead of silently coercing them via
`juce::var::toString()`.

A few envelopes exist purely for liveness and fault reporting rather than
project edits: `PING` (renderer → backend) and `PONG` (backend → renderer) form
a liveness probe — the backend answers `PONG` **on the JUCE message thread**, so
a completed round-trip proves the command thread itself is responsive, not merely
that the socket is open — and `ENGINE_ERROR` (backend → renderer) reports a
handler-level fault that the engine **caught and survived**. Their behaviour and
the recovery UX they drive are described under
[Engine resilience and recovery](#engine-resilience-and-recovery).

The MIDI control path uses seven domain envelopes:

- `MIDI_DEVICES_REQUEST` asks the backend to enumerate connected inputs.
- `MIDI_INPUTS_SET { identifiers }` replaces the set of enabled inputs. The
  backend ignores identifiers whose device names do not match a supported
  profile.
- `MIDI_DECK_SELECTION_SET` restores the enabled state of physical decks 1 and
  2 for one input.
- `MIDI_DEVICES_LIST` reports every detected input with its identifier,
  connection/enabled state, recognised profile label, and latest activity.
- `MIDI_MESSAGE` carries a rate-limited raw-message sample for the MIDI Monitor.
- `MIDI_CONTROL` carries one decoded semantic button, relative, or absolute
  controller action.
- `MIDI_DECK_SELECTION` reports a physical deck-selection change made from the
  controller.

## MIDI controller architecture

MIDI support is model-specific and data-driven. The canonical user-facing
device and capability matrix is
[MIDI deck controllers](midi-controllers.md); the JSON schema is documented in
[`backend/resources/midi-mappings/README.md`](../backend/resources/midi-mappings/README.md).

The backend loads every
`backend/resources/midi-mappings/*.json` file on first use. Development builds
fall back to that source directory; CMake copies the same directory beside the
backend executable and electron-builder packages it unchanged. Profiles are
validated for types, value ranges, model-name conflicts, and overlapping input
bindings. Device matching is case-insensitive, uses token boundaries, honours
`excludedModels`, and selects the longest matching model name.

`MidiInputMonitor` owns connected inputs:

- Enumeration reports all MIDI inputs, including unsupported ones.
- `MIDI_INPUTS_SET` opens only inputs recognised by
  `supportsMidiControllerMapping`; the same allowlist is enforced in the UI and
  backend.
- JUCE's MIDI callback writes raw short messages into a preallocated
  512-message `AbstractFifo`. A 60 Hz JUCE message-thread timer drains it,
  decodes profile bindings, combines relative movement received in one tick,
  and broadcasts semantic `MIDI_CONTROL` messages. JSON parsing and allocation
  never occur in the MIDI callback.
- The mapper supports buttons, centred and two's-complement relative values,
  7-bit and 14-bit absolute values, relative/absolute 14-bit platters, and
  contiguous pad ranges. Shift and jog-touch state can select alternate
  actions.
- Two physical decks are modelled. A profile's headphone-Cue/PFL binding
  toggles whether messages from that deck are accepted; shared controls remain
  active while either deck is active. The state is persisted by the Electron
  preferences layer.

The renderer converts semantic controls into operational actions in
`midiControllerActions.ts` and `midiBrowseActions.ts`. Jog movement is
animation-frame coalesced; normal movement snaps to timeline grid lines and a
held Sync modifier selects free movement. Browse controls switch between track
selection, clip selection/range extension, and timeline zoom. Absolute channel
faders, Tone EQ, and Filter target the currently selected track, with a short
catch-up transition when hardware and software positions differ. Master volume
is applied to the project. Crossfader input is retained as controller telemetry
but does not currently alter the audible mix.

If a profile defines output bindings, the backend opens one unambiguous MIDI
output whose name matches the input. It can then send selected-track meters,
Play/Cue state, active-deck state, and marker-pad lights. Missing output
feedback does not prevent controller input.

## Engine resilience and recovery

The audio engine runs as a separate process, so Silverdaw treats "the engine
went away" as a normal, recoverable event rather than a crash the user has to
manage. Four cooperating mechanisms keep a session alive across an engine crash,
hang, or OS sleep/resume fault — none of which expose the front-end/back-end
split to the user.

### Process supervisor (main)

[`backendSupervisor.ts`](../frontend/src/main/backendSupervisor.ts) owns the
backend's lifecycle for the whole session. It spawns the engine once and, on any
*unexpected* exit, respawns it on the **same** loopback port and AUTH token (so
the renderer's socket reconnects transparently) after a short backoff. Respawns
are bounded: after `MAX_CONSECUTIVE_FAILURES` (8) consecutive failed restarts it
gives up into a terminal `failed` state instead of fork-bombing. A respawn that
stays alive past a stability window (~10 s) is treated as healthy and resets the
failure budget, so unrelated crashes spread across a long session each get a full
set of retries. The supervisor pushes coarse process status — `restarting`,
`recovered`, `failed` — to the renderer, and an intentional app shutdown marks
the next exit as expected so it is not respawned. Covered by Vitest specs.

### Liveness watchdog (renderer)

The backend only pushes data while playing, so an idle session has no inbound
traffic to prove the engine's message thread is still alive.
[`bridgeService.ts`](../frontend/src/renderer/src/lib/bridgeService.ts) runs a
watchdog that, after a quiet spell (`WATCHDOG_IDLE_MS`, 3 s), sends a `PING` and
expects a `PONG` answered on the JUCE message thread. `WATCHDOG_MAX_MISSED` (3)
consecutive missed replies (each timed out after `WATCHDOG_PONG_TIMEOUT_MS`, 2 s)
declare the engine hung and trigger a supervised restart via `restartBackend`.
The probe is suppressed when the engine is legitimately busy — during playback
(`PLAYHEAD_UPDATE` already proves liveness) and during known-heavy work such as
library import or BPM analysis — to avoid false restarts. A large positive clock
drift (`WATCHDOG_DRIFT_MS`, 4 s) is read as an OS sleep/resume and resets the
watchdog rather than counting the gap as missed pongs. In practice this surfaces
a wedged engine within roughly 7–11 s.

### Recovery coordinator (renderer)

A respawned engine is **empty**: reconnecting the socket is not the same as
recovering the session.
[`engineRecovery.ts`](../frontend/src/renderer/src/lib/engineRecovery.ts) bridges
that gap. At the instant of loss it captures what the user had open (project id,
file path, dirty flag), then re-loads it into the fresh engine — preferring the
matching autosave bucket, falling back to the last saved file, and doing nothing
for an untitled, never-saved project (the empty engine already matches it). It
exposes a small state machine — `engineRecovery ∈ { ok, recovering, restoring,
unavailable }` — that
[`EngineRecoveryOverlay.vue`](../frontend/src/renderer/src/components/EngineRecoveryOverlay.vue)
uses to gate the UI while a recovery is in flight. Every cycle is tagged with a
monotonic generation so a stale async continuation from a superseded attempt
can't corrupt a fresh one, and per-phase deadlines (`RECONNECT_TIMEOUT_MS` 15 s,
`RESTORE_TIMEOUT_MS` 20 s) turn a stuck recovery into a terminal `unavailable`
state that offers **Try again** / **Quit** rather than spinning forever.
Completion is confirmed only by the re-load's own `reset=true` `PROJECT_STATE`
snapshot — never by process status alone — after which a friendly toast notes
that the last few seconds of changes may need redoing.

### In-handler guardrail (backend)

Every inbound envelope is dispatched on the JUCE message thread inside a `try` /
`catch`. An exception escaping a single handler would otherwise unwind out of the
dispatch loop and take the whole engine down, so the catch keeps the process
alive, logs the fault, and surfaces it to the renderer as a **non-fatal**
`ENGINE_ERROR { message, context }` — which the UI shows as a brief "the engine
hit a problem but kept running" notice. A top-level `try` / `catch` in `main()`
is the last resort for anything that still escapes. The trade-off is explicit: a
handler that threw part-way may leave an edit partially applied, but a
possibly-imperfect edit is preferred over a dead engine.

### Startup diagnostics (always-on)

The backend is not optional — without its audio engine the app is unusable — so
a backend that **can't start** is a hard failure, surfaced to the user as
"could not connect to the audio engine" (the renderer's cold-start connect
timeout, `BRIDGE_CONNECTION_TIMEOUT_MS`, 30 s). Because a hard fault during
startup (e.g. an access violation deep in a WASAPI/COM audio driver while
enumerating devices) happens *before* the bridge is listening — and MSVC's
default `/EHsc` means the top-level `try` / `catch` in `main()` cannot catch a
structured (SEH) exception — such a failure would otherwise leave no trace,
especially on a machine we can't attach to (a clean install, a Store
certification VM). Two always-on mechanisms guarantee a diagnosable artifact,
**independent of the Preferences ▸ Developer diagnostic-logging toggle**:

- **Diagnostics directory.** Electron main always creates a diagnostics
  directory on launch (packaged installs: `%USERPROFILE%\Silverdaw\Diagnostics`,
  a discoverable non-virtualised location — under MSIX a `userData`/`%APPDATA%`
  path is silently redirected into a hidden package container; dev builds:
  `<userData>/diagnostics`) and passes it to the backend as `SILVERDAW_DIAG_DIR`
  on every spawn — distinct from
  the opt-in verbose sink (`SILVERDAW_LOG_DIR`, only set when logging is enabled).
  Main writes `startup.log` there (truncated each launch): the launch banner and
  the backend lifecycle it observes (spawn path/port, exit code/signal, respawns,
  `failed`). This captures the case where the backend never even spawns.
- **Backend crash reporter + startup log.**
  [`CrashHandler.cpp`](../backend/src/core/CrashHandler.cpp) installs a
  `SetUnhandledExceptionFilter` as the very first thing in `runBackend`, writing
  `backend-crash.log` (fixed name, overwritten) with the exception code, fault
  address, faulting **module**, the access type/address, and a **phase**
  breadcrumb (`startup` → `audio-device-init` → `bridge-start` → `running`, set
  via `crash::setPhase`) so a report names exactly what the backend was doing.
  Alongside it, `Log` is always initialised to the diagnostics dir at **INFO**
  level (truncated each launch) so the startup sequence is recorded even with
  verbose logging off. This diagnostics sink is **startup-scoped**:
  `log::markStartupComplete()` closes it the instant the message loop is reached,
  so it holds only the startup trace — ending in `startup complete` on success,
  or cut off at the failing phase — and never accumulates runtime chatter (that
  is the verbose sink's job). A later runtime crash is still captured by the
  crash reporter.

The net result: on any failed launch, the diagnostics directory holds a small,
current-launch-only picture — `startup.log` (did it spawn / what exit code),
`backend.log` (how far startup got), and `backend-crash.log` (the faulting
module, if it crashed) — enough to pinpoint a failure-to-start without a debugger
and without the user enabling anything.

## Project state model

`ProjectState` (C++) wraps a `juce::ValueTree`:

```text
PROJECT[name, bpm, projectLengthMs, viewPxPerSecond, viewScrollX, playheadMs,
        viewSelectedTrack?, viewFxPanelOpen?,
        audioOutputTypeName?, audioOutputDeviceName?, targetSampleRate?,
        masterVolume?, exportSettingsJson?, barCounterStart?, mixdownStartBar?,
        metronomeEnabled?,
        reverbSize?, reverbDecay?, reverbTone?, reverbMix?,
        delayNoteValue?, delayFeedback?, delayTone?, delayMix?]
  TRACK[id, name, gain, heightPx?, muted?, soloed?,
        toneBassDb?, toneMidDb?, toneTrebleDb?, toneFilter?,
        sendReverb?, sendDelay?, pan?]
    CLIP[id, libraryItemId, offsetMs, inMs, durationMs, colorIndex?, clipName?,
         locked?, reversed?, brake?, backspin?,
         warpEnabled?, warpMode?, tempoRatio?, semitones?, cents?, pendingAutoWarp?,
         envelopePoints?,
         effectiveDurationMs?, effectiveTempoRatio?, effectiveWarpActive?]
  LIBRARY
     ITEM[id, kind, filePath, fileName?, displayName?, durationMs,
          sampleRate, channelCount, key?, bpm?, beats?, beatAnchorSec?,
          playbackFilePath?, variableTempo?, lowConfidence?, audioType?, collapsed?,
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

`effectiveDurationMs`, `effectiveTempoRatio` and `effectiveWarpActive` are
**backend-authoritative** effective timing fields. They are computed by
`ProjectState::computeClipEffectiveTiming` from the source BPM, current warp
state and project BPM, and emitted on every clip in `PROJECT_STATE` plus the
`CLIP_WARP_APPLIED` payload. The frontend uses them as the single source of
truth for the rendered/audible timeline footprint of a warped clip — drawing,
collision checks, split / duplicate / paste maths, and Clip Editor
overlap-validation all read from these fields rather than recomputing the
ratio in the renderer.

`ITEM.kind` is one of `source`, `stem`, `sample`, or `clip`. Source, stem, and
sample items are standalone audio files; clip items are reusable regions derived
from a timeline clip. Clip items share `filePath` with their parent source item
and carry `sourceItemId` / `sourceClipId` / `sourceInMs` / `sourceDurationMs`
describing the trim window into the source. `displayName` is the user-facing name
shown on library tiles. `collapsed` is a per-source UI flag that hides the saved
clip sub-list under a parent source. `ITEM.key`, `ITEM.bpm`, `ITEM.beats`,
`ITEM.beatAnchorSec` and `ITEM.variableTempo` hold the BTrack analysis output (see
[Audio analysis](#audio-analysis) below). `ITEM.lowConfidence` is the backend's
auto-classification hint from that same analysis; `ITEM.audioType` is the user's
explicit `'simple'` / `'music'` override (absent = auto). `ITEM.playbackFilePath` is
the on-disk path of the decoded-WAV cache the audio engine reads from. The durable
library fields are stored once and round-tripped through save/load so a reopened
project doesn't have to re-analyse every imported file.

`PROJECT.audioOutputTypeName` / `PROJECT.audioOutputDeviceName` carry the project's
preferred audio output (driver name + device name); both absent means "use the
user-scope default". `PROJECT.targetSampleRate` is the project sample rate when
explicitly set (`44100` or `48000`); absent means the renderer falls back to the
user-scope `ui.defaultProjectSampleRate` preference. Both are user-editable from
the Project Properties dialog (see [Project properties](#project-properties)).
`PROJECT.masterVolume` is the linear master-bus gain in `[0, 1]` (UI presents
it in dB via the shared `lib/audio/db.ts` taper); absent means unity and the
property is suppressed from save when at unity to keep older projects bit-clean.
`PROJECT.exportSettingsJson` is a single opaque JSON blob (capped at 64 KB)
holding the last-used mixdown export dialog choices for this project; it is
written via `PROJECT_SET_EXPORT_SETTINGS`, parsed with field-level whitelist /
clamp / schema-version guards on load, and does not generate undo entries
(only a dirty-mark) so re-exporting doesn't clutter the undo history.
`PROJECT.barCounterStart` is the number shown for the **first** bar on the
timeline ruler (default `1`); the ruler labels each bar as
`barIndex + barCounterStart`, so the default shows `1, 2, 3, …` and setting it to
`0` or lower (down to `-64`) reveals lead-in bars (`0, 1, 2, …`) before bar one —
useful when a clip has a silent intro and should sit against the timeline start
without trimming. `PROJECT.mixdownStartBar` is the displayed bar number the
mixdown render begins from (default `1`, range `-64..4096`); it is converted to a
project-time offset as `max(0, mixdownStartBar - barCounterStart)` bars, so bars
before it are skipped from the exported file. Both are integers, set via
`PROJECT_SET_BAR_COUNTER_START` / `PROJECT_SET_MIXDOWN_START_BAR`, suppressed from
save when at the default `1`, and round-trip through `PROJECT_STATE` and the
`.silverdaw` file. `barCounterStart` is user-editable from the Project Properties
dialog; `mixdownStartBar` is edited in the Export Mixdown dialog and changing it
does not affect `barCounterStart` (and vice versa).
`CLIP.locked` is an optional boolean (absent == unlocked) that freezes a clip
against move / trim / split gestures on the timeline; the lock is per-clip,
not propagated across linked saved clip siblings, and round-trips through
`PROJECT_STATE`. `CLIP.reversed` is an optional boolean (absent == forward) that
plays the clip's source window back-to-front; it is set via `CLIP_SET_REVERSED`
(timeline) or `PREVIEW_SET_REVERSED` (Clip Editor live preview), suppressed from
save when off, and round-trips through `PROJECT_STATE` and the `.silverdaw` file.
`CLIP.brake` and `CLIP.backspin` are optional, **mutually exclusive** booleans
(absent == off) for the per-clip turntable record-stop / reverse-rewind tail
effects; they are toggled from the timeline via `CLIP_SET_BRAKE` /
`CLIP_SET_BACKSPIN` and from the Clip Editor's Brake / Backspin toolbar toggles.
Like reverse, they **propagate across linked saved clip siblings** — toggling one
on a linked clip (timeline right-click or Clip-Editor Save) routes through
`library.updateLibraryClipBrake` / `updateLibraryClipBackspin`, which fans the flag
out to every linked timeline instance; an unlinked clip is set directly. Their
global duration / curve / intensity defaults are
pushed to the engine with `BRAKE_SETTINGS_SET` / `BACKSPIN_SETTINGS_SET`. The
Clip Editor auditions them live on the preview voice via `PREVIEW_SET_BRAKE` /
`PREVIEW_SET_BACKSPIN`. Both flags are
suppressed from save when off and round-trip through `PROJECT_STATE` and the
`.silverdaw` file.

**Phase 5 effects properties.** Each `TRACK` carries optional sound-shaping
fields, all suppressed from save when at their defaults so legacy projects stay
bit-clean: `toneBassDb` / `toneMidDb` / `toneTrebleDb` are the per-track 3-band
EQ gains in dB, `toneFilter` is the bipolar Filter position, signed
`[-1, 1]` (`0` = off / centre, negative = low-pass / High Cut, positive =
high-pass / Low Cut),
`sendReverb` / `sendDelay` are `[0, 1]` send amounts feeding the project-wide
Reverb and Delay buses, `pan` is the equal-power pan position, signed
`[-1, 1]` (`-1` = hard left, `0` = centre, `+1` = hard right), and
`levelerAmount` is the per-track **Leveler** strength in `[0, 1]` (`0` = off /
bypassed). The shared buses themselves live on the `PROJECT` node:
`reverbSize` / `reverbDecay` / `reverbTone` / `reverbMix` describe the single
project **Reverb**, and `delayNoteValue` / `delayFeedback` / `delayTone` /
`delayMix` the project **Delay** (tempo-locked). `CLIP.envelopePoints` is
an optional `{ timeMs, gain }` breakpoint array — the per-clip **Volume Shape**;
`gain` is linear in `[0, 4]` (`1.0` = unity) and the property is normalised
(sorted, clamped, de-duplicated) backend-side and removed entirely when the
shape is cleared. `viewSelectedTrack` / `viewFxPanelOpen` are view state for the
bottom-panel FX tabs, round-tripped through `PROJECT_SET_VIEW`.

Timeline markers are stored as `MARKER` children with absolute project positions in
milliseconds, round-trip through `PROJECT_STATE`, and mark the project dirty when
added, moved or removed.

`metronomeEnabled` toggles an audible click track that the backend
[`Metronome`](../backend/src/engine/Metronome.h) renders in time with the project
BPM during playback. The click is phase-locked to the absolute transport sample
position (tempo- and seek-correct) and mixed in **after** the master-gain stage in
the metering source, so master volume never silences it. The toggle lives in the
transport bar's timing display (top-right) and defaults to off. The flag is
persisted with the project but **silently**: its setter runs under a dirty
suppression guard and is excluded from the undo history, so flipping this
monitoring aid never marks the project dirty or adds an undo step. It is omitted
from save (and from the `PROJECT_STATE` broadcast) while at its default-off value.

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
flag, collapse state, saved clip warp defaults and (for saved clips) the source-window pointers. Cover art, ID3 tags,
waveform peaks and playable bytes are not written into the project file; they are re-fetched
or served from cache on load.

**Save / load** is via `.silverdaw` files — a versioned JSON serialisation. A small outer
object carries `schemaVersion`, `appVersion`, and an ISO `savedAt` timestamp; the `project`
field holds the entire `PROJECT` `ValueTree` mapped through
[`ValueTreeJson`](../backend/src/project/ValueTreeJson.h) (each node becomes
`{ "$type": "TRACK", id: "...", $children: [ … ] }`). Atomic save (write `<file>.tmp` then
rename) and forward-compatible load (unknown keys are ignored). Normal Save / Save As writes
the full project tree. Before leaving a clean project, the renderer sends
`PROJECT_SAVE_VIEW_STATE`; the backend updates only `viewScrollX` and `playheadMs` in the
existing `.silverdaw` file, so view state survives reopen without saving unrelated unsaved
project edits or changing the dirty flag. Logic lives in
[`backend/src/project/ProjectFile.cpp`](../backend/src/project/ProjectFile.cpp).

**Portable project folder** — Save / Save As nests the project into its own folder
(`<chosen dir>/<Name>/<Name>.silverdaw`) so all generated artifacts can live beside it
(`stems/`, `samples/`, plus the `metadata/` and `covers/` media store described below).
At the disk boundary `ProjectFile.cpp` rewrites path properties
(`filePath`, `playbackFilePath`) **relative to the project folder** when they point inside
it, and keeps them absolute otherwise — so original source files and machine-local caches
stay absolute while project-internal stems/samples become relative. The in-memory tree and
the `PROJECT_STATE` snapshot always hold absolute paths; the conversion happens only on
save (absolute → relative) and load (relative → absolute, resolved against the file's
location). The net effect: moving or syncing the project folder (e.g. via cloud storage)
carries the project with its stems and samples intact, as long as the original source files
sit at the same absolute path on the other machine. Peaks are deliberately **not** stored
with the project — they are a regenerable cache (`<appData>/Silverdaw/peaks`) rebuilt from
source on demand.

**Central media store (cover art + tags)** — embedded tag metadata and cover art are not
stored per library item. At first import each source file is minted a **media GUID**, and
its tags are written to `<projectDir>/metadata/<guid>.json` and its cover image to
`<projectDir>/covers/<guid>.<ext>` (before the first save the store lives in the temp
workspace `<temp>/Silverdaw/{metadata,covers}` registered at startup, copied into the
project folder on save). Every derived item — stems
and samples — **carries the source's GUID** (the backend resolves it by walking the
`sourceItemId` provenance chain) so it reads the same cover art and tags from that one
store entry, even after the original library item is removed. The renderer reads/writes the
store through guarded main-process IPC (`media:get` / `media:save`, roots registered by
`registerProjectMediaRoots`); the dirs are returned by `getProjectMediaDirs`. When the
optional **Clean up project files** preference is on, removing a library item deletes
its generated stem/sample WAV and then prunes the per-source folder once nothing but the
artifacts that removal took remains in it (another still-referenced stem/sample, or any
file the app did not generate, keeps the folder) — all via the **audio backend** over the
bridge (`LIBRARY_DELETE_ARTIFACTS { paths }`), which re-confines every path to the
project's stems/samples artifact trees so a user's original imported audio is never
touched. The backend counts the folder's files **before** deleting, and when its own
artifacts are the only contents it removes the whole directory in one `deleteRecursively`
(no delete-then-prune window). It first clears the folder's **read-only attribute** —
sync clients such as OneDrive stamp synced folders read-only, and Windows refuses
`RemoveDirectory` on a read-only directory with *Access denied* (this is why an earlier
Node-`fs`/Electron attempt failed the same way). A directory removal blocked by a
genuinely transient lock is retried on a short background timer. The GUID-keyed
cover-art / tag **media store lives in its own `metadata/` + `covers/` folders** and is
**shared and reference-counted** across every stem/sample/source from the same origin, so
it is cleaned up separately in the main process (`media:cleanup`) — only once no remaining
item references that GUID — and the artifact deletion above never touches it. As a further
backstop for any stray empty per-source folder, the main process also sweeps empty
artifact subdirs when a project next opens. Because deleting the file is
irreversible, a cleanup removal is sent as `LIBRARY_REMOVE { itemId, cleanup: true }`
and the backend removes the item via `removeLibraryItemNonDirty` — it is **not
undoable and does not mark the project dirty** (mirrored into the clean snapshot),
since the file can't be put back; the removal also bypasses the renderer's undo
group. The backend then prunes just that item from the **already-saved project
file in place** (`ProjectFile::removeLibraryItems` — a targeted JSON edit like
`saveViewState`, not a full save), so the deleted file can never dangle in the saved
project, **without committing the user's other unsaved edits** (they stay unsaved and
the project stays dirty for them; an unsaved project has nothing on disk to prune). A
normal removal (cleanup off, or a saved clip that owns no file) stays a single
undoable edit and marks the project dirty like any other change — except that removing
an item that was only *added this session* (never saved) is a net-zero change, so the
project can return to clean, exactly as adding-then-removing anything else does.

**Hiding a tile's cover art** — a library tile's right-click menu offers **Remove Image**
(when the tile shows a cover) and **Restore Image** (when it is hidden). This sets a
per-item boolean `coverArtHidden` — a display-only flag persisted on the library `ITEM`
(`LIBRARY_ITEM_SET_COVER_HIDDEN { itemId, hidden }` → `setLibraryItemCoverArtHidden`,
serialised as `coverArtHidden: true`, suppressed when off, marks the project dirty). It
**never touches the shared media store**, so the image is only suppressed for that one
item and can always be restored from the original source. The renderer suppresses the
cover in both the tile (`groupCoverArtUrl`) and the info dialog when the flag is set. When
no cover image shows (never had one, or hidden), the fallback tile is styled per kind so
the three read apart at a glance: an **original source** shows a sky music-note on a sky
tint, a **stem** a teal layers icon on a teal tint, and a **saved sample** an indigo bars
icon on an indigo tint (plus the persistent stem / sample corner badge).

**Setting a custom cover** — the same tiles offer **Update Image…**, which opens a file
picker; the chosen image is copied into the project's `covers/` dir as a **per-item
override** named `override-<itemId>.<ext>` and shown on that tile only (the shared
media-store cover is untouched, so sibling stems/samples keep theirs). It persists as a
per-item `coverArtOverride` basename on the library `ITEM`
(`LIBRARY_ITEM_SET_COVER_OVERRIDE { itemId, coverFile }` → `setLibraryItemCoverArtOverride`,
marks the project dirty). Main-process IPC does the pick+copy (`media:updateCover`) and the
load-time read-back (`media:getCover`); on load the renderer uses the override in place of
the shared cover, and picking a new image also clears any `coverArtHidden` so the new art
is visible. The override file rides along with the rest of the media store when the project
is first saved or Saved As (the covers dir is copied wholesale).

**Temporary workspace + migrate-on-save** — until a project is first saved it has no
folder, so generated stems and samples are written to a shared temp workspace
(`<temp>/Silverdaw/{stems,samples}`; the backend derives this from `juce::File::tempDirectory`
and the renderer trusts `<temp>/Silverdaw/stems` for reads via
`registerStemsWriteRoot`). Unsaved work is therefore **temporary — lost if the project is
never saved**. On the first save (`handleProjectSave` when `session.currentPath` was empty),
`migrateTempArtifactsIntoProject` runs *before* serialization: it stops the engine,
`removeClip`s every clip (releasing the open WAV file handles Windows would otherwise lock),
merge-moves the temp `stems`/`samples` into the project folder, rebases the in-memory path
properties (`ProjectState::rebaseArtifactPaths`), rebuilds the engine at the new paths,
restores the playhead, and deletes the whole temp root. The renderer separately copies the
temp media store (`metadata/`, `covers/`) into the project folder on save. The subsequent
`PROJECT_STATE` broadcast re-syncs the renderer's library/clip paths and re-reads media from
the new location. Starting a New project (`handleProjectNew`) also purges the temp workspace,
since a new project abandons any unsaved artifacts. The artifact base directories are chosen
by a single backend helper, `projectArtifactsBaseDir(projectPath, subdir)` —
`<projectDir>/<subdir>` when saved, else `<temp>/Silverdaw/<subdir>` — so stems
(`StemSeparationCommands`) and samples (`SampleExport`) share the same temp-vs-project
decision and no path is passed over the bridge.

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
- Lets the user re-enter the relink flow later via the **Relink** entry on any
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

The JUCE backend decodes formats supported by its `AudioFormatManager`: WAV, AIFF, FLAC,
MP3, and the Windows Media family (WMA / WMV / ASF / WM) via the Windows Media Format
SDK that ships with JUCE.

Other formats (notably **AAC / M4A / MP4**, which JUCE doesn't decode out of the box on
Windows) currently round-trip through the renderer's Web Audio decoder:
`AudioContext.decodeAudioData` decodes the file, the resulting PCM is shipped to main via
`audio:writeTempWav` which writes a 32-bit float WAV into `%TEMP%/silverdaw-transcode-cache/`
(keyed by a hash of source path + sample rate + channel count + length). The cached WAV path
is what goes on the wire as `CLIP_ADD.filePath`.

The relevant code is in
[`audioDecode.ts`](../frontend/src/renderer/src/lib/audioDecode.ts),
[`importAudio.ts`](../frontend/src/renderer/src/lib/importAudio.ts) and the `audio:writeTempWav`
handler in [`main/index.ts`](../frontend/src/main/index.ts).

Imports also preflight every file's **true** header sample rate via the
`AUDIO_FILE_PROBE` envelope before adding it to the library — see
[Project sample rate](#project-sample-rate). The probe avoids trusting the
renderer's Web Audio decoder, which silently resamples to the AudioContext
rate and so cannot report the source file's actual rate.

### Internal signal format and bit depth

Silverdaw processes audio internally in **32-bit floating point**, end to end.
On import the JUCE `AudioFormatManager` (and the renderer's Web Audio fallback
for AAC / M4A) decodes every source file into 32-bit float regardless of its
on-disk bit depth — a 16-bit WAV, a 24-bit FLAC, or an MP3 all become float on
the way in, and the original file is never modified (non-destructive editing).

Every processing stage runs on `juce::AudioBuffer<float>`: per-clip warp, the
per-clip volume-shape multiplier, the per-clip turntable brake / backspin tail
varispeed (`OffsetSource`), per-track summing, the per-track
Tone EQ + bipolar Filter and the per-track Leveler
([`ToneEq`](../backend/src/dsp/ToneEq.h) / [`Leveler`](../backend/src/dsp/Leveler.h) /
[`TrackChain`](../backend/src/dsp/TrackChain.h)),
the per-track Reverb / Delay sends into the project-wide shared-FX buses,
track gain and mute / solo, equal-power panning, the master mix and metering,
and the `MasterClockSource` that gates playback and feeds the device. The
`AudioSourcePlayer` hands 32-bit float to the OS audio driver, which converts
to whatever the hardware expects. Float gives very large headroom, so
intermediate sums can briefly exceed 0 dBFS without clipping as long as the
final master is back in range. (`TrackChain` is the canonical per-track DSP
seam shared by live playback and mixdown, running Tone → Leveler → gain →
mute/solo; further nodes are planned there — see the
[Development Plan](development-plan.md).)

To stop sleep-prone audio devices (notably generic USB-Audio-Class dongle DACs)
from soft-muting and swallowing the first instants of playback, the engine keeps such
endpoints awake with an inaudible keep-alive signal owned by
[`OutputKeepAlive`](../backend/src/engine/OutputKeepAlive.h) and injected by the
metering stage **after** the master-gain ramp (so a low master volume can't
attenuate it below the level that keeps the endpoint awake). It has two tiers — a
continuous **holding dither** and a short **wake burst** — plus a per-play wake
pre-roll, described below.

The signal has two tiers, both owned by `OutputKeepAlive`:

- **Holding dither** — continuous TPDF dither (`kKeepAliveDitherPeak`, ≈1/16384 / −84 dBFS
  peak, about 2 LSB of a 16-bit endpoint), per-channel and zero-mean, mixed into
  otherwise-silent output whenever the device is open (`deviceActive`), a project is
  loaded (`contentLoaded`), or playback is active. A generic dongle DAC auto-mutes on
  silence — commonly on runs of exact-zero PCM, and/or on energy below a short-window
  threshold. A near-Nyquist ultrasonic tone is stripped by the DAC's reconstruction
  filter before its detector ever sees it (so the endpoint sleeps anyway); continuous
  dither instead keeps **every sample non-zero** with steady in-band energy the detector
  registers as "audio present", while sitting at the format noise floor so it stays
  inaudible. It stops entirely on real programme above `kKeepAliveSilenceThreshold`, so
  content is never coloured.

- **Wake burst** — the holding dither *holds a warm device awake* but is too quiet to
  *wake a cold one* (an amp that auto-muted while Silverdaw was closed, was just
  (re)connected, or relaxed back to mute between plays). So a brief, decaying broadband
  burst (`kWakeBurstPeak`, ≈−26 dBFS, over `kWakeBurstMs`) is emitted (a) once at every
  device (re)start, and (b) as a short pre-roll at the start of each play (see below).
  Both run while the amp is muted, so the burst itself is inaudible yet carries enough
  in-band energy to cross the hardware's auto-mute wake threshold.

Amplitudes are the tuning knobs: raise `kKeepAliveDitherPeak` / `kWakeBurstPeak` if an
endpoint still sleeps or swallows the opening; lower them if a sensitive IEM reveals hiss
in true silence or a rapid replay onto a warm amp produces a tick.

The wake burst is delivered to programme via a **per-play, audio-thread pre-roll** in
[`MasterClockSource`](../backend/src/engine/MasterClockSource.h): on a stopped→playing
transition while keep-awake is enabled, the master emits silence (which the metering
stage fills with the re-armed wake burst) for `kWakePrerollMs` **without advancing the
transport**, then opens to programme. The amp is roused before the downbeat, the opening
beat is never swallowed, the transport position (and therefore the downbeat) is preserved,
and — crucially — it runs entirely on the audio thread, so the message thread never blocks
(an earlier 500 ms `Thread::sleep` pre-roll froze the UI). With keep-awake off, playback
skips the pre-roll and plays from the first sample.

The **Clip Editor / preview** voice follows the same rule via an equivalent pre-roll in
[`PreviewMetronomeSource`](../backend/src/engine/PreviewMetronomeSource.h) (the preview's
single mixer input): it detects the transport's stopped→playing edge on the audio thread and
holds the preview silent for `kWakePrerollMs` while the wake burst re-arms, so the first
preview play into a cold DAC isn't swallowed. Unlike the master transport, the preview
pre-roll fires **only when the endpoint is cold**: `OutputKeepAlive` marks the device *warm*
for `kWarmHoldMs` after any real programme above the silence threshold
(`OutputKeepAlive::isWarm()`), and a warm play skips the burst. This keeps rapid back-to-back
clip auditioning — which shares an already-awake amp — free of the otherwise-audible
start-of-play hiss, while a genuinely cold play after a pause still wakes the amp.

The keep-alive — both the dither **and** the wake burst / pre-roll — is a simple
**explicit per-device toggle**, off by default. There is no device-type
auto-detection: a device is kept awake only when the user turns it on for that
device (typically a USB DAC that sleeps and clips the first beat). The toggle is
stored **per output device** (keyed by the device's reported name) in
`preferences.json` as `keepAwakeByDevice` (a `Record<string, boolean>` holding only
the enabled devices), so it is remembered even while the device is unplugged — it
re-applies on reconnect. The renderer resolves the state for the physically-open
device (`audioDeviceStore.currentDeviceKeepAwakeEnabled`) and pushes it to the
backend via `AUDIO_KEEP_AWAKE_SET { enabled }` on every connect **and whenever the
open device changes** (so unplugging a kept-awake USB DAC and falling back to the
onboard card re-sends `enabled: false`, rather than leaving the onboard card running
the tone). `AudioEngine::setKeepAwakeEnabled` forwards the flag straight to
`OutputKeepAlive` (default off); the keep-alive only ever runs for the currently-open
output when it is enabled. The gate simply stops writing — returning the output to
**truly silent** digital zero — once the device is released or keep-awake is off.
`MasterClockSource` gates the transport and clears the buffer when not playing, runs
the wake pre-roll at play-start, and otherwise delivers the source verbatim; the
keep-alive injection lives downstream in the metering stage. A play-start click can come from `juce::AudioTransportSource`:
it ramps each track from the previously-rendered block's gain (`lastGain`) to the
current gain across the first block it renders. Because the per-track transports
are not pulled while the master is gated, a gain changed during that window — most
visibly a track muted by engaging **solo** — leaves `lastGain` stale, so the first
block after the gate opens would fade the now-muted content from its old level down
to zero, leaking one block of audio. `primeTracksForPlayback` therefore **settles**
each transport before opening the gate: it pumps a single throwaway sample through
the transport (the gate is closed, so only the message thread touches it) to make
`lastGain == gain`, then re-seeks and restarts. (An earlier design also included a 5 ms
master play-start declick fade, but it was removed because it softened the attack
transients of drum hits played from the timeline.)

Quantisation to a fixed bit depth happens in exactly one place — the **mixdown
export writer** in [`MixdownExport`](../backend/src/mixdown/MixdownExport.cpp). (The
renderer's throwaway transcode / preview WAV is itself 32-bit float, so it does
not quantise either.) Export bit depth defaults to **16-bit**
(`MixdownOptions::bitDepth{16}`) and offers, per format: WAV 16 / 24 / 32-float,
FLAC 16 / 24, AIFF 16 / 24 (MP3 is encoder-defined). TPDF dither is applied by
default for 16-bit targets; 24-bit and 32-float skip it, since their noise
floor is far below audibility. See the mixdown export notes under
[Current status and roadmap](#current-status-and-roadmap) for the full dialog
and loudness-normalisation options.

## Peaks cache

Waveform peaks (`min, max` float32 pairs) are computed once per source
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
or requested resolution invalidates the entry automatically.

The peaks are stored **channel-major in lanes**. A stereo (exactly two-channel)
source stores three lanes — `[summary, left, right]` (`laneCount = 3`) — where
lane 0 is the same mono `sum-then-min/max` summary used by the single-waveform
display, byte-for-byte. Mono and >2-channel sources store the summary lane only
(`laneCount = 1`). The on-disk format is a **28-byte header** (magic, version,
requested peaksPerSecond, peakCount *(buckets per lane)*, laneCount, sampleRate)
followed by `peakCount × laneCount × 2 × float32` little-endian peak values.
Versioned so a future format change is detected as a miss rather than a
corrupted read; the same layout is what the renderer reads via the
`peaks:readCacheFile` IPC and the shared `parsePeaksCacheBuffer` parser, which
returns the summary plus (for stereo) the per-channel arrays.

The renderer keeps the per-channel peaks in a session-only
`libraryStore.channelPeaksByItemId` map (keyed by the source item id,
each with its own LOD pyramid). The **Waveform display** preference (Preferences ▸
General) chooses between *Single waveform* (summary) and *Left and
right channels* (stacked L/R lanes for stereo sources, the default); the choice is persisted
to `preferences.json` and applied to both the timeline and the Clip Editor. Mono
sources, and rows too short to fit two readable lanes, always fall back to the
single summary lane. On the timeline, stereo lanes also reflect the track's
**pan**: each channel's lane height and opacity scale with its normalised
equal-power pan gain, so a hard-panned channel collapses to a faint near-flat
lane while the other stays full — a centred track leaves both lanes full.

The timeline waveform also reflects a clip's **volume shape**: each rendered
column's height is scaled by the clip's gain envelope sampled at that point in
time (clip-local post-warp ms), so a fade-out visibly tapers toward nothing and
a dip shows as a notch. This applies to both the single summary lane and the
stereo lanes (composing on top of the pan scaling), and works for mono and
stereo sources alike. Unity gain renders identically to an unenveloped clip, and
greater-than-unity boosts are clamped to the lane so the waveform never spills
outside the clip block. The clamped excursion maths is the pure, unit-tested
`waveformColumnExcursion` helper (`lib/timeline/waveformColumn.ts`).

The cache survives backend restarts.

## Audio analysis

Every imported audio file is automatically analysed for musical key, tempo and
beat positions. The key and BPM are shown on the library tile. A stable-tempo
file shows a badge such as `124.37 BPM`; a variable-tempo file shows an amber
`~ 124.37 BPM` badge. Beat analysis drives faint vertical beat markers on the
clip waveform and — on the first import into a project — seeds the project
tempo so the timeline grid lines up with the source. When automatic detection is
uncertain the user can set a BPM by hand and slide the beat grid over the
waveform to align it (see [BPM and beat detection](#bpm-and-beat-detection)).

### Key detection

Key detection runs in the renderer immediately after Web Audio decodes the file.
`detectMusicalKey` in [`audioDecode.ts`](../frontend/src/renderer/src/lib/audioDecode.ts)
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
  [`PATCHES.md`](../backend/third_party/btrack/PATCHES.md) for the two MSVC-compatibility
  changes (the patches are mechanical: `_USE_MATH_DEFINES` for `M_PI` and a handful of
  VLA → `std::vector` substitutions).
- **Resampler**: [libsamplerate](https://github.com/libsndfile/libsamplerate) 0.2.2
  (BSD-2-Clause), pulled in via FetchContent. Used to one-shot convert decoded mono
  audio to BTrack's expected 44.1 kHz.
- **FFT**: [KISS FFT](https://github.com/mborgerding/kissfft) 1.3.0 (BSD), bundled in
  the BTrack vendor copy. No FFTW dependency.

The detector lives in [`backend/src/dsp/BpmDetector.cpp`](../backend/src/dsp/BpmDetector.cpp) and
runs on the same `juce::ThreadPool` that produces peaks — kicked off from both the
`LIBRARY_ADD` and `CLIP_ADD` dispatch handlers (whichever arrives first wins; the
helper `ensureBpmDetection` is idempotent and won't re-analyse a file the library
already has a BPM for). The library tile context menu can also send
`LIBRARY_REANALYSE`, which clears the current tempo/beat fields, recreates the
decoded-WAV cache, and reruns detection from the current source file. Worker thread
→ decode the file via JUCE → downmix to mono → resample to 44.1 kHz with
libsamplerate → feed BTrack frame-by-frame at hop=256 (~5.8 ms steps) recording every
`beatDueInCurrentFrame()` event. **BTrack itself only tracks the first 60 seconds**
(`kBeatTrackingSeconds`) — it is the expensive, causal part and a bounded prefix gives a
robust octave/tempo *seed* without risking octave-wander on long, variable material. The
**onset-detection-function (ODF) period/phase refinement described below spans the whole
decoded track** (bounded only by the generous `kMaxAnalysisSeconds` ceiling), so the final
period is fit over the entire piece rather than extrapolated from the opening minute.
Estimates outside `[40, 240]` BPM are dropped as implausible.

The reported BPM starts from the **median of beat-to-beat intervals** (more stable
than BTrack's running tempo estimate, which can drift a fraction of a BPM from the
implied spacing) and is then refined by a least-squares period+anchor fit and a
guarded ODF autocorrelation pass. The LSQ fit's phase is **seeded from the circular
mean of every detected beat's phase** (`circularMeanAnchor`), never from the first
detected beat: intro fills, pickup beats and stray early detections routinely sit
off the body grid, and anchoring on such a beat would push the entire track past
the fit's quarter-period inlier gate — collapsing the fit (so the BPM falls back to
BTrack's raw, sometimes wrong-octave estimate and the grid lands visibly out of
phase). Deriving the anchor from the bulk makes the grid phase a property of the
whole track rather than its first transient. Before any of the ODF-driven stages
run, the recomputed ODF is passed through a **sliding-window median floor
subtraction** (`subtractMovingMedianFloor`, adapted from aubio's median-adaptive
peak picking):
it subtracts a ~2-beat-wide running median and half-wave rectifies, stripping the
slow sub-onset energy swell that sustained vocals, horns and pads add to a full
mix. A median (not a mean) is used so the very onset peaks we want to keep don't
pull the floor up. This sharpens transient peaks so the autocorrelation,
median-phase and ODF-peak stages key off true onsets rather than broad humps —
it is the difference between the median-phase alignment engaging or being skipped
on dense material (where the raw ODF's per-beat offset IQR otherwise blows past
the consistency gate). A final **whole-track ODF-peak refit**
(`refineGridFromOdfPeaks`) does a least-squares period+anchor fit over the
sub-frame-interpolated ODF onset peaks across the *entire* track; the long lever arm
pins the period far more tightly than a 60 s fit, which is what stops the rigid grid
from drifting late→early across a long track (adopted only when it stays within 5 % of
BTrack's octave, so a spurious fit can't hijack the tempo). This keeps the project grid
we later seed lined up with the source's beats from the first beat to the last. A
`variableTempo` flag is also computed by checking the spread of per-beat tempo samples
(after a short settling period) — if it's > 5 % of the mean, the library tile shows the
amber `~ BPM` warning badge.

The grid is rendered as a **rigid metronome** from a single `(bpm, beatAnchorSec)`
pair, so the anchor's phase matters as much as the period. After the period is
final the detector runs a guarded **phase correction**: `estimateGridPhaseOffset`
measures, for each grid beat across the whole track, the offset to the strongest nearby
ODF peak and takes the **median**. The anchor is shifted by that median
only when the offsets are *consistent* (IQR ≤ 30 ms — chosen over median-absolute-
deviation, which is blind to a bimodal early/late split), *plausible* (≤ 120 ms,
latency-sized), *significant* (> 4 ms) and backed by *enough* matched beats
(≥ 50 %). This pulls the anchor off BTrack's causal lag onto the true transients
without ever locking the grid to off-beat energy on ambiguous material; it is a
no-op on already-aligned tracks. The behaviour is covered by unit tests in
`backend/tests/BpmDetectorTests.cpp`.

When detection finishes the worker `MessageManager::callAsync`s back to the JUCE
message thread to write `bpm`, `beats`, `beatAnchorSec`, `variableTempo`, `lowConfidence`,
and the decoded playback cache path onto the matching `LIBRARY > ITEM` node and broadcast
`LIBRARY_ITEM_ANALYSIS { itemId, bpm, beatAnchorSec, beats, variableTempo, lowConfidence,
playbackFilePath }`. The project BPM is seeded once, from the first musical clip
placed **on a track**: the seed fires only when at least one clip is on a track
and `ProjectState::isBpmSeeded()` is still false (the flag — not a count of
analysed library items — is the authoritative once-only signal, and derived stems
inherit a BPM without ever seeding), **and** the app-level `ui.seedProjectTempoFromFirstClip`
preference (default on, mirrored to the backend via `PROJECT_SET_SEED_TEMPO_PREF`)
is enabled — with it off the seed is skipped entirely and the project BPM stays put.
When it fires a `PROJECT_BPM_APPLIED { bpm }`
envelope is broadcast and the renderer mirrors both into `libraryStore` and
`transportStore`. At that point the renderer also beat-aligns the just-analysed
clips to the project **bar** grid when the **Align clips to the beat grid after
analysis** preference is on (see that preference for the mechanics). Seeding runs even for variable-tempo and low-confidence sources
(an approximate tempo is more useful than the default 100) but is suppressed for
items **explicitly classified as a sample**, so a rain ambience the user has
marked as a sample can't drag the project tempo. The user can fine-tune from the
Transport bar afterwards.

**Manual tempo.** When detection is wrong or absent the user can set a BPM by hand
on a source item. `LIBRARY_ITEM_SET_MANUAL_TEMPO { itemId, bpm, beatAnchorSec }`
builds a rigid grid across the item's duration on the backend and re-broadcasts
`LIBRARY_ITEM_ANALYSIS` with `variableTempo` and `lowConfidence` cleared, so the
item reads as verified music. In the Clip Editor the whole grid is edited as a
**draft**: a slide-the-grid drag, the BPM field, the octave buttons, the nudges and
the half-beat shift all update the source's local `(bpm, beatAnchorSec)` only — the
markers and preview metronome track the edit live with no bridge round-trip — and
mark the Clip Editor dirty. The draft is persisted with a single
`LIBRARY_ITEM_SET_MANUAL_TEMPO` on **Save** (inside the Save undo group, so the
grid change and any on-Save re-align fold into one undo step), and rolled back to
the grid captured on open if the session ends without a Save (Cancel / close).
Alongside the drag, the beat-grid panel is split into a **Tempo** section — a BPM
field you type and commit with Enter or by clicking away (no separate Apply
button), **÷2 / ×2**
octave buttons that halve or double the source BPM while holding the phase anchor,
and, once the tempo has changed, the **Original** value with a **Restore** button —
and a **Position** section with the slide-to-align toggle, **±5 ms** fine-nudge
buttons, and a **half-beat** shift for when the grid has locked onto the off-beat.
Manual values survive save / load because `ensureBpmDetection`
is idempotent and skips a source that already has a BPM.

### Confidence and audio type classification

`BpmAnalysis` also reports a `lowConfidence` flag derived from the LSQ-fit
residual and the fraction of detected beats kept after outlier rejection.
Specifically the analysis is flagged when *both* of these hold:

- **poor fit**: `relResidual > 0.08` OR `keptFraction < 0.6`, AND
- **non-musical signature**: `variableTempo` is true OR `keptFraction < 0.5`.

`variableTempo` alone is intentionally not sufficient — live performances and
rubato music can drift more than 5 % per beat without being non-musical. The
combined gate avoids false-positive flags on real music while still catching rain
ambience, vocal one-shots and sound effects that BTrack would otherwise report
bogus tempo / beat positions for.

Crucially, **`lowConfidence` does not classify an item as a sample.** It is a
*tempo-unverified* signal: the grid is still drawn and the clip is still warpable,
so a musical track BTrack is merely unsure about keeps its beat grid.
(The classification helper `libraryItemTempoUnverified(item, byId)` exposes this
signal, but the UI does not surface a separate amber marker for it.) The
renderer treats a library item as a simple audio file via a single
helper, `libraryItemIsSimple(item, byId)`, with the resolution order:

1. user override `item.audioType` (`'simple'` / `'music'`),
2. for saved clips, fall back to the source item's `audioType`, then
3. default to `false` (music).

When an item's `audioType` is `simple` the library tile shows a small indigo
**Simple** pill in place of the BPM / key / variable-tempo badges, clip beat
markers are not drawn, `applyDropTimeWarp` skips the auto-warp branch (the
drop-zone preview width matches), and the backend's `maybeSeedProjectBpmFor` /
late-pending-auto-warp loop both refuse to fire from it. **Warp and Pitch
dialogs continue to work** so the user can still speed up, slow down, or
pitch-shift the clip manually.

Set the classification from the library tile's right-click menu
(**Auto-classify** / **Treat as Music** / **Treat as Simple** — source, stem,
and sample items only; saved clips inherit) or from the **Treat as** radio in the
Library Item Info dialog. The `LIBRARY_ITEM_SET_AUDIO_TYPE { itemId, audioType }`
envelope round-trips the choice (undoable); `audioType = 'auto'` clears the override so
the item falls back to music.

### Beat markers and source-beat snap

The renderer overlays faint white vertical lines on every clip at the source's
detected beats. The markers are **synthesised on a source-global beat grid**
anchored on the regression-derived `beatAnchorSec` (older projects fall back to
`beats[0]`) and spaced by `60 / sourceBPM`, not on each raw detected position.
This makes them survive a split / duplicate / trim without drifting — both halves
of a split clip share one coordinate system, so the markers stay in lockstep
across the split point.

Drag-snap on a clip with a known source tempo locks onto the same grid: instead
of snapping the clip's left edge to the project sub-beat, it snaps the first
source beat inside the clip's window. With the project BPM seeded to the source
BPM (the common case), every subsequent marker on the clip then lines up exactly
with a project grid sub-beat. Drag with `Alt` for fine 1 ms unsnapped
behaviour.

Non-linked edge-trim drags use the same project grid by default, snapping the
dragged edge as the source window changes. Hold `Alt` while trimming for
freeform 1 ms edge placement. Linked saved clip instances do not expose timeline
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

## Stem separation

Stem separation splits a track into **vocals, drums, bass and other**. The
primary engine is a pair of optional MIT-licensed **RoFormer quality models** — a
Mel-Band RoFormer for vocals and a 4-stem BS-RoFormer for drums/bass (see below)
— which are downloaded once and then used automatically. The MIT-licensed
`htdemucs-ft` ONNX export (a "bag" of four specialist models, one per source, run
through ONNX Runtime in the backend, `OnnxStemSeparator.cpp`) is the **backup**:
it is used per stem only when that stem's quality model isn't installed (or the
user forces the backup via `stems.useBackupModel`, or a partial selection
includes `other` without the full four-stem set). On first use the default
download fetches the two RoFormer quality packs, not htdemucs; the backup is
fetched on demand only when a run actually needs it. ONNX Runtime is
fetched and bundled via CMake (`onnxruntime.dll` ships beside the backend); the
model weights (htdemucs ~1.2 GB; the quality packs ~1 GB together) are **not**
shipped — the Electron main process (`src/main/stems/`, pinned manifests + a
dependency-injected `ModelStore`) downloads them on demand, verifies each file's
SHA-256 + size, and commits atomically. All model weights are hosted on
Silverdaw's own Hugging Face account ([huggingface.co/silverdaw](https://huggingface.co/silverdaw))
and the per-model manifests resolve their download URLs from that namespace.

A fully pack-covered run needs no htdemucs weights on disk at all: the backend
only validates the htdemucs files for stems it will actually produce with the
backup, and `other` is the residual `mixture − (vocals + drums + bass)` whenever
all four stems are produced.

Each htdemucs specialist model processes fixed 7.8 s stereo segments with a
quality-selectable overlap (**Fast / Balanced / Best** → 0.10 / 0.25 / 0.50,
sent as `quality` on `STEM_SEPARATE`) and triangular-window weighted overlap-add;
the same preset overlap now also drives the RoFormer packs' chunk stride, so the
Fast/Balanced/Best knob is a real speed/quality control on either engine.
"Best" also applies **vocal test-time augmentation** (the demucs `shifts` trick,
4 deterministic time-shifts averaged — vocals only, so ~2× cost) to cut the
"watery"/phase artefacts. When all four stems are requested the `other` model run
is skipped and `other = mixture − (vocals + drums + bass)` is synthesised instead
— a mixture-consistency residual that is faster and loses no energy. Separation
runs on a background thread and never touches the audio callback; progress is
reported via `STEM_PROGRESS`, each stem lands the instant its WAV is written
(`STEM_PARTIAL`), and `STEM_READY` backfills the rest.

**The Separate Stems dialog** lets the user tick which of **vocals / drums / bass /
other** to extract. It opens with **nothing ticked** (Start stays disabled until at
least one stem is chosen), so a run processes only the parts the user picks rather
than making them un-tick from a full set — and each un-picked stem proportionally
shortens the run.

**Optional vocal cleanup** (opt-in, vocals only) runs after separation and is
**model-aware**. For an **htdemucs** vocal it runs the full chain: a cross-stem
**de-bleed** (`VocalDebleeder`, a conservative STFT Wiener soft mask using
`instrumental = mixture − vocal` as the interferer reference) removes pitched
instrument bleed the broadband denoiser can't, then RNNoise + a sub-bass
high-pass/expander. For the high-SDR **RoFormer** vocal the de-bleed is **skipped
entirely** (it over-cuts a clean vocal on dense mixes) and the RNNoise wet +
expander are gentled (the `cleanModel` path). Objective tuning uses the
`SilverdawStemEval` dev tool (SI-SDR/SDR vs a reference stem).

**Optional vocal de-reverb** (`Dereverberator`, vocals only) is a separate,
**per-run** cleanup — ticked (with a `Light`/`Medium`/`Strong` selector) in the
Separate Stems dialog, never a persisted preference, because whether a vocal wants
de-reverb is a per-source artistic call (a dry studio acapella must not be touched,
a live/room recording benefits), not a set-once global default. It is sent on the
`STEM_SEPARATE` payload as `dereverb` + `dereverbStrength` and resolved independently
of `enhanceVocals`. It runs **before** the RNNoise denoise (a tighter envelope helps
the denoiser) and, when de-bleed is active, after it (so the reverb estimate isn't
contaminated by other instruments' tails). It is a conservative statistical STFT
late-reverb subtraction (a Lebart/Habets-style estimator): with no separate reference
signal, it estimates the late-reverberant power per bin as a **recursively-accumulated,
room-decayed copy of the signal's own (delayed, smoothed) power spectrum** — a diffuse
estimate present *continuously*, so it removes reverb embedded IN sustained singing,
not only in gaps (the earlier decay-only model was too subtle). That estimate is
spectrally over-subtracted with a floor and a cap (so a steady note is never crushed
to the floor), giving a gain in `[sqrt(floor), 1]` (strictly attenuating — never
amplifies or nulls), band-limited ~120 Hz–12 kHz, shared across channels (stereo image
preserved), smoothed across **time and frequency** (to avoid musical noise), with
**broadband onset protection** so vocal attacks stay crisp, then a wet/dry blend. The
inherent trade is that a single-channel dereverb can't tell a dry sustained note from a
reverberant one, so it dries held notes somewhat — `Light`/`Medium`/`Strong` scale the
floor, over-subtraction, reverb weight, and wet mix together so the user picks the
amount. Full WPE-style linear prediction was deliberately rejected as too unstable to
ship without auditioning; the worst case here is an over-dry vocal, never a blow-up.
When de-reverb is active, a final **`VocalRestorer`** stage runs **last** — after the
denoise and expander — to counter the dulling AND the level drop that spectral
subtraction leaves behind: two gentle high-shelves (presence ~3.5–4 kHz + a little air
above the sibilant band) plus a single static **active-loudness match**. The vocal's
loudness is sampled BEFORE de-reverb (`VocalRestorer::activeLoudness` — the RMS of only
the loud ~50 ms blocks, so silence and reverb tails are excluded) and the finished stem
is brought back to it, undoing the level loss without re-inflating the removed tail (the
gate ignores the quiet gaps) and without pumping (one scalar for the whole stem, clamped
to ~[-3, +8] dB). It runs after the expander on purpose (so the make-up can't lift the
noise/reverb floor back over the expander threshold), and a per-sample soft-knee limiter
keeps the shelves + make-up from ever clipping. Matching the loud-frame loudness (not a
full-buffer RMS) is what keeps this a level restoration rather than a reverb re-inflation.

**Vocal Quality Pack** (primary vocal engine, downloaded on demand): a
higher-quality **Mel-Band RoFormer** vocal model (MIT; `MelRoformerVocals` + the
host-side STFT engine `MelRoformerSpectral`, run through the same ONNX Runtime).
When the pack is installed it is used **automatically** (unless
`stems.useBackupModel` forces htdemucs): the renderer passes its `.onnx` path as
`roformerModelPath` and the backend produces **vocals** with it (drums/bass come
from the rhythm pack, `other` stays the residual). The host pipeline (STFT
n_fft 2048 / hop 441, complex-mask multiply, iSTFT, preset-driven chunk overlap)
is unit-tested by an identity-mask round-trip and was validated end-to-end
against a numpy reference of the model's reference WebGPU host. htdemucs is the
backup when the pack is absent.

**Rhythm Quality Pack** (primary drums/bass engine, downloaded on demand): a
higher-quality 4-stem **BS-RoFormer** model (MIT — an export of ZFTurbo's
MUSDB18-HQ checkpoint; `BsRoformerRhythm` + the host-side STFT engine
`BsRoformerSpectral`, run through the same ONNX Runtime). When installed it is
used **automatically** (unless the backup is forced): the renderer passes its
`.onnx` path as `rhythmModelPath` and the backend produces **drums and bass**
with it (one model run extracts both; vocals come from the vocal pack, `other`
stays the residual), composing with the vocal pack into a fully RoFormer hybrid.
**Cascaded vocal pre-removal:** when both packs are active the rhythm pack is fed
`mixture − vocal` (using the dedicated vocal pack's high-SDR estimate) rather than
the raw mixture, so residual vocal energy can't bleed into drums / bass — the
vocal estimate is the one already extracted for the vocals stem, or one internal
vocal pass when vocals wasn't selected. The model applies its mask in-graph and returns the masked per-stem spectrogram
(the host runs STFT n_fft 2048 / hop 441 and per-stem iSTFT, preset-driven chunk
overlap); it is exported at an 8 s window (the largest that fits a modest GPU's
VRAM) and the runner transparently retries on the CPU provider if DirectML runs
out of memory. The host pipeline is unit-tested by an identity round-trip, and
the C++ runner was validated end-to-end against a numpy reference (drums/bass RMS
matched to four decimals). htdemucs is the backup when the pack is absent.

In **Preferences ▸ Stems** the two packs share one combined **Download models**
action (~1 GB), and the vocal, drums/bass, and htdemucs backup models each appear
as a compact **Locate…** row (identical style) to point at an existing on-disk
copy — the backup row carries a note that it is only a fallback. The backup has
no manual download button (it is fetched on demand when a run needs it); an
**Always use the backup model** toggle sits below the locator group. Each
pack/model persists its located directory override (`vocalPackDir` /
`rhythmPackDir` / `stemModelDir`).

GPU acceleration uses the **DirectML** execution provider. The bundled ONNX
Runtime is a DirectML build (one DLL serves CPU and GPU, with `DirectML.dll`
shipped alongside); the renderer threads a `useGpu` flag through to the backend
session options. Using the GPU is **opt-in** — the `stems.useGpu` preference
defaults off. The Preferences ▸ Stems toggle is enabled unless a GPU probe
positively reports software-only rendering (`detectGpuFromInfo`): DirectML runs
on any Direct3D-12 adapter, so an integrated GPU that Chromium's probe reports as
inactive or without a vendorId must still be offered. The path is hardened
against recoverable GPU faults — both a timeout/TDR device reset **and** running
out of (often shared, integrated-GPU) memory transparently retry the whole job on
the CPU (`isRecoverableGpuFault` in `OnnxStemSeparator.cpp`) so the user still
gets their stems. On memory-constrained integrated GPUs the fixed-shape RoFormer
models may simply not fit, in which case the run falls back to the CPU; GPU
acceleration is therefore treated as a best-effort, dedicated-GPU-oriented
option rather than a guaranteed speed-up.

Inference runs on **one thread per physical core**, bounded by the historical
`logical − 2` default (`inferenceIntraOpThreads()` in `stems/InferenceThreads.cpp`
counts physical cores via `GetLogicalProcessorInformationEx` + `EfficiencyClass`
and returns `min(physicalCores, logical − 2)`, falling back to `logical − 2`
when detection is unavailable). The transformer models synchronise at every op
boundary, so oversubscribing a hyperthreaded CPU — running two threads per core
that fight over the same execution units — is markedly **slower** than one
thread per physical core: the fix drops the hyperthread siblings on HT CPUs
(e.g. 20 logical / 14 physical → 14 threads) while keeping every physical core
(P **and** E) on non-hyperthreaded hybrid CPUs, where the E-cores add real
throughput with no sibling contention. Reserving the two logical processors of
the `logical − 2` bound leaves headroom for the backend's websocket-send and
message threads, so the progress bar keeps flowing. On the GPU path the compute
runs on the adapter instead.

Cancellation aborts the **in-flight** ONNX run rather than waiting for the
current chunk (which can take tens of seconds on a slow CPU) to finish. Each
`Session::Run` is wrapped by `runCancellable()` (`stems/StemRunCancellation.h`),
which spins a lightweight watcher thread that calls `Ort::RunOptions::SetTerminate()`
the moment the cancel flag is set; ONNX Runtime then unwinds at the next op
boundary and the resulting `Ort::Exception` is translated to a normal
`StemFailureCode::Cancelled`. So `STEM_SEPARATE_CANCEL` lands in well under a
second instead of up to a whole chunk later.

The separation-progress dialog is driven by the reactive `stemSeparationState`
and stays open through a final **"Writing files…"** phase: on `STEM_READY` the
renderer marks the job finalising (`markStemSeparationFinalizing`) and only
clears the state — dismissing the dialog — once the stems have been read,
imported, and placed on the timeline. This stops the dialog from vanishing
seconds before the new clips appear during the (main-thread-bound) import.

A **timeline** separation (started from a placed clip) also lands each stem on its
own new track aligned to the source clip's start; a **library** separation
(started from a source or sample library item) imports the stems to the library only,
leaving it to the user to drag them onto the timeline. The audio that is separated
is always the selected clip's (or library item's) **own** library item — a stem is
a standalone WAV, so re-separating an already-separated stem separates that stem's
audio, not the original source (which may no longer be in the library). The
library panel hides **Separate Stems** on stems (they are already separated), but a
stem placed on the timeline can still be re-separated from its clip. A timeline
separation only processes the **clip's own time window** (`[inMs, inMs + durationMs)`
of its library item, sent as the `clipId` whose window the backend reads from
`ProjectState`), so the stem WAVs
are clip-length and drop in already aligned; a library separation has no clip and
separates the **whole track**. Either way the source is untouched
(non-destructive) and each stem is added to the library as a top-level **stem**
item. Because each stem is sample-aligned with its source it
**inherits** the source's analysis (BPM, beat grid, key, variable-tempo flag)
rather than being re-analysed. On disk each separation writes its WAVs into a
`stems\<sourceFileName>-stems` folder named after the original source file
(disambiguated with `-2`/`-3`… for repeat runs), so it matches the
`samples/<sourceFileName>/` grouping and travels with the project folder when it
is moved or synced between machines; an **unsaved** project writes them to the
temporary workspace (`<temp>/Silverdaw/stems`) and they are migrated into the
project folder on the first save (or discarded if the project is never saved).
Each stem file basename uses the source's friendly library name plus a **unique
GUID token** (`<sourceName> - <stem> - <guid>.wav`) so regenerating stems from the
same source
never overwrites earlier files — including when an unsaved temp workspace is later
merged into a saved project's `stems` folder. A stem inherits the source's **media
GUID**, so it keeps the original's tags and artwork (resolved from the central
`metadata/` + `covers/` store, see *Project state model*) even after the source
item is removed. Because separated stems
are already WAV, they are played back directly from their project file — the
`DecodedCache` short-circuits a WAV source (it only transcodes non-WAV formats),
so no redundant (and, for float stems, lossy) decoded copy is written to the
central cache. Track transports are restarted on every play-prime, so a short
stem clip that has played to its end resumes correctly on the next seek + play
(an `AudioTransportSource` auto-stops at EOF and repositioning alone would not
clear that, leaving the clip silent until reloaded).

Optionally, each stem can be passed through a **post-separation cleanup and
enhancement** pass before it is written (Preferences ▸ Stems, off by default per
stem, with a Light / Medium / Strong strength). Drums, bass and the residual each
have a small purpose-built DSP unit in `backend/src/dsp/` (`DrumEnhancer`,
`BassEnhancer`, `OtherEnhancer`) that runs a cleanup stage followed by an
enhancement stage; the vocal path runs an RNNoise denoise and then
`VocalEnhancer`:

- **Vocals** — for the htdemucs backup vocal a cross-stem **de-bleed** (a Wiener
  mask built from `mixture − vocal`) runs first, then **RNNoise** (xiph,
  BSD-2-Clause; fetched and statically linked via CMake) suppresses broadband
  noise and separation artefacts, then `VocalEnhancer` applies a subsonic
  high-pass and a gentle downward expander on the quiet bleed.
- **Drums** — high-pass + expander cleanup, then a **transient designer** that
  emphasises the attack of each hit for punch.
- **Bass** — high-pass + low-passed-detector expander cleanup, then a **harmonic
  exciter** that adds a high-passed harmonic layer above ~120 Hz (without boosting
  the sub/fundamental band) so the bass keeps its definition on small speakers.
- **Other** (the residual) — high-pass + a shallow STFT spectral attenuation that
  shaves the musical-noise floor, then a mid/side **stereo widener** that opens up
  the image while preserving the mono sum.

**Model-aware gentling.** The cleanup parameters were tuned for the dirtier
htdemucs stems; the RoFormer quality packs produce far cleaner stems, so each
`*EnhanceOptions` struct carries a `cleanModel` flag the separator sets per stem:
vocals when `haveVocalPack`, drums/bass when `useRhythmPack`, and the residual
`other` only when it is the full mixture-consistency residual built from both packs
(`mixtureConsistency && haveVocalPack && haveRhythmPack`). On the clean path the
processing is scaled right back: the vocal **cross-stem de-bleed is skipped
entirely** (it would gut a clean vocal on dense mixes — the symptom that prompted
this) and the denoise wet + expander run far gentler; the drum transient boost is
×0.4, the bass harmonic blend and the residual widener / spectral reduction are
×0.5, and the drum/bass expander range and ratio-excess are halved. The htdemucs
backup path keeps the original (stronger) settings (`cleanModel=false`). Because the
vocal-removal cascade already strips vocal bleed from the rhythm input, aggressive
post-cleanup is largely redundant on the RoFormer path.

On the drum, bass and residual paths the cleanup stage self-bypasses on dense,
sustained or low-contrast material, but the enhancement stage still runs
afterwards (it is a no-op on silence), and a soft-knee limiter on those three
paths keeps the added energy from clipping. The whole pass is non-destructive — it
only shapes the freshly written stem WAVs and never touches the user's source, and
it is a guaranteed no-op when disabled, empty, or silent. See
[`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) for RNNoise attribution.

## Library panel

The bottom library panel stores source, stem, sample, and clip items as draggable tiles.
Tiles wrap to the available width and the panel scrolls vertically when there are more
tiles than fit; it does not expose a horizontal scrollbar. Each source tile shows
duration, detected key and detected BPM when those fields are available.

**Saved clips** — right-click a timeline clip and choose **Save Clip to Library** to
turn its trim window into a reusable library entry. Saved clips are non-destructive
references back into their source file (same audio, same WAV cache, same BPM / key)
and are grouped underneath the source they came from. Each source group has a
disclosure chevron with **Show saved clips** / **Hide saved clips** tooltips; the
open/closed state persists with the project. Adding a new saved clip auto-expands
the group so the new clip is immediately visible. Dragging a saved clip tile onto a track creates a
timeline clip with the same source window and non-destructive warp defaults the
saved clip describes.

**Samples** — right-click a timeline clip and choose **Save as Sample…** to open
the **Save as Sample** dialog, or right-click a library clip and choose
**Save as Sample (Music)** or **Save as Sample (Simple)** to bake a new WAV.
Silverdaw writes the file to
`samples\<sourceFileName>\<name>-sample-001.wav` — grouped in a per-source subfolder
named after the source's (sanitised) file name, under the current project folder, or
under the temporary workspace
(`<temp>/Silverdaw/samples`) when the project has not been saved yet; temp samples
migrate into the project folder on the first save. The numeric
suffix increments for duplicate base names. There are two flavours: a **music
sample** inherits the source's tempo/key grid so it warps and shows its grid, while
a **simple sample** is a non-musical one-shot — the presence of pitch + BPM is the
only difference. The baked WAV is added as a
sample library item that **records its source** (`sourceItemId`, persisted in
the project file): that provenance both inherits the source's cover art + tags via
the shared media GUID and marks the item as a saved sample rather than an ordinary
import. Sample tiles use the **Saved from a clip** cover-art badge tooltip, and
simple samples show a **Simple** audio-type pill. Deleting that library item removes the reference from
the project and, by default, leaves the WAV file on disk; enabling **Clean up
project files** (Preferences ▸ Project) instead has the **audio backend** delete the
generated WAV — and prune its now-empty per-source folder — plus any shared cover/tag
media (swept in the main process) nothing else still references. That file-deleting
removal **cannot be undone and does not mark the project dirty** (the file can't be
put back), and the item is pruned from the already-saved project file in place so it
never dangles — without saving the user's other unsaved edits. A simple sample bakes the clip's
warp/pitch through Rubber Band during export so the one-shot sounds like the clip did
on the timeline; a music sample is exported at the source tempo/pitch so it can
re-warp on drop.

> **Re-baking is non-destructive and unlinked.** Every **Save as Sample** run
> creates a *new, independent* WAV. The resulting item records its source only for
> cover-art / tag inheritance and sample identification — it is not *live-linked*
> back to the clip it was baked from. Running it again on the same saved clip
> always produces a fresh sample (`…-sample-002.wav`, `-003`, …) rather than
> overwriting the previous one, and future edits to the source clip's trim,
> warp, or pitch do not propagate to previously-baked samples. To replace an
> outdated sample, bake a new one and remove the older library entry.

**Renaming** — single-click the name on any library tile (or pick **Rename** from
the right-click menu) to edit it inline. Saved clips inherit a sensible default name
based on their source and offset; renaming is the same flow.

Double-click a tile to **preview** it — source, stem, and sample items open a
read-only preview of the original file (warp, pitch, and effects are edited per
clip on the timeline, not on the source), while saved **clip** items open the
editable **Clip Editor** (see below). In the preview you can still select a
section and **Save Selection to Library** as a reusable clip. To view the read-only
information dialog instead — file details, technical audio details, detected
BPM/beat/key metadata (the BPM shown in the same pill style as the tile, with a
leading `~` for a variable tempo), tag metadata, cover art, the item **type**
(source / stem / sample / clip) and, for stems and samples, a banner
naming the source it derives from (**Separated from** for stems, **Saved from**
for samples, and **Source** for clips / other items), plus which tracks currently
use the library item — pick **Show information** from the tile's right-click context menu.
The right-click context menu also includes **Reanalyse file** (source, stem, and
sample items only), which refreshes the decoded cache, BPM/beat analysis and
musical key; **Auto-classify** / **Treat as Music** / **Treat as Simple** for the
simple-vs-music classification override (source, stem, and sample items only — see
[Confidence and audio type classification](#confidence-and-audio-type-classification));
**Save as Sample (Music)** and **Save as Sample (Simple)** (clip items only); and
**Remove**. Removal is gated
for source items while they're in use by a timeline clip; saved clip
items can always be removed (every linked timeline clip is silently unlinked
first and continues playing from the underlying source).

**Clip Editor** — the same dialog opens from four entry surfaces:

- Double-click a **library tile**, or pick **Preview** / **Open in editor** from
  its right-click menu: source, stem, and sample items open a **read-only
  preview** (select a section there to **Save Selection to Library**), while a
  saved **clip** item opens the editable editor.
- Double-click a **timeline clip body** (anywhere other than the title strip,
  which still inline-renames), or pick **Open in editor** from the clip's
  right-click menu, to edit that timeline clip — its window, warp and pitch.

The dialog renders the source waveform with an adaptive time ruler, faint
beat lines extrapolated from the detected BPM, and zoom + horizontal scroll
(`+` / `-` / `0`, mouse-wheel anchored at the pointer, `Shift+wheel` to pan;
capped at **64× / 6400 %** so even narrow saved clips can be inspected
sample-precise). Once zoom or selection narrows past a threshold the dialog
opportunistically requests a **2000 peaks/sec** rendering for the item on
screen so the waveform stays crisp at deep zoom; the request is keyed on the
library item id and cached on disk alongside the default 500 peaks/sec cache.
Audio-file items open at the same px-per-second scale as the main timeline;
existing clips (saved clip library items, linked timeline clips, and
unlinked timeline clips) open zoomed to fit their window and the **Source**
/ **Clip** toggle flips between full-source view (so the window can be
extended beyond the current bounds) and the narrowed view. Warped clips show
a **WARP** pill in the editor header; the playhead is shown at the start of
the view immediately, and Play becomes available once the backend preview
voice is ready. Auditioning runs through an independent **backend preview
voice** (`PREVIEW_LOAD` / `PREVIEW_PLAY` / `PREVIEW_PAUSE` / `PREVIEW_STOP` /
`PREVIEW_SEEK` / `PREVIEW_SET_WARP` / `PREVIEW_SET_REVERSED` / `PREVIEW_SET_BRAKE` /
`PREVIEW_SET_BACKSPIN` / `PREVIEW_UNLOAD` → `PREVIEW_STATE` /
`PREVIEW_POSITION` / `PREVIEW_ENDED`) so the main transport is unaffected. A
monotonic `generation` counter on the preview voice means stale events for a
preview the user has already closed are silently dropped. While playing the
canvas follows the playhead with the same smooth ease-in catch-up the main
timeline uses.

The dialog is **transactional**. Whenever it opens on an existing clip
(saved clip library item, linked timeline clip, or unlinked timeline clip)
every edit — trim window, narrowed view, warp settings, pitch settings, reverse,
and the brake / backspin tail toggles — is held
as a local draft that affects only the preview voice. The footer shows
**Cancel** + **Save**. **Save** commits the whole draft atomically; **Cancel**
(and `Esc`) discard it without touching the library item or the timeline.
Save scope depends on the target:

- Saved clip library item or linked timeline clip → updates the library item
  and propagates the new window + warp + pitch (and the reverse / brake /
  backspin flags, via `library.updateLibraryClip*`) to every linked timeline
  instance in lockstep, refused with a toast if any sibling would collide
  with a neighbour on its track.
- Unlinked timeline clip → updates only that one clip after the same
  collision check.

For source, stem, and sample library items the footer instead shows **Close** +
**Save Selection to Library**, which writes a fresh saved clip entry from the current
selection without modifying the source.

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
- **Trim** lives in the inline clip-controls row beside the **Source / Clip**
  toggle and the zoom controls. It narrows the in-dialog view to the current
  selection without writing anything to the project — purely a non-destructive
  preview zoom. Ctrl+Z / Ctrl+Y inside the dialog walk a dialog-local trim
  history so the user can experiment freely. **Source** / **Clip** flips between
  full-source view (so the window can be extended beyond the current bounds)
  and the narrowed view; switching back from Source carries the most recently
  selected range with you so a wider selection on the source can be tightened
  up at clip-level zoom.
- **Warp + Pitch inspector** (existing-clip targets only): a right-hand panel
  exposes draft controls for **Enable Warp**, warp **Mode** (rhythmic / tonal
  / complex), **Playback tempo** (**Follow project BPM**, **Pin to** a specific
  BPM, or a free **Stretch %** for material with no source tempo — e.g. spoken
  word, and **samples**, which are committed free-form audio that expose no
  source tempo to the warp controls so they offer Stretch only), pitch
  **Semitones** / **Cents** range sliders, and **Key presets**
  computed from the source's detected key. The resulting **Playback BPM** +
  ratio and the current pitched key are shown alongside the controls (the source
  BPM lives in the sibling Beat grid panel, not duplicated here). Slider movement
  updates the preview voice **live** — Rubber Band's
  `setTimeRatio` / `setPitchScale` are applied as atomic parameter changes
  with no reseek or history flush, so the audio stays continuous through
  drags and loops. The renderer coalesces draft updates to roughly 30 Hz so
  Rubber Band isn't re-tuned per pointer event.

## Preferences

User preferences are persisted as JSON at `%APPDATA%/silverdaw/preferences.json`
and edited via the in-app **Edit → Preferences…** dialog. The dialog is
**transactional**: every field is held in a local working copy until you click
**Save**; **Cancel** (and `Esc`) discard pending edits without touching the
engine or the file. The settings are organised into eight tabs on a left-hand
sidebar:

- **General** — appearance: the **waveform display** mode (single vs. left/right
  channels), library tile imagery, and toast notifications.
- **Timeline** — timeline behaviour: follow-playback auto-scroll, **set project
  tempo from first clip** (seed a new project's BPM from the first clip dropped),
  **match project tempo on drop** (auto-warp a dropped clip to the project BPM),
  and the transport **previous / next button target**.
- **Project** — default Save / Open / Import directories, background autosave
  configuration, and **clean up project files on remove** (with a *cannot be
  undone* warning; a file-deleting removal is non-undoable and doesn't dirty the
  project).
- **Audio** — output device + driver selection (see below, with a per-device
  **Keep awake** checkbox — off by default — on each device row), and the
  **Default project sample rate** (44.1 kHz / 48 kHz) used to seed
  `PROJECT.targetSampleRate` on new projects.
- **MIDI** — detected MIDI inputs, supported-deck enablement, connection and
  activity state, and a manual device rescan. Unsupported devices remain
  visible with disabled checkboxes.
- **Effects** — global defaults for the per-clip DJ turntable effects: the
  **Brake** Duration (short ~0.4 s / medium ~0.6 s / long ~0.9 s) and Curve
  (linear / curved / steep), and the **Backspin** Duration (same ~0.4 / ~0.6 /
  ~0.9 s presets) and Intensity (gentle / medium / wild = 4× / 6× /
  8× reverse speed). On save these are pushed to the engine (`BRAKE_SETTINGS_SET`
  / `BACKSPIN_SETTINGS_SET`) and re-applied live to every clip already carrying
  that effect; they are also re-sent on each backend reconnect.
- **Stems** — stem-separation model management (a combined **Download models**
  action for the two RoFormer quality packs, plus a **Locate** row for each of the
  vocal, drums/bass, and backup models, an **Always use the backup model** toggle
  below them, per-stem cleanup options, and the experimental **GPU
  acceleration** toggle).
- **Developer** — diagnostic logging, log folder and DevTools access.

### MIDI controller preferences

The MIDI tab requests a fresh backend device list whenever Preferences opens.
The **Rescan devices** action repeats that enumeration and shows progress until
the refreshed list arrives or a six-second safety timeout expires. Each row
shows the Windows device name, supported-profile label, connection state, and
latest activity time.

> **Only supported deck MIDI controllers can be enabled.** Other MIDI inputs
> remain visible but their checkboxes are disabled. The backend independently
> rejects unsupported identifiers, so this restriction is not only a UI state.

Ticking a supported device opens it for the current session immediately.
Selecting **Save** persists enabled identifiers in `preferences.json`;
**Cancel** restores the pre-dialog selection. Persisted deck 1/2 enablement is
re-applied after a backend reconnect.

The **MIDI Monitor** is available from **Preferences ▸ Developer** and the
**Debug** menu. It retains the latest 200 raw messages from enabled inputs and
shows timestamp, device, message kind, controller code, and value. See
[MIDI deck controllers](midi-controllers.md) for setup, all supported model
names, mapped behavior, controller feedback, and troubleshooting.

Persisted fields:

- Window bounds + maximised state.
- Panel sizes (track-header column width, library panel height).
- **Bottom panel minimised state** — `ui.libraryPanelCollapsed`. When on, the
  bottom tabbed panel is collapsed to its tab strip; expanding it (or clicking a
  tab) restores the last height. Persisted independently of the project so it
  survives relaunch without marking the project dirty.
- **Follow playback** — continuous-follow auto-scroll. When on, the timeline scrolls so the
  playhead stays near the centre of the viewport during playback (default). Off pins the
  view in place. Toggleable in the transport bar (chevron-in-circle icon) and the
  Preferences dialog.
- **Show images on library tiles** — controls whether library tiles show embedded cover
  art or the fallback audio icon. Off makes the library tiles text-only.
- **Set project tempo from first clip** — `ui.seedProjectTempoFromFirstClip`
  (default on). Gates the first-clip project-BPM seed (see *Tempo, key & warp*).
  When off, dropping the first clip onto a new project leaves the project BPM
  untouched and the transport BPM field does not pulse a detection hint. Like the
  turntable-effect defaults, it is pushed to the backend on change and re-sent on
  every reconnect (`PROJECT_SET_SEED_TEMPO_PREF { enabled }`).
- **Align clips to the beat grid after analysis** — `ui.alignClipsToGridOnAnalysis`
  (default on). Once a clip's tempo analysis completes, its first in-window grid beat
  is snapped to the nearest project **bar** line (via `project.alignClipToBarGrid`,
  reusing the drag-time `clipFirstBeatOffsetMs` projection), bumping one bar forward
  when the nearest bar would fall before the timeline origin — so a clip that starts
  with silence lands with its bars on the timeline's bars (a lead-in bar of silence)
  rather than a beat off. Renderer-only (not sent to the backend). It **only moves a
  clip whose effective tempo matches the project tempo** — a clip whose beats are
  spaced differently from the grid can't align. The align runs at analysis time
  (covering a clip dropped at a tempo the project already uses) and is **re-run from
  `PROJECT_BPM_APPLIED`** (`library.flushGridAlignAfterBpm`): a first-clip tempo seed
  arrives in the bridge message *after* the analysis, so a clip that seeds the project
  is skipped as a mismatch at analysis time and snaps into place once the seeded tempo
  lands (a short-lived pending set stops a later manual BPM change from reflowing clips).
  Clips with no beat grid (simple samples), locked clips, and clips queued for
  auto-warp are left untouched.
- **Show toast notifications** — pop transient feedback (errors, save acks) in the
  bottom-right. Off silences them; the underlying events still go to the log when
  diagnostic logging is enabled.
- **Default project folder** — used as the starting directory for File → Save / Save As /
  Open. Defaults to `%USERPROFILE%\Silverdaw\Projects` (alongside `Logs`, `Diagnostics`,
  and `Models`), which is created on first launch.
- **Default clip folder** — starting directory for Add Track from File / library Import.
  Defaults to the user's Music library (`<home>/Music/`). After every successful open it
  remembers the folder you browsed to **for the rest of the session**; on next launch it
  resets to this default.
- **Autosave** — enable / disable plus tick interval (clamped 5..600 s, default 30 s).
- **Audio output device** — persisted `{ typeName, deviceName }` pair. The
  Preferences ▸ Audio list shows **real named devices only** (pseudo-endpoints like
  the DirectSound "Primary Sound Driver" and "Microsoft Sound Mapper" are filtered
  out, and there is no "System default" row — each device has its own keep-awake
  toggle, which an opaque default couldn't). A `null` / `null` pair is the internal
  "no pin" state: the backend opens the OS default and, if the pinned device is
  unavailable (e.g. a USB DAC is unplugged), **falls back to the next available
  device** while leaving the preference intact so re-plugging restores it. The
  backend receives the pair as `SILVERDAW_OUTPUT_DEVICE_TYPE` /
  `SILVERDAW_OUTPUT_DEVICE_NAME` env vars at spawn time. May be overridden per
  project (see [Project properties](#project-properties)).
- **Default project sample rate** — `ui.defaultProjectSampleRate`, `44100` or
  `48000`. Seeds new projects' effective sample rate when the project hasn't
  set `targetSampleRate` itself. See [Project sample rate](#project-sample-rate).
- **Previous / next button target** — `ui.skipButtonTarget`, `timelineEnds`
  (default) or `markers`. Controls where the transport bar's previous / next
  buttons jump: `timelineEnds` seeks the project start / end; `markers` steps
  through the timeline markers, falling back to the start / end past the last
  marker in either direction.
- **Waveform display** — `ui.waveformDisplayMode`, `summary` or
  `stereo` (default). `summary` draws a single combined waveform per clip; `stereo`
  stacks separate left / right lanes for two-channel sources (mono sources and
  rows too short for two lanes still show one lane). Applies to both the
  timeline and the Clip Editor.
- **Recent Projects** MRU (max 10, head = most recent, case-insensitive dedupe by path). Each entry is a `{ path, name }` pair; the display name is refreshed on every save (so a renamed project shows its current name), and legacy path-only entries fall back to the file name.
- **Write diagnostic logs** — enables the opt-in cross-layer **verbose** file
  logger (all levels, whole session). When on, the next launch writes a
  per-session timestamped folder containing `{main,backend,renderer}.log` with
  aligned millisecond timestamps. The **Log folder** field lets the user choose
  the parent folder; by default this is a discoverable `Silverdaw\Logs` folder in
  the user's home folder (packaged installs — a `userData`/`%APPDATA%` path is
  redirected into a hidden MSIX container; dev builds use the repo `debug`
  folder), and blank entries are normalised back to that default. This is
  separate from the always-on **startup diagnostics**
  (packaged: `%USERPROFILE%\Silverdaw\Diagnostics`, see *Engine resilience and
  recovery ▸ Startup diagnostics*), which are written on every launch regardless
  of this toggle but only cover startup. All of these logs are privacy-scrubbed at
  the point of writing: the Windows user-profile segment of any logged file path is
  replaced with `<user>` and the computer name is never logged, so a shared log
  carries nothing that identifies the user. When diagnostic logging is on, Help ▸
  **Send Diagnostic Logs** zips the current run's logs into the Logs folder, reveals
  the zip in the file manager, and opens a pre-filled email to `support@silverdaw.com`
  to attach it (a `mailto:` draft can't auto-attach, so the reveal + attach is manual).
- **Show Developer Tools** — gates the visibility of the **Debug** menu and
  DevTools shortcuts independently of file logging.
- **Stem-separation settings** — `stems.useGpu` (GPU acceleration, default off),
  `stems.quality` (Fast / Balanced / Best — the inference + RoFormer chunk
  overlap), `stems.useBackupModel` (force the htdemucs backup for every stem,
  default off), and the per-stem cleanup toggles + strengths (`enhanceVocals` /
  `enhanceDrums` / `enhanceBass` / `enhanceOther` and their `*Strength`).
- **Located model directories** — optional override paths to existing on-disk
  copies of each separation model: `paths.stemModelDir` (htdemucs backup),
  `paths.vocalPackDir` and `paths.rhythmPackDir` (the RoFormer packs). Empty =
  use the app-managed download location: a discoverable `Silverdaw\Models`
  folder in the user's home folder for packaged installs (one subfolder per
  model id; a userData/%APPDATA% path would be redirected into a hidden MSIX
  container), `<userData>/models` for dev builds. Existing downloads are
  best-effort migrated from the legacy `<userData>/models` location on first run
  after the default moved.

QoL settings take effect on **Save**; developer settings require a restart and
the dialog surfaces that explicitly.

### Audio output device

Pick where Silverdaw sends audio in **Preferences → Audio**, or switch live from the
chip on the left of the transport bar without leaving the timeline. Both surfaces list
**real named devices only** — pseudo-endpoints (the DirectSound "Primary Sound Driver",
"Microsoft Sound Mapper") are filtered out, and there is **no "System default" option**:
device selection is always explicit (an opaque default can't carry a per-device
keep-awake toggle). Devices are **deduplicated across backends** — the same physical
Speakers exposed by both Windows Audio and DirectSound shows up as a single row in both
surfaces, with the most-friendly backend auto-picked (Windows Audio first, falling back
to DirectSound, then the rest). The transport chip and the Preferences list share one
composable, `lib/audio/audioOutputPicker.ts`.

Advanced users can override the backend via the collapsed **Audio driver ▸** disclosure
in Preferences (hidden until you've picked a non-default device). Each backend carries a
plain-English description — e.g. *"Recommended. Modern Windows audio path; reliable
latency and shares the device with other apps."* / *"ASIO — Lowest latency, but requires
a vendor-supplied ASIO driver."* — so no outside docs are needed.

Robustness:

- **Removable devices** (USB / Bluetooth headphones) — when the saved device isn't
  present at launch the backend falls back to the next available device (the OS
  default). This is handled silently: there's nothing the user can act on (the device
  isn't there) and no way to dismiss a notice that would otherwise recur every launch,
  so no toast is shown. The persisted preference is kept so re-plugging works next launch.
- **Live unplug** — JUCE's `audioDeviceListChanged` callback fires; the backend reopens
  the next available device automatically so audio keeps flowing. A fresh `AUDIO_DEVICES_LIST`
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
  non-trivial (>30 ms), as a caption under the device name.

## Project properties

**File ▸ Project Properties…** opens a transactional dialog that edits the
fields stored directly on the `PROJECT` ValueTree node:

- **Project name** (required).
- **Tempo** (20–300 BPM) — same value as the transport-bar BPM field.
- **Duration** (`mm:ss` / `h:mm:ss`) — clamped above the longest clip's end.
- **Audio output device** + **driver** — per-project override of the global
  preference. Two dropdowns: device list (deduplicated across drivers) and
  driver list (Windows Audio / DirectSound / ASIO / etc.), both with a
  "Use Application Settings" entry that clears the override. If the saved device isn't
  present at project-load, an `AudioDeviceUnavailableDialog` informs the user
  and the engine falls back to the next available device; the project preference is left
  intact so re-plugging or re-saving restores it. Shares the device list (real
  named devices only, pseudo-endpoints filtered) with the Preferences ▸ Audio
  picker via the single composable in `lib/audio/audioOutputPicker.ts`.
- **Sample rate** — 44.1 kHz / 48 kHz dropdown. Changing the value pushes
  `PROJECT_SET_TARGET_SAMPLE_RATE` and the transport-bar **RATE** column
  updates immediately. See [Project sample rate](#project-sample-rate) for the
  import-time and mismatch behaviour.
- **Bar counter start** (`-64`…`1`, whole numbers) — the number shown for the
  first bar on the timeline ruler. `1` (the default) shows `1, 2, 3, …`; set `0`
  or lower to reveal lead-in bars before bar one. Committing pushes
  `PROJECT_SET_BAR_COUNTER_START`, the ruler relabels immediately, and the
  project is marked dirty (it does not change the Export Mixdown **Start from
  bar** value).

The dialog uses per-field validation: the Save button refuses to commit when
BPM, duration, or the bar-counter start parses outside its allowed range. Cancel
(and Esc) discard the working copy without touching the project.

## Project sample rate

Projects carry an explicit `targetSampleRate` (44 100 or 48 000 Hz) on the
`PROJECT` node. When unset, the renderer falls back to the user-scope
`ui.defaultProjectSampleRate` preference (44.1 kHz by default). The
transport bar's **RATE** column always shows the effective rate so the user
can see at a glance which path the project is on.

**Import preflight.** `LibraryPanel.onImportClick` and `onPanelDrop` both
call `preflightSampleRates(filePaths)` before adding any files. The renderer
issues an `AUDIO_FILE_PROBE { requestId, filePath }` envelope per file; the
backend opens the file via `AudioFormatManager::createReaderFor` and replies
with `AUDIO_FILE_PROBED { requestId, filePath, ok, sampleRate, channelCount,
durationMs }` (or `ok: false` + `error` on failure). The probe runs on the
peak worker pool with a 5 s renderer-side timeout; on timeout the file is
silently skipped from mismatch detection. Probes always read the **file
header's actual** rate — the renderer's Web Audio decoder otherwise
resamples to the AudioContext rate (typically the device rate, often 48 kHz
on Windows) and would lie about the source rate.

If every file matches the effective project rate the import proceeds
silently. Otherwise the **Sample-rate mismatch dialog** appears with a
bucket-by-rate summary and three exit paths:

- **Cancel** — abort the whole batch.
- **Convert to project rate** — keep the project at its current rate;
  imports are converted at load time. (Files above 48 kHz can only take
  this path if the project is already at 48 kHz.)
- **Switch project rate** — only offered when the source rates are 44.1 or
  48 kHz, or when at least one source is above 48 kHz (in which case the
  project bumps to the 48 kHz cap). Dispatches `PROJECT_SET_TARGET_SAMPLE_RATE`
  before the import loop runs so the new rate sticks.

48 kHz is the hard cap. The `PROJECT_SET_TARGET_SAMPLE_RATE` handler
whitelists `0` (clear), `44100` and `48000`; the dropdowns enforce the same
on the renderer side.

> **Phase 1 / Phase 2.** What's described here is Phase 1 — the foundations:
> probe envelope, target-rate field, prompt dialog, RATE indicator,
> classification gates. Phase 2 adds an on-disk rate-keyed playback cache
> (libsamplerate-converted WAVs under `%APPDATA%/Silverdaw/playback/`),
> project-rate change-and-rebuild (regenerate caches and resume transport
> with `transcodeGeneration` for stale-ack safety), sample-bake at the
> project rate, and a throttled probe-on-load batch for older projects that
> stored a wrong renderer-side rate. Phase 2 is not yet shipped.

## Keyboard & mouse reference

The timeline accepts the following inputs. Modifiers behave **live** during drags — pressing
or releasing the modifier between frames switches mode without restarting the drag.

The full, version-matched shortcut reference is published online and opened from **Help ▸
Keyboard Shortcuts**, which navigates to `https://docs.silverdaw.com/<app-version>/guide/shortcuts`
(the path always carries the running app's `app.getVersion()`, so a release must have the
matching versioned page live).

| Input | Effect |
|---|---|
| Click on **ruler** | Seek the playhead to the nearest sub-beat (1/16 at 4/4). |
| `Alt` + click on ruler | Seek to the exact pointer position (1 ms resolution, no snap). |
| Click + drag on **ruler** | Drag the playhead, snapping to the nearest sub-beat (`Alt` for 1 ms resolution). Double-click has no effect — toggle markers at the playhead with `M`. |
| `Shift` + drag a **marker** | Move the marker, snapping it to the timeline grid and refusing occupied grid points. Without `Shift`, a drag over a marker moves the playhead instead, so the two are never ambiguous when the playhead sits on a marker. |
| Click on **clip** (no drag) | Select the clip and its host track, and seek the playhead to the click position. |
| `Shift` + click on **clip** | Extend the selection to a range of clips on the anchor's track, between the anchor and the clicked clip (ordered by start time). |
| `Ctrl` + click on **clip** | Toggle that clip in/out of the multi-selection, across tracks. Right-clicking any selected clip opens a dedicated menu (Copy, Cut, Lock, Colour, Duplicate, Delete) that acts on the whole selection; **Delete**, **Ctrl+L** and **Duplicate** also apply to every selected clip as one undo step. **Copy / Cut / Paste** (Ctrl+C/X/V) carry the whole selection — paste drops it at the playhead starting on the selected track, keeping each clip's relative timing and track offset, and is rejected wholesale if any clip wouldn't fit. Dragging any selected clip moves the whole group by a uniform delta (preserving relative offsets, across tracks), applied atomically — the move is refused wholesale if any clip wouldn't fit or one is locked. **Shift + ←/→** (and **Shift+Alt+←/→** for 1 ms) nudge the whole group. A plain click on a selected clip (no drag) collapses back to just that clip. |
| Click + drag on **clip body** | Move the clip; the clip's first detected source beat snaps to the project sub-beat grid (or the clip's left edge if the source has no detected beats yet). Drag across rows to move the clip to a different track. Clips can't overlap on a single track — they magnetically butt against neighbour edges instead. |
| `Alt` + drag on clip | Move with 1 ms resolution — the clip stays at the unsnapped position. |
| Click + drag on **clip edge** (~8 px hit zone) | Trim the clip from that edge, snapping the dragged edge to the project grid by default. Non-destructive — only the window over the source file changes. Disabled on clips linked to a saved clip library item (right-click ▸ Unlink first, or use the Clip Editor) and on **locked** clips (Ctrl+L or right-click ▸ Unlock to free). |
| `Alt` + drag on clip edge | Trim with 1 ms resolution — the dragged edge stays at the unsnapped position. |
| Drag the **bottom edge of a track header** (~5 px hit zone) | Resize that track row vertically (60–400 px). Each track's height is persisted with the project and undoable. |
| Drag the **grip icon** (6-dot handle next to the track name) | Reorder the track. A green drop indicator shows the target slot. Drop on the indicator commits one undoable reorder step. |
| Double-click a **track gain number** | Type a track gain in dB directly (range `-∞..+6 dB`). Accepts `-3`, `+1.5`, `0 dB`, `-inf`, `-∞`. Invalid input is rejected and the previous value is kept. |
| Double-click the **master volume readout** in the transport bar | Type a master gain in dB directly (range `-∞..0 dB` — no boost above unity). Same parser as the track readout. |
| Click on **empty area of a track row** | Select that track (highlighted row border), deselect any clip, and move the playhead to the click position (drag to scrub). |
| Click on **inter-track gap** / below the last track | Deselect both clip and track, and move the playhead to the click position. |
| **Right-click on an empty track lane** | Open a **Paste** menu that drops the clipboard clip onto that track at the playhead (disabled when the clipboard is empty). Click first to place the playhead where the paste should land. |
| `←` / `→` | Step the playhead one grid line (sub-beat). |
| `Alt` + `←` / `→` | Step the playhead by one pixel's worth of time (~16.7 ms at default zoom, finer when zoomed in). |
| `Shift` + `←` / `→` | Move the **selected** clip one beat-grid step, snapping its first in-window source beat to the project sub-beat grid (the keyboard twin of a plain clip drag; falls back to the clip's left edge when the source has no detected beats). Bump-clamped against neighbours; a burst folds into one undo step. No-op on a locked clip or with no clip selected. |
| `Shift` + `Alt` + `←` / `→` | Nudge the **selected** clip along the timeline at the finest granularity (1 ms, no snap — the keyboard twin of `Alt`+drag). Bump-clamped against neighbours; a burst of nudges folds into one undo step. No-op on a locked clip or with no clip selected. |
| `M` | Toggle a marker at the nearest grid point to the playhead. Markers are shown as emerald downward triangles on the ruler and are saved with the project. |
| `Ctrl` + `←` / `→` | Move the playhead to the previous or next marker, scrolling the timeline if needed. |
| `Ctrl` + `Shift` + `←` / `→` | Skip to the start or end of the project and jump the timeline viewport there. |
| `Home` / `End` | Skip to the start or end of the project and jump the timeline viewport there (the bare-key twin of `Ctrl` + `Shift` + `←` / `→`). |
| Mouse wheel | Scroll the track stack vertically. |
| `Ctrl` + mouse wheel | Zoom the timeline (anchored on the pointer). |
| Two-finger horizontal swipe (trackpad) | Pan left/right. |
| `Shift` + mouse wheel | Pan left/right. |
| `Ctrl +` / `Ctrl =` | Zoom in 10% (anchored on the playhead). |
| `Ctrl -` | Zoom out 10%. |
| `Ctrl 0` | Reset zoom to 100% (100 px/s). |
| `Ctrl + F` | Zoom to fit — size the whole project to the timeline width and jump the view to the start. |
| `Space` | Play / pause globally unless a text field or modal dialog is active. Disabled when the playhead is at the end of the project (skip back to start to re-arm). |
| `Escape` | Step down through the selection: when a track and clip(s) are selected, the first press clears the clip(s) (and any selected automation point) but keeps the track selected, and a second press clears the track. When only a track is selected, one press clears it. |
| `K` | Toggle the project metronome. |
| `Shift + M` / `Shift + S` | Mute / solo the selected track (bare `M` / `S` are Marker / Split, so the track-mix twins take `Shift`). No-op when no track is selected. **Ctrl-clicking** a track's on-screen **Solo** button while another track is soloed switches the solo straight to that track (solos it and unsolos the other) in one undo step — no need to unsolo first. |
| `F2` | Rename project (also activates the title-bar rename input). |
| `S` | Split every clip whose timeline window straddles the playhead into two at that position. |
| `D` / `Ctrl + D` | Duplicate the selected clip. Repeated duplicates from the same source append after the last duplicate in that track until there is no free slot, then a toast is shown. |
| `Delete` / `Backspace` | Delete the selected clip. |
| `Ctrl + Shift + T` | Trim the project length down to the end of the last clip. |
| `Ctrl + X` / `Ctrl + C` | Cut / copy the selected clip into the local clipboard. |
| `Ctrl + V` | Paste the clipboard clip to the selected track at the playhead. A toast appears if the selected track has no space at that position. |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo any project-mutating edit (clip / track / library / marker / BPM / length / rename / master volume). Drag streams coalesce within 500 ms into one step, and compound ops (split / duplicate / paste) fold into a single undo step. |
| `Ctrl + L` | Toggle the **lock** flag on the selected clip. Locked clips refuse drag-move, edge-trim and Split-at-playhead, and show a padlock badge in their title strip. Per-clip — linked saved clip siblings stay independently lockable. |
| **Right-click on a clip** | Open the context menu: **Open in editor**, **Show information**, **Cut** / **Copy** / **Paste** (Cut and Copy act on the right-clicked clip — selecting it and its track first; Paste needs a clip on the clipboard and lands on this clip's track at the playhead, mirroring the Edit-menu / Ctrl+X·C·V behaviour), **Lock** / **Unlock** (Ctrl+L), **Delete**, **Duplicate**, **Split at playhead** (label changes to "Split at playhead (clip is locked)" on a locked clip; the entry stays clickable so the store guard can surface a toast), **Chop to Grid** (a submenu — whole bar / 1/2 bar / 1/4 / 1/8 / 1/16 — that slices the whole clip onto the beat grid in one undo step; shown only for an unlocked, unlinked clip with a known tempo), an inline 16-swatch **Colour** picker, **Reverse** (a checkmarked toggle that plays the clip back-to-front; propagates to every linked saved clip sibling), **Brake** / **Backspin** (checkmarked toggles for the turntable record-stop / reverse-rewind tail effects, also propagated across linked siblings — Reverse, Brake and Backspin form a mutually-exclusive group, so each entry stays visible but is **disabled** while any other in the group is set), **Save Clip to Library**, **Save as Sample…** (opens the **Save as Sample** dialog with **Music** and **Simple** choices), **Split Stereo Channels…** (stereo clips only — splits the Left and/or Right channel onto its own new track), **Warp** for BPM/time-stretch controls, and **Pitch** for semitone/cents tuning. The Warp and Pitch context-menu entries open lightweight transactional dialogs (**Save** applies, **Cancel** / close discards); for richer multi-setting editing use **Open in editor** instead. **Warp and Pitch work on linked clips too** — the dialog detects that the parent library item is a saved clip and routes the save through `library.updateLibraryClipWarp`, which updates the library entry and propagates to every linked timeline instance in lockstep (the dialog footer surfaces a small "Saving updates the library entry and every linked timeline clip" notice when that path is active). Shows **Relink** at the top when the clip is unresolved. |
| Double-click on a **clip body** (off the title strip) | Open the **Clip Editor** for that timeline clip. Trim, warp and pitch are held as a draft until **Save**; **Cancel** discards. Save scope follows the linked/unlinked state of the clip — see the [Clip Editor](#clip-editor) section. |
| Double-click on a **clip title strip** (top of the clip block) | Inline-rename the clip. Enter commits, Escape cancels, clicking outside also commits. The name is shown on the clip and used as the default name when the clip is saved to the library. |
| Double-click a **library tile name** | Inline-rename the library item (same gesture as the project title). |
| Double-click a **library tile** (off the name) | **Preview** source / stem / sample items (read-only; select a section to Save Selection to Library), or open the editable **Clip Editor** for a saved **clip** item. Use **Show information** from the right-click menu for the read-only info dialog. |
| Right-click a **library tile** | Open the library tile context menu with **Show information**, **Rename**, **Reanalyse file** (source, stem, and sample items only), **Auto-classify** / **Treat as Music** / **Treat as Simple** (source, stem, and sample items only), **Update Image…** (source, stem, and sample tiles — pick a new cover image, copied into the project as a per-item override), **Remove Image** / **Restore Image** (source, stem, and sample tiles — hides or restores the tile's cover art without deleting the shared image file), **Save as Sample (Music)** / **Save as Sample (Simple)** (clip items only), and **Remove**. Removal is gated only for sources that are still in use by a timeline clip; saved clip removal silently unlinks dependent clips. |

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
| `K` | Toggle the Clip Editor metronome (only when the metronome control is shown). Scoped to the dialog — the main timeline metronome is a separate setting and stays unchanged. |
| `Home` / `End` | Jump the preview playhead to the start / end of the active playback range (honouring the selection bounds, like the skip-to-start / skip-to-end buttons). |
| `Ctrl` + `F` | Fit the whole working view — the cropped clip or the full source — into the canvas and scroll to the start (mirrors the timeline's zoom-to-fit; behaves the same in the clip editor and the library preview window). |
| Drag on waveform | Mark a sub-selection. The selection drives Save-as-new and Apply-trim. |
| Drag on a selection handle | Fine-tune the selection edge. |
| **Volume** toolbar toggle (cropped Clip view only) | Turn Volume Shape editing on / off. The volume line is always drawn faint as read-only context; toggling on makes its breakpoints editable. |
| **Reverse** toolbar toggle | Play the clip back-to-front. Mutually exclusive with the Brake / Backspin tail effects — kept visible but disabled while one of those is set (turn it off first). Part of the transactional draft and previewed live; **Save** commits it (following the same scope as the other edits), **Cancel** discards. |
| **Brake** / **Backspin** toolbar toggles | Apply a turntable record-stop (Brake) or reverse-rewind (Backspin) tail effect, drawing a matching red / violet deceleration overlay on the waveform tail. Reverse, Brake and Backspin form a mutually-exclusive group — each toggle stays visible but is disabled while any other in the group is set. Part of the transactional draft and auditioned live on the preview voice; **Save** commits the flag (propagating to every linked instance, like reverse), **Cancel** discards. |
| Click / drag on waveform (Volume mode on) | Add a breakpoint, or drag an existing one — freehand placement by default. Endpoints keep their pinned times. |
| `Shift` + click / drag (Volume mode on) | Snap the breakpoint to the nearest source beat while adding or moving it. |
| `Alt` + click or right-click a breakpoint (Volume mode on) | Remove that breakpoint (pinned endpoints can't be removed). |
| **Silence** / **Full** toolbar buttons (`S` / `F`) | Flatten the current sub-selection to silence or full volume with hard step edges (a region gate). Enabled once a range is selected; the rest of the shape is left untouched. The `S` and `F` keys trigger the same gate without drawing the envelope. |
| **Slice** toolbar toggle (cropped Clip view only) | Turn loop-slice mode on / off (mutually exclusive with Volume mode). Shows green slice markers on the waveform and a **Slice** panel: a subdivision picker (1 bar / 1/2 bar / 1/4 / 1/8 / 1/16 / 1/32), **Generate to grid**, the marker count, and **Slice to timeline** / **Slice to samples**. |
| Drag on empty waveform (Slice mode on) | Add a slice marker and drag to position it; markers clamp between their neighbours. |
| Drag a marker (Slice mode on) | Move that marker. |
| `Alt` + click or right-click a marker (Slice mode on) | Remove that marker. |
| Mouse wheel | Zoom (anchored on the pointer), capped at 64× / 6400%. |
| `Shift` + wheel | Pan left / right. |
| `+` / `-` / `0` | Zoom in / out / reset. |
| `Esc` | Close the dialog. |

The transport bar's **previous / next** buttons honour the **Previous / next
button target** preference (`ui.skipButtonTarget`). With the default
`timelineEnds`, **previous** rewinds the playhead to the project start (and
returns the timeline's horizontal scroll to the start) while **next** seeks the
project end and jumps the viewport to the right edge. With `markers`, they step
to the previous / next timeline marker instead, falling back to the start / end
past the last marker. The `Ctrl + ←/→` and `Ctrl + Shift + ←/→` keyboard
shortcuts keep their fixed marker / project-end behaviour regardless of this
setting.

The status bar shows the current zoom level (e.g. `🔍 150%`). It deliberately does
**not** show backend / audio-engine connection status: the front-end/back-end
split is an implementation detail the user shouldn't have to reason about, so
engine availability is handled invisibly by automatic recovery (see
[Engine resilience and recovery](#engine-resilience-and-recovery)) and only
surfaces as a focused overlay when the user actually needs to act. The **Pos**,
**Bar**, **Length**, and **BPM** readouts in the transport bar are greyed out
until the project has at least one track — empty-project edits to those fields
would have no visible effect, so we hide the affordance until it's meaningful.

The same zoom commands are reachable from the **View** menu — **Zoom In** (`Ctrl +`),
**Zoom Out** (`Ctrl -`), **Reset Zoom** (`Ctrl 0`), and a **Zoom Presets** submenu of
fixed levels (20% / 50% / 100% / 200% / 400% / 800%). In addition, `Ctrl 1`–`Ctrl 8`
jump straight to 100%–800% zoom (N × 100%); the presets that land on one of those levels
show the matching accelerator. The View-menu accelerators are display-only
labels; the keys themselves are handled by App.vue's global shortcut handler, so
`menuShortcuts` deliberately skips binding them to avoid a double-fire (see
`GLOBAL_SHORTCUT_ACTIONS`). Presets are defined once in
`lib/timeline/zoomPresets.ts` (px-per-second values that are exact multiples of the zoom
step, so they survive the geometry's snap-to-step) and shared by the menu and its handler.

### Selection model

A click selects two things at once: the **selected clip** (thick outline) is the target of
Cut, Copy, Duplicate, Delete, and Split-at-playhead shortcuts; the **selected track**
(highlighted row border) is the destination of Paste. Clicking a clip selects both the clip
and its host track. Clicking an empty area of a track row selects just that track and moves
the playhead to the click position (drag to scrub); clicking between tracks clears both and
likewise moves the playhead — so the playhead can be placed anywhere on the timeline, not
just on the ruler.

Copy/paste is target-driven: copy a clip, place the playhead where it should land, then
paste onto a track. Keyboard `Ctrl+V` pastes onto the **selected** track; the clip and empty
track-lane right-click menus paste onto the **right-clicked** track (selecting it first). The
new clip always lands at the playhead. Overlap rules are evaluated only on that destination;
the source-track's clips don't constrain placement.

Adding a track selects it automatically, so a clip paste, the mute/solo shortcuts, and the
Track FX rack all target the new track without a further click. The selected-track outline is
drawn in the track's own palette colour and extends continuously across both the timeline row
and its header panel.

**Multi-selection.** Shift-click builds a same-track range and Ctrl-click toggles clips across
tracks; the store keeps a `selectedClipIds` set alongside the single anchor clip. When more than
one clip is selected, Delete / Ctrl+L / Duplicate / Copy / Cut and the dedicated context menu act
on the whole set (each as one undo step), a body-drag moves the group by a uniform delta, and
Paste drops the whole group at the playhead starting on the selected track — keeping each clip's
relative timing and track offset, rejected wholesale if any clip wouldn't fit. Selection is
renderer-only (never serialised), so it needs no migration.

### Track effect automation

Each track header has an **A** toggle that opens an automation lane (a strip reserved at the
bottom of the track row; clips compress above it, so a collapsed lane leaves the timeline
layout untouched). A parameter picker chooses what the lane edits — **Filter**, **Pan**, the
3-band **Tone**, **Reverb/Delay sends**, **Compressor**, or **Gain** (a post-FX track level in
dB, distinct from the header fader and clip Volume Shape). Click to add a breakpoint, drag to
move, right-click or Alt-click to remove; a selected point fine-nudges with arrow keys; a drag
stream coalesces into one undo step. Lane-header controls raise/lower the whole curve, set the
value at the playhead, copy/paste a curve between tracks, and reset to default. The picker marks
already-automated params with a ● dot, and the value editor shows the sign convention (Filter:
negative = LPF, positive = HPF). Curves are stored on
each `TRACK` as one `automation` array-of-lanes property (`{ paramId, points: [{ timeMs,
value }] }`), round-tripped through `PROJECT_STATE` and `.silverdaw`. A lane with no curve shows a
faint baseline line at the parameter's **static (resting) value**, so the line tracks the live
Track FX control; the first point you draw starts from that value. A curve that settles flat at
the static value is treated as a no-op and the lane auto-clears. Each static Track FX
control (and the header **Pan**) carries a small **A** button that opens that parameter's lane
(`useFxAutomation`); while a curve owns the value the static control is **disabled**, dimmed, and
shows an **AUTO** tag, so it is clear the lane is in charge. While automated the control is
**read-only but live**: its slider and readout follow the curve's value sampled at the playhead
(`useFxAutomation.displayValue` reading `transport.positionMs`), so during playback or scrub the
Filter / Tone / Sends / Compressor sliders and the header Pan animate to the current automated
value (the static value remains the resting baseline the curve rides). The keyboard/value nudges
snap to the parameter default so 0 / centre
is always reachable. The lane resizes via a thin middle splitter (redistributes height between
waveform and lane) and the row's bottom edge (grows both together), clamped to a minimum that
keeps the readout visible. The backend publishes an
immutable `TrackAutomationSnapshot` per track (lock-free + retire queue) and samples it on a
fixed 256-frame control quantum at the block-start transport position, driving the existing
smoothed targets and snapping on seek/loop/play discontinuities, restoring neutral when a lane
clears; mixdown samples the same curves so
exports match playback. Authoring helpers (`setAutomationRamp`, `copyAutomationToTrack`,
`createFilterCrossfade`) build curves directly — e.g. an opposing filter sweep across two
tracks. Values are stored in native units; only the lane renderer normalises to pixels.

## Rendering performance

The timeline canvas is PixiJS. All world-space content (clip blocks, waveforms, grid lines,
ruler ticks) is drawn once at absolute world coordinates into a `tracksLayer` / `rulerTicksLayer`,
which are then translated by `-scrollX` / `-scrollY` on every scroll change. The result: scroll
and auto-follow during playback are O(1) layer translations — no clip iteration, no Graphics
allocation. A full repaint (`redraw()`) only fires on content change: track add/remove, clip
move, peaks arrival, zoom, BPM, project length, header-column resize.

**Peaks LOD pyramid.** Each library item carries a small ladder of pre-downsampled
peak arrays (`peaksLod`) alongside its base peaks. `drawClip` picks the LOD whose
`peaksPerSecond` is closest to the current draw scale so the waveform stays crisp
when zoomed in and the inner per-pixel min/max scan stays cheap when zoomed out.
Older projects that lack a stored pyramid auto-bake one on the next load. The
clip's beat-marker loop **stride-steps** by a precomputed `ceil(minMarkerSpacingPx /
pxPerBeat)` so a 5-minute clip at 120 BPM doesn't iterate every beat when only a
handful of markers fit on screen.

**Hot-path library lookups** go through the `libraryStore.byId` Pinia getter (an
`O(items)`-built `Record<string, LibraryItem>` cached and refreshed only when the
library changes). `drawClip` resolves the parent library item and source BPM once
and threads them into `drawClipHeader`, so the per-clip per-redraw cost is two
O(1) lookups rather than four O(n) array scans.

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
  scrolling waveform (the playhead stays in view as playback advances).

On the backend, `BridgeServer::broadcast` suppresses per-envelope log writes for both
`PLAYHEAD_UPDATE` and `PREVIEW_POSITION` (the only 60 Hz envelopes), so a playing transport
does not generate 60 log lines / second.

**Clip Editor uses the same renderer discipline.** The Clip Editor waveform
(`lib/clipEditor/useClipEditorWaveform.ts`) is also PixiJS, mirroring the timeline rather
than its own draw model. The scene (`useClipEditorScene.ts`) has a static ruler-background
layer, a `worldLayer` and a `rulerTicksLayer` — both translated by `-scrollPx` on scroll /
playback frames until scroll drifts past the overscan threshold, at which point a rebuild is
scheduled instead — plus a viewport-space `playheadLayer`. Translating the already-built band
is an O(1) layer move, not a repaint. The waveform is a batched `Mesh` per lane built by
`clipEditorWaveMesh.ts` (one in summary mode, two in stereo), and the beat grid, selection,
volume overlay, slice-marker overlay and ruler ticks draw into pooled `Graphics` / `Text` (acquired via
`beginFrame()` + `acquireGraphics()` / `acquireText()`, which `removeChildren()` rather than
destroy) so pooled display objects are detached and reused between frames instead of being
recreated. A full `redraw()` only fires on content, zoom, selection, or scroll drifting past
the horizontal overscan (`exceedsRebuildThreshold` / `horizontalOverscanPx`, shared with the
timeline). The playhead position is the authoritative `preview.positionMs` (from inbound
`PREVIEW_POSITION`); a per-frame `requestAnimationFrame` loop in `useClipEditorController.ts`
(`startPlayheadRaf`) repaints the playhead and eases the follow-scroll, matching the main
timeline's smooth catch-up. Time-anchored draw loops are clamped to the visible band so their
cost is O(visible width), independent of zoom — including the volume overlay, whose unity line
and envelope curve are inverted back through the linear `envX` to the on-screen millisecond
window. When the view is zoomed in past the peak resolution (fewer than one peak per
pixel — common on a short clip), each column's min/max is linearly interpolated between
adjacent peaks (`sampleInterpolatedPeak`) so the waveform draws a smooth envelope instead
of blocky repeated columns.

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

Release packaging additionally signs the MSIX with the Windows SDK `signtool.exe`.
It ships with the MSVC **C++ build tools** workload above, and
`scripts/Build-Release.ps1` locates it automatically — see
[Packaging for Windows](#packaging-for-windows).

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

## Packaging for Windows

`scripts/Build-Release.ps1` is the canonical release path. From the repository
root it runs the whole pipeline end-to-end:

1. Configures + builds the JUCE backend (`SilverdawBackend.exe`) in **Release**.
2. Runs a **bundling guard** that fails early if any runtime binary the backend
   drops next to `SilverdawBackend.exe` is missing from the `extraResources`
   allowlist in `electron-builder.yml`.
3. Ensures a self-signed **`CN=Silverdaw`** code-signing certificate exists in
   `Cert:\CurrentUser\My` (created on first run; the private key stays in the
   store and is **never** exported to the repo) and locates the Windows SDK
   `signtool.exe` (electron-builder's bundled signtool cannot sign AppX).
4. Compiles the Electron bundles and packages **three artefacts** from them.
5. Exports the **public** certificate so users can trust the sideload package.

```powershell
pwsh -NoProfile -File scripts/Build-Release.ps1
```

Everything lands in the repo-root `dist/` directory (gitignored except for a
`.gitkeep` marker):

| Output | What it is |
| ------ | ---------- |
| `Silverdaw-<version>.appx` | **Signed sideload package** (`CN=Silverdaw`). Installs via the App Installer once the certificate is trusted (below); registers `.silverdaw` and integrates with Start / Apps & features. |
| `Silverdaw-<version>.zip` | **Portable archive** — extract anywhere writable and run `Silverdaw.exe`. No certificate or install step (see limitations below). |
| `Silverdaw-<version>-store.appx` | **Unsigned Microsoft Store package** carrying the Store-assigned identity. Upload manually to Partner Center; Microsoft signs it at ingestion. Not locally installable as-is. |
| `Silverdaw-PublicCert.cer` | The public half of the signing certificate (no private key) — import it to trust the sideload package. |
| `win-unpacked/Silverdaw.exe` | The unpacked app, a build byproduct handy for a quick smoke test. |

The packaged backend is statically linked against the MSVC runtime, so a clean
Windows machine needs no separate Visual C++ Redistributable.

### Installing the signed sideload package

A self-signed package will not install until its certificate is trusted — this
is by design (unlike an `.exe`, there is no click-through SmartScreen override
for MSIX). In an elevated PowerShell:

```powershell
# Trust the publisher (one-time). Add-AppxPackage accepts the narrower
# TrustedPeople store; the App Installer GUI (double-click) needs Trusted Root.
Import-Certificate -FilePath dist\Silverdaw-PublicCert.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage -Path dist\Silverdaw-<version>.appx
```

To use the App Installer GUI (double-click the `.appx`) instead, import the
`.cer` into `Cert:\LocalMachine\Root`. `scripts/Build-Release.ps1` prints the
exact commands at the end of a build. The imported `.cer` is the public key
only — it lets a machine trust packages signed by `CN=Silverdaw`; it cannot be
used to sign anything.

### Portable archive

The zip needs no certificate and no install: unzip it and run `Silverdaw.exe`.
A copy downloaded from the internet may show a one-time SmartScreen prompt
(Mark-of-the-Web) that you can click through. Because it has no package
identity it also has **no** Start-menu entry, no Apps & features uninstall,
and no `.silverdaw` file association — those come only from the MSIX. An MSIX
install runs with package identity (some paths/permissions differ from the
plain exe), so test file-I/O behaviour in whichever form you ship.

### Microsoft Store package

`Silverdaw-<version>-store.appx` is built by `pnpm dist:store` (via
`electron-builder.store.cjs`, which reuses `electron-builder.yml` and overrides
only the Partner Center identity and disables signing). It is **unsigned** on
purpose — Microsoft re-signs it at ingestion, and the Store publisher is not a
certificate we hold — so it cannot be installed locally. Upload it to Partner
Center by hand; verify its identity first (`Build-Release.ps1` prints the
packaged `Identity/Name`, `Publisher`, and `PublisherDisplayName`).

Because it is a full-trust (`runFullTrust`) packaged desktop app it runs outside
the AppContainer, so the loopback bridge, backend child-process spawn, and access
to user-chosen files behave as in an unpackaged build. The `WindowsApps` install
dir is read-only, so all writable state — preferences, projects, autosave,
peaks/decoded caches, downloaded models and diagnostic logs — lives under the
per-user `userData`/`temp` locations, the backend is spawned with a writable
working directory, and user-chosen save/export destinations are pre-flighted for
writability (a read-only choice raises a clear warning rather than a cryptic
failure).

### Package artwork

`scripts/Build-InstallerArt.py` regenerates the packaging art from the source
logo `frontend/resources/icons/256x256.png` into `frontend/resources/appx/`
(and the `.silverdaw` document icon into `frontend/resources/icons/`):

- the MSIX tile logos (`StoreLogo`, `Square44x44Logo`, `Square150x150Logo`,
  `Wide310x150Logo`) with their DPI `scale-*` variants,
- the unplated `Square44x44Logo.targetsize-*` set (plain +
  `altform-unplated` / `altform-lightunplated`) that Windows themes for the
  taskbar / Start,
- the `StoreLogo` on an opaque `#F3F3F3` plate that matches the light App
  Installer dialog, and
- the `.silverdaw` document icon as both `silverdaw-file.ico` and
  `silverdaw-file[.targetsize-*].png` (referenced by the file-type `<uap:Logo>`
  in `frontend/resources/appx-extensions.xml`).

Re-run it whenever the source logo changes; the outputs are committed so a
normal release build doesn't need Python on the PATH.

```powershell
pip install Pillow
python scripts/Build-InstallerArt.py
```

### One-time signing setup

`electron-builder` extracts a `winCodeSign` archive on first use that contains
macOS symlinks; Windows refuses to create symlinks unless the process has the
privilege. Enable **Developer Mode** once (Settings → System → For developers →
Developer Mode = On) and re-run the build. Signing the MSIX also needs the
Windows SDK `signtool.exe`; it ships with the MSVC C++ workload from
[Prerequisites](#prerequisites) and `Build-Release.ps1` locates it
automatically (failing with a clear message if it is absent).

You can iterate on packaging without rebuilding the backend or reinstalling
frontend dependencies with the skip flags:

```powershell
pwsh -NoProfile -File scripts/Build-Release.ps1 -SkipBackend -SkipFrontendInstall
```

The lower-level frontend packaging commands assume the backend, bundles, cert,
and `SIGNTOOL_PATH` are already in place, so prefer `Build-Release.ps1`:

```powershell
cd frontend
pnpm dist        # signed sideload .appx + portable .zip
pnpm dist:store  # unsigned Microsoft Store .appx
pnpm dist:dir    # win-unpacked only, no packaging
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
  Backend coverage is available with `-DSILVERDAW_ENABLE_COVERAGE=ON`, which
  adds a `SilverdawBackendCoverage` target that runs the backend unit tests and
  writes reports under `backend/build-coverage/` (a dedicated, non-hidden
  folder). Clang / GNU
  builds use source-based instrumentation (llvm-cov / gcovr); **MSVC** builds
  use [OpenCppCoverage](https://github.com/OpenCppCoverage/OpenCppCoverage)
  over the Debug binary (`winget install OpenCppCoverage.OpenCppCoverage`),
  producing an HTML report plus `cobertura.xml`. OpenCppCoverage attaches as a
  debugger, so a Debug JUCE build ends on a benign breakpoint stop code even
  though every test passes and the report is written — that code is expected.
  `scripts/Coverage.ps1` runs frontend and/or backend coverage in one step
  (`./scripts/Coverage.ps1 -Target All | Frontend | Backend`) and collects both
  viewable HTML reports into a single gitignored root folder —
  `coverage/frontend/`, `coverage/backend/`, and a `coverage/index.html` landing
  page linking both.
- **TypeScript / Vue**: `pnpm typecheck` (`vue-tsc --noEmit -p tsconfig.web.json`
  for the renderer/shared sources and tests, then `tsc --noEmit -p tsconfig.node.json`
  for the Electron main/preload sources and the main-process tests),
  `pnpm lint` (ESLint flat config with `eslint-plugin-vue` and `@typescript-eslint`).
- **Tests**: `pnpm test` runs Vitest over the shared bridge-protocol guards,
  music-time helpers and Pinia stores. Test files live under `frontend/tests/`,
  mirroring the `src/` layout (`tests/renderer`, `tests/main`, `tests/shared`),
  are named `*.test.ts`, and reference the code under test through the `@`,
  `@shared` and `@main` path aliases. `pnpm test:coverage` runs the same
  suite with V8 coverage and writes text, HTML, lcov and JSON-summary reports
  under `frontend/coverage/`.
- **Dead code**: a configured `frontend/knip.json` (entry points for the main /
  preload / renderer electron-vite processes) lets `pnpm dlx knip` report unused
  files, exports and dependencies. Treat its output as *candidates* — the zod
  inbound/outbound schema maps and `.vue`-only usages produce false positives
  that need manual confirmation. Run before large refactors; not wired into CI.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](../LICENSE) for the full text. You are free to use,
study, modify, and redistribute it; any distributed or network-hosted modified
version must in turn be released under the AGPL with its source available to
users.

Third-party components (JUCE, IXWebSocket, Electron, Vue, etc.) retain their
own licences; see [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) for the
attribution notices required by those licences.
