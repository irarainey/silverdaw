# Project Context — Silverdaw

_Last reviewed: 2026-07-07 · Owner: @irarainey_

The small, always-on source of truth. Read this first. It is mostly an index —
inline only what is `CRITICAL`; open the linked documents only when a task
touches them.

## What this is

An open-source **Windows desktop DAW** for bedroom DJs, producers, and mixers
making remixes and mashups. A studio **creation** tool, not a live-performance
instrument. Two processes: an Electron 42 + Vue 3 UI and a headless JUCE 8 C++
audio engine, linked by a per-session-authenticated loopback WebSocket.

## Current state

Core arrangement, mixing, analysis, stem separation, and out-of-process engine
recovery are all shipped. See `docs/developer-guide.md#current-status-and-roadmap`
for the current feature set and roadmap.

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
  ADR 0012 (detailed tokens in `.github/instructions/ui-ux-styling…`).
- `IMPORTANT` — **Maintainability is a first-class gate.** Small, single-purpose
  files; no duplication; names carry intent; the authoring-time "extract before
  you grow" rule and per-file-type ceilings. See ADR 0016.
- `IMPORTANT` — **Audio playback performance is always first-class.** JUCE-level
  optimisation on the audio path is expected, balanced against maintainable code.
  See ADR 0017 (firm figures in `docs/developer-guide.md#rendering-performance`).
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

## Load on demand

_Read these only when the task touches them — not by default._

- Structure, boundaries, threading, data flow → `ARCHITECTURE.md`
- Significant decisions (the *why*, and what was rejected) → `DECISIONS.md`
- Per-language rules the AI must respect → `.github/copilot-instructions.md`
  and `.github/instructions/`
- Feature detail, roadmap, protocol catalogue → `docs/developer-guide.md`,
  `docs/development-plan.md`
