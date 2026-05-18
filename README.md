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

## Bridge protocol

The bridge is **text only**. Every envelope is a JSON `{ type, payload }` frame:

```json
{ "type": "TRANSPORT_PLAY" }
{ "type": "CLIP_ADD", "payload": { "trackId": "...", "clipId": "...", "filePath": "...", "positionMs": 0 } }
{ "type": "WAVEFORM_REQUEST", "payload": { "clipId": "..." } }
```

- `type` is an UPPER_SNAKE_CASE discriminator.
- `payload` is a JSON object or omitted.
- Every connection's first envelope must be
  `{ "type": "AUTH", "payload": { "token": "<hex>" } }` — the renderer fetches the token from
  Electron main (it's a per-session random string passed via `SILVERDAW_BRIDGE_TOKEN` env var on
  backend spawn). Wrong / missing token closes the socket.
- After AUTH succeeds the backend sends `PROJECT_STATE` exactly once (full snapshot: tracks +
  clips + file path + project name). The renderer treats it as the canonical truth; on a load
  (`reset=true`) it wipes optimistic local state first, on the connect path it merges additively.

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
  TRACK[id, gain]
    CLIP[id, filePath, offsetMs, inMs, durationMs, colorIndex?]
  LIBRARY
    ITEM[id, filePath, bpm?]
```

`CLIP` carries a non-destructive trim window: `offsetMs` is the timeline start,
`inMs` is where in the source file playback begins (≥ 0), and `durationMs` is
how long the clip plays for from that point. Split, duplicate and edge-drag
trim all manipulate this window without ever re-decoding the source — peaks
are computed once per file and the renderer windows into them at draw time.
`colorIndex` is an optional 0..15 per-clip palette override; when absent the
clip inherits its host track's colour. `ITEM.bpm` is the BTrack-detected
tempo for the library item's source file (see [BPM detection](#bpm-detection)
below); it's stored once and round-trips through save/load so a reopened
project doesn't have to re-analyse every imported file.

The view-state properties (`viewScrollX`, `playheadMs`) bypass the dirty-flag listener via a
`suppressDirtyTransitions` guard inside their setters — scrolling or moving the playhead
doesn't prompt an unsaved-changes dialog. Everything else (BPM, project length, view zoom,
clip add/move/remove, gain changes, library import/remove, etc.) marks the project dirty as
a normal property edit.

The `LIBRARY` sub-tree carries the user's imported-but-not-yet-placed samples so the catalogue
survives save / load. Only the stable `(id, filePath)` pair is persisted — cover art, ID3
tags, peaks and the playable bytes are re-fetched on load via the existing
`audio:readMetadata` IPC and the peaks cache.

**Save / load** is via `.silverdaw` files — a versioned JSON serialisation. A small outer
object carries `schemaVersion`, `appVersion`, and an ISO `savedAt` timestamp; the `project`
field holds the entire `PROJECT` `ValueTree` mapped through
[`ValueTreeJson`](backend/src/ValueTreeJson.h) (each node becomes
`{ "$type": "TRACK", id: "...", $children: [ … ] }`). Atomic save (write `<file>.tmp` then
rename) and forward-compatible load (unknown keys are ignored). On save, the current engine
playhead position is captured into `playheadMs` so reopening the project resumes where the
user left off. Logic lives in [`backend/src/ProjectFile.cpp`](backend/src/ProjectFile.cpp).

**Missing files** — on every `tracksAsJson` / `libraryAsJson` call, the backend stat()s each
referenced source path. Anything that's gone gets an `unresolved: true` flag in the
`PROJECT_STATE` snapshot. The renderer:

- Draws affected clips in a muted grey fill + red border so they're visibly broken.
- Auto-pops the **RelinkDialog** listing each missing clip with a *Locate file…* button. Each
  successful pick emits `CLIP_RELINK { clipId, filePath }`; the backend updates the project
  tree and re-creates the engine source, then rebroadcasts `PROJECT_STATE` which clears the
  `unresolved` flag on the relinked clip.
- Surfaces a single info toast summarising the count.
- Lets the user re-enter the relink flow later via the **Relink…** entry on the clip's
  right-click menu (only visible when the clip is unresolved).

**Dirty tracking** is driven by a `juce::ValueTree::Listener` on `ProjectState` that flips an
internal flag on every mutation. The flag is cleared by `markClean()` (called after load + a
successful save) and changes are broadcast as `PROJECT_DIRTY { dirty }` envelopes. The renderer
mirrors it as `projectStore.isDirty`, shows a leading `•` next to the project name in the title
bar when dirty, and intercepts **File → New / Open / Exit** and the window close button to
prompt with **Save / Don't save / Cancel** before discarding work.

On every connect the backend sends a `PROJECT_STATE` snapshot. The renderer:

- Reconstructs any track / clip / library item the backend knows but it doesn't (e.g. after a
  renderer reload).
- Sends `WAVEFORM_REQUEST` for every clip lacking peaks.
- Re-fetches embedded metadata (cover art, artist/title) via `audio:readMetadata` IPC for
  reconstructed library items.

`PROJECT_STATE` is purely additive on the connect path — it never deletes optimistic state the
user just created, so a race between an early user action and the snapshot arriving doesn't
lose work. On a load / new-project the same envelope carries `reset: true` and the renderer
wipes its mirror before applying.

Until the first `PROJECT_STATE` arrives, an inline splash inside `index.html` (then the Vue
`BridgeReadyOverlay` once it mounts) blocks all input so the user can't act on state that
hasn't been reconciled yet. A 30-second timeout shows an "Unable to start Silverdaw" error if
the bridge handshake never completes.

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

Waveform peaks (mono-mixed `min, max` float32 pairs at 200 peaks/sec) are computed once per
source file and persisted under `%APPDATA%/Silverdaw/peaks/<hash>.peaks`. The cache key is a
64-bit hash of `(filePath | mtime | size | peaksPerSecond)` — any change to the file
invalidates the entry automatically. The on-disk format is a 24-byte header (magic, version,
peaksPerSecond, peakCount, sampleRate) followed by `peakCount × 2 × float32` little-endian
peak values. Versioned so a future format change is detected as a miss rather than a corrupted
read; the same layout is what the renderer reads via the `peaks:readCacheFile` IPC.

The cache survives backend restarts.

## BPM detection

Every imported audio file is automatically analysed for tempo. The
result is shown on the library tile (e.g. `124.37 BPM`) and, on the
first import into an otherwise-empty project, seeds the project BPM
so the timeline grid lines up with what you imported.

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
already has a BPM for). Worker thread → decode the file via JUCE → downmix to mono
→ resample to 44.1 kHz with libsamplerate → feed BTrack frame-by-frame at hop=512 →
read `getCurrentTempoEstimate()`. Analysis is capped at the first 2 minutes of audio;
estimates outside `[40, 240]` BPM are dropped as implausible.

When detection finishes the worker `MessageManager::callAsync`s back to the JUCE
message thread to write `bpm` onto the matching `LIBRARY > ITEM` node and broadcast
`LIBRARY_ITEM_BPM { itemId, bpm }`. If the project is still at the default 100 BPM
and this is the *first* library item with a detected BPM, the project BPM is seeded
too and a `PROJECT_BPM_APPLIED { bpm }` envelope is broadcast — the renderer mirrors
both into `libraryStore` and `transportStore`.

The renderer shows a floating **import progress dialog** in the bottom-right corner
that surfaces both stages — "Decoding audio…" (renderer-side) then "Detecting tempo…"
(backend-side BTrack job) — so the long-tail BPM analysis isn't invisible. The
OS busy cursor stays in its `progress` state for the same lifespan.

## Preferences

User preferences are persisted as JSON at `%APPDATA%/silverdaw/preferences.json`:

- Window bounds + maximised state.
- Panel sizes (track-header column width, library panel height).
- **Follow playback** — continuous-follow auto-scroll. When on, the timeline scrolls so the
  playhead stays near the centre of the viewport during playback (default). Off pins the
  view in place. Toggleable in the transport bar (chevron-in-circle icon) and the
  Preferences dialog.
- **Show toast notifications** — pop transient feedback (errors, save acks) in the
  bottom-right. Off silences them; the underlying events still go to the log when debug
  mode is enabled.
- **Default project folder** — used as the starting directory for File → Save / Save As /
  Open. Defaults to `<home>/Music/Silverdaw/`, which is created on first launch.
- **Default clip folder** — starting directory for Add Track from File / library Import.
  Defaults to `<home>/Music/`. After every successful open it remembers the folder you
  browsed to **for the rest of the session**; on next launch it resets to this default.
- Last opened project path (for future Recent Projects MRU).
- **Enable Debugging** — gates the visibility of the **Debug** menu (Toggle Developer Tools)
  and the entire cross-layer file logger. Off by default. When on, the next launch writes a
  per-session `<repo>/.logs/<ISO-timestamp>/{main,backend,renderer}.log` triple with aligned
  millisecond timestamps so post-mortem analysis is one `cat *.log | sort` away.

Toggled via the in-app **Edit → Preferences…** dialog. QoL settings take effect on **Save**;
the **Enable Debugging** toggle requires a restart and the dialog surfaces that explicitly.

## Keyboard & mouse reference

The timeline accepts the following inputs. Modifiers behave **live** during drags — pressing
or releasing the modifier between frames switches mode without restarting the drag.

| Input | Effect |
|---|---|
| Click on **ruler** | Seek the playhead to the nearest sub-beat (1/16 at 4/4). |
| `Alt` + click on ruler | Seek to the exact pointer position (1 ms resolution, no snap). |
| Click on **clip** (no drag) | Select the clip and its host track, and seek the playhead to the click position. |
| Click + drag on **clip body** | Move the clip; start position snaps to the sub-beat grid. Drag across rows to move the clip to a different track. Clips can't overlap on a single track — they magnetically butt against neighbour edges instead. |
| `Alt` + drag on clip | Move with 1 ms resolution — the clip stays at the unsnapped position. |
| Click + drag on **clip edge** (~8 px hit zone) | Trim the clip from that edge (ms-precise; non-destructive — only the window over the source file changes). |
| Click on **empty area of a track row** | Select that track (highlighted row border), deselect any clip. |
| Click on **inter-track gap** / below the last track | Deselect both clip and track. |
| `←` / `→` | Step the playhead one grid line (sub-beat). |
| `Alt` + `←` / `→` | Step the playhead by one pixel's worth of time (~16.7 ms at default zoom, finer when zoomed in). |
| Mouse wheel | Zoom the timeline (anchored on the pointer). |
| Two-finger horizontal swipe (trackpad) | Pan left/right. |
| `Shift` + mouse wheel | Pan left/right. |
| `Ctrl +` / `Ctrl =` | Zoom in 20% (anchored on the playhead). |
| `Ctrl -` | Zoom out 20%. |
| `Ctrl 0` | Reset zoom to 100% (60 px/s). |
| `Space` (in transport bar) | Play / pause. |
| `F2` | Rename project (also activates the title-bar rename input). |
| `S` | Split every clip whose timeline window straddles the playhead into two at that position. |
| `D` | Duplicate the selected clip immediately after the original. |
| `Delete` | Delete the selected clip. |
| `Ctrl + X` / `Ctrl + C` | Cut / copy the selected clip into the local clipboard. |
| `Ctrl + V` | Paste the clipboard clip — on the source track it lands immediately after the source clip; on a different (selected) track it lands at the playhead. A toast appears if the slot is already occupied. |
| **Right-click on a clip** | Open the context menu: **Delete**, **Duplicate**, **Split at playhead**, an inline 16-swatch **Colour** picker, plus disabled placeholders for **Warp settings…**, **Transpose…**, **Save as Sample…**. Shows **Relink…** at the top when the clip is unresolved. |

The status bar shows the current zoom level (e.g. `🔍 150%`) next to the backend connection
indicator (plug-and-socket icon + green/grey dot).

### Selection model

A click selects two things at once: the **selected clip** (thick outline) is the target of
Cut, Copy, Duplicate, Delete, and Split-at-playhead shortcuts; the **selected track**
(highlighted row border) is the destination of Paste. Clicking a clip selects both the clip
and its host track. Clicking an empty area of a track row selects just that track. Clicking
between tracks clears both.

Copy/paste works across tracks: copy a clip on one track, click another track, paste — the
new clip lands on the destination track at the playhead. Overlap rules are evaluated only
on the destination; the source-track's clips don't constrain the new clip's placement.

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
  Developer Shell module that `scripts/Invoke-DevShell.ps1` relies on). Quick install:

  ```powershell
  winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  If you already have Visual Studio or Build Tools installed without the C++ workload, run the
  Visual Studio Installer and **Modify** the install to add *C++ build tools* (Build Tools SKU)
  or *Desktop development with C++* (full VS).
- **CMake** ≥ 3.22 and **Ninja**.
- **Node.js** ≥ 20 and **pnpm** ≥ 9 (the frontend is pure ESM and pnpm-only).

JUCE 8.0.12 and IXWebSocket are fetched automatically by CMake `FetchContent`; nothing to
install by hand.

The PowerShell helpers under `scripts/` (`Invoke-DevShell.ps1`, `Invoke-ClangTidy.ps1`) and the
matching Visual Studio Code tasks import the Visual Studio Developer Shell so `cl.exe` /
`link.exe` are on `PATH`.

## Setup and run

Clone the repository and from the workspace root:

```powershell
# 1. Configure + build the backend (Debug)
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake -S backend -B backend/build -G Ninja -DCMAKE_BUILD_TYPE=Debug"
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake --build backend/build --config Debug --parallel"

# 2. Install frontend dependencies
cd frontend
pnpm install

# 3. Start the Electron app (spawns the backend automatically)
pnpm dev
```

The same commands are also available as Visual Studio Code tasks (`backend: configure`,
`backend: build`, `frontend: install`, `frontend: dev`, plus the composite `dev: all`).

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
  starting up).
- `dist/win-unpacked/Silverdaw.exe` — the unpacked app for local smoke
  testing without going through the installer.

The installer is **not** code-signed, so Windows SmartScreen will show an "Unknown publisher"
warning on first run even though the Publisher field is populated. Code-signing is a separate
follow-up that requires an Authenticode certificate.

### Installer artwork

`scripts/Build-InstallerArt.py` regenerates the NSIS banner BMPs
(`installerHeader.bmp`, `installerSidebar.bmp`, `uninstallerSidebar.bmp` —
the jackdaw logo on black) and the `.silverdaw` document icon
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
  `readability-*`). Format with `clang-format` (`backend/.clang-format`).
- **TypeScript / Vue**: `pnpm typecheck` (vue-tsc + tsc --noEmit), `pnpm lint` (ESLint flat
  config with `eslint-plugin-vue` and `@typescript-eslint`).
- **Tests**: `pnpm test` runs Vitest over the shared bridge-protocol guards and music-time
  helpers (49 tests at time of writing).

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](LICENSE) for the full text. You are free to use,
study, modify, and redistribute it; any distributed or network-hosted modified
version must in turn be released under the AGPL with its source available to
users.

Third-party components (JUCE, IXWebSocket, Electron, Vue, etc.) retain their
own licences; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the
attribution notices required by those licences.

