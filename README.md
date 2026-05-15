# Jackdaw

A digital audio workstation built with a headless JUCE audio engine and an Electron + Vue 3 UI,
linked by a localhost WebSocket bridge.

## Architecture

Jackdaw is split into two processes that talk over a localhost WebSocket bridge:

- **Backend** (`backend/`) — A headless C++17 / JUCE 8 binary (`JackdawBackend`) that owns the
  audio device, mixer and timeline. It exposes its state and commands over an
  [IXWebSocket](https://github.com/machinezone/IXWebSocket) server bound to `127.0.0.1`.
- **Frontend** (`frontend/`) — An Electron 31 + Vue 3 (Composition API, `<script setup>`) app
  built with electron-vite. The renderer talks to the bridge directly; the main process owns
  the OS dialogs, native menu and persisted preferences.

```text
+---------------------------+        ws://127.0.0.1:8765        +-------------------------+
|  Electron renderer (Vue)  |  <----------------------------->  |  JackdawBackend (JUCE)  |
|  + Electron main (IPC)    |        envelope JSON frames       |  AudioEngine + Bridge   |
+---------------------------+                                   +-------------------------+
```

Threading rules:

- Audio thread: no allocations, no locks, no exceptions.
- Engine mutations happen on the JUCE message thread via `juce::MessageManager::callAsync`.
- IXWebSocket I/O threads marshal inbound frames onto the message thread before touching the
  engine.

## Bridge protocol

Every frame is a UTF-8 JSON object with this envelope:

```json
{ "type": "PLAYHEAD_UPDATE", "payload": { "positionMs": 1234.5, "isPlaying": true } }
```

- `type` is an UPPER_SNAKE_CASE string discriminator.
- `payload` is a JSON object (or `null` for type-only messages).
- The bridge is loopback-only; TLS and authentication are intentionally omitted.

The renderer dispatches inbound messages in `frontend/src/renderer/src/lib/bridgeService.ts`;
the backend dispatches inbound messages in `backend/src/Main.cpp` (`dispatchBridgeMessage`).

## Audio formats

The JUCE backend decodes formats supported by its `AudioFormatManager`:

- **All platforms**: WAV, AIFF, FLAC, Ogg Vorbis.
- **Windows**: additionally MP3 and the Windows Media family (WMA / WMV / ASF / WM) via
  the Windows Media Format SDK that ships with JUCE.

Other formats the user may want to import (notably **AAC / M4A / MP4** on Windows, where
JUCE doesn't bundle a Media Foundation reader) are handled in the renderer:

1. The Web Audio API (`AudioContext.decodeAudioData`) decodes the file — it understands
   every codec the host Chromium build does.
2. The decoded PCM is sent to the Electron main process via the `audio:writeTempWav` IPC,
   which writes a 32-bit float WAV into `%TEMP%/jackdaw-transcode-cache/` (or the OS
   equivalent) keyed by a hash of the source path + sample rate + channel count + length.
3. The cached WAV path is sent to the backend as `CLIP_ADD.filePath`, so the audio engine
   only ever sees formats it can decode natively. The original path stays on the library
   item for display purposes; re-dragging the same library item onto another track reuses
   the cached WAV without re-decoding.

The relevant code lives in
`frontend/src/renderer/src/lib/audio.ts`,
`frontend/src/renderer/src/lib/importAudio.ts` (`BACKEND_NATIVE_EXTS` + `resolvePlaybackPath`)
and the `audio:writeTempWav` handler in `frontend/src/main/index.ts`.

## Prerequisites

Jackdaw is developed in Visual Studio Code; the toolchain is cross-platform.

- A **C++17 compiler** — MSVC on Windows, Clang ≥ 14 on macOS, or GCC ≥ 11 / Clang ≥ 14 on
  Linux. JUCE 8 also needs the platform's audio headers (e.g. ALSA / JACK dev packages on
  Linux, the macOS SDK on macOS). On Windows the full Visual Studio IDE is **not** required:
  the standalone **Build Tools for Visual Studio** SKU with the *C++ build tools* workload is
  sufficient (it ships `cl.exe`, `link.exe`, the Windows SDK, `vswhere.exe` and the Developer
  Shell module that `scripts/Invoke-DevShell.ps1` relies on). Quick install:

  ```powershell
  winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  If you already have Visual Studio or Build Tools installed without the C++ workload, run the
  Visual Studio Installer and **Modify** the install to add *C++ build tools* (Build Tools SKU)
  or *Desktop development with C++* (full VS).
- **CMake** ≥ 3.22 and **Ninja**.
- **Node.js** ≥ 20 and **pnpm** ≥ 9 (the frontend is pure ESM and pnpm-only — see
  `frontend/pnpm-workspace.yaml`).

JUCE 8.0.12 and IXWebSocket are fetched automatically by CMake `FetchContent`; nothing to
install by hand.

The PowerShell helpers under `scripts/` (`Invoke-DevShell.ps1`, `Invoke-ClangTidy.ps1`) and
the matching Visual Studio Code tasks are Windows-only conveniences — they import the Visual
Studio Developer Shell so `cl.exe` / `link.exe` are on `PATH`. On macOS and Linux you call
`cmake` directly (see below).

## Setup and run

Clone the repository and from the workspace root:

**Windows (PowerShell, via the VS Dev Shell helper):**

```powershell
# 1. Configure + build the backend (Debug)
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake -S backend -B backend/build -G Ninja -DCMAKE_BUILD_TYPE=Debug"
pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 `
  "cmake --build backend/build --config Debug --parallel"

# 2. Install frontend dependencies
cd frontend
pnpm install

# 3. Start the Electron app with HMR (spawns the backend automatically)
pnpm dev
```

**macOS / Linux:**

```bash
# 1. Configure + build the backend (Debug)
cmake -S backend -B backend/build -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build backend/build --config Debug --parallel

# 2. Install frontend dependencies
cd frontend
pnpm install

# 3. Start the Electron app with HMR (spawns the backend automatically)
pnpm dev
```

On Windows the same commands are also available as Visual Studio Code tasks
(`backend: configure`, `backend: build`, `frontend: install`, `frontend: dev`, plus the
composite `dev: all`).

Production builds use `--config Release` for the backend and `pnpm build` for the frontend.

## Quality gates

- **C++**: `clang-tidy` via `scripts/Invoke-ClangTidy.ps1` (`backend: lint` task) — `.clang-tidy`
  enables `modernize-*`, `bugprone-*`, `performance-*`, `readability-*`. Format with
  `clang-format` (`.clang-format` at repo root).
- **TypeScript / Vue**: `pnpm typecheck` (vue-tsc + tsc --noEmit) and `pnpm lint` (ESLint flat
  config with `eslint-plugin-vue` and `@typescript-eslint`).

## Project layout

```text
backend/             JUCE audio engine + WebSocket bridge (C++17, CMake)
  src/
    AudioEngine.*    Mixer / track / clip primitives
    BridgeServer.*   IXWebSocket loopback server
    Main.cpp         Entry point, message dispatch, PlayheadEmitter
  CMakeLists.txt     FetchContent for JUCE + IXWebSocket
frontend/            Electron + Vue 3 app (TypeScript, electron-vite, pnpm)
  src/
    main/            Electron main process (window, menu, IPC, prefs)
    preload/         contextBridge surface exposed as window.jackdaw
    renderer/src/    Vue 3 SPA (Composition API, Pinia, PixiJS, Tailwind v4)
scripts/             Dev-shell + clang-tidy helpers (PowerShell)
.github/instructions Copilot/AI agent guidance per file type
```

