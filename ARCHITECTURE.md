# Architecture — Silverdaw

_Last reviewed: 2026-08-30 · Owner: @irarainey_

Linked from `CONTEXT.md`; read when a task touches structure, boundaries, or
data flow. Keep this a lean overview — push detail into `docs/developer-guide.md`
and per-area sections rather than growing this file.

## Shape at a glance

Two long-lived processes. The Electron app owns the UI, OS integration, and the
backend's lifecycle; the headless JUCE engine owns audio, DSP, file I/O, and the
canonical project state. They speak a text-only JSON bridge; bulk bytes go via
disk.

Two things qualify "two" and "headless", both from ADR 0025 and neither a third
architectural peer. A **plugin scan** runs the backend binary again in a
transient child worker, so an unknown VST3 is loaded outside the engine; the
worker is reused across files and replaced when a plugin crashes it. And the
engine links `juce_gui_basics` purely to own the **native editor window** of a
hosted plugin — it still draws no Silverdaw interface of its own.

```text
+-----------------------------+   ws://127.0.0.1:<port>   +-----------------------------+
|  Electron renderer (Vue 3)  |  <--------------------->  |  SilverdawBackend (JUCE)    |
|  + Electron main (IPC)      |    text {type,payload}    |  AudioEngine + ProjectState |
+-----------------------------+                           +-----------------------------+
             ^                                                          |
             |          bulk data (peaks, stems, mixdowns) on disk      |
             +----------------- %APPDATA%/Silverdaw/ <------------------+
```

## Boundaries

- **Electron main** — spawns/supervises the backend, picks a free loopback port
  in `[8765, 8784]`, mints the AUTH token, owns OS dialogs, native menu,
  `preferences.json`, autosave, recents, and all disk-read IPC for bulk data.
  It also owns the **path allow-list**: a folder becomes readable only when the
  user picks it in a native dialog (or it is restored from prefs main itself
  wrote), which is what confines the library file browser to folders the user
  chose. See `docs/developer-guide.md#file-browser-files-tab`.
- **Preload** — least-privilege `contextBridge` surface (`window.silverdaw`).
- **Renderer (Vue 3 + Pinia + PixiJS)** — all UI, drag-and-drop, timeline
  rendering, key detection (Web Audio chroma). Mirrors backend state and owns
  only **ephemeral interaction state** (hover, in-flight drag, transient
  selection highlight). Persisted view state (zoom, scroll, snap grid, selected
  track, open FX panel, timeline range and its Loop Selection flag) is
  backend-authoritative and round-trips via `PROJECT_SET_VIEW` /
  `PROJECT_STATE`; per-track automation lanes persist the same way through
  `TRACK_SET_AUTOMATION_LANE_VIEW`.
- **Backend bridge** — IXWebSocket loopback server; AUTH gate; marshals every
  envelope onto the JUCE message thread.
- **Backend engine** — `AudioEngine` (mixer/bus graph, per-track sources, master
  transport clock, device manager), DSP, stems, mixdown, and `ProjectState`
  (`ValueTree` + `UndoManager`). The engine owns the Loop Selection wrap, so a
  looped range restarts without a bridge round trip. See ADR 0023.

## Threading rules (backend)

- `CRITICAL` — **Audio thread:** no allocation, locks, or exceptions. Reaches
  mutated state via `std::atomic` (master clock, offsets, double-buffered
  envelope/breakpoint lists swapped by an atomic pointer). See ADR 0006. A
  hosted plugin's own `processBlock` is the sole exception — third-party code
  cannot be held to the rule, which ADR 0025 accepts as a bounded risk. It
  relaxes nothing for Silverdaw's own audio code.
- **JUCE message thread:** owns every mutation of `AudioEngine`, `ProjectState`,
  the `ValueTree`, and the source graph. The bridge `callAsync`s onto it.
- **IXWebSocket I/O threads:** parse JSON, gate AUTH, then `callAsync`.
- **Peaks worker pool:** `juce::ThreadPool` (4) computes/loads peaks off-thread,
  coalesces matching source/resolution jobs, writes the cache, and emits a small
  `WAVEFORM_READY` for every waiter. Live clip copies that already hold complete
  peaks opt out before joining the pool. `WAVEFORM_FAILED` lets the renderer
  fall back to local decoding.
- **Tempo detection** runs on that same pool, then `callAsync`s its result onto
  the message thread to apply it. The result is discarded if the user set that
  item's tempo by hand while the job was running, so a slow analysis can never
  overwrite a correction. See ADR 0027 and ADR 0028.

## Data-flow rules

- **Control plane on the socket, bulk data on disk.** The bridge carries
  commands, state, metadata, progress, and `*_READY` notifications. Audio files,
  peak caches, stems, mixdowns, and project files live on disk; the backend
  writes a stable path and the renderer reads it via main IPC. See ADR 0003.
- **`ValueTree` is the source of truth.** After AUTH the backend sends one full
  `PROJECT_STATE`; the renderer treats it as canonical (`reset=true` wipes
  optimistic state, connect path merges additively). See ADR 0002.
- **Clips reference audio by `libraryItemId`,** never by path; the backend
  resolves the on-disk file (preferring the decoded-WAV cache) at load time.
- **Same canonical chain for playback and mixdown** so exports match what the
  user hears.
- **MIDI is a profile-driven control plane.** The backend enumerates MIDI
  inputs, opens only recognised deck profiles, decodes raw messages on the JUCE
  message thread, and sends semantic `MIDI_CONTROL` envelopes to the renderer.
  The renderer applies transport, timeline, marker, browse, and selected-track
  mixer actions. Optional controller feedback travels through a matching MIDI
  output. See `docs/midi-controllers.md` and
  `docs/developer-guide.md#midi-controller-architecture`.

## Engine resilience

The engine is a separate process, so "the engine went away" is a normal,
recoverable event. Four cooperating mechanisms — a main-process **supervisor**
(respawn on the same port/token, bounded retries), a renderer **PING/PONG
watchdog** (PONG answered on the message thread proves liveness), a renderer
**recovery coordinator** (reloads the open project into the fresh, empty engine,
generation-tagged), and a backend **in-handler guardrail** (per-envelope
try/catch → non-fatal `ENGINE_ERROR`) — plus always-on startup diagnostics.
See ADR 0008 and `docs/developer-guide.md` → Engine resilience and recovery.

## Component map

One line each; open the linked area only when the task touches it.

| Area | Responsibility | Detail |
| --- | --- | --- |
| `backend/src/bridge/` | Loopback server, AUTH, dispatch, payload helpers | `docs/developer-guide.md#bridge-protocol` |
| `backend/src/commands/` | Per-domain bridge command handlers | — |
| `backend/src/midi/` | Generic JSON-profile loader, MIDI decoder, and feedback encoder | `docs/developer-guide.md#midi-controller-architecture` |
| `backend/resources/midi-mappings/` | Source JSON profiles for model aliases and controller bindings | `docs/midi-controllers.md` |
| `backend/src/scratch/` | Scratch source/backing preparation, session routing, recording, realism, evaluation, and sample bake | ADR 0021 |
| `backend/src/engine/` | Transport clock, mixer/bus graph, per-track sources | — |
| `backend/src/dsp/` | Per-track/shared DSP (Tone, Compressor, Punch, Saturation, Bit Crusher, Reverb, Delay, Glue Compressor, Safety Limiter, peaks), plus tempo and beat-grid detection | ADR 0028 |
| `backend/src/plugins/` | VST3 catalogue and out-of-process scanning, hosted per-track insert chains, plugin play head, native editor windows | ADR 0025 |
| `backend/src/stems/` | ONNX stem-separation orchestration | ADR 0009 |
| `backend/src/mixdown/` | Offline render/export on the canonical chain | — |
| `backend/src/project/` | `ValueTree` state, UndoManager, save/load, peaks cache | ADR 0002 |
| `frontend/src/main/` | Window, menu, IPC, prefs, backend spawn + supervisor | ADR 0008 |
| `frontend/src/preload/` | `contextBridge` surface | — |
| `frontend/src/renderer/src/` | Vue SPA, Pinia stores, PixiJS timeline | — |
| `frontend/src/renderer/src/lib/scratch/` | Scratch dialog orchestration, backing, controls, replay, notation layout/editing, persistence, and save flow | ADR 0021 |
| `frontend/src/shared/` | `bridge-protocol.ts` facade over `bridge/inbound.ts` (zod schemas) + `outbound.ts` (typed interfaces) — wire SoT | ADR 0004 |

## Why it is built this way

Isolating the real-time C++ engine in its own process keeps a driver or
audio-engine fault from taking down the UI (and vice versa), lets each side use its natural
stack, and makes crash recovery a first-class feature rather than a catastrophe.
See ADR 0001. The text-only bridge keeps the single-threaded IXWebSocket I/O
loop off the bulk-data path. See ADR 0003.
