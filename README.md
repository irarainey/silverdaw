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
+---------------------------+        ws://127.0.0.1:8765        +-----------------------------+
|  Electron renderer (Vue)  |  <----------------------------->  |  SilverdawBackend (JUCE)    |
|  + Electron main (IPC)    |  text JSON  +  binary frames      |  AudioEngine + ProjectState |
+---------------------------+                                   +-----------------------------+
```

Threading invariants:

- **Audio thread**: no allocations, no locks, no exceptions. Mutated state is reached via
  `std::atomic` (master clock, OffsetSource).
- **JUCE message thread**: owns every mutation of `AudioEngine`, `ProjectState`, the project
  `ValueTree`, and the audio source graph. The bridge marshals every incoming envelope onto this
  thread via `juce::MessageManager::callAsync`.
- **IXWebSocket I/O threads**: parse JSON, gate AUTH, then callAsync to the message thread.
- **Peaks worker pool**: `juce::ThreadPool` of 4 workers computes / loads waveform peaks off the
  message thread and broadcasts them as binary frames.

## Project layout

```text
backend/                 JUCE audio engine + WebSocket bridge (C++17, CMake)
  src/
    AudioEngine.*        Master transport clock, mixer, per-track audio sources
    BridgeServer.*       IXWebSocket loopback server + AUTH + binary frame send
    Main.cpp             Entry point, message dispatch, PlayheadEmitter, peaks ThreadPool
    PeaksCache.*         Disk-backed peaks cache (%APPDATA%/Silverdaw/peaks/)
    ProjectState.*       juce::ValueTree wrapper + UndoManager
    Waveform.*           Min/max peak computation + chunked binary frame encoder
  CMakeLists.txt         FetchContent for JUCE + IXWebSocket
frontend/                Electron + Vue 3 app (TypeScript, electron-vite, pnpm)
  resources/icons/       Multi-resolution .ico + PNG set (consumed by main + renderer)
  src/
    main/                Electron main process (window, menu, IPC, prefs)
    preload/             contextBridge surface exposed as window.silverdaw
    renderer/src/        Vue 3 SPA (Composition API, Pinia, PixiJS, Tailwind v4)
    shared/              Bridge wire-protocol catalogue + runtime guards (also TS-tested)
scripts/                 Dev-shell + clang-tidy helpers (PowerShell)
.github/instructions/    Copilot/AI agent guidance per file type
```

## Bridge protocol

The bridge carries two physical frame types:

**Text frames** — JSON control plane:

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
- After AUTH succeeds the backend sends `PROJECT_STATE` exactly once (full snapshot of tracks +
  clips). The renderer treats itself as an additive mirror of that snapshot.

**Binary frames** — bulk data plane (length-prefixed JSON header + raw bytes):

```text
| u32 LE: jsonHeaderLen | jsonHeaderLen UTF-8 bytes | raw payload |
```

Today the only binary envelope is `WAVEFORM_DATA`. Header fields:

```json
{ "type": "WAVEFORM_DATA", "clipId": "...", "sampleRate": 44100, "peaksPerSecond": 200,
  "peakCount": 63324, "format": "int16le",
  "chunkIndex": 3, "chunkCount": 8, "chunkOffset": 49152 }
```

Peaks are int16-quantised and chunked at ≤32 KB per frame with a 2 ms yield between sends,
which keeps the IXWebSocket I/O loop responsive to renderer → backend reads even during a
post-reconnect rehydrate that ships many chunks back-to-back.

The full catalogue (text + binary, both directions) lives in
[`frontend/src/shared/bridge-protocol.ts`](frontend/src/shared/bridge-protocol.ts) with TS
discriminated unions and runtime guards. The renderer dispatches inbound messages in
[`frontend/src/renderer/src/lib/bridgeService.ts`](frontend/src/renderer/src/lib/bridgeService.ts);
the backend dispatches in [`backend/src/Main.cpp`](backend/src/Main.cpp)
(`dispatchBridgeMessage`).

## Project state model

`ProjectState` (C++) wraps a `juce::ValueTree` (`PROJECT > TRACK[id, gain] > CLIP[id, filePath,
offsetMs, durationMs]`) plus a shared `UndoManager`. It's the structural source of truth; the
audio graph in `AudioEngine` is updated in lockstep by the bridge dispatch handlers.

On every connect the backend sends a `PROJECT_STATE` snapshot. The renderer:

- Reconstructs any track / clip / library item the backend knows but it doesn't (e.g. after a
  backend restart).
- Sends `WAVEFORM_REQUEST` for every clip lacking peaks.
- Re-fetches embedded metadata (cover art, artist/title) via `audio:readMetadata` IPC for
  reconstructed library items.

`PROJECT_STATE` is purely additive — it never deletes optimistic state the user just created,
so a race between an early user action and the snapshot arriving doesn't lose work.

Until `PROJECT_STATE` arrives, a full-screen `BridgeReadyOverlay` blocks all input (mouse +
menu shortcuts) so the user can't act on state that hasn't been reconciled yet.

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

Waveform peaks (int16-quantised, mono-mixed min/max pairs at 200 peaks/sec) are computed once
per source file and persisted under `%APPDATA%/Silverdaw/peaks/<hash>.peaks`. The cache key is
a 64-bit hash of `(filePath | mtime | size | peaksPerSecond)` — any change to the file
invalidates the entry automatically. The on-disk format is preceded by a versioned header
(magic + version + peaks-per-second + peak count + sample rate) so future format changes are
detected as a miss rather than corrupted reads.

The cache survives backend restarts.

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

Production builds use `--config Release` for the backend and `pnpm build` for the frontend.

## Packaging a Windows installer

The `scripts/Build-Release.ps1` helper does the whole release pipeline end-to-end:

1. Configures + builds the JUCE backend (`SilverdawBackend.exe`) in **Release**.
2. Compiles the Electron main / preload / renderer bundles (`electron-vite build`).
3. Packages an **NSIS installer** with `electron-builder`, bundling the
   backend exe + icons + `LICENSE` + `THIRD_PARTY_LICENSES.md`.

From the repository root:

```powershell
pwsh -NoProfile -File scripts/Build-Release.ps1
```

Outputs land in the repo-root `dist/` directory (gitignored except for a
`.gitkeep` marker):

- `dist/Silverdaw-Setup-1.0.0.exe` — the NSIS installer (~90 MB). Runs a
  standard wizard with an AGPL licence page, choose-directory step, and
  desktop + Start menu shortcuts.
- `dist/win-unpacked/Silverdaw.exe` — the unpacked app for local smoke
  testing without going through the installer.

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
- **Tests**: `pnpm test` runs Vitest over shared bridge-protocol guards and music-time helpers.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](LICENSE) for the full text. You are free to use,
study, modify, and redistribute it; any distributed or network-hosted modified
version must in turn be released under the AGPL with its source available to
users.

Third-party components (JUCE, IXWebSocket, Electron, Vue, etc.) retain their
own licences; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the
attribution notices required by those licences.

