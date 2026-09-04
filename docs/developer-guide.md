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
- [VST3 plugins](#vst3-plugins)
  - [Limitations](#limitations)
  - [Catalogue storage](#catalogue-storage)
- [MIDI controller architecture](#midi-controller-architecture)
- [Engine resilience and recovery](#engine-resilience-and-recovery)
- [Project state model](#project-state-model)
  - [Loop Selection playback](#loop-selection-playback)
- [Audio formats](#audio-formats)
  - [Internal signal format and bit depth](#internal-signal-format-and-bit-depth)
- [Peaks cache](#peaks-cache)
- [Audio analysis](#audio-analysis)
  - [Key detection](#key-detection)
  - [BPM and beat detection](#bpm-and-beat-detection)
  - [Confidence and audio type classification](#confidence-and-audio-type-classification)
  - [Beat markers and source-beat snap](#beat-markers-and-source-beat-snap)
  - [Timeline snap grid](#timeline-snap-grid)
  - [Processing progress panel](#processing-progress-panel)
- [Stem separation](#stem-separation)
- [Library panel](#library-panel)
  - [File browser (Files tab)](#file-browser-files-tab)
- [Scratch Editor](#scratch-editor)
- [Preferences](#preferences)
  - [MIDI controller preferences](#midi-controller-preferences)
  - [Audio output device](#audio-output-device)
- [Project properties](#project-properties)
- [Project sample rate](#project-sample-rate)
- [Keyboard & mouse reference](#keyboard--mouse-reference)
  - [Application commands](#application-commands)
  - [Dialogs](#dialogs)
  - [Library file browser](#library-file-browser)
  - [Timeline commands](#timeline-commands)
  - [Clip Editor](#clip-editor)
  - [Scratch Editor](#scratch-editor-shortcuts)
  - [Track effect automation](#track-effect-automation)
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
- [Continuous integration](#continuous-integration)
- [License](#license)

## Architecture

Silverdaw is a digital audio workstation built with a headless JUCE 8 audio engine and an Electron 42 + Vue 3 UI, linked by a local WebSocket bridge that is guarded by a token unique to each run.

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
  `std::atomic` (master clock, OffsetSource). A hosted plugin's own `processBlock` is the one
  exception, accepted as a bounded risk by ADR 0025; it relaxes nothing for our own code.
- **JUCE message thread**: owns every mutation of `AudioEngine`, `ProjectState`, the project
  `ValueTree`, and the audio source graph. The bridge marshals every incoming envelope onto this
  thread via `juce::MessageManager::callAsync`.
- **IXWebSocket I/O threads**: parse JSON, gate AUTH, then callAsync to the message thread.
- **Peaks worker pool**: `juce::ThreadPool` of 4 workers computes / loads waveform peaks off the
  message thread. Requests for the same source and resolution share one job, which writes the
  disk cache and emits a small `WAVEFORM_READY` envelope for every waiting clip.

## Project layout

```text
backend/                 JUCE audio engine + WebSocket bridge (C++17, CMake)
  src/
    core/                Entry point (Main.cpp), logging + always-on crash reporter
    bridge/              IXWebSocket loopback server, AUTH, message dispatch,
                         payload helpers, playhead emitter
    commands/            Per-domain bridge command handlers
    midi/                JSON-profile loader (MidiControllerProfiles) and MIDI
                         decoder + output encoder (MidiControllerMapping)
    engine/              Master transport clock, mixer / bus graph (incl.
                         equal-power pan), per-track audio sources, preview and
                         keep-alive. AudioEngine, BusGraph and OffsetSource each
                         use focused implementation units for their hot paths.
    dsp/                 Per-track DSP, shared Reverb / Delay, BPM + loudness,
                         waveform peaks, automation snapshots and per-stem
                         cleanup enhancers. Shared helpers centralise smoothing
                         and BPM analysis.
    stems/               ONNX stem-separation orchestration (RoFormer + htdemucs
                         backup, GPU→CPU fallback); invokes the enhancers in dsp/
    mixdown/             Offline render + export / normalise / dither on the
                         same canonical chain as playback
    project/             juce::ValueTree state + UndoManager, .silverdaw save /
                         load, ValueTree↔JSON converter, peaks cache, library
                         analysis and sample export
    scratch/             Scratch Editor domain: source/backing preparation,
                         session control, MIDI routing, recording, pattern
                         evaluator, save-as-sample bake
  resources/
    midi-mappings/       Controller model aliases and MIDI input/output bindings
  tests/                 SilverdawBackendTests custom harness (wired into CTest)
  CMakeLists.txt         FetchContent for JUCE + IXWebSocket
frontend/                Electron + Vue 3 app (TypeScript, electron-vite, pnpm)
  resources/icons/       Multi-resolution .ico + PNG set (consumed by main + renderer)
  src/
    main/                Electron main process (window, menu, IPC, prefs,
                         backend spawn + supervisor, diagnostics, autosave,
                         project paths and stem-model management)
    preload/             contextBridge surface exposed as window.silverdaw
    renderer/src/        Vue 3 SPA (Composition API, Pinia, PixiJS, Tailwind v4);
                         lib/ holds composables + audio/timeline/clip/midi/fx/
                         automation/transport/export/stems helpers, plus
                         lib/scratch/ (one composable per Scratch Editor
                         concern: session, pointer dispatch, record control,
                         transport, backing, notation, replay, save/reopen);
                         stores/ holds Pinia stores, including the scratch
                         session and pattern-persistence stores; components/
                         holds .vue files, including the Scratch* dialog,
                         platter, notation, and transport components
    shared/              Bridge wire-protocol facade (bridge-protocol.ts re-exports)
                         → bridge/inbound.ts (zod inbound schemas + guards)
                         → bridge/outbound.ts (outbound typed payload contracts)
                         inbound.ts also re-exports MIDI-specific schemas from
                         bridge/midi-inbound.ts
                         Plus ipc-channels.ts and types.ts (also TS-tested)
  tests/                 Vitest specs mirroring src/ (renderer, main, shared)
  e2e/                   Playwright journeys driving the built app against a
                         real backend (ADR 0014)
  electron-builder.yml   Windows packaging config (signed MSIX/AppX + portable zip)
  electron-builder.store.cjs  Store variant of the above (unsigned, Store identity)
scripts/                 Dev-shell / build / clang-tidy helpers (PowerShell)
.github/instructions/    Copilot/AI agent guidance per file type
```

Notable hot-path splits include `AudioEngineDevice.cpp`,
`AudioEngineTransport.cpp`, `AudioEngineAudibility.cpp`,
`AudioEngineMix.cpp`, `BusGraphRender.cpp`, `OffsetSourceWarpRender.cpp`, and
`OffsetSourceTailRender.cpp` under `engine/`, plus `ToneEq.cpp`, `SharedFx.cpp`,
`BpmAnalysisHelpers.cpp`, and `DspSmooth.h` under `dsp/`. These keep device,
transport, track audibility, rendering, effects, and analysis responsibilities
out of monolithic implementation files.

## Current status and roadmap

Silverdaw currently supports the core arrangement workflow:

- Import audio into a project-scoped library by dropping files onto the Library,
  using the panel's Import button, or choosing **File ▸ Import to Library…** /
  `Ctrl+I`; then drag library items onto the timeline. You can also drop an
  Explorer file directly onto an existing timeline track to import and place it.
  Dropping one file onto empty timeline space creates a fresh track for it, and
  dropping several files creates one new track per file at the drop position.
- The library panel's **Files** tab browses folders of audio on disk, showing
  each track's artwork, title, artist, album, type and length. Audition a file
  through your chosen audio device before importing it. Added folders are
  remembered between sessions and are the only paths the browser may read. See
  [File browser (Files tab)](#file-browser-files-tab).
- **File ▸ Import from Project…** lists saved projects from the configured
  project folder, then lets you select their managed stems and samples. A
  selected scratch sample also imports its linked Scratch pattern and original
  source-audio snapshot. Its Scratch Editor playback and waveform use that
  copied snapshot. The source project is read-only; imported items get
  independent destination assets and one undo step. Tracks, timeline clips,
  markers, automation, and settings are not imported.
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
- Extend a clip edge over an adjacent clip to create a transition. Right-click
  the resulting fade to choose the **Smooth** or **Fade out/in** recipe, or
  remove it; every change is undoable.
- Split a stereo clip's **Left** and/or **Right** channel onto its own new track
  (**Transform ▸ Split Stereo Channels…**); each channel becomes a stereo clip carrying
  only that side, inheriting the source's grid and warping like a stem.
- Move clips across tracks with grid snapping, source-beat snapping and `Alt` bypass.
- Loop-slice a timeline clip into adjacent clips or saved samples:
  **Transform ▸ Chop to Grid** (whole bar down to 1/32) for a quick grid chop, or open the Clip
  Editor's **Slice** mode for grid plus hand-placed markers.
- Analyse imported audio for key, BPM, beat positions and variable-tempo status.
- Non-destructive per-clip warp and pitch settings via Rubber Band. Dropped
  music auto-matches the project tempo by default, including variable-tempo
  sources using their detected representative BPM. Late auto-warp engages
  after BPM analysis if needed, and warped clips show a visible **WARP** badge
  or pending spinner on the timeline. The Timeline preference can disable
  automatic matching without removing per-clip warp controls.
- Resize any track row by dragging its bottom edge in the track-header column
  (clamped 120..400 px). Reorder tracks by grabbing the 6-dot grip icon next to
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
- **Track & project effects.** The bottom panel has five tabs — **Files**,
  **Library**, **Track FX**, **Plugins**, and **Project FX**. The per-track surfaces sit
  together: **Plugins** (the selected track's VST3 inserts, ADR 0025) follows **Track FX**,
  and **Project FX** comes last as the only project-wide one. The whole panel collapses / expands from its
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
  bit-exact passthrough; internal class `Leveler`), **Punch** (a stereo-linked
  transient shaper with one Amount control that smoothly lifts attacks; Amount 0 is a bit-exact
  bypass), **Saturation** (Drive and
  Mix controls for soft clipping; lower Drive settings add warmth, while the strongest effect is near
  100%; Drive 0 is a bit-exact bypass), and a
  **Bit Crusher** (Rate, Bits, Boost, and Mix controls for lo-fi digital
  reduction; Mix 0 is a bit-exact bypass), and a
  **Reverb & Delay** rack setting how much the track feeds the project-wide
  Reverb and Delay buses. **Project FX** hosts the
  shared, song-wide returns those amounts route into: a **Reverb** and a
  **Delay** (tempo-locked), a one-control **Glue Compressor**, plus a
  **Safety Limiter** switch. Glue Compressor processes the completed project bus after
  the shared Reverb and Delay returns and before master gain; Amount 0 is a
  bit-exact bypass and its automatic makeup gain is capped at 3 dB. The limiter
  is enabled by default and is a fixed -1 dBFS, stereo-linked sample-peak guard
  on final output; it is not a true-peak or mastering limiter. Delay Time
  uses direct 1/4, 1/8, 1/8T, and 1/16 beat-division buttons, and every Track
  FX and Project FX header offers a short hover explanation. All are edited
  live (slider drags coalesce into one undo step) and applied to both playback
  and mixdown. **Track FX** keeps five effect columns side-by-side:
  Tone, Saturation, and Bit Crusher occupy full-height columns; Filter sits
  above Reverb & Delay, and Compressor sits above Punch. Each retains the
  same share of the available panel width. The grid stops growing after
  `120rem`, so wider displays do not stretch the racks.
  **Project FX** modules wrap to the available panel width. Both panels scroll
  vertically rather than horizontally. The DSP lives in
  [`ToneEq`](../backend/src/dsp/ToneEq.h) / [`Leveler`](../backend/src/dsp/Leveler.h) /
  [`Punch`](../backend/src/dsp/Punch.h) /
  [`Saturation`](../backend/src/dsp/Saturation.h) /
  [`BitCrusher`](../backend/src/dsp/BitCrusher.h) /
  [`TrackChain`](../backend/src/dsp/TrackChain.h)
  / [`BusGraph`](../backend/src/engine/BusGraph.h) (which applies pan to the dry path
  after the pre-pan send tap) / [`SharedFx`](../backend/src/dsp/SharedFx.h) (the
  project-wide Reverb and Delay return buses). The open
  FX tab, selected track, timeline range, and its **Loop Selection** state are
  project **view state**, round-tripped through `PROJECT_SET_VIEW` and saved in
  the `.silverdaw` file alongside mute / solo.

  Beat Repeat regions are stored per track in beat space, so they follow project
  tempo changes. Right-click a clip or empty track lane and choose **Effects →
  Beat Repeat**, choose a `1/2`-beat, 1-beat, 2-beat, or 1-bar duration, then
  `1/4`, `1/8`, or `1/16`, to add a region at the beat-snapped playhead.
  Its first division of the mixed track is captured and repeated until the
  region ends. The same **Effects ▸ Beat Repeat** submenu removes a region under
  the pointer.
  Regions show as a sky overlay and the clip that owns a region carries a
  **REPEAT** badge. Ownership is by widest overlap: a region belongs to the one
  clip on that track it overlaps most, so a neighbouring clip whose tail runs a
  few milliseconds past the region's start beat is not badged, and the same
  attribution drives the region's removal entries in the context menu
  ([`beatRepeatAttribution.ts`](../frontend/src/renderer/src/lib/timeline/beatRepeatAttribution.ts)).
  Playback and mixdown use the same processor. A seek, timeline discontinuity,
  or region edit clears the capture so playback begins from fresh track audio
  instead of replaying an old slice. Older projects omit the optional region
  data and continue without Beat Repeat.
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
  playback and mixdown export. A clip edge with no explicit fade still gets a
  32-sample de-click ramp in `OffsetSource`, so a hard boundary never clicks.
  In the stereo waveform display the single
  envelope line is mirrored and kept in sync across both channel lanes —
  editing a breakpoint in either lane edits the one shared shape (the engine
  applies that shape equally to both channels).
- **Reverse clip.** A clip can be played back-to-front non-destructively. The
  flag is set from the timeline clip's **Effects ▸ Reverse** entry (a
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
  group with **Reverse**: in **both** the timeline **Effects** menu and the Clip
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
  to timeline** / **Slice to samples**); a timeline **Transform ▸ Chop to Grid**
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
- **Clip lock** (Ctrl+L or **Edit ▸ Lock / Unlock**) freezes a single
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
- **Timeline range playback** starts by dragging across the ruler away from the
  playhead. The range is shown across the ruler and track rows, snaps to the
  timeline grid by default, and supports `Alt` for exact pointer placement.
  Dragging the playhead keeps its established repositioning behavior. Play starts
  at the range beginning and pauses at its exclusive end, parking the playhead
  exactly on that end so the next Play replays the range from its start rather
  than resuming beyond it. Enable **Loop
  Selection** in the transport (or the `L` shortcut) to return to the beginning
  at that boundary while retaining shared Reverb and Delay tails; the engine owns
  that wrap, so the restart is seamless. Starting selected playback smoothly
  reveals its beginning when it is off-screen, from the Play button, the
  Spacebar, and MIDI alike. Dragging to either viewport edge
  auto-scrolls the timeline, so a range can be longer than the visible area, and
  completing that drag scrolls the playhead back into view. The
  **Skip** buttons, the `Ctrl + ←/→` shortcuts, and the MIDI cue buttons treat
  the range start as a temporary jump point without creating a saved marker.
  **Escape** clears the range and Loop Selection before stepping through clip,
  automation-point, and track selection. The range and loop state are saved as
  non-undoable project view state.
- **Edit ▸ Trim Project to Last Clip** collapses the project length to the end of
  the latest clip on any track. Manual project-length edits are also clamped so
  the ruler cannot be shortened below the longest clip's effective end. Project
  length is mirrored onto every track's `lengthMs`, so a newly created track
  adopts the current project length (`newTrackLengthMs`) rather than the
  5-minute default — otherwise Add Track, stem separation, or channel split
  would stretch a trimmed project back out. Reducing
  project length truncates a crossing timeline range, or clears a range whose
  start falls outside the new duration (also disabling Loop Selection).
- Save reusable saved clips to the library from any timeline clip; saved clips are
  grouped under their source file and can be dragged back to the timeline as a clip
  with the same source window. **Linked saved clips**: clips dropped from a saved clip
  library tile remember that link; the Clip Editor batches trim, warp and pitch edits
  into a single transactional draft and the **Save** button propagates them to every
  linked timeline instance in lockstep, unless a collision would result (in which
  case the user is prompted and the edit is rejected). Linked clips show a small
  chain badge in their title strip and are locked against edge-resize on the timeline
  — to free a single instance for per-clip trim use **Library ▸ Unlink from
  Library**. Removing a saved clip from the library is always allowed: every
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
- **Split Stereo Channels…** on a stereo timeline clip (**Transform ▸ Split
  Stereo Channels…**; hidden when the source isn't 2-channel) opens a Left/Right
  picker. Each chosen channel is
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
  collapses to a single undo step. An undo or redo that replaces the whole
  project state shows the OS busy cursor until the timeline has repainted, and
  carries the library's cached peaks, tags and cover art across the replace
  instead of re-decoding the audio, so undoing a large edit in a project with
  many unplaced library items doesn't stall scrolling.

Playback is always served from the decoded WAV cache; original compressed sources
(MP3, M4A, …) are only used to generate that cache. This keeps the read-ahead
buffer's latency-hiding contract intact at clip boundaries so back-to-back loops
play seamlessly. MP3 is decoded by the bundled LAME rather than by JUCE's own MP3
reader — see *Decoding compressed sources*.

The main remaining roadmap areas are region selection on timeline clips, library
search / tags / list view, and the
wider mixer / effects / automation work (a deeper per-clip processor chain
beyond the per-track Tone EQ + Filter, Compressor, Punch, Saturation, and Bit Crusher,
the project-wide Reverb and Delay sends, Glue Compressor, Safety Limiter, and Beat Repeat,
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

`PREVIEW_LOAD` is the one exception, and only for auditioning: it accepts an
optional absolute `filePath` that takes precedence over `libraryItemId`, so the
[file browser](#file-browser-files-tab) can play a file that has not been
imported and therefore has no library item. The backend rejects a path that is
not an existing file, and still resolves the decoded-WAV cache for it.

- `CLIP_ADD.requestWaveform` is optional and defaults to `true`. The renderer
  sends `false` only when a split, duplicate, or pasted clip already has complete
  waveform data inherited from a live source clip.
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

Track automation curves use `TRACK_SET_AUTOMATION { trackId, paramId, points }`.
Visible automation-lane layouts use
`TRACK_SET_AUTOMATION_LANE_VIEW { trackId, lanes: [{ paramId, heightPx }] }`.
Both are persisted in the project and returned in `PROJECT_STATE`.

Cross-project import uses `PROJECT_IMPORT_SOURCE_INSPECT` to request a compact
`PROJECT_IMPORT_SOURCE_MANIFEST`, then `PROJECT_IMPORT_ASSETS` with only the
selected managed-library item IDs. Selecting a scratch sample automatically
includes its linked pattern and source snapshot. `PROJECT_IMPORT_COMPLETED`
reports the result. Audio and metadata remain disk-resident; the source project
is never written.

**Bulk data goes via disk, never via the socket.** When the backend has fresh waveform peaks
ready it sends a `WAVEFORM_READY { clipId, cachePath, peakCount, peaksPerSecond, sampleRate, laneCount }`
envelope. The cache file at `cachePath` (under `%APPDATA%/Silverdaw/peaks/`) holds the peaks
themselves; the renderer reads it via main's `peaks:readCacheFile` IPC and parses the 28-byte
header + float32 payload locally. This mirrors how the same architecture treats audio files,
project files, stems and mixdowns — the WebSocket carries the control plane, the
filesystem carries bulk data. Keeps the IXWebSocket I/O loop on the lightweight text-only path
it was designed for. `WAVEFORM_FAILED { clipId, error }` triggers renderer-side decoding as a
recovery path when the backend cannot produce peaks.

When a saved scratch reopens from its self-contained source snapshot, the
backend also sends `SCRATCH_SOURCE_PEAKS_READY { sessionId, cachePath,
peakCount, peaksPerSecond, sampleRate }`. Its peaks use the same cache-file
format and IPC path as `WAVEFORM_READY`, but remain scoped to that Scratch
Editor session so the rendered library sample keeps its own waveform.

The full envelope catalogue lives in
[`frontend/src/shared/bridge-protocol.ts`](../frontend/src/shared/bridge-protocol.ts),
which is a **re-export facade** — it `export *`s from
[`frontend/src/shared/bridge/inbound.ts`](../frontend/src/shared/bridge/inbound.ts)
(the canonical owner of all inbound `zod` schemas and `isXxxPayload` guards) and
[`frontend/src/shared/bridge/outbound.ts`](../frontend/src/shared/bridge/outbound.ts)
(the canonical owner of all outbound typed payload interfaces and the
`BridgeOutboundMap` index).
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

Beat Repeat uses `TRACK_BEAT_REPEAT_ADD { trackId, startBeat, lengthBeats,
division }` and `TRACK_BEAT_REPEAT_DELETE { trackId, regionId }`. The backend
validates the non-overlapping per-track regions, publishes the updated
`PROJECT_STATE`, and includes each region in its track's optional `beatRepeats`
array. Valid divisions are `1/4`, `1/8`, and `1/16`.

Track FX uses `TRACK_SET_TONE`, `TRACK_SET_LEVELER`, `TRACK_SET_PUNCH`,
`TRACK_SET_SATURATION`, `TRACK_SET_BIT_CRUSHER`, and `TRACK_SET_SENDS`. The
backend clamps and persists each effect value, publishes it to live audio, and
reconciles the renderer with the matching `TRACK_*_APPLIED` acknowledgement.
Project FX uses `PROJECT_SET_REVERB`, `PROJECT_SET_DELAY`,
`PROJECT_SET_MIX_GLUE`, and `PROJECT_SET_SAFETY_LIMITER`; Reverb, Delay, and
Glue Compressor similarly return canonical `PROJECT_*_APPLIED` state.

VST3 inserts (ADR 0025) use `PLUGIN_LIST_REQUEST` (no payload) and `PLUGIN_SCAN
{ clearBlacklist? }`, answered by `PLUGIN_LIST { plugins, blacklisted, scanning }`
and, while a scan runs, a stream of `PLUGIN_SCAN_PROGRESS { currentFile, scanned,
total, finished? }`. Because a scan runs on its own thread, its callbacks hop back
to the message thread before touching the bridge. Chain edits are
`TRACK_ADD_PLUGIN { trackId, identifier }`, `TRACK_REMOVE_PLUGIN`,
`TRACK_REORDER_PLUGIN { …, index }`, `TRACK_SET_PLUGIN_BYPASS { …, bypassed }` and
`TRACK_OPEN_PLUGIN_EDITOR`, all keyed by the backend-minted `slotId`; each mutates
the project tree *and* the live chain. Add, remove and reorder then republish
`PROJECT_STATE`, where a track's inserts appear in chain order in its optional
`plugins` array — only a whole snapshot is self-consistent when the backend has
minted a `slotId` or clamped chain order. Bypass instead acks narrowly with
`TRACK_PLUGIN_BYPASS_APPLIED { trackId, slotId, bypassed, ok }`, because it can
change neither, and re-sending every track and clip to flip one boolean made the
renderer repaint the whole timeline on each click — dropped frames in the middle
of playback. The renderer still applies only what the backend reports, so the panel
stays non-optimistic; `ok: false` means the slot had gone, and the mirror is left
untouched. Two things
deliberately never cross the bridge: a plugin's opaque **state chunk** (ADR 0003 —
it is stored inline in the project file and nowhere else) and any plugin UI, which
the backend draws in its own native window. A slot flagged `unresolved` names a
plugin that is not installed on *this* machine; the flag is derived per broadcast
from the catalogue and is never written to the project file.

`PLUGIN_NOTICE` carries strings written **for the user** and shown verbatim,
which is why it is not `ENGINE_ERROR` — that reports a raw handler fault behind
a fixed, generic toast, so anything routed through it loses its wording. What
Silverdaw does and does not accept, and what each notice means, is set out under
[VST3 plugins](#vst3-plugins).

`restoreTrackPlugins` (`backend/src/engine/TrackPluginRestore.cpp`) is shared by
project load, undo/redo rebuilds and offline render. It keeps a live instance
whenever the slot id and identifier still match, because a saved state chunk is
only refreshed on save — reloading unconditionally would reset a plugin to its
last-saved settings as a side effect of an unrelated undo. Slots it *will*
destroy are reported through its `onSlotDestroyed` callback first, which the
engine uses to close the editor window whose content the instance owns.

Hosted plugins share one read-only `plugins::PluginPlayHead`, so tempo-synced
effects follow the transport. It does not mirror the transport — it holds
pointers to the engine's own position, sample-rate and play-state atomics, so a
plugin cannot drift from what the renderer is rendering; the mixdown builds an
equivalent play head over the offline position for export parity. Plugin
latency is **compensated** (ADR 0026): `BusGraph` delays every track to the
largest chain latency in the project, so nothing shifts against its siblings,
and the residual constant is folded into the reported playhead and trimmed
from the mixdown. The fixed 4/4 is not a limit — 4/4 is the app's assumption
throughout, stated once as `BEATS_PER_BAR` in `shared/snapGrid.ts`, so the play
head states it rather than guessing it.

A few envelopes exist purely for liveness and fault reporting rather than
project edits: `PING` (renderer → backend) and `PONG` (backend → renderer) form
a liveness probe — the backend answers `PONG` **on the JUCE message thread**, so
a completed round-trip proves the command thread itself is responsive, not merely
that the socket is open — and `ENGINE_ERROR` (backend → renderer) reports a
handler-level fault that the engine **caught and survived**. Their behaviour and
the recovery UX they drive are described under
[Engine resilience and recovery](#engine-resilience-and-recovery).

The MIDI control path uses eight domain envelopes:

- `MIDI_DEVICES_REQUEST` asks the backend to enumerate connected inputs.
- `MIDI_INPUTS_SET { identifiers }` replaces the set of enabled inputs. The
  backend ignores identifiers whose device names do not match a supported
  profile.
- `MIDI_DECK_SELECTION_SET` restores the enabled state of physical decks 1 and
  2 for one input. On startup a device with a saved (cue-set) selection restores
  it; a device with none instead auto-selects per its **Default deck**
  preference (see below).
- `MIDI_DEVICES_LIST` reports every detected input with its identifier,
  connection/enabled state, recognised profile label, and latest activity.
- `MIDI_MESSAGE` carries a rate-limited raw-message sample for the MIDI Monitor.
- `MIDI_CONTROL` carries one decoded semantic button, relative, or absolute
  controller action.
- `MIDI_DECK_SELECTION` reports a physical deck-selection change made from the
  controller.
- `MIDI_SCRATCH_SETTINGS_SET` applies per-device scratch-audio and crossfader
  preferences.

The Scratch Editor adds its own domain of envelopes (full schemas in
[`frontend/src/shared/bridge/scratch.ts`](../frontend/src/shared/bridge/scratch.ts);
every payload carries `protocolVersion: 1`). Renderer → backend:

- `SCRATCH_SESSION_OPEN { clipId? | libraryItemId? }` opens a session for exactly
  one target (a timeline clip or a library item).
- `SCRATCH_SESSION_CLOSE { sessionId }` tears the session down.
- `SCRATCH_SESSION_CONTROL { sessionId, action, … }` carries one control action:
  `play` / `pause`, `recordArm` / `recordDisarm` / `recordStart` / `recordStop`,
  `seek { positionUs }`, `platterMove { deck, deltaTurns }`,
  `platterTouch { deck, touched }`, `crossfader { value 0..1 }`, the
  monitor-only `backingGain { value 0..1 }` / `scratchGain { value 0..1 }` trims,
  and `backingLoop { enabled }` (auto-restart the bed at its end; off by default).
- `SCRATCH_BACKING_PREPARE { sessionId, trackIds, startAnchor, durationSec }`
  (anchor `arrangement` | `playhead`; duration `60` | `120` | `0` where `0` means
  the full arrangement from the anchor to the last clip end) and
  `SCRATCH_BACKING_CLEAR { sessionId }` manage the backing monitor.
- `SCRATCH_PATTERN_SAVE` / `_DELETE` / `_RENAME` / `_APPLY` (to a clip) /
  `_REMOVE` (from a clip) manage saved patterns, and
  `SCRATCH_PATTERN_REPLAY_START` / `_STOP` audition a stored pattern.
- `SCRATCH_SAVE_AS_SAMPLE { sessionId, itemId, sampleName, sourceItemId?,
  sourceInMs?, sourceDurationMs?, pattern }` bakes the pattern over the
  prepared source into a library sample. `itemId` is a fresh id for a new
  scratch or an existing scratch-origin item's id to re-save in place;
  `sourceItemId` carries the source library item's cover art forward, and
  `sourceInMs` / `sourceDurationMs` are the exact source window the scratch was
  performed over, persisted so re-opening shows the original context. The
  backend answers with the existing `SAMPLE_SAVED` and `PROJECT_STATE`
  envelopes rather than a scratch-specific reply.

Backend → renderer:

- `SCRATCH_SESSION_STATE` is the throttled (up to half the 60 Hz
  playhead-timer rate, ~30 Hz), display-only session snapshot — `status`,
  `preparationProgress`, `positionUs` / `durationUs`,
  `platterTurns`, `playbackRate`, `crossfader`, `crossfaderReversed`, deck
  ownership, `armed`, and the
  backing/monitor fields (`backingStatus`, `backingDurationUs`, `backingPositionUs`,
  `backingLoop`, `backingGain`, `scratchMonitorGain`). It never drives audio timing.
- `SCRATCH_PATTERN_RECORDED { sessionId, pattern }` delivers the completed,
  possibly simplified action pattern after a recording stops.
- `SCRATCH_SOURCE_PEAKS_READY { sessionId, cachePath, peakCount,
  peaksPerSecond, sampleRate }` points a reopened saved scratch at the
  disk-backed peaks for its prepared source snapshot. The renderer uses it only
  for the matching Scratch Editor session.

Bulk scratch and backing audio never crosses the socket — prepared sources are
written through the disk/cache boundary exactly like clip audio and peaks.

Recording adds a smaller domain (full schemas in
[`frontend/src/shared/bridge/recording.ts`](../frontend/src/shared/bridge/recording.ts);
every payload carries `protocolVersion: 1`). Renderer → backend:

- `RECORD_INPUTS_REQUEST` asks for the capture devices; `RECORD_SESSION_OPEN
  { input? }` opens the one recording session, optionally on a remembered
  device, and `RECORD_SESSION_CLOSE { sessionId }` tears it down — discarding an
  uncommitted recording and aborting one still rolling.
- `RECORD_SESSION_CONTROL { sessionId, action, … }` carries one action:
  `selectInput { input }`, `selectChannels { firstChannel, channelCount }`,
  `setCountInBars { bars }`, `setInputGain { gainDb }`, `setWindowMode { mode }`,
  `start`, `stop`, and `discard` (Record Again). `setInputGain` is the only
  action accepted while rolling. There is deliberately no monitoring action.
- `RECORD_RECORDING_COMMIT { sessionId, recordingId, itemId, name, destination,
  trackId?, clipId? }` keeps the finished recording as a library item, and for
  `destination: "timeline"` places a clip at its anchor in the same undo
  transaction.

Backend → renderer:

- `RECORD_INPUTS_LIST` enumerates devices grouped by driver type.
- `RECORD_SESSION_STATE` is the session snapshot — `status`, the `input` as it
  actually resolved, channel selection, `countInBars`, `inputGainDb`,
  `windowMode`,
  `hasSelection`, `anchorMs` / `windowEndMs`, `recordedMs`, `droppedSamples` and
  any `errorCode` / `error`.
- `RECORD_INPUT_LEVEL { peakL, peakR }` meters the input at ~30 Hz, always, and
  is excluded from bridge logging.
- `RECORD_RECORDING_READY` announces the finished file by **path** with its
  peaks cache, anchor, tempo and the corrections applied (`latencyOffsetMs`,
  `driftPpm`). Recorded audio never crosses the socket.
- A commit is acknowledged by the existing `SAMPLE_SAVED` envelope, correlated
  by the renderer-generated `itemId`, for both success and failure.

## VST3 plugins

Silverdaw hosts **VST3 effect plugins that process stereo audio**, as per-track
inserts. Everything outside that sentence is unsupported, and ADR 0025 is the
binding scope. Support is enforced in three layers that behave differently, and
the difference matters when diagnosing a report:

| Requirement | How it is enforced | What the user sees |
| --- | --- | --- |
| VST3 format | Compile time — `JUCE_PLUGINHOST_VST=0`, `AU=0`, `LV2=0`, `ARA=0` (`backend/CMakeLists.txt`) | VST2, AU, LV2 and CLAP plugins are never scanned, so they never appear |
| Effect, not instrument | Rejected at add (`PluginCommands.cpp`, `description->isInstrument`) and filtered from the picker | "…is an instrument, and Silverdaw currently hosts effect plugins only." |
| Audio only — no MIDI, no side-chain | **Not blocked.** Detected after `prepare` and reported | `PLUGIN_NOTICE` naming what is missing |

That third row is the one that surprises people. A plugin's declared category
does not decide it: a MIDI-driven vocoder typically declares itself an `Fx` with
`isInstrument="0"`, so it passes both blocking checks, loads, prepares, and
runs — and then outputs little or nothing, because `PluginSlot::process` clears
`midiScratch` before every `processBlock` and `negotiateStereoLayout` pads any
input bus the plugin refuses to disable with silence. The plugin is behaving
correctly on the inputs it is given; it simply is not given a carrier.

So `PluginSlot::prepare` logs the negotiated layout (`in`, `out`, `acceptsMidi`,
`latency`), and `TRACK_ADD_PLUGIN` answers with `PLUGIN_NOTICE` whenever the
prepared slot reports more than two input channels or accepts MIDI. Read the
**prepared** slot, never the scanned description — the channel count that
matters is the one bus negotiation actually settled on.

### Limitations

Behaviours to state plainly rather than let a user discover:

- **Effects only.** Instruments are rejected outright.
- **No MIDI to plugins and no side-chain input**, permanently and by design.
  See ADR 0025 §Scope before proposing either — the reasoning covers why each
  is a large change, not an oversight.
- **No plugin-parameter automation.** Track-parameter automation does not
  extend to plugin parameters; that needs a dynamic replacement for the fixed
  `AutomationParam` enum and is a decision of its own.
- **Per-track inserts only.** There is no project-wide, master or per-clip
  plugin slot.
- **Latency compensation is bounded at one second**
  (`kMaxLatencyCompensationSeconds`). A plugin reporting more is treated as
  misreporting and clamped rather than allowed to desync the project (ADR 0026).
- **No cap on chain length**, but each insert costs CPU on the audio thread and
  may add latency that every other track is then delayed to match.
- **Hosting is in-process.** A plugin that crashes takes the engine with it.
  That is a recoverable event under ADR 0008 — the supervisor respawns the
  backend and the recovery coordinator reloads the project — but it is a visible
  interruption, unlike a scanner crash.
- **A missing plugin is preserved, not dropped.** The slot keeps its position
  and saved state, passes audio through untouched, and is written back on save
  (ADR 0019). Opening a project that references one raises a single
  `PLUGIN_NOTICE` naming each missing plugin once, because unlike a missing
  audio file — which is visibly broken on the timeline — an insert that has
  quietly stopped processing is otherwise only discoverable by selecting that
  track and opening the Plugins panel.

### Where plugins are found

Scanning searches the two locations the VST3 specification defines on Windows,
and nothing else:

| Scope | Path |
| --- | --- |
| Per user | `%LOCALAPPDATA%\Programs\Common\VST3` |
| Machine-wide | `C:\Program Files\Common Files\VST3` |

These come from JUCE's `VST3PluginFormat::getDefaultLocationsToSearch()`, which
Silverdaw passes to `PluginCatalogue::startScan` unmodified. There is
deliberately **no preference for adding folders**: both paths are the standard
every VST3 installer targets by default, so a configurable search path would add
a setting that almost nobody needs and give a support burden — a plugin "missing"
because it was installed somewhere non-standard — to everybody. A plugin
installed outside them is not found; the fix is to install it to a standard
location, not to point Silverdaw elsewhere.

Note the paths are read at scan time, not cached, so a plugin installed while
Silverdaw is running is picked up by the next **Scan for plugins**.

### Catalogue storage

The catalogue is machine-scoped, not project-scoped, and lives in
`%APPDATA%/Silverdaw/plugins/`: `known-plugins.xml` holds the scanned
descriptions and the blacklist, and `scan-crashes.txt` is JUCE's dead-man's
pedal — the file a scan writes before loading a plugin so a crash can be
attributed to it. Both are replayed at the start of every scan, which is why
**Clear blacklist** deletes the pedal file as well as clearing the list; leaving
it would let the next scan restore what was just cleared. Deleting the folder
loses only the scan results, and the next scan rebuilds it. Scanning runs the
backend binary again as a child worker, and that worker is reused across files —
it is replaced only when a plugin kills it, so isolation is "out of the engine
process", not one process per plugin.

A scan **reconciles** the cache rather than only adding to it. JUCE's
`KnownPluginList` never removes anything, so a plugin uninstalled from the
machine would otherwise stay in the picker forever, offering the user something
that can no longer load. `PluginCatalogue::removeUninstalledPlugins` therefore
drops every cached entry whose binary has gone, and runs **at load as well as
after a scan** — at load the user has not asked for anything, so a plugin
uninstalled between runs is gone from the picker immediately instead of lingering
until someone thinks to rescan. It is affordable there precisely because it is
not a scan: it asks the filesystem whether each cached path still exists and
never loads or instantiates a binary, so it adds nothing measurable to startup,
unlike a real scan which runs a child process over every plugin and takes
minutes. The result is written back only when something actually went, so a
normal launch does no extra disk work.

Existence is the only test applied, which is sound precisely because the search
paths are two fixed local folders — a path that has gone really has gone, rather
than being a removable drive that happens to be unplugged; cached entries whose
identifier is not an absolute path are left alone rather than guessed at. A
project still using a dropped plugin is unaffected: the slot becomes
`unresolved`, keeps its position and saved state, and is written back on save
(ADR 0019).

## MIDI controller architecture

MIDI support is model-specific and data-driven. The canonical user-facing
device and capability matrix is
[MIDI deck controllers](midi-controllers.md); the JSON schema is documented in
[`backend/resources/midi-mappings/README.md`](../backend/resources/midi-mappings/README.md).

The source profiles live in
`backend/resources/midi-mappings/*.json`. CMake copies them to a
`midi-mappings` directory beside the backend executable, which is the runtime
location loaded by packaged builds. Development runs fall back to the source
directory when that copied directory is unavailable. Profiles are validated for
types, value ranges, model-name conflicts, and overlapping input bindings.
Device matching is case-insensitive, uses token boundaries, honours
`excludedModels`, and selects the longest matching model name.

`MidiInputMonitor` owns connected inputs:

- Enumeration reports all MIDI inputs, including unsupported ones.
- `MIDI_INPUTS_SET` opens only inputs recognised by
  `supportsMidiControllerMapping`; the same allowlist is enforced in the UI and
  backend.
- JUCE's MIDI callback writes raw short messages into a preallocated
  512-message `AbstractFifo` per input. A 60 Hz JUCE message-thread timer drains
  it and decodes profile bindings. Button and absolute messages broadcast
  semantic `MIDI_CONTROL` messages immediately; jog/relative movement instead
  accumulates per deck and flushes its `MIDI_CONTROL` UI-feedback broadcast on
  its own ~30 Hz throttle (33 ms) so heavy scratching cannot flood the bridge —
  when a scratch session is active, the underlying scratch audio target still
  follows every message immediately and is unaffected by this visual-echo
  throttle. JSON parsing and allocation never occur in the MIDI callback.
  Overflow (the callback outrunning the drain) increments an atomic per-input
  dropped-message counter that the same timer reads and logs each tick, giving
  observable back-pressure instead of silent loss or blocking the callback.
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
animation-frame coalesced; normal movement is free, Shift moves faster, and a
held Sync modifier snaps movement to timeline grid lines. Touching an enabled
jog platter while playing pauses the backend without clearing renderer play
intent. Movement while held sends short directional scrub grains through the
audio output without advancing normal transport playback unless that device's
saved scrub-audio preference is off. Per-device MIDI preferences are keyed by
the Windows/JUCE identifier and retain the selected crossfader direction and a
**Default deck** (`none` / `deck1` / `deck2`, default `none`). The Default deck
sets which deck is auto-selected when the application starts, but only for a
device that has no saved cue selection; once running, the headphone-Cue button
changes the live selection without altering the preference, and that cue change
persists and takes precedence on the next startup.
The final platter release resumes playback, while an explicit pause cancels
that resume. Browse controls switch between track selection, clip
selection/range extension, and Shift-modified timeline zoom; clockwise zooms
in and anticlockwise zooms out.
Absolute channel faders, Tone EQ, and Filter target the currently selected
track, with a short catch-up transition when hardware and software positions
differ. Master volume is applied to the project. Crossfader input is retained
as controller telemetry but does not currently alter the audible mix.

While a modal or editor dialog owns input (clip editor, scratch editor, or any
other blocking dialog) the renderer's translation of `MIDI_CONTROL` into
ordinary timeline actions is otherwise inert, but the **master volume passes
through** so the main output level can still be ridden from the deck while
working in an editor. Every other control stays blocked and pending jog/dial
actions are suspended for the duration. This gate does not apply to the
[Scratch Editor](#scratch-editor)'s own eligible controls (platter, crossfader,
Play): the backend routes their raw MIDI directly into the scratch session
instead, independently of this renderer-side dispatch.

If a profile defines output bindings, the backend opens one unambiguous MIDI
output whose name matches the input. It can then send selected-track meters,
Play/Cue state, active-deck state, and marker-pad lights. Missing output
feedback does not prevent controller input.

The instant a controller is enabled the backend sends the profile's
connect-time **init frames** (see below), blanks every LED (meter, Play,
Cue, hot-cue pads and the deck-selection lights) with a reset burst, then holds
a short **warm-up window** (`kFeedbackWarmupMs`, 2 s) during which the 60 Hz
playhead emitter re-asserts authoritative LED state every tick — bypassing its
per-value dedupe guard — and the input monitor re-sends the deck-selection
lights. A single connect-time burst is unreliable on its own: a controller can
be mid power-on animation or in its idle demo/standby light show, and a
freshly opened Windows MIDI OUT port may drop the first messages. The sustained
host-output stream lands the blank (or authoritative) state once the port is
ready. The dedupe caches are left invalidated (`-1`) after reset rather than
seeded to `0`, so a dropped burst is still corrected on the emitter's next tick
even outside the warm-up window.
Cue and hot-cue pads are deliberately left dark by this reset — they are only
lit once a project is loaded, when the playhead emitter reasserts them from the
project's marker state (so a controller connected at the project picker shows no
stale cue lights).

Some controllers (notably Pioneer decks) ignore ordinary Note/CC LED writes
while in their power-on demo/standby state and only leave it when they receive a
specific "software connected" handshake — so re-sending LED messages cannot wake
them. A profile may therefore declare an optional **`init`** array of raw MIDI
frames sent once, immediately after the input starts, straight to the output
port. Each frame is a complete MIDI message given as decimal byte values — a
short message (e.g. `[155, 9, 127]`, the Pioneer DDJ-RB/SB2 "request the knob and
fader positions" message that also ends demo mode) or a full SysEx frame
(`[240, …, 247]`). Init frames serve two purposes: waking the controller out of
demo/standby, and requesting the current positions of its physical controls so
the mapped inputs adopt the hardware state on connect. The frames are sourced
verbatim from each controller's Mixxx mapping (`res/controllers/` in
`mixxxdj/mixxx`), the authoritative reference for deck protocols. They are sent
after `input->start()` so the controller's position-report replies are captured
rather than dropped.

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

### Renderer connection and liveness

The backend only pushes data while playing, so an idle session has no inbound
traffic to prove the engine's message thread is still alive.
[`bridgeService.ts`](../frontend/src/renderer/src/lib/bridgeService.ts) runs a
bounded 100 ms retry cadence while waiting for its first socket connection.
After ten attempts, or after any successful connection, retries use a 1–5 s
exponential backoff so sustained failures do not cause continuous connection
attempts. The same recovery backoff applies to later connection losses.

The bridge also runs a watchdog that, after a quiet spell
(`WATCHDOG_IDLE_MS`, 3 s), sends a `PING` and
expects a `PONG` answered on the JUCE message thread. `WATCHDOG_MAX_MISSED` (3)
consecutive missed replies (each timed out after `WATCHDOG_PONG_TIMEOUT_MS`, 2 s)
declare the engine hung and trigger a supervised restart via `restartBackend`.
The probe is suppressed when the engine is legitimately busy — during playback
(`PLAYHEAD_UPDATE` already proves liveness) and during known-heavy work such as
library import or BPM analysis — to avoid false restarts. A large positive clock
drift (`WATCHDOG_DRIFT_MS`, 4 s) is read as an OS sleep/resume and resets the
watchdog rather than counting the gap as missed pongs. In practice this surfaces
a wedged engine within roughly 7–11 s.

The startup screen has one 500 ms minimum loading dwell. During that dwell it
coalesces backend status changes, then displays only the current status if
startup is still in progress. Completed phases do not add separate delays.

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
timeout, `BRIDGE_CONNECTION_TIMEOUT_MS`, 60 s). Because a hard fault during
startup (e.g. an access violation deep in a WASAPI/COM audio driver while
enumerating devices) happens *before* the bridge is listening — and MSVC's
default `/EHsc` means the top-level `try` / `catch` in `main()` cannot catch a
structured (SEH) exception — such a failure would otherwise leave no trace,
especially on a machine we can't attach to (a clean install, a Store
certification VM). Two always-on mechanisms guarantee a diagnosable artifact,
**independent of the Preferences ▸ Developer diagnostic-logging toggle**:

The verbose application-log directory is configured separately in
**Preferences ▸ Developer**. When diagnostic logging is enabled, its default is
`%USERPROFILE%\Silverdaw\Logs`, and each run gets its own ISO-timestamped
subfolder holding `main.log` (Electron main), `renderer.log` (the UI), and
`backend.log` (the audio engine) — the first place to look when reproducing a
user-reported problem. **Help ▸ Send Diagnostic Logs** zips the current run's
folder alongside the always-on diagnostics below.

- **Diagnostics directory.** Electron main always creates a diagnostics
  directory on launch (packaged and development builds:
  `%USERPROFILE%\Silverdaw\Diagnostics`, a discoverable non-virtualised
  location — under MSIX a `userData`/`%APPDATA%` path is silently redirected
  into a hidden package container) and passes it to the backend as
  `SILVERDAW_DIAG_DIR` on every spawn — distinct from
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
        viewSelectedTrack?, viewFxPanelOpen?, viewFxTab?,
        audioOutputTypeName?, audioOutputDeviceName?, targetSampleRate?,
        masterVolume?, exportSettingsJson?, barCounterStart?, mixdownStartBar?,
        metronomeEnabled?, clipEditorMetronomeEnabled?,
        safetyLimiterEnabled?, mixGlueAmount?,
        reverbSize?, reverbDecay?, reverbTone?, reverbMix?,
        delayNoteValue?, delayFeedback?, delayTone?, delayMix?,
        scratchPatterns?]
  TRACK[id, name, gain, heightPx?, muted?, soloed?,
        colorIndex?, toneBassDb?, toneMidDb?, toneTrebleDb?, toneFilter?,
        sendReverb?, sendDelay?, pan?, levelerAmount?, punchAmount?, saturationDrive?, saturationMix?,
        bitCrusherRate?, bitCrusherBits?, bitCrusherBoost?, bitCrusherMix?,
        automation?, automationLaneView?, transitions?]
    BEAT_REPEAT[id, startBeat, lengthBeats, division]*
    CLIP[id, libraryItemId, offsetMs, inMs, durationMs, colorIndex?, clipName?,
         locked?, reversed?, brake?, backspin?, beatOffsetMs?,
         warpEnabled?, warpMode?, tempoRatio?, semitones?, cents?, pendingAutoWarp?,
         envelopePoints?,
         effectiveDurationMs?, effectiveTempoRatio?, effectiveWarpActive?,
         scratchPatternId?]
  LIBRARY
     ITEM[id, kind, filePath, fileName?, displayName?, durationMs,
          sampleRate, channelCount, key?, bpm?, beats?, beatAnchorSec?,
          playbackFilePath?, variableTempo?, lowConfidence?, audioType?, collapsed?,
          mediaId?, coverArtHidden?, coverArtOverride?, unresolved?,
          sourceItemId?, sourceClipId?, sourceInMs?, sourceDurationMs?,
          scratchOrigin?, scratchPatternId?, scratchSourcePath?,
          warpEnabled?, warpMode?, tempoRatio?, semitones?, cents?]
  MARKERS
    MARKER[id, positionMs]
```

`CLIP` references the audio it plays via `libraryItemId`; the underlying source file path
lives only on the library item. `offsetMs` is the timeline start, `inMs` is where in the
source file playback begins, and `durationMs` is how long the clip plays for from
that point. `inMs` is normally ≥ 0 but is **deliberately unclamped**: a beat-grid slide
can pull the window off the front of the file, and a window that overhangs either end
renders as silence rather than the edit being refused or the audio being shunted (see
[Beat markers and source-beat snap](#beat-markers-and-source-beat-snap)). Split,
duplicate and edge-drag trim all manipulate this window without ever
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
on a linked clip (timeline **Effects** menu or Clip-Editor Save) routes through
`library.updateLibraryClipBrake` / `updateLibraryClipBackspin`, which fans the flag
out to every linked timeline instance; an unlinked clip is set directly. Their
global duration / curve / intensity defaults are
pushed to the engine with `BRAKE_SETTINGS_SET` / `BACKSPIN_SETTINGS_SET`. The
Clip Editor auditions them live on the preview voice via `PREVIEW_SET_BRAKE` /
`PREVIEW_SET_BACKSPIN`. Both flags are
suppressed from save when off and round-trip through `PROJECT_STATE` and the
`.silverdaw` file.

`CLIP.beatOffsetMs` is an optional number (absent == 0) holding **this clip's beat-grid
phase**, in source milliseconds, added to the library item's anchor. Beat *spacing* stays
source-global — a file has exactly one tempo (ADR 0024) — but phase is per clip, because a
split makes two independent clips and on variable-tempo material the correct position of
beat one genuinely differs between them. Correcting one clip's grid used to rewrite the
shared library-item anchor, which moved the markers on every other clip cut from that file
while they sat perfectly still. It is set via `CLIP_SET_BEAT_OFFSET { clipId, beatOffsetMs }`,
suppressed from save when zero, and round-trips through `PROJECT_STATE` and the `.silverdaw`
file. The grid is drawn by the renderer only, so the engine stores and replays the value
but never reads it. A project saved before 1.7.1 simply has no offset and resolves to the
unshifted source grid (ADR 0019).

**How a split divides these properties.** `splitClipAt` cuts one clip in two at
a timeline position, and each per-clip property above has to land on the correct
half. Reverse plays the source window back-to-front, so the timeline-*left* half
is the *tail* of that window: the split mirrors its trim math instead of mapping
both halves forwards, and replays `CLIP_SET_REVERSED` onto the new right half.
`brake` and `backspin` fire at a clip's end, so they transfer to the right half
and are cleared from the left, keeping exactly one tail effect at the end of the
original clip's audio. `envelopePoints` are re-mapped onto both halves by
`splitEnvelopeAtMs`, which pins a shared breakpoint at the seam sampled from the
original curve and re-bases the right half to its own zero; the envelope's axis
is elapsed playback time from the clip start, so it splits on the timeline axis
regardless of reverse. `beatOffsetMs` is **inherited by both halves**, so the markers do
not move across the seam; from then on each half owns its phase, and correcting one
cannot disturb the other. Duplicate and paste inherit it the same way. `locked` needs no
handling — a locked clip refuses the split outright.

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
bypassed). `punchAmount` is the stereo-linked transient boost amount in `[0, 1]`
(`0` = bypassed). `saturationDrive` and `saturationMix` are `[0, 1]`: Drive defaults
to `0` (off), Mix defaults to `1` (fully wet), and both are suppressed from
save at their defaults. `bitCrusherRate` is a `[0.01, 1]` sample-rate ratio,
`bitCrusherBits` is an integer in `[1, 16]`, and `bitCrusherBoost` /
`bitCrusherMix` are `[0, 1]`; their defaults are Rate `1`, Bits `16`, Boost
`0`, and Mix `0`. The shared buses themselves live on the `PROJECT` node:
`reverbSize` / `reverbDecay` / `reverbTone` / `reverbMix` describe the single
project **Reverb**, and `delayNoteValue` / `delayFeedback` / `delayTone` /
`delayMix` the project **Delay** (tempo-locked). `mixGlueAmount` controls the
project-bus compressor (`0..1`; absent or zero is a bit-exact bypass).
`safetyLimiterEnabled` enables the final fixed `-1 dBFS` sample-peak guard.
When persisted, `delayNoteValue` is one of `1/4`, `1/8`, `1/8T`, or `1/16`;
these values map directly to the Delay Time buttons, and an absent legacy value
defaults to `1/8`.
Each `TRACK` can also have optional `BEAT_REPEAT` children: `{ id, startBeat,
lengthBeats, division }` regions stored
in beat space; older projects simply have none. `CLIP.envelopePoints` is
an optional `{ timeMs, gain }` breakpoint array — the per-clip **Volume Shape**;
`gain` is linear in `[0, 4]` (`1.0` = unity) and the property is normalised
(sorted, clamped, de-duplicated) backend-side and removed entirely when the
shape is cleared. `viewSelectedTrack` / `viewFxPanelOpen` / `viewFxTab` are view
state for the bottom-panel FX tabs — the tab is stored opaquely, like the snap
grid, so a value a build does not recognise falls back to Track FX rather than
rejecting the snapshot; `viewTimelineSelectionStartMs`,
`viewTimelineSelectionEndMs`, and `viewTimelineSelectionLoop` store the optional
timeline range and Loop Selection state. All are round-tripped through
`PROJECT_SET_VIEW`, which also arms the engine's transport loop (see
[Loop Selection playback](#loop-selection-playback)).

Timeline markers are stored as `MARKER` children with absolute project positions in
milliseconds, round-trip through `PROJECT_STATE`, and mark the project dirty when
added, moved or removed. `M` toggles a marker at the playhead: the marker is placed
at the exact playhead position rather than snapped to the beat grid, so it always
sits where the user put it and always toggles off from that same spot. The MIDI
hot-cue toggle pads run the same `toggleMarkerAt` store action, so both control
surfaces behave identically.
**Edit ▸ Clear All Markers** removes every marker as one undo step (greyed out
when the project has none).

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
Per-track row height (`heightPx`, in CSS pixels, clamped backend-side to 80..400,
and re-clamped to the stricter renderer range of 120..400 by `trackHeightPx()` in
`lib/timeline/trackLayout.ts` so a legacy project cannot crop the header controls) is
likewise persisted on the `TRACK` node and is undoable in the same project undo
history. Track order is the child order of `TRACK` nodes under `PROJECT` and is
preserved by save/load and by drag-reorder (`juce::ValueTree::moveChild` with the
project's `UndoManager`).
The view-state properties (`viewPxPerSecond`, `viewScrollX`, `playheadMs`) are written
through `setNonDirtyRootProperty`, which mirrors the value into `cleanSnapshot` so the
dirty comparison never sees a delta — zooming, scrolling, or moving the playhead doesn't
prompt an unsaved-changes dialog. Meaningful
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
`PROJECT_SAVE_VIEW_STATE`; the backend updates view state including scroll, zoom,
playhead, selected track, FX panel, timeline range, and Loop Selection in the
existing `.silverdaw` file, so it survives reopen without saving unrelated
unsaved project edits or changing the dirty flag. Logic lives in
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
Otherwise it's dirty. Changes are broadcast as `PROJECT_DIRTY { dirty, reason? }`
envelopes. The renderer mirrors it as `projectStore.isDirty`, shows a leading `•` next
to the project
name in the title bar when dirty, and intercepts **File → New / Open / Exit** and the
window close button to prompt with **Save / Don't save / Cancel** before discarding
work. When the project is clean, those same leave-project paths silently flush view
state only.

`reason` is sent only on a transition **into** dirty (going clean is always a save or a
load) and is either `edit` or `analysis`. Most background work never dirties at all:
detected BPM, beats, anchor and confidence flags are derived metadata, written through
`mutateDerivedLibraryItem`, which suppresses the dirty listener *and* mirrors the write
into the clean snapshot. Two things analysis does are not derived, and do dirty:
seeding the project tempo from the first clip, and the late auto-warp of clips dropped
before detection finished. Both change content that has to reach disk, so suppressing
them would report "saved" for work that is not saved. Instead
`ProjectState::BackgroundDirtyScope` wraps the automatic analysis path, tagging those
transitions `analysis`; the renderer shows an info toast naming the cause, so an
unsaved-changes marker that reappears on its own after a save is explained rather than
looking like a fault. The manual tempo path is deliberately outside the scope — that is
a user edit and reports `edit`.

On every connect the backend sends a `PROJECT_STATE` snapshot. The renderer:

- Reconstructs any track / clip / library item the backend knows but it doesn't (e.g. after a
  renderer reload).
- Sends `WAVEFORM_REQUEST` for every clip lacking peaks.
- Re-fetches embedded metadata and technical file metadata via `audio:readMetadata` IPC for
  reconstructed library items. Older projects that predate persisted library duration fall
  back to a renderer decode if metadata cannot provide a duration.
- Restores persisted zoom, horizontal scroll, BPM, project length, playhead position, and
  timeline markers from the snapshot, along with each track's visible automation-lane layout.

`PROJECT_STATE` is purely additive on the connect path — it never deletes optimistic state the
user just created, so a race between an early user action and the snapshot arriving doesn't
lose work. On a load / new-project the same envelope carries `reset: true` and the renderer
wipes its mirror before applying.

**Not every snapshot is a transport event.** Only a `reset: true` replacement and an
undo/redo `softReplace: true` rebuild stop playback and clear MIDI platter holds,
because both stop the engine backend-side — the undo full-rebuild path calls
`engine.stop()` before it broadcasts — and adopting that at once beats waiting for
`PlayheadEmitter` to re-assert it. An ordinary edit snapshot leaves the transport
alone. The plugin commands re-broadcast the whole project to change one field, so
treating every snapshot as a stop made bypassing a plugin mid-playback flip the
transport to stopped and rewind the ruler to the persisted playhead, then catch up
seconds later. The persisted playhead is likewise adopted only on a replacement or on
the first snapshot of a connection, which is what restores the position after a
renderer reload. `resetPlaybackForProjectChange` clears `playIntentAt` instead of
stamping it, since the stop is the backend's, not a local intent, and a stamped intent
would make the next `PLAYHEAD_UPDATE` wait out the settle window. Any other path that
stops the engine without a replacement snapshot — a first Save As that relocates temp
artifacts, say — is caught by the emitter's stop edge and 1 Hz stopped heartbeat, which
is what keeps the UI self-correcting rather than edge-dependent.

Until the first `PROJECT_STATE` arrives, an inline splash inside `index.html` (then the Vue
`StartupScreen` once it mounts) blocks all input so the user can't act on state that
hasn't been reconciled yet. `StartupScreen` is the single boot-and-landing surface — it
mounts at app boot (before the bridge is up) and stays visible until the project becomes
non-empty (file path, tracks, or library items) or the user explicitly dismisses it via
**New Project**. The loading screen has one 500 ms minimum dwell, coalesces intermediate
backend statuses, and displays only the current phase if startup is still in progress.
New / Open / Recent buttons enable when startup coordination finishes. On a terminal
startup failure the whole screen swaps to a focused error view with a single Quit
action; project actions are hidden because they cannot recover the app. A 60-second
timeout fires the failure path if the bridge handshake never completes.

The renderer starts consuming the pending launch path and scanning recoverable
autosaves as soon as it mounts. These main-process IPC calls run in parallel with
backend startup, but their results are applied only after the bridge handshake. The
`RecoveryDialog` then stacks above the `StartupScreen` when recoverable autosaves are
available.

### Loop Selection playback

When a timeline range has **Loop Selection** enabled, the **engine** owns the wrap, not
the renderer. `PROJECT_SET_VIEW` (and a project load) call `syncTimelineLoop`, which arms
`AudioEngine::setTimelineLoop` with the range; a 2 ms message-thread poll
(`kTimelineLoopPollMs`) wraps playback the moment the engine's own position reaches the
loop end, via the immediate `setPositionMsNow` seek path — the same one the Clip Editor
preview uses, and it deliberately does not reset shared-FX state, so Reverb and Delay
tails carry across the wrap.

Two properties make the restart seamless, and both are the reason this cannot live in the
renderer:

- **No round trip.** A renderer-driven wrap had to wait for a `PLAYHEAD_UPDATE`, then send
  `TRANSPORT_SEEK` back.
- **No fade and no latency skew.** `setPositionMs` while playing deliberately fades the
  output out, polls for the ramp to finish, seeks, then fades in — correct for a user seek,
  audible as a gap on every loop. The engine also wraps on its **uncompensated** position,
  so the restart lands at the loop end in the rendered stream; the renderer's playhead is
  latency-compensated, so it could only ever ask after audio past the end was already
  rendered and queued.

The renderer keeps only the view follow: auto-follow eases forward and never scrolls back,
so the transport controller watches for the position jumping back near the range start and
scrolls there. Pausing at the end of a **non**-looped range stays renderer-side.

Those boundary rules — follow a wrap, stop on a one-shot range end, stop at the project end
— live in [`playbackBoundary.ts`](../frontend/src/renderer/src/lib/transport/playbackBoundary.ts)
as a pure function, so the transport bar's position watcher only dispatches the result. A
one-shot stop pauses **and** seeks back to the boundary: the engine streams on until the
pause fade lands, so without the seek it parks past the range end and the next plain Play
resumes from outside the range. `AudioEngine::setPositionMs` holds a seek that arrives
while a pause fade is in flight and applies it once the pause lands — turning it into a
normal pending seek would fade the output back in and resurrect the playback that was just
stopped.

See [ADR 0023](adr/0023-engine-owned-timeline-loop.md) for the full rationale and the
rejected alternatives.

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

An entry already present at the expected size is reused rather than rewritten,
so a repeat play does not push tens or hundreds of megabytes back to disk; it is
touched instead, which keeps eviction treating it as recently used. The cache is
swept at startup by
[`transcodeCache.ts`](../frontend/src/main/transcodeCache.ts): entries unused for
longer than `TRANSCODE_CACHE_MAX_AGE_MS` (7 days) are deleted, and whatever
remains is trimmed oldest-first until it fits `TRANSCODE_CACHE_MAX_BYTES` (2 GB).
These are float WAVs — roughly 21 MB per stereo minute at 44.1 kHz — and nothing
else on the system removes them, so without a sweep auditioning a few albums of
m4a would leave gigabytes in the user's temp directory indefinitely. Eviction is
always safe: a transcode deleted while still wanted is simply decoded again on
the next play.

Note that this is not a matter of the backend picking the wrong format by
extension. JUCE's Windows codec is the Windows Media Format SDK
(`IWMSyncReader`), which reads the ASF family only; it cannot decode an MP4
container whatever the file is called, and content sniffing does not help. Any
format outside the list above **must** be transcoded before the backend sees it.

The transcode decision lives in
[`audioPlaybackPath.ts`](../frontend/src/renderer/src/lib/audioPlaybackPath.ts), which owns
the natively supported extension list, the cache write, and `ensureBackendPlayablePath()`
for callers holding a raw on-disk path. Two callers need it:

- **Import**, which already has the decoded PCM in hand and reuses the cache write.
- **The Files tab audition**, which plays files that were never imported and so has no
  library item or decoded cache to fall back on. It transcodes on first play, caches the
  result for the session, and keeps its row identity on the browsed file — the preview
  voice holds the WAV path, so `fileBrowserStore.auditionedPath` maps back to the file the
  user can see. A decode superseded by another click is abandoned rather than allowed to
  steal playback when it lands.

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
varispeed (`OffsetSource`), per-track summing and optional Beat Repeat, the
per-track Tone EQ + bipolar Filter, the per-track Leveler, Punch, Saturation, and Bit Crusher
([`ToneEq`](../backend/src/dsp/ToneEq.h) / [`Leveler`](../backend/src/dsp/Leveler.h) /
[`Punch`](../backend/src/dsp/Punch.h) /
[`Saturation`](../backend/src/dsp/Saturation.h) /
[`BitCrusher`](../backend/src/dsp/BitCrusher.h) /
[`TrackChain`](../backend/src/dsp/TrackChain.h)),
the per-track Reverb / Delay sends into the project-wide shared-FX buses,
track gain and mute / solo, equal-power panning, the master mix, Glue Compressor,
master gain, Safety Limiter, metering, and the `MasterClockSource` that gates
playback and feeds the device. The
`AudioSourcePlayer` hands 32-bit float to the OS audio driver, which converts
to whatever the hardware expects. Float gives very large headroom, so
intermediate sums can briefly exceed 0 dBFS without clipping as long as the
final master is back in range. (`TrackChain` is the canonical per-track DSP
seam shared by live playback and mixdown, running Tone → Leveler → Saturation → Bit Crusher → Punch → gain →
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
- **Second opinion**: [MiniBPM](https://breakfastquay.com/minibpm/) (Chris Cannam,
  Particular Programs) — a fixed-tempo estimator for whole files, used as an
  independent arbiter rather than as the primary detector. GPL-2.0-**or-later**; the
  "or later" clause is what makes it combinable with Silverdaw's AGPL-3.0-or-later. A
  verbatim copy lives at `backend/third_party/minibpm/` — see
  [`PATCHES.md`](../backend/third_party/minibpm/PATCHES.md) (no patches were needed).
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
libsamplerate (all shared with every other estimator via
[`BpmAudioLoader`](../backend/src/dsp/BpmAudioLoader.h), so they judge byte-identical
audio) → **condition the audio with a zero-phase percussive emphasis**
([`PercussiveEmphasis`](../backend/src/dsp/PercussiveEmphasis.h)) → feed BTrack
frame-by-frame at hop=256 (~5.8 ms steps) recording every
`beatDueInCurrentFrame()` event. **BTrack itself only tracks the first 60 seconds**
(`kBeatTrackingSeconds`) — it is the expensive, causal part and a bounded prefix gives a
robust octave/tempo *seed* without risking octave-wander on long, variable material. The
**onset-detection-function (ODF) period/phase refinement described below spans the whole
decoded track** (bounded only by the generous `kMaxAnalysisSeconds` ceiling), so the final
period is fit over the entire piece rather than extrapolated from the opening minute.
Estimates outside `[40, 240]` BPM are dropped as implausible.

The conditioning step emphasises the kick band (below ~180 Hz) and the snare/hat band
(above ~4 kHz) and attenuates the mid to 0.10, raising onset contrast on dense material
where sustained guitars, pads and vocals otherwise blur the beat. It uses only symmetric
FIR kernels applied centred over a reflected extension, so it adds **exactly zero group
delay at every frequency and every sample position** — non-negotiable, because the beat
anchor is de-biased by a calibrated ODF group delay and any material-dependent shift
would silently move every visible beat marker. See ADR 0028.

When the autocorrelation refinement is rejected, a second, independent estimator
([MiniBPM](../backend/src/dsp/MiniBpmEstimator.h)) arbitrates. That rejection test scores
candidates against BTrack's *own* beat times, so it is circular precisely when those beats
are untrustworthy. MiniBPM runs on the **raw** decode — not the conditioned buffer, so it
does not inherit the same blind spots — and may overturn the rejection only when it is
within 2.0 BPM of the autocorrelation period and at least 0.25 BPM closer to it than to the
baseline. It is consulted only on a dispute, so an uncontested import pays nothing for it.
MiniBPM offers no abort callback of its own, so the analysis timeout is enforced around it:
`MiniBpmEstimator` polls a `shouldAbort` callback between blocks and reports that it gave
up, which keeps a timeout reported as a timeout instead of reading as "no tempo found".

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
(`refineGridFromOdfPeaks`) does a least-squares period+anchor fit over
sub-frame-interpolated ODF onset points across the *entire* track; the long lever arm
pins the period far more tightly than a 60 s fit, which is what stops the rigid grid
from drifting late→early across a long track (adopted only when it stays within 5 % of
BTrack's octave, so a spurious fit can't hijack the tempo). This keeps the project grid
we later seed lined up with the source's beats from the first beat to the last. A
`variableTempo` flag is also computed by checking the spread of per-beat tempo samples
(after a short settling period) — if it's > 5 % of the mean, the library tile shows the
amber `~ BPM` warning badge.

Each of those points is the estimated **onset start**, not the ODF peak
(`estimateOnsetStartFrames`). The peak marks where the spectrum is changing fastest,
which for a broadband click is essentially the transient but for a kick or a soft pad
arrives several analysis frames later — measured against a corpus with known beat times,
peaks sat 0.7 ms late on clicks and 3.0–3.6 ms late on drums and pads. That spread is
material-dependent, so no single group-delay constant can remove it, and the residual is
exactly what reads as "markers slightly late". Walking back from the peak to where the
ODF first rose through 75 % of its height above the preceding valley adapts
automatically, because a slow-rising onset has a proportionally longer ramp; the crossing
is linearly interpolated because the 5.8 ms frame grid is coarser than the bias being
removed, and the backtrack is bounded to 120 ms so a quiet passage cannot drag the
estimate away. That fraction is calibrated, not arbitrary: it minimises mean |offset|
across click, drum and pad material (2.6 ms → 0.6 ms) and collapses the difference
between those materials to under 1 ms.

The grid is rendered as a **rigid metronome** from a single `(bpm, beatAnchorSec)`
pair, so the anchor's phase matters as much as the period. Before the final
ODF-peak refit, the detector runs a guarded **phase correction**:
`estimateGridPhaseOffset`
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
Once seeded a `PROJECT_BPM_APPLIED { bpm, bpmSeeded }`
envelope is broadcast and the renderer mirrors both into `libraryStore` and
`transportStore`. It is broadcast **whenever the seed gate passes, including when the
seeded value has not moved**, because `bpmSeeded` is the renderer's only source for
"does this project have an established tempo?" and it must learn the flag flipped.
Setting the tempo by hand (`PROJECT_SET_BPM`, and the Transport bar / Project
Properties controls that send it) also marks the project seeded, so the next clip
analysed cannot seed over a deliberate choice. At that point the renderer also beat-aligns the just-analysed
clips to the project **bar** grid when the **Align clips to the beat grid after
analysis** preference is on (see that preference for the mechanics). Seeding runs even for variable-tempo and low-confidence sources
(an approximate tempo is more useful than the default 100) but is suppressed for
items **explicitly classified as a sample**, so a rain ambience the user has
marked as a sample can't drag the project tempo. The user can fine-tune from the
Transport bar afterwards.

**Source BPM: one resolver per process.** A clip or library item has exactly one
original BPM and one warp target, and neither process may derive its own version
— see [ADR 0024](adr/0024-single-source-bpm-resolver.md), which is `CRITICAL`. The
renderer resolves it only through `libraryItemSourceBpm`
(`frontend/src/renderer/src/stores/libraryItemHelpers.ts`); the engine only
through `ProjectState::getLibraryItemBpm`
(`backend/src/project/ProjectStateClips.cpp`). Both apply the same rules in order:
a one-shot has no tempo at all, not even an inherited one; otherwise the tempo
implied by its **recorded musical length**; otherwise the item's own BPM; otherwise
the BPM of the item it was derived from. Nothing else may read
`item.bpm` to decide how a clip is drawn, gridded, warped or stretched — when the
two sides disagreed, a clip could be drawn stretched to the project tempo while the
engine played it dry. `libraryItemWarpSourceBpm` remains only as a deprecated
pass-through for the warp UI. The same rule governs how a tempo is *acquired*:
`ensureBpmDetection` (the automatic path, reached from `LIBRARY_ADD` and the first
`CLIP_ADD`) asks `ProjectState::getTempoInheritanceSourceId` first and inherits from
the source rather than analysing a derived item's own audio. A saved sample or clip
is routinely a couple of bars long — around eight beats, far below what the detector
needs — and the few-percent error that produces is plainly visible, because the clip
no longer warps to a whole number of bars. `LIBRARY_REANALYSE` is an explicit
instruction from the user, runs through `forceLibraryItemAnalysis`, and keeps
whatever it detects.

"A one-shot has no tempo" is decided by **inheritance** in both
processes — `ProjectState::isOneShotItemInherited` and
`libraryItemIsSimple` — and decided *before* any tempo is resolved. An
unclassified cut of a one-shot is a one-shot, and an item the user has
explicitly called music still cannot borrow a tempo from a one-shot parent,
because that parent has none to lend. Applying the rule at different depths on
the two sides is the same failure ADR 0024 exists to prevent.

**Legacy content is repaired forward, never left to the user.** A project
saved before these rules can hold shapes they forbid, so
`ProjectState::replaceTree` runs its migrations on every load:
`migrateLegacyAudioType` and `migrateLegacyLibraryKind` translate the older
property names, `migrateOneShotTempo` removes a grid from an item that is a
one-shot but still stores one, and `repairLibraryItemKinds` restores the
`kind` of a generated artifact that was demoted to a plain source. Two rules
make this safe to do silently. First, nothing may change how an existing
arrangement sounds: before stripping a one-shot's tempo,
`migrateOneShotTempo` pins the ratio that tempo implied onto every clip that
was warping against it, so those clips keep exactly the stretch the user saved
while opting out of project-tempo tracking. Second, the repairs run inside the
load's `SuppressDirtyScope` and before `clearUndoHistory`, so opening an old
project neither marks it dirty nor leaves a phantom undo step — it is simply
correct from that load on, and persists that way on its next save.

Note that `repairLibraryItemKinds` decides "is this a generated artifact?" by
containment under the project folder rather than by the path *looking*
relative: `ProjectFile::loadTree` resolves every portable path to an absolute
one before the tree is installed, so the in-memory tree never holds a relative
path to test.

**Musical length: how many bars, not how fast.** A derived item also records
`musicalBeats` — how many whole beats of music its file contains, measured against
the grid of the item it was cut from by `recordMusicalLength`
(`backend/src/project/LibraryAnalysis.cpp`), which every derived item reaches via
`inheritAnalysisFromSource`. It is a measurement of the audio rather than an opinion
about it, so it outranks a detected tempo in both resolvers: a clip cut to a number
of bars stays that number of bars however its tempo is later re-detected. It is
recorded only when the cut really is a whole number of beats (a tolerance that keeps
the implied stretch under ~1%); anything else records nothing rather than being
rounded onto the grid. `SampleExport` records it from the **source window** rather
than the exported file, so a sample saved with its warp baked in still records the
true count. `inheritAnalysisFromSource` measures the same way, preferring the
item's recorded `sourceDurationMs` over its own file duration: the source's
tempo describes the source's audio, so pairing it with a file that was rendered
stretched would land on the wrong beat count — and since a musical length is
written once and outranks every later reanalysis, a wrong one would never be
corrected. A hand-set tempo clears it (`setLibraryItemManualTempo`) — that is the
explicit override — while a reanalysis deliberately keeps it.

On load, `ProjectState::repairLibraryItemKinds` promotes library items an older
build persisted with the wrong `kind`: any `sample-`-prefixed item stored as a plain
source back to `kind: "sample"`, and any item whose path sits under the project
folder's `stems/`, `channels/`, `samples/` or `scratches/` back to the kind
that folder implies — a reanalysis used to demote a stem to a plain source, which
then vanished from the import-from-project picker. It runs from
`ProjectState::replaceTree`, so it covers `ProjectFile::load`, and separately from
`loadSourceProjectImport`, which reads a project tree without building a
`ProjectState`, so an old project imports correctly without being opened first.
Both callers pass the project's own folder, which is what makes the containment
test above possible.

**Warping on drop is a question about drift, not about the ratio.** Auto-warp on
drop engages whenever the mismatch between the source tempo and the project tempo
actually moves the clip's end: `warpChangesTiming` (`renderer/src/lib/warp.ts`)
converts the ratio into the milliseconds it pulls across that clip's own length and
ignores anything under `WARP_NEGLIGIBLE_DRIFT_MS`. A fixed ratio band cannot do this
job — the band that is inaudible on a two-bar loop swallows a fifth of a second on a
three-minute stem, which is how a drum stem reanalysed from 94.05 to 94.0446 BPM was
dropped unwarped and ended ~10 ms off the grid. `shouldAutoWarpOnDrop` and
`applyDropTimeWarp` share the one test, so the ghost width, the overlap check, the
beat snap and the landed clip cannot disagree.

The same drift rule decides whether a warp *reports* itself active, in both processes:
`isWarpActive` in the renderer and `ProjectState::getClipEffectiveTiming` in the backend
(`kWarpNegligibleDriftMs`). They must move together — the epsilons used to disagree with
the engine, which happily stretched the near-miss stem while the project state called the
warp inactive, so the timeline drew the clip at its native width, withheld the WARP badge
and spaced its beat markers on the unwarped grid. Each process keeps the rule in one
function — `warpChangesTiming` in `lib/warp.ts` and in `ProjectStateTypes.h` — so
enabling a warp, drawing one and reporting one cannot answer the question differently.

**Changing the project tempo.** `handleProjectSetBpm` keeps the arrangement's
musical shape: `ProjectState::retimeClipsForTempoChange` rescales every clip's start
by `previousBpm / newBpm`, so a clip on bar 9 stays on bar 9. Without it, warped
clips re-stretch in place while their starts stay in milliseconds and the
arrangement drifts apart on every tempo edit. When the renderer's **Auto-warp clips to project
tempo** preference is on — sent as the optional `autoWarp` flag on `PROJECT_SET_BPM`,
since the preference lives in the renderer — clips that are not warped but whose
source has a tempo are warped first, so nothing is left behind at the old tempo.
A clip whose own tempo *already matches* the new one is skipped: it is filtered by
`warpChangesTiming`, the same drift test the drop path applies, so typing a tempo and
dropping a file at that tempo reach the same answer about what warping means. Without
that filter a matching clip picked up a WARP badge, a stretch ratio and a resampled
playback path for a stretch that changes nothing — a warp the user can see and
cannot account for.
That is the same preference that governs warping a clip *on drop*, deliberately:
one setting expresses one intent ("keep music at the project tempo"), and it holds
at every moment the project tempo is established. Widening it rather than minting a
second key is explicitly sanctioned by [ADR 0019](adr/0019-backward-compatibility-released-product.md) —
both stored values still mean for the user exactly what they chose, so it is a
widening and not a repurposing.
Those clips are then re-stretched through `engine.setClipWarp` with `enabled`
explicitly `true`: the engine reads an unset `enabled` as "keep the current engine
state", and a clip that has never been warped has no warp processor, so leaving it
unset would disable warp on the very clips the auto-warp pass just enabled and they
would play dry and stop at their unwarped length. Sitting at the project tempo is a
coincidence of the moment, not a property of the clip — such a clip stays
warp-capable and a later tempo change warps it like any other; skipping it above
only declines to enable a warp that would do nothing *now*, and a tempo change must
never turn an existing warp off. The
renderer mirrors both in `projectStore.applyProjectBpm`, the single entry point
shared by the transport bar and the project properties dialog. An active timeline
selection is rescaled by the same factor there
(`uiStore.retimeTimelineSelectionForTempoChange`, persisted with
`PROJECT_SET_VIEW` after `PROJECT_SET_BPM`): a range is a musical span, so a
selection drawn around eight bars must still cover them, and Loop Selection reads
the range live every frame. It is view state only, which is why the retime is a
renderer concern with no backend counterpart.

Timeline markers and the playhead are rescaled by that factor too. A marker names a
musical place — the drop, the last bar of the intro — and the playhead is parked on
a beat, so leaving either in milliseconds strands it against whatever now happens to
occupy that instant while everything else moves. Markers are persisted state, so the
backend owns them (`ProjectState::retimeMarkersForTempoChange`, in the same undoable
transaction as the tempo itself) and `applyProjectBpm` mirrors the new positions
locally — marker positions otherwise only reach the renderer on a full
`PROJECT_STATE` snapshot, which a tempo edit does not trigger. The playhead is
likewise moved on the backend, through the ordinary `setPositionMs` seek: the same
material sits under it after the move, so the effect tails carry across rather than
being reset.

**Removing the last track.** `handleTrackRemove` clears every marker
(`ProjectState::clearMarkers`) and the timeline selection once no tracks remain, and
re-runs `syncTimelineLoop` so the engine's loop range goes with them. A marker names a
place on a timeline and a selection is a span of one, and with no tracks the ruler
draws no time for either to name. Left behind they were unreachable rather than merely
idle — the ruler renderer and the drag handlers both stand down with no tracks — so
they could be neither seen nor cleared, yet they persisted into the saved file and
reappeared the moment a track was added, with a looping selection still wrapping
playback inside a range nothing on screen accounted for.

The clear runs inside the transaction `beginUndoTransactionIfNeeded` has already
opened for `TRACK_REMOVE`, so removing a track and losing its markers is one action
and one undo, not two. Markers are persisted content and dirty the project, but only
through the derived path: `clearMarkers` does *not* call `markDirty`, because the
child-removed listener recomputes dirtiness against the clean snapshot, and forcing
the flag would strand the project dirty after an undo had put every marker back. The
selection is view state written through `setNonDirtyRootProperty`, so it never dirties
and is not restored by undo — consistent with how a selection is treated everywhere
else. `projectStore.removeTrack` mirrors both locally so the timeline does not draw
stale markers for the round trip.

Track automation is on that same timeline axis, so it is rescaled by the same factor
(`ProjectState::retimeTrackAutomationForTempoChange`, mirrored in `applyProjectBpm`);
a filter sweep drawn for the drop must still be over the drop rather than over
whatever now occupies those milliseconds.

Clip volume shapes are the exception that is *not* on the project scale. Breakpoints
are clip-local post-warp ms — `OffsetSource::applyClipGain` runs downstream of the
stretcher and measures from the clip's start — so a shape follows its own clip's
timeline footprint, and that footprint changes by a different amount per clip. A clip
following the project tempo re-stretches by `previousBpm / newBpm`; a clip the same
edit has just auto-warped changes by `sourceBpm / newBpm`; a pinned `tempoRatio` and
an unwarped clip do not re-stretch at all and their shapes must stay exactly where
they are. So the backend captures every shaped clip's footprint *before* the edit
(`ProjectState::snapshotClipFootprints`) and rescales each shape by its own
before/after ratio once the warp passes have settled
(`retimeClipEnvelopesForFootprintChange`); `applyProjectBpm` mirrors it with
`effectiveDurationMs` and `scaleEnvelopePoints`. Applying the project scale here
instead would drag the shapes off the clips that did not move.

**When a tempo edit applies.** The retime above is a whole-arrangement pass, so
running it per keystroke made the transport bar's BPM box animate the timeline —
and lag behind — as the arrows or the spinner were held.
`useProjectBpmEditor` (`lib/transport/`) owns the box's text and *when* a tempo
reaches `applyProjectBpm`: a step updates the displayed number immediately but
only schedules the apply, `BPM_SETTLE_MS` (250 ms) after the last one, so a run
of steps costs one retime across a single old→new ratio rather than one per
tick. `Enter` and blur cancel that timer and apply at once, and a tempo arriving
from anywhere else — a project load, Project Properties, first-clip seeding —
cancels a pending edit instead of being overwritten by it, since the box is a
proposal and `transport.bpm` is the fact. A pending target is held at full
precision and rounded only for display. Two details are easy to get wrong: a
`v-model` on `<input type="number">` hands the parser a `number`, not a string,
so it must accept either; and a number input has no `selectionStart`, so
select-on-entry re-selects on `mouseup` only when the pointer travelled less
than `CLICK_SLOP_PX`, leaving a genuine drag-select alone. The tempo range
itself lives once in `lib/musicTime.ts` (`MIN_BPM` / `MAX_BPM` / `clampBpm`),
shared by the editor, `transportStore.setBpm` and the clip editor's beat grid.

**Manual tempo.** When detection is wrong or absent the user can set a BPM by hand
on a source item. `LIBRARY_ITEM_SET_MANUAL_TEMPO { itemId, bpm, beatAnchorSec }`
builds a rigid grid across the item's duration on the backend and re-broadcasts
`LIBRARY_ITEM_ANALYSIS` with `variableTempo` and `lowConfidence` cleared, so the
item reads as verified music. In the Clip Editor the whole grid is edited as a
**draft**: a slide-the-grid drag, the BPM field, the octave buttons, the nudges and
the half-beat shift all update the grid locally — the markers and preview metronome
track the edit live with no bridge round-trip — and mark the Clip Editor dirty.

Which of the two the draft writes depends on what is being edited. **Tempo** is always
the source item's (a file has one tempo, ADR 0024) and is persisted with a single
`LIBRARY_ITEM_SET_MANUAL_TEMPO`. **Phase** belongs to the timeline clip being edited and
is persisted with `CLIP_SET_BEAT_OFFSET`, leaving the source item — and so every sibling
clip cut from the same file — untouched; only a session with no owning clip (a library
item or a linked saved clip, where the phase is shared by design) writes the item's
anchor. Both commit on **Save** inside the Save undo group, so the grid change and the
audio slide that follows it fold into one undo step, and both roll back to the grid
captured on open if the session ends without a Save (Cancel / close).
Alongside the drag, the beat-grid panel is split into a **Tempo** section — a BPM
field you type and commit with Enter or by clicking away (no separate Apply
button), **÷2 / ×2**
octave buttons that halve or double the source BPM while holding the phase anchor,
and, once the tempo has changed, the **Original** value with a **Restore** button —
and a **Position** section with the slide-to-align toggle, **±5 ms** fine-nudge
buttons, and a **half-beat** shift for when the grid has locked onto the off-beat.
Manual values survive save / load because `ensureBpmDetection`
is idempotent and skips a source that already has a BPM.

**Correcting a mis-detected tempo.** The manual-tempo path above says "play at this
tempo" and lets Save move the arrangement to suit; it cannot say "the detector read the
wrong number". Because `maybeSeedProjectBpmFor` copies the first musical clip's detected
tempo into the project tempo, one wrong detection lands in two places, and neither
existing control fixes both: the project tempo box rescales the whole arrangement
(`retimeClipsForTempoChange` and friends), while the Clip Editor tempo field corrects
only the source, so the clip then warps by the same error inverted. ADR 0027 adds a
distinct operation for the corrective intent, drawn at persisted position: **a correction
never moves a clip start, a marker, an automation point, the timeline selection or the
playhead**, while everything derived from a tempo — clip ratios, footprints, volume
shapes, transitions — is reconciled from the final corrected state.

`LIBRARY_ITEM_CORRECT_TEMPO { itemId, bpm, beatAnchorSec }` is handled by
`handleLibraryItemCorrectTempo` (`commands/TempoCorrectionCommands.cpp`). It resolves the
**tempo owner** first (`ProjectState::resolveTempoOwner`, mirrored by `resolveTempoOwner`
in `libraryItemHelpers.ts`), so an inherited tempo is corrected on the ancestor and every
sibling is fixed at once. `applyManualTempo` then writes the tempo and re-derives every
clip that follows it; `retimeClipEnvelopesForFootprintChange` runs last, against
footprints the re-derive has settled, and transitions are reconciled in-command so the
reported count is true of the state the user is told about.

**The project tempo is deliberately absent from the payload.** Setting it from the first
clip dropped is **merely a convenience, with no linkage and no history**:
`maybeSeedProjectBpmFor` copies a number once and returns early ever after, nothing
records that it happened, and the item it came from may since have been deleted from the
timeline or the library. The project tempo is the user's number, and a statement about a
file is not evidence about it — not even when the two are equal, which is the case a rule
would be most tempted to guess from. The command therefore writes exactly one tempo fact
and no provenance is persisted. The practical route for the common case is to correct the
file in the library **before** placing the first clip, at which point
`maybeSeedProjectBpmFor` seeds the project from the corrected number; otherwise the
project tempo is changed afterwards in the transport box, which is a tempo *change* and
rescales the arrangement as it always has. In that second case the corrected clip warps by
`projectBpm / correctedSourceBpm` in between — that is warp working correctly, not a
residual bug: before the correction both numbers were the same wrong number so the ratio
happened to be 1.0, and setting the project tempo unwarps it again.

Because the project grid never moves, nothing can be knocked off it: a correction moves no
clip, so there is no alignment pass and `libraryHandlers.ts` writes nothing to
`project.clips`.

**A correction outranks a detection that is still running.** Tempo detection runs on a
worker thread and applies its answer later, on the message thread, so a job started at
import can finish after the user has already corrected the same item. Each library item
therefore carries a *tempo authority generation*, bumped by `applyManualTempo`. A detection
job reads that number when it is **enqueued** — not when it starts, so a correction wins
even while the job is still queued — and throws its own result away if the number has since
moved. `getTempoAuthorityGeneration` and `tempoDetectionResultIsStale`
(`project/LibraryAnalysis.h`) are the guard, exposed so tests can reach it. This matters
more than an ordinary race: the automatic path writes derived, non-dirtying, non-undoable
metadata, so a correction it overwrote could not be recovered with undo, because nothing
was ever pushed onto the undo stack. A reanalysis the user explicitly asks for is enqueued
*after* the correction that preceded it, so it still applies — the guard only ever drops a
result the user has since overruled.

**The renderer shows the new tempo immediately and takes it back if the engine refuses.**
`libraryStore.correctItemTempo` snapshots the item's grid, applies the new tempo locally,
then sends. The `TEMPO_CORRECTION_APPLIED` handler calls `commitTempoCorrection` on
success or `rollbackTempoCorrection` on failure, which restores the snapshot — including
`musicalBeats`, `variableTempo` and `lowConfidence`, which the local write clears. The
snapshots are held in a `WeakMap` keyed by the item object rather than its id, so a
rollback point cannot outlive the item it describes when a project is closed and reopened.

The reply is `TEMPO_CORRECTION_APPLIED`. Its `ok` field says which of two shapes it
carries. `ok: false` carries `{ itemId, error }` and means nothing was written. `ok: true`
reports the owner and its resolution reason, both the previous and applied tempi, whether a
recorded musical length was discarded, and what was and was not touched: clips re-warped,
clips excluded because their ratio is pinned or their warp is off (exclusions by the user's own
earlier choice, not failures), transitions removed, and clips now past the project length.
`lib/library/tempoCorrectionReport.ts` turns that into the wording the user reads.

The consequence wording lives in `TempoCorrectionFields.vue` and is rendered by every
surface that offers a correction, so none of them can drift into saying something
different. It separates notes that are *facts about the item* — an inherited owner, a
tempo measured from a musical length — from the standing explanation of what a
correction does. The explanation is drawn only by hosts that offer the correction
unprompted; a host the user reached by choosing **Edit BPM** suppresses it with
`show-summary`, because that choice already states the intent and repeating it explains
the edit back to the person who asked for it. There are two:

- **`EditBpmDialog.vue`**, a dialog whose whole job is this one number. It lands on the
  field with the old value selected and commits on **Save**, with **Cancel** discarding
  the draft; its Escape listener is registered in the **capture** phase so a dialog
  underneath cannot close itself on the same key. It is reached from the library context
  menu's **Edit BPM…** (`useLibraryItemActions`) or from the **Edit** button beside the
  BPM on the item's information dialog, which is otherwise read-only — information states
  what a file *is*, editing is a transaction, and a live input in a dialog whose only
  footer button was Close made it ambiguous which control wrote anything. The Edit button
  appears only while the row shows the item's own tempo: a warped value is a product of
  the project tempo and the clip's ratio rather than a fact about the file, so typing over
  it would have no single meaning. State comes from `useLibraryItemTempoCorrection`, which
  writes through `libraryStore.correctItemTempo`.
- **The Clip Editor opened on a timeline clip**, via `useClipEditorBeatGrid`. This is the
  only one with a grid draft to unwind first: the typed BPM is written locally onto the
  item being edited so markers redraw live, and `applyCorrection` rolls that back and
  re-applies it to the resolved owner before sending.

The Clip Editor opened on a **library source** deliberately carries no Beat grid module.
That window's job is choosing a section to save; it has no Save of its own to commit a
file-level edit, and the tempo it would show belongs to the library item rather than to
anything on screen. Its hint text points at the library's **Edit BPM…** instead, so the
correction has one home on the source rather than two that mean subtly different things.
That window draws no beat markers either. `useClipEditorController` passes the waveform
and the canvas a `visibleBeatGrid` of `null` unless `editsExistingClip` is set, so markers
appear only where the Beat grid module is present to edit them. Previewing a source is
about hearing it and picking a section, and a grid nobody can adjust is decoration at best
and a misread tempo presented as fact at worst.

Beat markers need nothing extra. `resolveSourceBeatGrid` spaces them at `60000 / bpm`
phase-locked to `beatAnchorSec`; the detected `beats` array is consulted only for presence
and as a legacy anchor fallback, so a corrected tempo respells the grid by construction.
Phase is a separate fact: a correction carries the **owner's existing anchor**, never the
edited item's, so fixing a number can never slide the grid of every clip cut from that
file. Phase is corrected where it can be seen, in the Clip Editor's Position control.

### Confidence and audio type classification

`BpmAnalysis` also reports a `lowConfidence` flag derived from the LSQ-fit
residual and the fraction of detected beats kept after outlier rejection.
Specifically the analysis is flagged when *both* of these hold:

- **poor fit**: `relResidual > 0.08` OR `keptFraction < 0.6`, AND
- **non-musical signature**: `variableTempo` is true OR `keptFraction < 0.5`.

A **partly decoded file also forces the flag on its own**, whatever the fit
looked like. `BpmAudioLoader` sets `truncated` when it could not read the file to
the end, and the estimate then describes only the part that was readable, so it
may simply be wrong about the rest. The user is entitled to know the number is
provisional rather than have it presented as confirmed.

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
detected beats. The markers are **synthesised on a rigid beat grid** anchored on the
regression-derived `beatAnchorSec` (older projects fall back to `beats[0]`) and spaced by
`60 / sourceBPM`, not on each raw detected position. This makes them survive a split /
duplicate / trim without drifting — both halves of a split clip share one coordinate
system, so the markers stay in lockstep across the split point.

**Spacing is source-global; phase is per clip.** A file has exactly one tempo (ADR 0024),
so every clip cut from it is spaced identically. Where beat one falls is a different
question: on variable-tempo material the honest answer genuinely differs between two
halves of a split, and correcting one used to rewrite the shared library-item anchor and
so drag the markers on every sibling clip off the bar lines while they sat still. The
phase therefore lives on the clip, in `CLIP.beatOffsetMs`, and is inherited by split /
duplicate / paste so the correction is invisible at the moment it is made.

Every surface that reads that grid resolves it through a single helper,
`lib/clip/sourceBeatGrid.ts`. `resolveSourceBeatGrid()` returns the *item's* grid as
`{ bpm, spacingMs, anchorMs }` or `null`; **every clip-aware consumer must use
`resolveClipBeatGrid()`**, which is the same grid with that clip's phase applied.
`firstSourceBeatMsAtOrAfter()` walks either. That covers timeline markers, drag/nudge
snap, library drop snap, bar-grid alignment, Chop to Grid, and the Clip Editor and
Scratch Editor grids (waveform lines, envelope beat snap, grid slicing). Never re-derive
`60_000 / bpm` phase maths at a call site: the projections used to disagree on inherited
BPM and on the simple-item gate, which made one-shots snap to a grid they never drew and
made Chop to Grid silently do nothing on a stem that visibly had one.

Four rules the helper settles:

- **Inheritance is unconditional.** BPM resolves through `libraryItemSourceBpm`,
  and `beats` / `beatAnchorSec` fall back to the source item, so a stem or saved
  clip lands on the same grid its parent does. Anything drawn with a grid must be
  usable by every operation that reads one.
- **A one-shot has no grid, ever.** A simple sample has no musical pulse — it
  cannot even hold a BPM (see the sample flavours above) — so beat markers over it
  are noise on the timeline and equally meaningless zoomed into the Clip Editor or
  Scratch Editor. Neither draws them, the Clip Editor's tempo and align controls
  stay disabled to match, and **Chop to Grid** is not offered: its menu gate is the
  resolved grid itself, so the command appears exactly where lines are drawn,
  including on a stem that inherits its tempo. There is no opt-out; snapping or
  slicing against lines that were never drawn is how this went wrong before. Clip
  Editor surfaces read the resolved grid from `useClipEditorBeatGrid`'s
  `resolvedGrid` rather than resolving it themselves.
- **A warped clip's markers come from the project, not from arithmetic.** A clip
  warped to follow the project tempo *is* at the project tempo, so
  `clipTimelineBeatSpacingMs()` spaces its timeline markers at `60_000 / projectBPM`
  — by construction, rather than by two numbers agreeing. Deriving them as
  `sourceSpacing / effectiveTempoRatio` gives the same answer only while the grid
  and the ratio are built from the identical, current source BPM; a reanalysis broke
  that (the grid picked up the new BPM immediately, the ratio still held the old one)
  and the markers came out a few percent off the project grid — line one up and the
  rest walk away. A **pinned** ratio is deliberately not at the project tempo, so it
  keeps `sourceSpacing / ratio`. The phase still comes from the source grid, projected
  through the ratio the clip is playing at, so markers and the beat-aware snap agree.

  The backend half of the same fix lives in `LibraryAnalysis.cpp`: after any analysis
  it re-derives the warp of every unpinned clip using that item (or inheriting its
  tempo) and re-broadcasts `CLIP_WARP_APPLIED`, so the engine's stretch, the clip's
  drawn width and the markers all move onto the new tempo together.
- **Phase belongs to the clip, spacing to the source.** `resolveClipBeatGrid()` adds
  `CLIP.beatOffsetMs` to the item anchor and returns the same shape, so a consumer
  cannot accidentally read the unshifted grid. `clipAnchorOffsetMs()` is the one
  reference point every *placement* operation must agree on — drag snap, keyboard
  nudge, library drop and paste all anchor the first in-window beat rather than the
  clip's left edge, which is why a clip that opens with silence lands on the beat and
  why pasting a clip and then nudging it no longer moves it.

**Correcting a clip's grid never moves the clip.** Sliding the markers in the Clip
Editor answers "where is beat one in this audio?", so the clip's *placement* was never
what was wrong. On Save, `project.slideClipAudioWithGrid(clipId, gridShiftSourceMs)`
re-cuts the source window by exactly the distance the session moved the grid
(`useClipEditorBeatGrid.sourceGridShiftMs()`), holding `startMs` and the timeline
footprint byte-for-byte: the volume shape stays valid, no neighbour can be in the way,
every marker keeps the timeline position it had, and only the audio underneath moves.
The shift is wrapped to the smallest move that lands the new grid back on the old grid's
lines, so a whole-beat regrid (an octave fix, a half-beat flip applied twice) is a no-op
rather than a beat-long jump, and a window that runs off either end of the source
overhangs it and plays as silence rather than the edit being refused.

It deliberately does **not** re-align the clip to the project grid. Rounding the clip's
first beat to the nearest project *beat* ignores where the clip already sits, so a clip
placed on a sub-beat — an eighth off the bar — was dragged up to half a beat onto the
nearest whole one: a five-millisecond marker nudge moved the audio by a fifth of a
second and the clip came back playing visibly different material. Snapping to the project
grid is what clip drag, keyboard nudge and `alignClipToBarGrid` (the drop / first-analysis
path, where the placement genuinely is provisional) are for.

Drag-snap on a clip with a known source tempo locks onto the same grid: instead
of snapping the clip's left edge to the snap grid, it snaps the first
source beat inside the clip's window. With the project BPM seeded to the source
BPM (the common case), every subsequent marker on the clip then lines up exactly
with a project grid line. Drag with `Alt` for fine 1 ms unsnapped
behaviour.

Snapping the beat rather than the edge means the resulting start can resolve
*before* the timeline origin. `startMsForAlignedBeat()` (`lib/musicTime.ts`)
steps forward by whole snap units in that case instead of clamping the start to
0, and drag, library drop and the keyboard grid-nudge all go through it. The
clamp kept the clip on the timeline but left its beat off the line by the whole
offset, always in the same direction — a clip placed against the start of the
timeline drew its first marker a fraction of a beat ahead of bar 1 however
carefully it was positioned.

Non-linked edge-trim drags use the same project grid by default, snapping the
dragged edge as the source window changes. Hold `Alt` while trimming for
freeform 1 ms edge placement. Linked saved clip instances do not expose timeline
edge-resize handles; edit their shared window in the Clip Editor or unlink the
instance first.

### Timeline snap grid

The snap-grid dropdown in the status bar is the single setting behind both the
density of the drawn grid lines and the interval every timeline-time edit
quantises to, so what the user sees is what they snap to. It offers **Bar**,
**Beat**, **Half beat**, **Quarter beat** and **Free**, and defaults to Quarter
beat, which is the behaviour that shipped before the grid became selectable.
The control blurs itself once a choice is made — a focused `<select>` swallows
the global shortcuts, so keeping focus would leave the keyboard dead until the
user clicked away.

The vocabulary and its pure helpers live in `shared/snapGrid.ts` — the value
crosses the bridge, so both sides share one definition. `BEATS_PER_BAR` is
defined there too and is the single statement of the app's 4/4 assumption;
`timeline/constants.ts` derives `TIME_SIG_NUM` from it rather than restating the
number. There is deliberately no constant for the sub-beat tier: it follows the
selection, so `useGridGeometry` resolves it per read via
`gridSubdivisionsPerBeat()`.

Two derived quantities do the work:

- `beatsPerSnapStep()` feeds `msPerSnapUnit(bpm, grid)` in `lib/musicTime.ts`,
  which returns the snap interval in milliseconds. **Free returns 0**, meaning
  "do not snap" rather than "snap to zero", so callers must branch on it instead
  of dividing by it.
- `gridSubdivisionsPerBeat()` is what the two renderers draw. It is deliberately
  restricted to 1, 2 or 4 so the existing integer bar/beat tick maths still
  holds. At **Beat** and **Bar** every subdivision *is* a beat, which suppresses
  the fine tier and leaves the bar/beat hierarchy intact; **Free** keeps the
  finest lines as a visual reference even though nothing snaps to them.

`useGridGeometry` exposes `snapTimelineMs(ms, fineMode)` as a function rather
than a computed so a handler mid-drag always reads the latest
BPM and grid without wiring up its own watcher. Every snapping call site routes
through `snapTimelineMs`: ruler seeks and playhead drags, clip and group drags,
edge trims, marker drags, range boundaries, and library drops. The keyboard
(`←`/`→`, `Shift`+`←`/`→`) and the MIDI jog step rather than snap, so they go
through `stepToGridMs()` instead — see below.

`Alt` remains the temporary fine-placement override. Because `snapMs()` treats
Alt and Free identically, holding `Alt` on an already-Free grid is a no-op
rather than an inversion.

Stepped controls — the `←`/`→` playhead seek, the `Shift`+`←`/`→` clip nudge and
the MIDI jog — all walk the grid through one shared helper, `stepToGridMs()` in
`lib/musicTime.ts`. It differs from `snapMs()` in that it always *moves*: from a
position already sitting on a line it lands on the next one, which is what a
stepped control needs. On a Free grid there is no line to walk to, so it borrows
`freeGridStepMs()` (a quarter beat) and applies it
*relative* to the current position rather than quantising. This keeps stepping
at roughly the same pace on every grid setting and leaves a deliberately
off-grid position off-grid; a literal 1 ms step would take thousands of presses
to cross a bar. `Alt`+arrow (pixel-resolution seek) and `Shift`+`Alt`+arrow
(1 ms clip nudge) remain the finer steps on every grid.

The choice persists as **non-dirty project view state** — changing it never
marks a project unsaved. It travels as `snapGrid` on `PROJECT_SET_VIEW` and
comes back as `viewSnapGrid` on `PROJECT_STATE`, backed by the `viewSnapGrid`
root property in `ProjectState`. The backend stores the string opaquely and does
not validate it: the renderer owns the vocabulary, and `toSnapGrid()` falls back
to Quarter beat for an unknown or absent value. That fallback is what makes a
project saved before this feature open correctly, so the snapshot path applies
the grid on every reset even when the field is missing — otherwise an older
project would silently inherit the previously open project's choice.

### Processing progress panel

A floating panel in the bottom-right shows each in-flight import or reanalysis
job with up to four sequential stages so the long-tail analysis isn't invisible:

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
reported via `STEM_PROGRESS` at most every 100 ms while stage changes and the
terminal update pass through immediately. Each stem lands as soon as its WAV is
written (`STEM_PARTIAL`), and `STEM_READY` waits for in-flight imports before
backfilling the rest and reporting completion. The renderer opens the preparing
state before resolving request settings, reads the stem preferences once for
dispatch, and resolves independent model paths and GPU status concurrently.
Generated-stem envelopes include their sample rate, duration, and channel count.
The import path still decodes each WAV for waveform peaks, but uses that
authoritative geometry and the source's cached project media to skip file
metadata extraction, sample-rate probing, musical-key detection, playback-path
resolution, and repeated project-media reads.

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
VRAM). Recoverable DirectML failures are handled by the hybrid separator's
shared CPU fallback. The host pipeline is unit-tested by an identity round-trip, and
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
the CPU so the user still gets their stems. After either failure, the backend
quarantines DirectML for the lifetime of that process. Later jobs route directly
to the CPU instead of retrying a GPU already known to fail; restarting the
backend clears the quarantine. Model, decode, cancellation, and unrelated ONNX
errors do not quarantine the GPU. On memory-constrained integrated GPUs the
fixed-shape RoFormer models may simply not fit, in which case the run falls back
to the CPU; GPU acceleration is therefore treated as a best-effort,
dedicated-GPU-oriented option rather than a guaranteed speed-up.

The raw, denormalised stereo mixture used by the RoFormer packs is built once
per job and shared by the vocal and rhythm paths. Backup-only htdemucs jobs do
not build it. Fixed-shape ONNX tensor wrappers are also reused across chunks,
and the rhythm spectral engine keeps its iSTFT working buffers for the next
stem and chunk instead of reallocating them.

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

When the vocal and rhythm quality packs are both active, vocal cleanup runs on
one reserved processor while rhythm inference uses the model worker pool. The
separation thread continues to own progress and stem-ready callbacks, so the
vocal can be published as soon as cleanup finishes without concurrent bridge
callbacks. Cancellation stops both tasks, and a failed GPU attempt still
discards its staged notifications before the CPU retry.

Cancellation aborts the **in-flight** ONNX run rather than waiting for the
current chunk (which can take tens of seconds on a slow CPU) to finish. Each
`Session::Run` is wrapped by `runCancellable()` (`stems/StemRunCancellation.h`),
which spins a lightweight watcher thread that calls `Ort::RunOptions::SetTerminate()`
the moment the cancel flag is set; ONNX Runtime then unwinds at the next op
boundary and the resulting `Ort::Exception` is translated to a normal
`StemFailureCode::Cancelled`. So `STEM_SEPARATE_CANCEL` lands in well under a
second instead of up to a whole chunk later.

The separation-progress dialog is driven by the reactive `stemSeparationState`
and reports **"Loading … model…"** while an uncached ONNX session is being
created. Cached sessions skip that stage. If DirectML has fallen back, the
dialog reports that separation is continuing on the CPU. The dialog stays open
through a final **"Writing files…"** phase: on `STEM_READY` the
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

When verbose diagnostic logging is enabled, `stem-perf` entries record renderer
preparation and import durations, backend decode, normalisation, separation and
WAV-write durations, ONNX session cache hits or misses, progress-message counts
and each job's total duration. RoFormer profile entries further split each run
into setup, host STFT/tensor preparation, ONNX inference, synthesis,
overlap-add, and finalisation. These timings are emitted in Release builds and
run only on the existing stem worker or renderer orchestration paths.

## Decoding compressed sources

`DecodedCache` turns any non-WAV source into a 16-bit PCM WAV in a central cache,
and everything downstream — playback, preview, waveform peaks, tempo and beat
detection, stems — reads that WAV rather than the original file.

**MP3 is decoded by the bundled `lame.exe`, not by JUCE's MP3 reader.** JUCE
mis-parses some MP3s outright: one 192 kbps file was sized as though it were
256 kbps, so every frame boundary after the first was wrong, every read failed,
and the file could be neither played nor analysed — it simply appeared to have no
tempo and made no sound. Across a 25-file sample JUCE also stopped short on 18 of
them, discarding up to a twentieth of a second that was quietly accepted as a
"short tail". LAME decoded all 25 in full, at the same speed (about 330 ms for a
five-minute track), and it was already shipped for MP3 export, so it costs no new
dependency.

Two consequences worth knowing:

- **LAME strips the MP3 encoder delay (typically 529 samples) that JUCE leaves
  in.** Decodes are therefore about 12 ms earlier than before. This is the
  correct gapless behaviour, but it does move the audio, which is why the change
  carries a `kDecodedCacheGeneration` bump — every MP3 is decoded again on first
  use and its beat markers recalculated against the corrected audio.
- **JUCE remains the fallback.** If `lame.exe` is missing or fails, the old path
  still runs, so this can only add coverage. The chosen decoder is recorded in
  the `decodedcache` log line for each file.

`lame.exe` is required at configure time (see *Continuous integration*), because
a build without it can neither export nor import MP3.

Decoding is validated by reading the result back with `WavAudioFormat` directly
rather than through `AudioFormatManager`. The manager picks a reader from the file
extension, and decodes land on a `.wav.tmp` staging path, so an extension-based
check finds no format for `.tmp` and rejects every good decode — which silently
disabled the LAME path while looking exactly like a decode failure.

Because an MP3 cannot be trusted to play through JUCE, `PREVIEW_LOAD` decodes an
MP3 that has no cache entry yet on a worker thread before auditioning it, instead
of handing the original to the engine. Only the newest audition is allowed to
load, tracked by its own request counter rather than the engine's preview
generation, which advances only after a successful load.

`AUDIO_FILE_PROBE` reads metadata rather than audio, but it read it through the
same JUCE reader — so it reported 225.99 s for the file above, and refused files
the reader could not open, on the import path before any decode was attempted.
It now probes the decoded WAV for MP3, so the duration recorded at import matches
the audio that will play, and the decode the import goes on to need is already
warm.

## Library panel

The bottom library panel stores source, stem, sample, and clip items as draggable tiles.
Tiles wrap to the available width and the panel scrolls vertically when there are more
tiles than fit; it does not expose a horizontal scrollbar. Each source tile shows
duration, detected key and detected BPM when those fields are available.
Use the filter field beside **Import** to narrow items by their displayed name,
artist, or BPM. The circled **X** clears the filter. A matching saved clip keeps
its source group visible and expands it for the duration of the filter. Press
**Escape** while the filter field is focused to clear it.

**Saved clips** — choose **Library ▸ Save Clip to Library** on a timeline clip to
turn its trim window into a reusable library entry. Saved clips are non-destructive
references back into their source file (same audio, same WAV cache, same BPM / key)
and are grouped underneath the source they came from. Each source group has a
disclosure chevron with **Show saved clips** / **Hide saved clips** tooltips; the
open/closed state persists with the project. Adding a new saved clip auto-expands
the group so the new clip is immediately visible. Dragging a saved clip tile onto a track creates a
timeline clip with the same source window and non-destructive warp defaults the
saved clip describes.

**Samples** — choose **Library ▸ Save as Sample…** on a timeline clip to open
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
a **simple sample** is a non-musical one-shot. A one-shot has no pulse, so it
**cannot hold a BPM at all**: classifying an item simple strips `bpm`, `beats`,
`beatAnchorSec`, `variableTempo` and `lowConfidence`, and every tempo writer in
`ProjectStateLibraryAnalysis.cpp` then refuses it, so detection, reanalysis and
inheritance cannot put one back. A key is still allowed — a one-shot can be in a
key. The baked WAV is added as a
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
  its **Open** menu: source, stem, and sample items open a **read-only
  preview** (select a section there to **Save Selection to Library**), while a
  saved **clip** item opens the editable editor.
- Double-click a **timeline clip body** (anywhere other than the title strip,
  which still inline-renames), or pick **Open ▸ Clip Editor** from the clip
  menu, to edit that timeline clip — its window, warp and pitch.

The dialog renders the source waveform with an adaptive time ruler that always
uses minute-and-second labels, retaining fractional seconds at close zoom, faint
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
`PREVIEW_SEEK` / `PREVIEW_SET_LOOP` / `PREVIEW_SET_WARP` / `PREVIEW_SET_ENVELOPE` /
`PREVIEW_SET_REVERSED` / `PREVIEW_SET_METRONOME` / `PREVIEW_SET_BRAKE` /
`PREVIEW_SET_BACKSPIN` / `PREVIEW_UNLOAD` → `PREVIEW_STATE` /
`PREVIEW_POSITION` / `PREVIEW_ENDED`) so the main transport is unaffected. A
monotonic `generation` counter on the preview voice means stale events for a
preview the user has already closed are silently dropped. While playing the
canvas follows the playhead with the same smooth ease-in catch-up the main
timeline uses.

The **Loop** toggle arms an engine-side loop window over the active playback
range — the selection if there is one, otherwise the whole preview window — via
`PREVIEW_SET_LOOP`, in preview-relative ms. The engine wraps the voice itself on
a 2 ms poll, exactly as it does for the timeline loop, so the restart is
seamless; the renderer only scrolls the view back when it sees the playhead jump.
Bounding playback at the end of a **non**-looped selection stays renderer-side,
as a one-shot stop is not latency-critical. See
[ADR 0023](adr/0023-engine-owned-timeline-loop.md).

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
  toggle. It narrows the in-dialog view to the current
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

### File browser (Files tab)

The bottom panel's **Files** tab browses folders of audio on disk so a track can
be found, listened to, and imported without leaving the app. Unlike the Library
tab it is **not project-scoped**: the folders belong to the user and persist
across projects and sessions.

**Adding folders.** The folder button in the narrow fixed column on the left
opens the native directory picker. That pick is the **consent step**: it is the
only way a path enters the browser, and it is what grants read access. Chosen
folders are stored in `preferences.json` as `ui.fileBrowserFolders` (absolute,
de-duplicated paths only — `sanitiseFileBrowserFolders` drops anything else, so
a hand-edited prefs file cannot widen the renderer's reach) and re-trusted at
startup by `restoreFileBrowserRoots` before the renderer can ask for an index.
Both the handlers and the crawl refuse any directory that is not a browser root
or inside one (`isWithinFileBrowserRoot`). `fileBrowserIndex.ts` collects only
subfolders and files with an importable audio extension, ignores symlinks so a
link cannot reach outside the folder, and sorts folders before files, each
natural-order A–Z. **Refresh** on a folder's right-click menu re-crawls its root
so files added or removed on disk since it was indexed are picked up; **Remove
Folder** (offered only on a folder the user added — nested folders leave with
their root) drops the folder, its index, cover URLs and read trust.

**The index.** `fileBrowserIndex.ts` crawls an added root **once**, in the main
process, and everything downstream reads the result: rendering a row, expanding
a branch and filtering the tree all answer from it, so the tree touches the disk
only when a folder is added, when the user asks for a refresh, or once at
startup to reload the cache. (Cover art is the single exception, read per
visible row — see **Rows** below.) One crawl produces both halves of what the
tree needs — every folder's listing (`folders`) and every file's tags (`tags`) —
because the filter matches on tags, so a lazy per-folder listing could never
answer a search without walking everything anyway.

The walk is breadth-first over an explicit queue rather than recursion, so a
deeply nested library cannot exhaust the stack, and tag reads run through a
worker pool of `INDEX_READ_CONCURRENCY` (8). Tag reads are IO-bound, so some
overlap is a large win over going one at a time, but an unbounded fan-out over
tens of thousands of files would open that many handles at once and starve the
rest of the app. A file whose tags cannot be read still enters the index: it is
browsable and importable, and its row falls back to the file name.

`isWithinFileBrowserRoot` is re-checked for **every** directory the walk is
about to descend into, not just the root, so nothing reachable from inside a
browsed folder can widen what is read. Symlinks are skipped outright — and on
Windows that covers junctions too, which Node reports as links rather than
directories — so a link planted inside a browsed folder cannot be followed out
of it.

**An unreachable root is not an empty one.** A disconnected drive, a share that
is down or a folder deleted since it was added would otherwise return an empty
listing that looks exactly like a library with no audio in it — and, worse, get
cached as though it were the truth. When the *root itself* cannot be read the
crawl stops and returns `unavailable: true`; `getFolderIndex` then neither
remembers it in memory nor writes it to the cache, so plugging the drive back in
and asking again simply crawls. The row says **Unavailable** and offers
**Retry**. A *subfolder* failing is treated as local damage: it contributes an
empty listing and the rest of the crawl is kept.

**Progress.** A large library takes seconds to crawl, so the index is reported
to the renderer *as it is built* rather than only when it is done. `getIndex`
and `refreshIndex` pass an `onProgress` reporter into the crawl; each slice —
the folders listed and the tags read since the last message — goes to the
renderer on `fileBrowser:indexProgress`, and `applyIndexProgress` merges it into
the same `children` and `info` the finished index would have filled. The tree
therefore **fills in folder by folder**: because the walk is breadth-first, the
folders nearest the root, which are the ones on screen, arrive first.

Slices are batched at `INDEX_PROGRESS_INTERVAL_MS` (120 ms) rather than sent per
folder or per file, which for a large library would put thousands of messages
across the bridge and cost more than the crawl. Each message carries only what
completed since the last, so applying them in order rebuilds exactly the index
the crawl finally returns — which is applied again at the end as the
authoritative copy. An index served from the cache reports nothing, because
there is no wait to fill.

The added folder's row shows a spinner and a caption while its crawl runs
(`indexLabel`). It counts files while the tree is still being walked and
switches to a ratio once every folder is listed, because until then there is no
total to count against. Two orderings matter for this to be visible at all: a
root is marked expanded **before** its crawl starts, not after, and a re-crawl
clears the old subtree **as it starts** rather than when it finishes — otherwise
a late wipe would throw away the slices that arrived meanwhile.

**The cache.** Each index is written to `file-browser-index.json` under
`app.getPath('userData')` and reloaded by `loadFileBrowserIndexCache` at
startup, after `restoreFileBrowserRoots` has re-trusted the saved folders, so a
restart shows the user's folders without crawling the disk again. It is written
to a sibling and renamed over the target, so a crash part-way through leaves the
previous cache intact rather than truncated JSON. It is a **cache, not user
data**: a missing or malformed file is not an error, it just means the next
crawl rebuilds it. Because it is an ordinary file on disk that anything could
have written, `reviveIndex` re-validates what it restores — a cached root the
user has since removed is discarded whole, and any folder outside the trusted
roots is dropped — so a hand-edited cache cannot widen the app's reach.

The read is started at startup but deliberately **not** awaited, because an
un-cached root is simply crawled on demand and this must not gate window
creation. That leaves a window in which the renderer could ask for a root before
the cache has been read, so `getFolderIndex` awaits the same shared promise: a
root asked for mid-read waits for the cache rather than starting a crawl of a
library that was already indexed last run.

**Rows.** Each file row shows a cover-art thumbnail (hover it for a larger
preview, teleported to `body` so the scrolling tree cannot clip it), the track
name from the file's tags falling back to the file name, artist, album, file
type, a live playhead while the file is auditioning, and the tagged duration.
Tags come from the index, so a row costs nothing to display. Cover art is the
one thing left out of it and read lazily when a row mounts: it is large binary
data, and eagerly reading a library of tens of thousands of files would create
that many Blob URLs and bloat the cache file for artwork almost none of which is
on screen. Cover bytes stay out of reactive state — only the Blob URL is
exposed, and it is revoked when the folder is removed. Each row carries **Back
to start**, **Play / Pause**, and **Import** buttons; the same actions are on
its right-click menu. Import runs through `importAudioPathsIntoLibrary`, the
same path as a drag-and-drop import, so a browsed file becomes an ordinary
library item with no special casing downstream. The **whole row** is the click
target — a click selects it and a double-click plays it, wherever on the strip
of columns it lands, matching how folder rows already behaved. The button
cluster stops double-clicks so a quick second press on Play or Import cannot
also toggle row playback.

**Dragging a row onto a track.** A file row is `draggable`, so a browsed file can
be imported and placed in one gesture. The row is not a library item yet, so the
drag cannot use `useDropZone`'s library path; it is handled by
`useTimelineFileDrop`, which already had to import-then-place for an Explorer
drop and now treats a browsed row as a second source of paths. The row's path
travels as `application/x-silverdaw-file-path` and is mirrored into
`fileBrowserStore.draggingPath`, because `dragover` cannot read `dataTransfer` —
the same constraint, and the same remedy, as `library.currentDragItemId`. On
drop, the path is imported through `importDroppedAudioPaths` (shared with the
Explorer drop, and de-duplicating against an already-imported path) and the
resulting item is placed on the track under the pointer, or on a new track when
the drop lands below the last one. The drag shows the **same drop ghost** a
library drag does: `useTimelineFileDrop` feeds `useDropZone`'s
`previewExternalDrop`, so one renderer draws every timeline drop and the gesture
cannot look like two different features. Length is whatever the drag can supply:
a browsed row uses the duration already read from its tags, while an Explorer
drag has none, because `dragover` hides the file until drop. When there is none,
`DropPreview.durationMs` is `null` and the ghost runs to the edge of the view
rather than changing shape — a clip that long has its end off-screen anyway, so
it still reads like any other drop.

**Refreshing.** A refresh re-crawls the whole added root, because the index is
stored and cached per root rather than per folder. The crawl's tags are
**authoritative and replace** what the store holds, rather than merging into it:
`FileBrowserFileTags` omits an empty field instead of carrying an explicit
`undefined`, so a merge would keep showing an artist the user has since cleared
on disk. `fileBrowserInfoWithTags` carries the already-fetched cover URL across
that replacement, or a visible row's Blob would be dropped on the floor and
leaked. `pruneMissing` then drops rows, selection and cover URLs for anything
the re-crawl no longer lists.

Cover art needs its own step, because it is not part of the index: a refresh
revokes and clears the cover state for the refreshed subtree and bumps
`coverEpoch`, which mounted rows watch so they ask again. Without it, artwork
changed on disk would keep showing the old image for as long as its row stayed
on screen. The re-read is still driven by the rows, so a refresh pays for the
covers actually on screen and no more.

**Auditioning.** Playback uses the shared backend preview voice through the
chosen audio output device. `PREVIEW_LOAD` gained an optional `filePath` for
this: the file is not a library item, so there is no `libraryItemId` to resolve
(see [Bridge protocol](#bridge-protocol)). Only one thing plays at a time, so
starting an audition stops project playback, and removing a folder stops the
audition. The file being auditioned is also shown in a **bar above the tree**,
outside the scroll container, so a file that is *sounding* is never lost to
scrolling or a filter. The bar is a handle on live playback rather than a
history: it carries a row only while the audition plays, so pausing it — or
letting it finish — empties the bar instead of leaving a stale row sitting on top
of a filtered list. The strip itself is always rendered and keeps a row's height
whether or not anything is playing, so starting and stopping an audition cannot
shunt the tree up and down under the pointer. Idle it holds a **Nothing playing**
label and the same transport and Import controls in their disabled state, so the
reserved space reads as the audition slot rather than as a gap. The strip is its
own component, `FileBrowserAuditionBar.vue`, which reads `pinnedAudition`
directly rather than taking it as a prop. The file stays
listed in its own folder throughout.

A format the engine cannot decode is auditioned from a transcoded WAV (see
[Audio formats](#audio-formats)), so the preview voice does not always hold the
path shown in the tree. Two consequences shape the store:

- Row identity comes from `auditionSourcePath`, exposed as the `auditionedPath`
  getter, which is only claimed while the voice still holds the exact path the
  browser handed it. That makes the claim self-releasing: the Clip Editor or
  Scratch Editor taking the shared voice clears the browser's playing row
  instead of leaving a stale one lit. Anything reasoning about "which row is
  playing" — the pin, `isPlaying`, `positionMs`, `pause`, `restart` and
  `revealAudition` — must go through it rather than reading `previewStore`.
- A decode takes seconds, so `prepareAndPlay` holds two claims across it: the
  browser's own `preparingPath`, and `previewStore.loadSeq`, a counter bumped by
  every load, audition and unload of the shared voice. If either has moved on by
  the time the WAV is ready the audition is abandoned, so a slow decode cannot
  seize a voice something else has since taken.

**Filtering.** The field in the panel header matches a file's tagged title, its
displayed name, or its artist. Because the index already holds every folder and
every file's tags, filtering is a **synchronous read of in-memory state** — no
crawl, no IPC, no disk access — and files in folders the user has never opened
are still found. Matching folders are force-expanded by the `rows` getter for as
long as the filter is set, rather than by writing to `expanded`, so the user's
own disclosure state is never touched and simply reappears when the filter is
cleared. Clearing it also reopens the audition's folders and reselects it, so
the view scrolls back to what is playing.

`fileBrowserActiveFilter` treats anything shorter than
`FILE_BROWSER_FILTER_MIN_LENGTH` (3) as no filter at all, since one or two
characters match almost every track and so narrow nothing. Everything that hides
rows reads the active filter rather than the raw text, so a half-typed word
leaves the tree exactly as it was. No debounce is needed — with the index in
place a keystroke costs a re-render and nothing more, exactly as the Library
tab's filter does over its in-memory array.

**Keyboard.** The tree is a single tab stop rather than one per row (list rows
carry no focus ring — see the UI styling instructions). Switching to another tab
unmounts the view, so returning to **Files** puts the tree back at the offset it
was left at (kept in the store, which outlives the component), brings the
selection into view if that offset does not already show it, and takes focus, so
the keys below work without a click first. `↑` / `↓` walk the
visible rows, so filtered and collapsed rows are skipped and both ends stop
rather than wrap; `Enter` opens or closes a folder and plays or pauses a file;
`Delete` removes a selected added folder. The same keys work from the filter
field and drive the tree, and clearing the filter with `Escape` or its clear
button hands keyboard focus back to the tree. Both app-wide keyboard owners —
`onGlobalShortcutKey` — listen on `window` in the **capture** phase, so a
component cannot call them off with `stopPropagation`. `lib/selectionKeys.ts` is
the single opt-out: a list that drives its own selection marks its container
`data-owns-selection-keys="true"`, and both owners stand down for the keys in
`SELECTION_KEYS` (`ArrowUp`, `ArrowDown`, `Enter`) and for the `Delete`
selection actions. The files tree claims those keys **whenever focus is inside
it**, not only while a row is selected: the attribute expresses which container
owns the keyboard, and the tree's own handlers already do nothing without a
selection. Gating it on the selection instead let `Delete` fall through to the
timeline's *Delete Clip* while the user was looking at the Files tab, which is
destructive and invisible from there. `ArrowLeft` / `ArrowRight` are
deliberately not in the set — no self-navigating list uses them, so they stay
with the global playhead seek.

Focus stays on the tree container rather than moving row to row, so the tree
names the selected row with `aria-activedescendant`; without it a screen reader
announces the tree but never the row the arrow keys are on.

## Scratch Editor

The **Scratch Editor** is a large modal dialog for performing a vinyl-style
scratch over one audio source, editing the recorded performance, replaying it
non-destructively, and saving it as a reusable scratch pattern. It is a **studio
authoring** surface, not a live-performance instrument. The full design contract
— session ownership, the real-time/platter/crossfader model, the action-pattern
format, and the backing monitor — lives in
[ADR 0021](adr/0021-scratch-editor-action-patterns.md); this section covers the
protocol, module layout, and UI detail that ADR does not.

**Input hierarchy.** Supported MIDI DJ decks are the primary Scratch Editor
input. The on-screen deck's experimental trackpad and keyboard controls are a
less expressive fallback for creating a simple pattern, which the notation
editor can refine into a more complex scratch.

**Opening.** A single reused dialog instance is hosted in `App.vue` and driven by
`useScratchEditorStore`. It opens either from a **timeline clip** (**Open ▸
Scratch Editor**, enabled only for a resolved clip that has a library
item) or from a **library item** (the library-tile context menu, any kind —
including a previously saved scratch-origin item, which prepares its session
from the self-contained `scratchSourcePath` snapshot written at save time — the
exact source window the scratch was performed over — rather than the baked WAV
or a fresh crop of the current source). Imported scratches copy this snapshot
with their notation. The editor draws and auditions the snapshot rather than
the rendered scratch sample. It never seeks, starts, or stops the arrangement
transport; it runs its own audition session and blocks the global keyboard/MIDI
gate while open.

**Session model.** The renderer opens and closes a backend session with
`SCRATCH_SESSION_OPEN` / `SCRATCH_SESSION_CLOSE`; the open payload carries exactly
one of `clipId` or `libraryItemId`. Preparation renders a linear, seekable
scratch source from the target's source window, reverse, warp, and static pitch,
off the audio thread, through the disk/cache boundary (never the text bridge).
The backend claims a single **virtual/session deck** — pointer and keyboard
control always target deck 1; a MIDI device claims whichever of its two decks
(1 or 2) touches or moves first, and only one device or pointer/keyboard source
can own the session at a time — and emits throttled, display-only
`SCRATCH_SESSION_STATE` at up to half the 60 Hz playhead-timer rate (~30 Hz),
skipping a tick unless status, crossfader, or replay position changed or the
session is playing, recording, replaying, or touched; pointer/keyboard controls
are sent as `SCRATCH_SESSION_CONTROL` and the renderer never drives audio
timing. Preparation status and progress surface on the dialog until the source
is `ready`.

**Transport and platter.** The backing panel sits at the top of the dialog and
hosts the transport (skip-to-start, play/pause, skip-to-end); `Space` toggles
play/pause and `R` toggles record. **The transport drives the backing channel
only**: play runs/stops the prepared backing bed and skip seeks it — it never
spins the scratch clip, which is heard **only when the platter is jogged**. The
transport is disabled until a backing is prepared, and while recording. The
on-screen platter uses a 33⅓ RPM timebase (`VinylScratchProcessor::kSecondsPerTurn`
= 1.8 s per revolution at nominal speed); dragging or wheel-jogging it scrubs
the source bidirectionally (the wheel gesture direction is inverted so it
matches the expected scratch direction). Rate response uses two smoothing
weights selected by touch state: a heavier ~13 ms weight while the platter is
actively held (`manualRateSmoothingSeconds`) gives light/high-resolution jog
wheels a modest rotational-inertia feel, and a fast ~4 ms weight
(`rateSmoothingSeconds`) applies on release/at motor speed; touch-off always
engages the fast weight immediately, so it never delays how quickly releasing
the platter is heard. MIDI tick totals also retain the physical endpoint of a
touch gesture; release aligns the source to it so repeated pullbacks do not
accumulate displacement loss. Movement beyond the prepared source produces
de-clicked silence — the source never wraps. Recording captures compact **platter** and
**crossfader** keyframes (not audio), preserving the currently selected scratch
source position against a local clock, and still spins the scratch over the backing. A live **timing
readout** (`m:ss / m:ss`, position / prepared length) sits under the transport
and is **always shown** (dimmed until a bed is ready) so it never reflows the
panel; it is driven by the `backingPositionUs` snapshot field on the scratch
session state.

**MIDI deck controls while the editor is open.** The physical deck **Play** button
drives scratch recording, mirroring the on-screen **Record** button: idle → arm,
armed → cancel, recording → stop. An armed take still starts on the first
eligible platter touch, and the completed pattern is published to the notation
panel on stop. **Cue** runs the same **Build** action as the backing panel; it
builds or rebuilds the selected backing configuration. The backing bed's
play/pause transport is not MIDI-driven. The platter and crossfader control the
active session directly, while every other deck action remains blocked by the
modal editor except master volume. Recording is handled in the backend router
(`MidiScratchRouter::routeImmediate` → `scratchMidiRecordToggle()`), gated on
scratch-session existence: with the editor **closed** the engine method returns
`false` and the event falls through to the frontend's timeline handling; with the
editor **open** the frontend is interaction-blocked, so the also-broadcast event is
ignored (no double action).

**MIDI search / outer-wheel control.** The separately encoded `jogSearch`,
`wheelPitchBend`, and `wheelSearch` controls seek the ordinary main timeline
when the Scratch Editor is closed. They are intentionally excluded from the
Scratch Editor because they do not report contact; Scratch ownership requires a
platter touch signal where the controller provides one.

**Crossfader and keyboard cut.** The virtual crossfader controls only the scratch
deck's gain via a stored `linear-v1` curve (deck-1 audible at value 0). The
on-screen fader **bar** is coloured by fader position and a display `reversed`
flag whose meaning depends on the control source; deck ownership and platter touch
never change it. When a **MIDI** device owns the session
(`ownerDeviceIdentifier` set), the bar mirrors that device's crossfader
**direction** preference (the display-only `crossfaderReversed` flag, `true` =
`rightToLeft`): `leftToRight` fills blue from the left as the knob moves right
(blue at the right extreme), and `rightToLeft` mirrors it (blue at the left
extreme). The session's display direction is retained when platter ownership is
released, so touching or releasing the platter never recolours an unchanged
fader. The `L`/`R` label on the blue extreme is accented, and changing
colouring never moves the knob. When the fader is focused, `←`/`→` step it (0.02,
or 0.1 with `Shift`) and `Home`/`End` jump to the extremes. A **keyboard
cut** works globally within the editor: each non-repeating press of the configured
key **toggles** the fader between open (deck audible) and closed. The resting
state is **open**, asserted once the session is controllable so the fader and
audio agree before any key is pressed. The key is **Z**
(right-handed, default) or **M** (left-handed), chosen in **Preferences ▸ Effects**
(see below). While recording, the cut is captured like any other fader move.

**Backing accompaniment monitor.** Optionally, the user picks a set of timeline
tracks to play underneath the scratch as a fixed-length **backing bed** to
scratch against (see [ADR 0021](adr/0021-scratch-editor-action-patterns.md)).
The window is a start **anchor**
(*arrangement start* or *current playhead*) plus a **duration** of **60 or 120
seconds**, or **Full** (the whole arrangement from the anchor to the last clip
end) — default 120; when active it bounds the session's forward time.
The default track selection is *every track except the clip's owning track* (to
avoid hearing the source twice), chosen from a **checkbox dropdown** (so it scales
to many tracks) and editable while the bed is stopped. **Tracks muted on the
timeline** (explicitly muted, or silenced by a solo elsewhere) are always shown
**unchecked and disabled** and are filtered out of the bed, so the selection
mirrors what is actually audible. Because the
bed is a fixed pre-render, the track selection, anchor, and length (and the
**Build** button) are **locked while the backing is playing** — changing them
would only take effect after a fresh build, so they cannot be swapped in live.
A **Loop** toggle (off by default) controls what happens at the bed's end during
plain playback: when on, the bed restarts from its head instead of stopping, so
the accompaniment runs continuously while the performer scratches over it; loop is
ignored while **recording** (the take is still bounded by the window). The flag is
authoritative on the backend (`backingLoop`) and honoured in the end-of-window
reconciliation for the on-screen backing transport. The physical MIDI Play
button controls recording while the editor is open and never starts the bed.
The bed is a pre-rendered linear mixdown prepared off the audio thread; the
**Build** button shows a spinner while working and rebuilding simply replaces
the existing bed (there is no separate Clear action). Two **monitor-only** gain
trims (`0..1`) balance what the performer hears — a **Monitor** (backing) gain
(default 100%) in the backing panel, and a **Scratch** gain (default 85%, so the
source sits under the backing while auditioning) sited **beside the deck** it
trims rather than in the backing panel; **neither is baked into the recorded
pattern, mixdown, or exported sample** (see
[ADR 0021](adr/0021-scratch-editor-action-patterns.md)). The backing is
monitor-only and never reaches committed output.

**Notation, cropping, and editing.** The recorded pattern is shown as an editable
notation view (forward/reverse platter segments, hold spans, and a crossfader
lane) over the source waveform. Recording preserves the scratch source's current
position, so a take can begin at any phrase in the prepared source; only the
backing bed restarts at its head. The notation starts at a real time scale of
180 pixels per second rather than compressing a long take into the panel. It has
minute-and-second time markers, retaining fractional seconds at close zoom, zoom
controls (100%–800%), a horizontal scrollbar when needed, and smoothly follows
replay with the playhead held near the centre of the viewport.

Click a notation point to select it, then drag it or use the keyboard controls
listed below. Double-click a lane to add a point; right-click an editable point
to remove it. Endpoint points remain pinned. Every notation edit changes the
action data, marks the draft dirty, and participates in the notation-local
undo/redo history; one point drag is one undo step. Cropping clips the lanes,
evaluates values at the new boundaries, rebases time to zero, and preserves the
source offset. Waveform peaks are resolved from the target's **source item** (a
saved clip resolves to its source library item), windowed by the clip's
in/duration.

**Persistence, replay, and sample output.** Completed patterns are additive,
backend-authoritative project state (in the `ValueTree`, written through the
versioned project JSON). A pattern stores a stable id, name, `version` (1),
duration and crop range on an integer µs timebase, the start source offset,
platter and crossfader keyframes, the owner deck side, the `linear-v1` curve id,
and optional source provenance. The persistence panel saves, updates, renames,
deletes, auditions, and applies patterns to a clip (a clip references a saved
pattern non-destructively); it also replays the current unsaved draft ("Play
Scratch") and discards it ("Clear", which resets the notation panel to its empty
state without touching saved patterns). Dirty state is tracked against a canonical
baseline. While a draft or pattern is auditioning, the backend publishes a live
replay position on the session state (`replaying` + `replayPositionNormalized`,
0→1 across the cropped window) at the ~30 Hz emit rate; the waveform playhead
tracks the scratch clip's source position (`positionUs`, which scrubs with the
platter) and a green playhead sweeps the notation lanes so the performer can see
where replay is. The backing panel's transport and configuration are
**disabled** for the duration of an audition. Replay is independent of the
arrangement and backing transport controls, but when a prepared bed exists the
backend rewinds and plays it from its head in sync with the scratch; without
one, replay is scratch-only. The backing Play button does not switch to a
playing look because replay does not change the session's ordinary transport
status.
Live audition, timeline playback, mixdown, and rendering a new library sample all
use the same closed-form trajectory evaluator, so live and offline replay of a
stored pattern are identical regardless of block size or seek history. An
in-progress recording is transient (engine loss aborts it); a committed pattern
is covered by normal save, autosave, undo, and recovery.

**Save to the library.** Saving sends `SCRATCH_SAVE_AS_SAMPLE` (see
[Bridge protocol](#bridge-protocol)), which bakes the pattern over the prepared
source into a frozen stereo WAV library item. A first save mints a fresh
`scratch-<id>` item id; re-saving a scratch-origin item reuses its existing id
so the library tile, badge, and any placed clips keep referencing the same
item while the underlying revision file is replaced atomically. The saved item
carries `scratchOrigin: true` and `scratchPatternId` (driving a dedicated vinyl
tile icon and "Scratch" badge in the library panel instead of the generic
sample tile) plus the `sourceItemId` / `sourceInMs` / `sourceDurationMs` fields
sent in the save payload, so "Open in Scratch Editor" on that tile (see
**Opening**, above) can show the original source context rather than the baked
audio.

## Recording

**Record Audio** captures live input — vocals, an instrument, a line input, a
sound effect — while the arrangement plays, and turns the result into an
ordinary library item. It is a transactional modal, not a record-armed track:
the full design contract lives in
[ADR 0030](adr/0030-audio-recording-capture-model.md), and this section covers
the module layout and behaviour that ADR does not.

**Opening.** The transport's record button and **File ▸ Record Audio…** both
open the one dialog, hosted lazily in `App.vue` and driven by
`useRecordingSessionStore`. `R` records and stops **inside the dialog only**,
exactly as the Scratch Editor claims it, so there is no global record shortcut.

**Session model.** `useRecordingSession` opens a backend session with the dialog
and closes it with the dialog — including on unmount, on engine recovery, and
for a session whose first state arrives after the dialog has gone — so an
abandoned dialog can never leave a capture device held open. The store mirrors
`RECORD_SESSION_STATE` and rejects broadcasts from sessions the renderer has
already closed. Only one session can exist; opening a second closes the stale
one.

**Capture path.** The engine is opened output-only, so recording runs its own
standalone input-only `juce::AudioIODevice` (`CaptureDevice`) outside the
engine's `AudioDeviceManager`: playback is never reconfigured or restarted, and
the input may come from a different driver type entirely. `InputCaptureTap` is
the capture-side real-time callback — it allocates nothing, publishes atomics
for metering and drift measurement, and hands blocks to a
`juce::AudioFormatWriter::ThreadedWriter` that does its file I/O on its own
thread (`RecordingWriter`). A device that presents many inputs is narrowed to
one chosen channel or one adjacent pair rather than captured whole. Nothing from
the engine is ever mixed into a recording — the tap writes only the capture
device's own input channels — so a backing track or metronome audible in a take
was picked up acoustically, or came from a loopback input (a "Stereo Mix" style
device) chosen as the source. **Input gain** is applied here too, in the same
callback: a pre-sized scratch buffer holds the gain-applied copy, so the file
and the meter always show the same signal and nothing is allocated on the audio
thread. It is the one setting that can be changed while rolling — a performer
who is clipping should not have to lose the take to fix it.

**The record window.** A recording belongs to a window in time, not to a track:
either from the playhead until **Stop**, or over the existing timeline range
selection, which stops itself at the end of the range. The optional count-in is
one bar or none — a second bar was a choice nobody needed to make — and is the
existing metronome over a preroll: the
transport simply starts early and the preroll is trimmed at finalise. The
count-in only borrows the metronome: the click through the take itself is the
project's own metronome setting, which the dialog exposes as **Click While
Recording** so it can be changed without leaving the dialog (the same state the
`K` shortcut toggles, and monitoring only — the click is never captured).
Capture is capped at `MAX_RECORDING_SECONDS`; hitting the cap stops the
recording and keeps everything captured up to that point. **Cancel** (and
Escape) work at any point before a commit, including mid-take: closing the
session stops the transport, abandons the capture and deletes the part-written
file, so there is never a half-recording to clean up. Only an in-flight commit
holds the dialog open, because closing then would race the `SAMPLE_SAVED` ack.

**Finalise.** Input and output are two unrelated clocks, so latency and drift
are corrected **once, offline**, in `finaliseRecording` on a worker thread:
round-trip latency (plus any count-in) is trimmed from the head, and clock drift
is corrected by resampling to the ratio measured from the capture callback's
own tick stamps. Streamed in blocks, so a long recording never has to fit in
memory. A recording over a range selection is also trimmed at the tail to the
exact length of its record window: capture always overruns the window end by
however long the auto-stop takes to reach the message thread, and a beat count
claimed for a file that is fractionally longer than it says resolves to a tempo
that is not the project's (ADR 0024 derives a source BPM from beats ÷ duration
in preference to a stored one). The trim makes the claim true of the audio;
material too short to trim keeps its length and carries no beat count. The
finished file lands in the project's `recordings/` artifact folder and is
announced by path with `RECORD_RECORDING_READY`; recorded audio never crosses
the bridge.

**Choosing an input.** The dialog lists one row per physical input device,
deduplicated across the drivers that expose it and with driver aliases (the
DirectSound "Primary Sound Capture Driver", the legacy Sound Mapper) filtered
out — the same treatment `useUniqueAudioDevices` gives the output picker, from
which `recordingInputOptions` borrows `isPseudoDeviceName` and the backend
preference order. Which *driver* those devices come from is a machine-wide setup
decision, so it lives in **Preferences ▸ Audio** (`useRecordingInputDriver`,
default automatic) next to the output driver, not in the dialog: picking a
microphone never means picking a backend first. The preference is stored in the
existing user-scope `audioInput` pair, and the dialog writes back only the
device it resolved to, leaving the driver as the user set it. A device that
presents many inputs is offered as **Mono** or **Stereo** from its first
channels rather than as a raw channel list — "Channel 5" means nothing to
someone holding a microphone. Input and output remain independent: a recording
device is chosen here and never follows the project's output device.

**Review and commit.** The dialog's review state draws the finished recording
from its peaks cache, auditions it through the shared preview voice, and offers
**Record Again** (throws the file away and re-arms), **Add to Library**, and
**Add to Timeline**. The take can be heard on its own or, with **Play With the
Arrangement**, against what was playing under it: the preview voice carries the
take while the project transport rolls from the recording's anchor, and the
timeline is parked back at that anchor when playback stops. `PREVIEW_PLAY`
pauses the transport, so the arrangement is always started after the audition is
actually rolling, never before. A commit writes a normal `sample` library item —
no new library kind — marked `recordingOrigin`, with `audioType = "music"` and
the project's own BPM applied as a **known** tempo rather than a detected one,
so a later project-tempo change warps it like any other clip. The timeline exit adds
the item and places a clip at the recording's anchor inside a single undo
transaction. Its destination is resolved by `resolveRecordingTrackId`: the
selected track only when that track holds no clips at all, otherwise a track of
its own, and either way the row is scrolled into view (`requestRevealTrack`) so
a recording never lands out of sight or on top of what is already arranged. The
backend applies the same rule for a commit that names no track. Commits are
acknowledged by `SAMPLE_SAVED`, correlated by the renderer-generated `itemId`.
Recordings are named `Recording 1`, `Recording 2`, … and renamed later like any
library item or clip.

**Failure reporting.** Each failure is a distinct thing that happened, because
"recording failed" on its own makes a working feature look broken: no input, the
device refused to open, the device delivered nothing but digital silence (the
signature of absent Windows microphone consent — the MSIX package therefore
declares the `microphone` device capability), the device went away, no disk
space, the file could not be written, and the length cap. `recordingMessages.ts`
maps each to a sentence saying what to do next, and an overrun that dropped
samples is reported rather than handed over as a silently damaged recording.

**Out of scope for the first release.** Track record-arm, multi-input capture,
punch-in and stacked passes, comping, live-growing clips on the timeline, and
low-latency software monitoring — input metering is always live, but Silverdaw
does not play the input back, so performers use headphones or their interface's
own direct monitoring.

## Preferences

User preferences are persisted as JSON at `%APPDATA%/Silverdaw/preferences.json`
and edited via the in-app **Edit → Preferences…** dialog. The dialog is
**transactional**: every field is held in a local working copy until you click
**Save**; **Cancel** (and `Esc`) discard pending edits without touching the
engine or the file. The settings are organised into eight tabs on a left-hand
sidebar:

- **General** — appearance: the **waveform display** mode (single vs. left/right
  channels), library tile imagery, and toast notifications.
- **Timeline** — timeline behaviour: follow-playback auto-scroll, **set project
  tempo from first clip** (seed a new project's BPM from the first clip dropped),
  **auto-warp clips to project tempo** (default on, including variable-tempo
  music; governs both the drop and a later project-BPM change), beat-grid
  alignment after analysis, and the transport **previous /
  next button target**.
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
  that effect; they are also re-sent on each backend reconnect. This tab also
  provides **Scratch realism** (Off / Medium / High, default Medium). It applies
  held-platter high-frequency softening and low-level groove texture to every
  Scratch Editor input source through `SCRATCH_REALISM_SET`, without changing the
  recorded platter trajectory. This persisted `scratchRealism.level` preference
  is also re-sent on each backend reconnect. The tab also
  hosts the **Scratch crossfader cut** key used inside the Scratch Editor — a
  toggle that closes or opens the crossfader (open at rest) — choosable as **Z**
  (right-handed, default) or **M** (left-handed). It is a renderer-only
  preference (`scratch.crossfaderCutKey`, values `KeyZ` / `KeyM`) that is never
  sent to the backend; an unrecognised persisted value falls back to `KeyZ`.
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

The **MIDI Monitor** is available from **Preferences ▸ Developer**. It retains
the latest 200 raw messages from enabled inputs and shows timestamp, device,
message kind, controller code, and value. See
[MIDI deck controllers](midi-controllers.md) for setup, all supported model
names, mapped behavior, controller feedback, and troubleshooting.

Persisted fields:

- Window bounds + maximised state.
- Panel sizes (track-header column width, clamped to 180–480 px so the header's
  own button row never squashes; library panel height).
- **Bottom panel minimised state** — `ui.libraryPanelCollapsed`. When on, the
  bottom tabbed panel is collapsed to its tab strip; expanding it (or clicking a
  tab) restores the last height. Persisted independently of the project so it
  survives relaunch without marking the project dirty.
- **Follow playback** — continuous-follow auto-scroll. When on, the timeline scrolls so the
  playhead stays near the centre of the viewport during playback (default). Off pins the
  view in place. Toggleable in the transport bar (chevron-in-circle icon) and the
  Preferences dialog. Follow eases *forward* only, since playback never runs
  backwards and easing back introduces scroll jitter — so on the frame follow
  begins, a playhead left outside the viewport by a zoom or a manual pan enters
  a one-off **recovery** scroll that eases in either direction until the view is
  centred, then hands back to steady-state follow. Without that, starting
  playback with the view scrolled past the playhead appeared to do nothing at
  all. Recovery eases rather than jumping, because a jump reads as a glitch
  rather than as the view catching up. Both modes share one deceleration curve
  in `playbackFollow.ts`.
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
  auto-warp are left untouched. It applies **only** to this analysis-time snap: a grid
  correction made in the Clip Editor slides the audio inside the clip unconditionally
  (see *Beat markers and source-beat snap*), because that holds the clip still rather
  than re-placing it and so is never unwanted.
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
  `SILVERDAW_OUTPUT_DEVICE_NAME` env vars at spawn time. The engine also
  remembers whichever output it last opened successfully and re-selects it, once
  per device-list change, if JUCE has quietly reverted to the system default —
  which it does whenever it decides the open endpoint went away, including on an
  unrelated event such as a capture device being opened for a recording. A
  restore that fails is not retried for that device, so a genuinely gone device
  still falls back rather than looping. May be overridden per
  project (see [Project properties](#project-properties)).
- **Recording input driver** — the driver recording inputs are listed from,
  stored in the same user-scope `audioInput` pair (a `null` `typeName` means
  automatic). Chosen in Preferences ▸ Audio, never in the Record Audio dialog;
  see [Recording](#recording).
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
- **Show Developer Tools** — enables DevTools shortcuts independently of file
  logging.
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
- **Stalled device recovery** — a device can also stop delivering audio without
  ever being removed: JUCE's WASAPI thread exits on a stream error and does not
  come back, leaving the transport reporting `playing` with a playhead that never
  moves and no sound. `DeviceCallbackGuard`
  (`backend/src/engine/DeviceCallbackGuard.{h,cpp}`) wraps the device callback,
  logs `audioDeviceAboutToStart` / `audioDeviceStopped` / `audioDeviceError`, and
  exposes `isDeviceRunning()`. Those are device-thread *lifecycle* callbacks, not
  the block callback, so logging in them is safe; the block callback itself is
  pure forwarding and adds no real-time work. A message-thread watchdog in
  `AudioEngineDevice.cpp` (`checkAudioDeviceHealth()`) then polls
  `MasterClockSource::getCallbackCount()` every `kDeviceWatchdogIntervalMs`; the
  counter advances on every block regardless of transport state, so a frozen
  count is an unambiguous stall even while idle. After `kDeviceStallTicks`
  consecutive ticks with no progress it calls `restartLastAudioDevice()`, capped
  at `kMaxDeviceRecoveryAttempts` so a genuinely dead device can't spin. A
  stalled device is now either recovered or, at minimum, named in the log
  instead of failing silently.
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
  "Use Application Settings" entry that clears the override. The saved
  preference is a `(driver, device)` **pair**, because the same physical device
  can be exposed by several drivers under different names and latencies, so the
  pair is the device's real identity. If that pair isn't present at
  project-load, an `AudioDeviceUnavailableDialog` informs the user
  and the engine falls back to the next available device; the project preference is left
  intact so re-plugging or re-saving restores it. Drivers are machine-wide, so
  the usual cause is a missing *device* under a driver that is still there
  (unplugged, powered off, renamed); `audioUnavailableSavedTypeAvailable`
  distinguishes that from the rarer case of the driver itself being absent
  (for example ASIO with no ASIO driver installed), and the dialog wording
  differs accordingly so the driver name is never mistaken for the thing that
  is missing. The same distinction governs the driver dropdown: `(not
  available)` is appended only when the driver is genuinely not installed, and
  when the chosen device is absent the list falls back to every installed
  driver (the device-scoped subset is unknowable while the device is gone).
  Shares the device list (real
  named devices only, pseudo-endpoints filtered) with the Preferences ▸ Audio
  picker via the single composable in `lib/audio/audioOutputPicker.ts`, which
  also owns `buildDriverOptions` — the pure builder behind the driver dropdown.
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

> **Scope.** This is the shipped foundation: probe envelope, target-rate field,
> prompt dialog, RATE indicator and classification gates. An on-disk rate-keyed
> playback cache and project-rate change-and-rebuild are tracked as Phase 8 work
> in [the development plan](development-plan.md).

## Keyboard & mouse reference

The timeline accepts the following inputs. Modifiers behave **live** during drags — pressing
or releasing the modifier between frames switches mode without restarting the drag.

The full, version-matched shortcut reference is published online and opened from **Help ▸
Keyboard Shortcuts**. Its path includes the running app's `app.getVersion()` before
`/guide/shortcuts`, so a release must have the matching versioned page live.

### Application commands

| Input | Effect |
|---|---|
| `Ctrl + N` / `Ctrl + O` | Create a new project or open an existing project. |
| `Ctrl + S` / `Ctrl + Shift + S` | Save the current project or open Save As. |
| `Ctrl + I` / `Ctrl + T` | Import audio into the library or add a track. |
| `Ctrl + M` / `Ctrl + E` | Open Export Mixdown or exit the application. |
| `Ctrl + J` | Toggle the Library / FX panel. |
| `F11` | Toggle full screen. |
| `Ctrl + 1`–`Ctrl + 8` | Set timeline zoom to 100%–800%. |

### Dialogs

| Input | Effect |
|---|---|
| `Enter` | Accept the dialog — activates its footer's primary (blue) button, exactly as clicking it would. Disabled primaries are left alone, so a dialog with an invalid form cannot be submitted by keyboard any more than by mouse. |
| `Escape` | Cancel the dialog, discarding any draft it was holding. |
| `Tab` / `Shift + Tab` | Move focus within the dialog; focus is trapped inside it. |

`Enter` is wired once for the whole application by `useDialogDefaultButton`,
which works off the rendered DOM rather than per-dialog handlers — any dialog
built from the documented `.dialog-*` markup inherits the behaviour, including
ones added later. It stands down wherever `Enter` already means something
locally, so it never overrides a newline in a textarea, a focused button (so
`Cancel` stays `Cancel`), a `<select>` committing its value, an IME candidate,
any modified `Enter`, or a dialog that claims the key itself with
`preventDefault()`. Dialogs whose footer offers no single safe accept — the
progress dialogs, and the recovery dialog with its per-item **Restore**
buttons — carry no primary button and so have no default.

### Library file browser

These apply to the bottom panel's **Files** tab, and only while a row is
selected — see [File browser (Files tab)](#file-browser-files-tab).

| Input | Effect |
|---|---|
| `↑` / `↓` | Move the selection through the visible rows. Collapsed and filtered-out rows are skipped; both ends stop rather than wrap. |
| `Enter` | Open or close the selected folder, or play / pause the selected file. |
| `Delete` | Remove the selected folder from the browser. Only a folder you added can be removed; nested folders leave with their root. |
| `Escape` (filter field) | Clear the filter and hand keyboard focus back to the tree. |

The filter field passes `↑`, `↓`, and `Enter` through to the tree, so a file can
be found and auditioned without leaving the search box.

### Timeline commands

**Nested clip context menu.** On a single clip, commands are grouped under
**Open** (Clip Editor, Scratch Editor, information), **Edit** (cut, copy, paste,
duplicate, lock, split), **Transform** (Chop to Grid, Warp, Pitch, Separate
Stems, Split Stereo Channels), **Effects** (Beat Repeat, Reverse, Brake,
Backspin), **Crossfade** (recipes and removal when applicable), and **Library**
(save, unlink, bake a sample). The **Colour** picker and **Delete** remain direct
entries; **Relink** is also direct when a clip is unresolved. The dedicated
multi-selection and empty-track menus show only actions relevant to that target.

| Input | Effect |
|---|---|
| Click on **ruler** | Seek the playhead to the nearest snap-grid line (see [Timeline snap grid](#timeline-snap-grid)). |
| `Alt` + click on ruler | Seek to the exact pointer position (1 ms resolution, no snap). |
| Click + drag on **ruler** away from the **playhead** | Create a timeline range, snapping its boundaries to the snap grid (`Alt` for 1 ms resolution). Dragging to either viewport edge auto-scrolls the timeline, so a range can be longer than the visible area, and completing the drag scrolls the playhead back into view. Play starts at its beginning and pauses exactly on its exclusive end; enable **Loop Selection** in the transport to wrap instead. The range and loop mode persist as non-undoable project view state. A click without a drag clears the range and seeks the playhead. |
| Drag the **playhead** | Move the playhead, snapping to the snap grid (`Alt` for 1 ms resolution). This does not create or change a timeline range. |
| `Shift` + drag a **marker** | Move the marker, snapping it to the timeline grid; hold `Alt` as well for a 1 ms fine drag to any position. A move onto an occupied position is refused. Without `Shift`, a drag over a marker moves the playhead instead, so the two are never ambiguous when the playhead sits on a marker. |
| Click on **clip** (no drag) | Select the clip and its host track, and seek the playhead to the click position. |
| `Shift` + click on **clip** | Extend the selection to a range of clips on the anchor's track, between the anchor and the clicked clip (ordered by start time). |
| `Ctrl` + click on **clip** | Toggle that clip in/out of the multi-selection, across tracks. Right-clicking any selected clip opens a dedicated menu (Copy, Cut, Lock, Colour, Duplicate, Delete) that acts on the whole selection; **Delete**, **Ctrl+L** and **Duplicate** also apply to every selected clip as one undo step. **Copy / Cut / Paste** (Ctrl+C/X/V) carry the whole selection — paste drops it at the playhead starting on the selected track, keeping each clip's relative timing and track offset, and is rejected wholesale if any clip wouldn't fit. Dragging any selected clip moves the whole group by a uniform delta (preserving relative offsets, across tracks), applied atomically — the move is refused wholesale if any clip wouldn't fit or one is locked. **Shift + ←/→** (and **Shift+Alt+←/→** for 1 ms) nudge the whole group. A plain click on a selected clip (no drag) collapses back to just that clip. |
| Click + drag on **clip body** | Move the clip; the clip's first detected source beat snaps to the snap grid (or the clip's left edge if the source has no detected beats yet). Drag across rows to move the clip to a different track. Clips can't overlap on a single track — they magnetically butt against neighbour edges instead. |
| `Alt` + drag on clip | Move with 1 ms resolution — the clip stays at the unsnapped position. |
| Click + drag on **clip edge** (~8 px hit zone) | Trim the clip from that edge, snapping the dragged edge to the project grid by default. Non-destructive — only the window over the source file changes. Disabled on clips linked to a saved clip library item (**Library ▸ Unlink from Library** first, or use the Clip Editor) and on **locked** clips (Ctrl+L or **Edit ▸ Unlock** to free). |
| `Alt` + drag on clip edge | Trim with 1 ms resolution — the dragged edge stays at the unsnapped position. |
| Drag the **bottom edge of a track header** (~5 px hit zone) | Resize that track row vertically (120–400 px). Each track's height is persisted with the project and undoable. |
| Drag the **grip icon** (6-dot handle next to the track name) | Reorder the track. A green drop indicator shows the target slot. Drop on the indicator commits one undoable reorder step. |
| Double-click a **track gain number** | Type a track gain in dB directly (range `-∞..+6 dB`). Accepts `-3`, `+1.5`, `0 dB`, `-inf`, `-∞`. Invalid input is rejected and the previous value is kept. |
| Double-click the **master volume readout** in the transport bar | Type a master gain in dB directly (range `-∞..0 dB` — no boost above unity). Same parser as the track readout. |
| Click on **empty area of a track row** | Select that track (highlighted row border), deselect any clip, and move the playhead to the click position (drag to scrub). |
| Click on **inter-track gap** / below the last track | Deselect both clip and track, and move the playhead to the click position. |
| **Right-click on an empty track lane** | Open a menu with **Paste** and **Effects ▸ Beat Repeat**. Paste drops the clipboard clip onto that track at the playhead (disabled when the clipboard is empty); Beat Repeat acts at the beat-snapped playhead. Click first to place the playhead where the action should land. |
| `←` / `→` | Step the playhead one snap-grid line (a relative quarter beat on a Free grid). |
| `Alt` + `←` / `→` | Step the playhead by one pixel's worth of time (~16.7 ms at default zoom, finer when zoomed in). |
| `Shift` + `←` / `→` | Move the **selected** clip one snap-grid step, snapping its first in-window source beat to the grid (the keyboard twin of a plain clip drag; falls back to the clip's left edge when the source has no detected beats). Bump-clamped against neighbours; a burst folds into one undo step. No-op on a locked clip or with no clip selected. |
| `Shift` + `Alt` + `←` / `→` | Nudge the **selected** clip along the timeline at the finest granularity (1 ms, no snap — the keyboard twin of `Alt`+drag). Bump-clamped against neighbours; a burst of nudges folds into one undo step. No-op on a locked clip or with no clip selected. |
| `M` | Toggle a marker at the exact playhead position. Markers are shown as emerald downward triangles on the ruler and are saved with the project. |
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
| `Space` | Play / pause globally unless a text field or modal dialog is active. With a timeline range armed, playback starts from the range start. Disabled when the playhead is at the end of the project (skip back to start to re-arm). |
| `Escape` | Clear the timeline range first, including Loop Selection. Then step down through the selection: when a track and clip(s) are selected, the next press clears the clip(s) (and any selected automation point) but keeps the track selected, and a further press clears the track. When only a track is selected, one press clears it. |
| `K` | Toggle the project metronome. |
| `L` | Toggle **Loop Selection** for the active timeline range (the keyboard twin of the transport loop button). No-op when no range is selected. |
| `Shift + M` / `Shift + S` | Mute / solo the selected track (bare `M` / `S` are Marker / Split, so the track-mix twins take `Shift`). No-op when no track is selected. **Ctrl-clicking** a track's on-screen **Solo** button while another track is soloed switches the solo straight to that track (solos it and unsolos the other) in one undo step — no need to unsolo first. |
| `S` | Split every clip whose timeline window straddles the playhead into two at that position. |
| `D` / `Ctrl + D` | Duplicate the selected clip. Repeated duplicates from the same source append after the last duplicate in that track until there is no free slot, then a toast is shown. |
| `Delete` / `Backspace` | Delete the selected clip. |
| `Ctrl + Shift + T` | Trim the project length down to the end of the last clip. |
| `Ctrl + X` / `Ctrl + C` | Cut / copy the selected clip into the local clipboard. |
| `Ctrl + V` | Paste the clipboard clip to the selected track at the playhead. A toast appears if the selected track has no space at that position. |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo any project-mutating edit (clip / track / library / marker / BPM / length / rename / master volume). Drag streams coalesce within 500 ms into one step, and compound ops (split / duplicate / paste) fold into a single undo step. |
| `Ctrl + L` | Toggle the **lock** flag on the selected clip. Locked clips refuse drag-move, edge-trim and Split-at-playhead, and show a padlock badge in their title strip. Per-clip — linked saved clip siblings stay independently lockable. |
| **Right-click on a clip** | Open the nested context menu described above. Cut and Copy select the right-clicked clip and its track first; Paste needs a clip on the clipboard and lands on this clip's track at the playhead, mirroring the Edit menu / Ctrl+X·C·V behaviour. **Edit ▸ Split at Playhead** changes label when the clip is locked but stays clickable so the store guard can surface a toast. **Transform ▸ Chop to Grid** offers whole bar / 1/2 bar / 1/4 / 1/8 / 1/16 for eligible unlocked, unlinked clips with a known tempo. **Effects** keeps Reverse, Brake, and Backspin mutually exclusive and checkmarks the active one. **Transform ▸ Warp / Pitch** open transactional dialogs; **Library ▸ Save as Sample…** opens the Music / Simple choice. Shows direct **Relink** at the top when the clip is unresolved. |
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
| `Ctrl + Z` / `Ctrl + Y` / `Ctrl + Shift + Z` | Undo / redo local crop edits without affecting the project undo stack. |
| `Ctrl + D` | Clear the current playback sub-selection. |
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
| `Esc` | Clear the active playback sub-selection, or close the dialog when no selection remains. |

The transport bar's **previous / next** buttons honour the **Previous / next
button target** preference (`ui.skipButtonTarget`). With the default
`timelineEnds`, **previous** rewinds the playhead to the project start (and
returns the timeline's horizontal scroll to the start) while **next** seeks the
project end and jumps the viewport to the right edge. With `markers`, they step
to the previous / next timeline marker instead, falling back to the start / end
past the last marker. The `Ctrl + ←/→` shortcut and the MIDI cue buttons always
step between markers regardless of this setting, and `Ctrl + Shift + ←/→` always
jumps to the project start / end. Every marker-stepping affordance treats the
start of an active timeline selection as a temporary marker, so a selection is
always reachable in one step.

The status bar shows the current zoom level (e.g. `🔍 150%`) and the snap-grid
dropdown (see [Timeline snap grid](#timeline-snap-grid)). Both are labelled by a
glyph rather than a word — a magnifier and a grid — with the name carried by the
hover tooltip, so the strip stays 24px tall. It deliberately does
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

### Scratch Editor shortcuts

When the Scratch Editor dialog is open, the global timeline shortcuts are
suspended and this set applies regardless of focus within the editor. Pointer/wheel
gestures on the platter and crossfader are described in the
[Scratch Editor](#scratch-editor) section.

| Input | Effect |
|---|---|
| `B` | Build or rebuild the backing bed from the current track, anchor, and length choices. Does not run while editing a text field. |
| `Space` | Toggle play / pause of the backing channel (disabled until a backing is prepared, while recording, or during scratch replay). |
| `R` | Toggle record: arm a take, cancel arming, or stop an active take. Recording starts on the first platter touch after arming. Unavailable during scratch replay. |
| `P` | Play or stop the current recorded scratch draft. Available when a draft exists. |
| `C` | Clear the current recorded scratch draft. Saved patterns are unaffected. Unavailable during scratch replay. |
| Tap the virtual platter | **Experimental trackpad control.** Toggle the virtual platter hold. While held, move one finger around the platter or use a two-finger pan to scratch. Small accidental movements are ignored; larger movements respond more quickly. |
| `Z` / `M` (configurable) | **Crossfader cut toggle** — press to close the crossfader (scratch deck silent), press again to open. The fader starts open. The key is chosen in **Preferences ▸ Effects ▸ Scratch crossfader cut** (**Z** right-handed default, **M** left-handed). Works even when the fader is not focused. |
| `←` / `→` (crossfader focused) | Nudge the crossfader by 0.02 (or 0.1 with `Shift`). |
| `Home` / `End` (crossfader focused) | Jump the crossfader fully open / fully closed. |
| `←` `→` `↑` `↓` (platter focused) | Jog the platter by 0.02 turns (0.1 with `Shift`); `Home` / `End` jog by half a turn. |
| Click a notation point | Select it and focus the notation controls. |
| `D` (notation focused) | Deselect the current notation point. |
| `Delete` / `Backspace` (notation focused) | Delete the selected editable notation point. |
| `←` / `→` (notation focused) | Move the selected point 10 ms earlier or later; hold `Shift` for 50 ms. |
| `↑` / `↓` (notation focused) | Move the selected platter point by 0.01 turns or the selected crossfader point by 0.02; hold `Shift` for five times the step. |
| `Insert` / `Enter` (notation focused) | Add a point at the midpoint after the selection, or at the pattern midpoint when nothing is selected. |
| `T` (platter notation focused) | Toggle the selected platter point's touch state. |
| `Ctrl` + `Z` / `Ctrl` + `Y` (notation focused) | Undo / redo notation edits. |
| Double-click a notation lane | Add a point at that time. |
| Right-click a notation point | Delete that editable point. |
| `Ctrl` + mouse wheel over notation | Zoom the notation timeline. |
| `Escape` | Close the editor, or dismiss the unsaved-changes prompt. |

### Record Audio shortcuts

When the Record Audio dialog is open, `R` is claimed by the dialog only — there
is no global record shortcut. See the [Recording](#recording) section.

| Input | Effect |
|---|---|
| `R` | Start recording, or stop one that is rolling. Does not run while editing a text field, or once a recording is in review. |
| `Enter` | Activate the footer's primary button — **Record**, or **Add to Timeline** while reviewing. |
| `Escape` | Close the dialog, discarding an uncommitted recording. Ignored while a recording is rolling or a commit is in flight, so nothing is thrown away by accident. |


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

Each track header has an **A** toggle that opens an automation stack below the clip area; the
first lane defaults to Filter. **Add automation lane** adds another distinct parameter, so
several curves can be viewed and edited together. Opening a lane scrolls the track row into
view, aligned so the new lane at the bottom of the row is visible even when the expanded row
is taller than the timeline viewport. Every lane has its own parameter picker and
height; its lower edge resizes only that lane from 80 to 220 px. The picker truncates a name
too long for the header and names the parameter in its tooltip, and it hands focus back to the
timeline on change or `Escape`, so the global shortcuts keep working after a lane is
retargeted. The track row's bottom edge
still resizes only the clip/header area from 120 to 400 px. Removing a lane only hides it; it
does not clear its curve. The ordered visible descriptors are stored separately on each `TRACK`
as `automationLaneView` (`{ paramId, heightPx }`), are undoable, and round-trip through
`PROJECT_STATE` and `.silverdaw`; absence keeps old projects collapsed.

Lanes can edit **Filter**, **Pan**, the 3-band **Tone**, **Reverb/Delay sends**,
**Compressor**, **Punch**, **Saturation**, **Bit Crusher**, or **Gain** (a post-FX track level in
dB, distinct from the header fader and clip Volume Shape). Click to add a breakpoint, drag to
move, right-click or Alt-click to remove; a selected point fine-nudges with arrow keys; a drag
stream coalesces into one undo step. Lane-header controls raise/lower the whole curve, set the
value at the playhead, copy/paste a curve, and reset to default. Pasting into a different
parameter maps every value through its normalized range, preserving the copied curve's visual
shape. The picker marks already-automated params with a ● dot, and the value editor shows the
sign convention (Filter: negative = LPF, positive = HPF). Curves are stored on each `TRACK` as
one `automation` array-of-lanes property (`{ paramId, points: [{ timeMs, value }] }`), separately
from `automationLaneView`. A lane with no curve shows a faint baseline line at the parameter's
**static (resting) value**, so the line tracks the live Track FX control; the first point you draw
starts from that value. A curve that settles flat at the static value is treated as a no-op and
the lane auto-clears. Each static Track FX
control (and the header **Pan**) carries a small **A** button that opens that parameter's lane
(`useFxAutomation`); while a curve owns the value the static control is **disabled**, dimmed, and
shows an **AUTO** tag, so it is clear the lane is in charge. While automated the control is
**read-only but live**: its slider and readout follow the curve's value sampled at the playhead
(`useFxAutomation.displayValue` reading `transport.positionMs`), so during playback or scrub the
Filter / Tone / Sends / Compressor / Punch / Saturation / Bit Crusher sliders and the header Pan animate to the current automated
value (the static value remains the resting baseline the curve rides). The keyboard/value nudges
snap to the parameter default so 0 / centre is always reachable. The backend publishes an
immutable `TrackAutomationSnapshot` per track (lock-free + retire queue) and samples it on a
fixed 256-frame control quantum at the block-start transport position, driving the existing
smoothed targets and snapping on seek/loop/play discontinuities, restoring neutral when a lane
clears; mixdown samples the same curves so
exports match playback. Authoring helpers (`setAutomationRamp`, `copyAutomationToTrack`,
`createFilterCrossfade`) build curves directly — e.g. an opposing filter sweep across two
tracks. Values are stored in native units; only the lane renderer normalises to pixels.

## Rendering performance

The timeline component mounts as soon as the shared idle loader has warmed the
PixiJS chunk, while the startup screen is still up. The startup overlay is
opaque and covers the whole window, so the WebGL application is created,
observers attach, and the first (empty) draw happens unseen. That matters
because creating the WebGL context contends badly with project-load work on the
main thread: paid at open time it measured ~800 ms — long enough for the Vue
track headers to appear a beat before the canvas — while paid against an idle
startup screen it is ~50 ms, leaving the first paint after a project snapshot in
the tens of milliseconds. `App.vue` falls back to mounting on startup-screen
dismissal, so a project opened before warming completes still gets a timeline.

Both Pixi surfaces (timeline and Clip Editor) init through
`pixiInitOptions()` in `pixiLoader.ts`. It pins `preference: 'webgl'`: Pixi 8
otherwise probes for WebGPU first, and the renderer is WebGL-only by design —
the CSP shader patch targets WebGL and context loss is handled through the
`webglcontextlost` event, which a WebGPU renderer would never raise.

Two `perf` log lines make this measurable in a user's `renderer.log`:
`pixi+webgl ready in Xms (import wait=…, webgl init=…)` splits chunk load from
context creation, and `[perf.timeline] first paint after project snapshot in
Xms` spans the gap between a project snapshot landing in the store and the
canvas actually drawing it.

Dialogs that cannot appear during startup use async Vue components and
parent-level visibility gates. Their component code is requested only when the
corresponding dialog or progress state becomes active, keeping it out of the
initial renderer module graph.

The timeline canvas is PixiJS. All world-space content (clip blocks, waveforms, grid lines,
ruler ticks) is drawn once at absolute world coordinates into a `tracksLayer` / `rulerTicksLayer`,
which are then translated by `-scrollX` / `-scrollY` on every scroll change. The result: scroll
and auto-follow during playback are O(1) layer translations — no clip iteration, no Graphics
allocation. A full repaint (`redraw()`) only fires on content change: track add/remove, clip
move, peaks arrival, zoom, BPM, project length, header-column resize.

**The ruler is not in world space.** Clip hit regions are stored at absolute world
coordinates, so a pointer is mapped by adding `scrollX` / `scrollY` — but the ruler
is a fixed overlay that does not scroll with the tracks, so that mapping is only
meaningful below `RULER_HEIGHT`. Every pointer query that reads world y must reject
the ruler band first; `timelineQueries.pointerToTracksWorld` is the single guard
`hitTestClip`, `hitTestTrimEdge` and `pointerToTrackId` share, and
`useTimelineContextMenu` applies the same test. Skipping it means a press on the
ruler resolves to whatever row happens to be scrolled under that offset: the playhead
became ungrabbable from the ruler the moment the view was scrolled down at all,
starting a clip drag instead, and right-click opened that clip's menu.

**Peaks LOD pyramid.** Each library item carries a small ladder of pre-downsampled
peak arrays (`peaksLod`) alongside its base peaks. `drawClip` picks the LOD whose
`peaksPerSecond` is closest to the current draw scale so the waveform stays crisp
when zoomed in and the inner per-pixel min/max scan stays cheap when zoomed out.
Older projects that lack a stored pyramid auto-bake one on the next load. The
clip's beat-marker loop **stride-steps** by a precomputed `ceil(minMarkerSpacingPx /
pxPerBeat)` so a 5-minute clip at 120 BPM doesn't iterate every beat when only a
handful of markers fit on screen.

**Live clip peak reuse.** Split, duplicate, and paste operations reuse complete
summary peaks and, for stereo sources, both channel arrays already held by the
source clip. Their `CLIP_ADD` payload sets `requestWaveform` to `false`, so the
backend does not reload and re-announce the same cache file. Missing, incomplete,
and older payloads default to requesting waveform data. Matching
`WAVEFORM_READY` envelopes are also ignored before cache-file IPC when the
renderer already holds data with the announced shape, rate, and sample rate.

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

**Warp and track rendering.** Faster/R2 warp processors use Rubber Band's
lower-cost pitch path while a clip has no pitch shift; pitch-shifted R2 and all
Finer/R3 processors retain the high-consistency path. Input is supplied according
to `getSamplesRequired()` with latency-derived bounds instead of fixed 1,024-frame
pushes. Live playback, preview, mixdown, and sample export share the same pitch
conversion and processor setup.

Muted and solo-excluded tracks are omitted from immutable `BusGraph` render
snapshots after one final gain-ramp block. Their clips, warp and pitch processing,
track effects, sends, and metering are therefore not pulled. Effect and clip
settings remain editable while excluded. Before a track returns to the graph, its
transports are reseeked to the master position and stale read-ahead is rebuilt.

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
- **Node.js** ≥ 20 (LTS recommended). **pnpm** is activated via `corepack` (bundled with
  Node) — the version is pinned by `frontend/package.json`'s `packageManager` field;
  do not `npm i -g pnpm`.

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
backend CMake cache in `backend/build/` with the Visual Studio 17 2022 generator and
`SILVERDAW_BUILD_TESTS=ON` (CMake creates that directory itself — no
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

# Cache the pnpm version pinned by frontend/package.json
corepack enable
Push-Location frontend
corepack install
Pop-Location
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
  "cmake -S backend -B backend/build -G 'Visual Studio 17 2022' -DSILVERDAW_BUILD_TESTS=ON"
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake --build backend/build --config Debug --parallel"

# 2. Install frontend dependencies — Setup-Dev already did this too
cd frontend
pnpm install

# 3. Start the Electron app (spawns the backend automatically)
pnpm dev
```

Equivalent Visual Studio Code tasks cover the same steps (`setup: dev`,
`backend: configure`, `backend: build`, `frontend: install`, `frontend: dev`, plus the
composite `dev: all`).

The recommended dev path is **F5** in VS Code with the `Silverdaw (Dev)` launch configuration
selected — it has a `preLaunchTask: "backend: build"` so the Debug backend is always rebuilt
before the renderer starts.

`backend/build/` is the Debug cache; `backend/build-release/` is the Release
cache used by `scripts/Build-Release.ps1`. They're kept separate so a release build doesn't
reconfigure the Debug cache out from under your dev session.

> **`backend/build/` is a Visual Studio 17 2022 (multi-config) tree — don't
> reconfigure it with another generator.** `scripts/Setup-Dev.ps1`, the
> `backend: configure` VS Code task, and `cmake.generator` in
> `.vscode/settings.json` all agree on that generator, so `--config` decides the
> build type and `CMAKE_BUILD_TYPE` is ignored. CMake refuses to reconfigure a
> tree with a different generator, and CMake Tools treats that refusal as a
> failed configure — which silently empties the backend tests out of the VS Code
> Testing panel. If you really must switch, delete `backend/build/` first rather
> than reconfiguring over the top, and change `cmake.generator` to match.
>
> `backend/build-release/` is the **Ninja** tree, and the only one that emits
> `compile_commands.json` — which is why clangd and `scripts/Invoke-ClangTidy.ps1`
> both point at it.

## Packaging for Windows

`scripts/Build-Release.ps1` is the canonical release path. From the repository
root it runs the whole pipeline end-to-end:

1. Configures + builds the JUCE backend (`SilverdawBackend.exe`) in **Release**.
2. Runs a **bundling guard** that fails early if any runtime binary the backend
   drops next to `SilverdawBackend.exe` is missing from the `extraResources`
   allowlist in `electron-builder.yml`.
3. Runs a **version guard** that fails if `frontend/package.json`, the
   `project()` version in `backend/CMakeLists.txt`, and the version the built
   `SilverdawBackend.exe` actually reports are not all identical.
4. Ensures a self-signed **`CN=Silverdaw`** code-signing certificate exists in
   `Cert:\CurrentUser\My` (created on first run; the private key stays in the
   store and is **never** exported to the repo) and locates the Windows SDK
   `signtool.exe` (electron-builder's bundled signtool cannot sign AppX).
5. Compiles the Electron bundles and packages **three artefacts** from them.
6. Exports the **public** certificate so users can trust the sideload package.

Bumping a release version means editing **both** `frontend/package.json` and the
`project(... VERSION ...)` line in `backend/CMakeLists.txt`; the backend's
`kBackendVersion` (reported over the bridge and written into saved projects) and
its Windows VERSIONINFO resource are both generated from the latter. The version
guard is what stops those two drifting apart unnoticed.

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

The `pnpm` gates below run from `frontend/` (the only package manifest in the
repo); the `pwsh` and `scripts/` gates run from the workspace root.

- **C++**: `clang-tidy` via `scripts/Invoke-ClangTidy.ps1` (`backend: lint` task), using
  `backend/.clang-tidy` (enables `modernize-*`, `bugprone-*`, `performance-*`,
  `readability-*`, less a documented exclusion list). **The backend is at zero
  clang-tidy warnings — keep it there.** A clean baseline is the whole point:
  it means any warning a change introduces is visible immediately instead of
  being lost in a list of hundreds that everyone has learned to scroll past.
  Fix what a run reports, or — if the check is genuinely wrong for this
  codebase — exclude it and write down why in the config header. Every
  exclusion is a style disagreement, a micro-optimisation, or a check that was
  audited site by site and found not to apply; each records that reasoning.
  Keep `backend/.clangd` (the IDE-time list) in sync when changing them.
  Run it with:

  ```powershell
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "pwsh -NoProfile -File scripts/Invoke-ClangTidy.ps1"
  ```

  The outer `Invoke-DevShell.ps1` is what puts the Visual Studio `clang-tidy` on
  `PATH`. The console gets a per-check summary; the full output goes to
  `clang-tidy-report.txt` at the repo root (gitignored), because a run emits
  thousands of lines and would otherwise scroll its own findings out of the
  terminal. Useful switches:

  - `-Fix` applies the suggested code-mods, including those attached to notes.
    Rebuild and run the tests afterwards — a code-mod is a change like any
    other — and follow with `clang-format`.
  - `-Checks '-*,some-check'` overrides the config for one run, so a code-mod
    can be applied and reviewed one check at a time.
  - `-Filter 'regex'` narrows the console summary to matching checks.
  - `-Strict` turns warnings into errors. Now that the baseline is clean this
    is viable as a CI gate.
  - `-Jobs N` sets the parallelism, defaulting to the logical processor count.
    `-Jobs 1` forces the serial path.
  - `-NoSystemHeaders` lints against the build's own `compile_commands.json`
    rather than the derived copy described below. Only needed to diagnose a
    suspected difference between the two.
  - `-Changed` lints only what the current changes affect, and `-Since <ref>`
    picks what they are compared against (default `HEAD`, i.e. uncommitted
    work; pass a branch point to cover a whole branch).
  - `-ClangTidyPath <path>` names the executable instead of taking whichever
    one `PATH` offers. Worth knowing that the developer shell puts Visual
    Studio's LLVM ahead of anything installed separately, so this is how CI
    guarantees it runs the pinned version the baseline was set with.

  A run is parallel by default: when LLVM's `run-clang-tidy.exe` sits alongside
  the chosen `clang-tidy` — it does in both the Visual Studio and PyPI
  distributions — it fans the 133 sources out across cores. Only that copy is
  used, never one found on `PATH`, so the driver always matches the linter.
  Measured on a 16-core machine, a full run goes from about 400 seconds serial
  to 85 parallel; 8 jobs took 104 seconds and 24 and 32 both took 83, so the
  curve flattens at roughly the core count and the default needs no tuning.

  On top of that the script derives its own compile database into
  `<build>/clang-tidy/`, rewriting every third-party include directory —
  anything under `_deps/` or `backend/third_party/` — from a `-I` user include
  to a system include. CMake passes dependencies as plain `-I`, so without this
  clang treats JUCE, rubberband, ixwebsocket and the rest as first-party code:
  it runs the whole check set over all of it and `HeaderFilterRegex` then
  discards the results. Marking them as system headers lets clang skip that
  work and takes the run from 85 seconds to 47. The derived database is
  regenerated whenever the real one is newer, and is inside the build tree so
  it is already gitignored. It was validated by running a deliberately noisy
  check set over both databases and diffing the output: 5173 diagnostics,
  byte-identical, so the speedup costs no coverage. Re-run that comparison if
  you ever widen what counts as third-party.

  Two further consequences of running in parallel. Workers each analyse their
  own translation unit, so a finding in a shared header is reported once per
  file that includes it — the summary deduplicates on file, line, column, and
  check. And `-Fix` always falls back to the serial path, because clang-tidy
  applies edits by byte offset and concurrent workers rewriting the same header
  would corrupt each other. `run-clang-tidy` resolves `.clang-tidy` from the
  working directory rather than from the files it lints, so the script passes
  `-config-file` explicitly; without it every check is silently disabled.

  `-Changed` narrows the run further. A changed `.cpp` lints itself; a changed
  header lints every translation unit that includes it, which the script reads
  from the dependency graph Ninja recorded during the last build rather than by
  re-scanning `#include` lines. That distinction matters — the recorded graph
  is what the compiler actually saw, transitive includes included. On a typical
  branch this is the difference between one file and the whole tree.

  The narrowing is deliberately pessimistic, because a partial run that wrongly
  reports clean would quietly undermine the baseline the gate depends on.
  Anything it cannot resolve confidently — no Ninja, no dependency record, a
  stale record, a header the build has never compiled, or an edit to
  `.clang-tidy` or `.clangd` themselves, which changes what every file is
  measured against — abandons the narrowing and lints everything. Prefer a full
  run for the CI gate and keep `-Changed` for the local edit loop.

  Watch for `compile error(s)` in the summary. clang-tidy stops analysing a
  translation unit at the first compile error, so errors silently *hide*
  warnings — a header that Clang rejects but MSVC accepts can mask findings
  across most of the codebase.

  clang-tidy needs a `compile_commands.json`, which only a **single-config**
  generator writes — the Visual Studio tree in `backend/build` has none — so
  the script searches the known build trees and uses the first that has one.
  Pass `-BuildDir` to pin a specific tree. If no tree has a compile database,
  configure a Ninja one:

  ```powershell
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "cmake -S backend -B backend/build-release -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo"
  ```

  Format with `clang-format`
  (`backend/.clang-format`). Backend unit tests are gated behind
  `-DSILVERDAW_BUILD_TESTS=ON`:

  ```powershell
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "cmake -S backend -B backend/build -G 'Visual Studio 17 2022' -DSILVERDAW_BUILD_TESTS=ON"
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "cmake --build backend/build --target SilverdawBackendTests --config Debug --parallel"
  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
    "ctest --test-dir backend/build --build-config Debug --output-on-failure"
  ```
  Each case is a separate CTest test, discovered at build time via the harness's
  `--list` / `--run` flags, so cases appear individually in `ctest` and the VS
  Code Testing panel. Test-case names must be unique and ASCII — the harness
  checks this at startup, along with every domain having registered at least one
  case, and fails discovery with a named error if not. Adding or removing a test
  needs no bookkeeping beyond registering it in its domain's `add*Tests`.

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
  (`./scripts/Coverage.ps1 -Target All`, `-Target Frontend`, or
  `-Target Backend`) and collects both
  viewable HTML reports into a single gitignored root folder —
  `coverage/frontend/`, `coverage/backend/`, and a `coverage/index.html` landing
  page linking both.
- **TypeScript / Vue**: `pnpm typecheck` (`vue-tsc --noEmit -p tsconfig.web.json --composite false`
  for the renderer/shared sources and tests, then `tsc --noEmit -p tsconfig.node.json --composite false`
  for the Electron main/preload sources and the main-process tests),
  `pnpm lint` (ESLint flat config with `eslint-plugin-vue` and `@typescript-eslint`).
- **Tests**: `pnpm test` runs Vitest over the shared bridge-protocol guards,
  music-time helpers and Pinia stores. Test files live under `frontend/tests/`,
  mirroring the `src/` layout (`tests/renderer`, `tests/main`, `tests/shared`),
  are named `*.test.ts`, and reference the code under test through the `@`,
  `@shared` and `@main` path aliases. `pnpm test:coverage` runs the same
  suite with V8 coverage and writes text, HTML, lcov and JSON-summary reports
  under `frontend/coverage/`.
- **End-to-end**: `pnpm test:e2e` builds the app (`electron-vite build`) and runs
  the Playwright journeys under `frontend/e2e/` against a real spawned backend,
  so a run covers the spawn → port → AUTH → handshake chain, the native dialog
  stubs and the saved project format. The tier is deliberately small and wide and
  asserts mostly on the DOM, the filesystem and saved project files; its rules and
  helpers are documented in `frontend/e2e/README.md` and ADR 0014. The specs are
  type-checked by `pnpm typecheck` through `tsconfig.node.json`.

  One journey is the exception to "no audio": `playback.e2e.ts` (J17) presses
  Play and asserts the playhead crosses a bar line. The playhead is advanced by
  `MasterClockSource` from inside the audio device callback, so a moving
  position is the only end-to-end proof that a device opened and its callback
  is firing — the gap that let a frozen-playhead regression through the whole
  suite. That makes it the one spec needing a real output device: with none,
  the engine reports `no_device` and the renderer disables Play outright. Its
  fixture is digital silence (`createToneWav({ amplitude: 0 })`), because the
  callback fires regardless of sample values and a test suite should not make a
  noise.

  The specs launch the *built* app, so anything that invokes the runner
  directly — `pnpm test:e2e:only`, or the ▶ button in the VS Code Testing panel
  — skips that build and would otherwise silently test stale bundles.
  `frontend/e2e/globalSetup.ts` guards against it: before any spec runs it
  compares `out/{main,preload,renderer}` against `src/` and
  `electron.vite.config.ts` and aborts with a build hint if the bundles are
  missing or older. Discovery is unaffected, so the panel always lists the
  specs. Installing the recommended `ms-playwright.playwright` extension (see
  `.vscode/extensions.json`) puts them in the Testing panel alongside the
  CTest-provided backend tests; it finds `frontend/playwright.config.ts` on its
  own.
- **Dead code**: a configured `frontend/knip.json` (entry points for the main /
  preload / renderer electron-vite processes) lets `pnpm dlx knip` report unused
  files, exports and dependencies. Treat its output as *candidates* — the zod
  inbound/outbound schema maps and `.vue`-only usages produce false positives
  that need manual confirmation. Run before large refactors; not wired into CI.

## Continuous integration

`.github/workflows/ci.yml` runs the gates above on pushes to any branch except
`main`, on pull requests, and on demand (**Actions ▸ CI ▸ Run workflow**), so a
regression is caught before it reaches `main`. A merge to `main` does not re-run
them: main is only reachable through a pull request that already passed, so a
post-merge run would re-answer a settled question. Runs are grouped per ref with
`cancel-in-progress`, because a newer commit makes the previous answer
irrelevant.

The `pull_request` trigger covers pull requests from forks, whose pushes never
reach this repository. For a branch here that already has a pull request open,
that means two runs per push — the price of covering outside contributions.

Every job runs on `windows-2022`. Silverdaw is Windows-x64 only, so a green
result anywhere else would be false signal — and the image is pinned rather
than `windows-latest` because that label moved to Visual Studio 2026 in June
2026, which has no VS 2022 instance for the generator to find. The deeper
reason is parity: releases are built with VS 2022, and a gate on a different
MSVC would validate a compiler nobody ships from. `windows-2022` is available
for a transition period only; when it retires, migrate the local toolchain
first, then bump the image, the generator, `.vscode/settings.json` and
`scripts/Setup-Dev.ps1` together, deleting both build trees (CMake refuses to
reuse a tree configured by a different generator).

| Job | What it proves |
| --- | --- |
| **Frontend lint, typecheck and unit tests** | `pnpm lint`, `pnpm typecheck`, `pnpm test` |
| **Backend build and unit tests** | Visual Studio generator with `-DSILVERDAW_BUILD_TESTS=ON`, then `ctest` |
| **Backend linting** | The zero-warning clang-tidy baseline, run `-Strict` as an error gate |
| **End-to-end journeys** | The Playwright tier against the backend the build job produced |

Six details are worth knowing before changing it:

- **`lame.exe` is not in the repository**, so both C++ jobs run
  `scripts/Fetch-Lame.ps1` first. LAME is required, not optional — it both
  encodes MP3 on export and decodes MP3 on import — so configuring without it
  now fails outright rather than producing a backend that cannot do either.
- **Two build trees, two generators.** The test job uses the multi-config
  Visual Studio generator; clang-tidy needs `compile_commands.json`, which only
  Ninja emits, so it configures `backend/build-release` separately and through
  `Invoke-DevShell.ps1` (Ninja needs the MSVC environment that the VS generator
  finds for itself). The lint job configures without building: nothing here is
  generated at build time, so compiling first would only cost minutes.
- **The backend is built once.** The build job uploads
  `SilverdawBackend_artefacts/Debug/` and the e2e job downloads it to the path
  the Electron main process resolves in a development launch.
- **clang-tidy is version-pinned, and named explicitly.** `-Strict` turns
  warnings into errors, and different clang-tidy releases disagree about what
  to warn on, so an unpinned runner would fail the gate on findings nobody can
  reproduce locally. The workflow installs the exact version the zero-warning
  baseline was established against (`CLANG_TIDY_VERSION`, currently 22.1.8,
  from PyPI) and passes its path to `-ClangTidyPath`. Naming it is not
  belt-and-braces: the MSVC developer shell puts Visual Studio's own LLVM ahead
  of everything else on `PATH`, so relying on `PATH` silently ran the gate with
  VS's clang-tidy 19 against a baseline established with 22. **When bumping the
  pin, re-run the linter locally first and clear whatever the new version
  finds.**
- **A runner has no sound hardware.** `scripts/Install-VirtualAudioDevice.ps1`
  installs Scream, an open-source virtual sound card, giving JUCE a WASAPI
  endpoint to open so the audio callback — and therefore the playhead — runs.
  It keeps Scream's own driver signature, which is timestamped and so still
  verifies as valid despite the signing certificate having expired in 2023, and
  adds that publisher to `TrustedPublisher` so the install is non-interactive.
  Re-signing with a locally-minted certificate is the tempting alternative and
  does not work: it replaces a valid signature with one that chains to nothing
  Windows trusts, and Driver Signature Enforcement then refuses to load the
  driver unless Secure Boot is off and test-signing is on, neither of which can
  be arranged on a hosted image. Trusting a third-party driver publisher
  machine-wide is only acceptable on a disposable machine, so the script
  refuses to run unless `CI=true` or `-AllowLocal` is passed. It is a separate
  step so a driver problem never reads as a test failure. Both the e2e job and
  the **backend** job install it: two unit tests drive the transport (one seeks
  and reads the playhead back, one asserts `play()` reaches `isPlaying()`) and
  neither names a JUCE device class, so their dependency on an open device is
  easy to miss until they fail.
- **The dependency cache is scoped to the runner image, and configure retries
  once.** `backend/build*/_deps` holds *configured* sub-build trees that bake in
  an absolute path to `cl.exe`, so a cache written on one image and restored
  onto another sends CMake looking for a compiler that is not installed — the
  failure names a missing `cl.exe` and says nothing about the cache, which is
  why this is worth stating. The image label is therefore part of both the key
  and the `restore-keys` fallback. A Visual Studio update *within* an image
  moves that path too, so both configure steps discard the tree and try again
  on failure, turning a stale cache into a slower green run rather than a
  baffling red one.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](../LICENSE) for the full text. You are free to use,
study, modify, and redistribute it; any distributed or network-hosted modified
version must in turn be released under the AGPL with its source available to
users.

Third-party components (JUCE, IXWebSocket, Electron, Vue, etc.) retain their
own licences; see [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) for the
attribution notices required by those licences.
