# Project Context — Silverdaw

_Last reviewed: 2026-07-12 · Owner: @irarainey_

The small, always-on source of truth. Read this first. It is mostly an index —
inline only what is `CRITICAL`; open the linked documents only when a task
touches them.

## What this is

An open-source **Windows desktop DAW** for bedroom DJs, producers, and mixers
making remixes and mashups. A studio **creation** tool, not a live-performance
instrument. Two processes: an Electron 42 + Vue 3 UI and a headless JUCE 8 C++
audio engine, linked by a per-session-authenticated loopback WebSocket.

## Current state

Core arrangement, mixing, analysis, stem separation, supported MIDI deck
control, and out-of-process engine recovery are all shipped. Silverdaw is
**publicly released** — installable from the **Microsoft Store**
(auto-updating), so existing installs, saved preferences, and saved projects
must keep working across every update (see ADR 0019). See
`docs/developer-guide.md#current-status-and-roadmap` for the current feature set
and roadmap.

## Goals and non-goals

- **Goal:** radical, beginner-friendly simplicity — sensible defaults, no modal
  dialogs for common actions, drag-and-drop everywhere, immediate feedback.
- **Goal:** fast import-to-arrangement for remixes, mashups, stems, harmonic
  matching.
- **Non-goal:** notation and live DJ performance (explicitly deprioritised).
- **Non-goal (permanent):** any non-Windows platform or a hosted/web version.
  Silverdaw is, and will remain, a **Windows x64 desktop application only** — do
  not add macOS/Linux abstractions or a server/hosted mode.

## Constraints

- `CRITICAL` — **Audio thread is real-time.** No allocation, locking, throwing,
  or blocking I/O in the audio callback. Publish to it lock-free. See ADR 0006.
- `CRITICAL` — **Backend `ValueTree` is the single source of truth** for project
  state; the renderer mirrors it. See ADR 0002.
- `CRITICAL` — **Non-destructive editing.** Tempo, pitch, trim, fades, reverse,
  and volume shape are clip settings — never mutate the user's source files.
  See ADR 0007.
- `CRITICAL` — **Backward compatibility is binding — the app is publicly
  released (Microsoft Store, auto-updating).** Persisted **project files** and
  **preferences** are versioned and read-old/write-latest; new fields are
  additive with safe defaults; never remove/repurpose a persisted key or make an
  older project or prefs file fail to open. Bump a version only on a semantic
  change and migrate it explicitly; code around changed features must degrade
  gracefully for older state. See ADR 0019 (and ADR 0015).
- `CRITICAL` — **Bridge is text-only `{ type, payload }`.** Bulk data (peaks,
  stems, mixdowns) goes via disk + a small `*_READY` envelope, never the socket.
  See ADR 0003.
- `CRITICAL` — **`bridge-protocol.ts` zod schema is the wire-protocol source of
  truth.** Add the message there first; never hand-write a parallel type. ADR 0004.
- `CRITICAL` — **Dynamic loopback port + per-session AUTH.** Never hardcode a
  port; the backend refuses to start without `--port` (exit 2); the first
  envelope on every socket is `AUTH { token }`. See ADR 0005.
- `IMPORTANT` — **Electron hardening:** context isolation on, `nodeIntegration`
  off, sandboxed renderer, restrictive CSP, validated IPC, least-privilege
  preload, `setWindowOpenHandler` deny; validate/clamp imported file paths.
- `IMPORTANT` — **Licence is AGPL-3.0-or-later.** New third-party code must be
  licence-compatible. See ADR 0010.
- `IMPORTANT` — **Beginner-first simplicity is the product tie-breaker;** the
  renderer follows a single dark, small-palette design system. See ADR 0011,
  ADR 0012 (detailed tokens in `.github/instructions/ui-ux-styling.instructions.md`).
- `IMPORTANT` — **Audio playback performance is always first-class.** JUCE-level
  optimisation on the audio path is expected, balanced against maintainable code.
  See ADR 0017 (firm figures in `docs/developer-guide.md#rendering-performance`).
- `IMPORTANT` — **Inaudible tracks perform no per-track audio work.** Muted,
  solo-excluded, and fully attenuated tracks skip clip reads, warp, pitch,
  effects, sends, and metering while remaining live-editable. See ADR 0020.
- `REFERENCE` — No references or comparisons to any other DAW product in any
  document. Naming streaming/sharing services as feature targets is fine.

## Glossary

- **Bridge** — the loopback WebSocket carrying the `{ type, payload }` control
  plane between renderer and backend.
- **Library item** — a source audio entry; clips reference audio by
  `libraryItemId`, never by path.
- **Warp** — non-destructive per-clip time-stretch/pitch mapping (Rubber Band).
- **Peaks** — waveform min/max summary, disk-cached, delivered via `*_READY`.
- **Mixdown** — offline render through the same canonical chain as playback.

## Maintainability

A first-class, **blocking-class** gate — not a style nit. One coherent unit of
thought per file; no duplication (logic, dispatch branches, payload shapes, magic
constants); one reason to change per module; names carry intent; comment the
*why*, not the *what*. The full policy — domain separation, the authoring-time
"Before you add code" gate, per-file-type ceilings, the ~800-line hard trigger,
and the real-time-path exception — is ADR 0016
(`docs/adr/0016-maintainability-file-size.md`); the path-specific files under
`.github/instructions/` carry only their language's ceiling.

## Testing & coverage

Match the existing harness/framework — never introduce a new one. Rationale and
detail: ADR 0014 (`docs/adr/0014-testing-strategy.md`).

- **Backend** — a custom `SilverdawBackendTests` harness wired into **CTest** (no
  Catch2/GoogleTest). Configure with `-DSILVERDAW_BUILD_TESTS=ON`, build the
  `SilverdawBackendTests` target, then run in an MSVC Developer environment
  (e.g. via `scripts/Invoke-DevShell.ps1`):
  `ctest --test-dir backend/build --build-config Debug --output-on-failure`.
  Each case is a separate CTest test (discovered at build time via the harness's
  `--list` / `--run` flags), so cases show individually in `ctest` and the VS
  Code Testing panel. Keep test-case names ASCII. **When you add or remove a
  backend test, update the registry-count assertion in `backend/tests/BackendTests.cpp`
  (`tests.size() == N`) to match — otherwise build-time test discovery (`--list`)
  aborts and the build fails.**
- **Frontend** — **Vitest** (`pnpm test`; `pnpm test:watch`), Vue Test Utils for
  components; Playwright e2e planned.
- **Coverage** — `scripts/Coverage.ps1 [-Target All|Frontend|Backend]` runs
  either/both and collects the HTML reports into a single gitignored root
  `coverage/` folder (`coverage/index.html` links both). Frontend uses Vitest v8
  (`pnpm test:coverage`); backend uses **OpenCppCoverage** over the Debug binary
  on MSVC via the `SilverdawBackendCoverage` target
  (`-DSILVERDAW_ENABLE_COVERAGE=ON`; `winget install
  OpenCppCoverage.OpenCppCoverage`). OpenCppCoverage ends on a benign breakpoint
  stop code on Debug JUCE builds — expected; the report is still written.

## Versioning & builds

- **Two version numbers — bump both together on every release:**
  - `backend/CMakeLists.txt` → `project(SilverdawBackend VERSION x.y.z)` is the
    **single source of truth for the backend**. CMake generates `Version.h`
    (`silverdaw::kBackendVersion`) from it (template: `backend/src/core/Version.h.in`),
    feeding the startup log banner, the project-file `appVersion`, and the bridge
    `READY` version — no source file hardcodes the number.
  - `frontend/package.json` → `"version"` is the Electron app version and drives
    the electron-builder artifact names (`Silverdaw-<version>.*`).
- `CRITICAL` — **All native (C++) builds and `ctest` need the MSVC Developer
  environment.** Never run `cmake` / `ninja` / `ctest` from a bare shell
  (standard headers like `<algorithm>` fail to resolve). Wrap the command in
  `scripts/Invoke-DevShell.ps1 "<command>"`, which enters the latest VS x64 dev
  shell first (the same wrapper `.vscode/tasks.json` uses).

## Load on demand

_Read these only when the task touches them — not by default._

- Structure, boundaries, threading, data flow → `ARCHITECTURE.md`
- Significant decisions (the *why*, and what was rejected) → `DECISIONS.md`
- Per-language rules the AI must respect → `.github/copilot-instructions.md`
  and `.github/instructions/`
- Feature detail, roadmap, protocol catalogue → `docs/developer-guide.md`,
  `docs/development-plan.md`
