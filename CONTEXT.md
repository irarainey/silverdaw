# Project Context — Silverdaw

_Last reviewed: 2026-08-30 · Owner: @irarainey_

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
control, Scratch Editor, and out-of-process engine recovery are all shipped, as
are the **1.4.x** additions — multiple automation parameter lanes per track,
timeline range selection with one-shot or looped playback, importing stems and
samples from another project, range-auditioning polish, and the Playwright
end-to-end test tier. **1.5.0** added a selectable timeline snap grid,
exact-position markers, Clear All Markers, smooth playhead-follow scrolling,
`Enter` to accept a dialog, restyled dropdowns, an immediate timeline paint on
project open, and a set of beat-grid, marker, MIDI-jog, audio-driver and
loop-playback fixes. **1.5.1** was a patch covering undo and clip-split
correctness and performance. **1.5.3** was a patch fixing warped clips: a
stretched clip now plays and exports for its full stretched
length, and saved music samples auto-warp to the project tempo on drop and offer
Follow project BPM / Pin in the warp controls. It also settles what a one-shot
is: a simple sample cannot hold a BPM at all, and no surface draws a beat grid
over one, and it makes a clip's original BPM a single fact resolved the same way
in both processes (ADR 0024), so a clip can no longer be drawn stretched while
playing back dry. A clip cut to a number of bars now stays that number of bars
however its tempo is later re-detected, and changing the project tempo keeps the
arrangement's musical shape — clips, their warps, an active timeline selection,
the markers and the playhead all move with it; a reanalysis likewise brings the
clips already using that source onto its new tempo. It also detects an audio
device that has silently stopped delivering audio and restarts it, rather than
leaving the transport showing playback with a playhead that never moves.
**1.6.0** added a user-scoped **file browser** (the library panel's Files tab)
for browsing folders of audio on disk, auditioning a file before importing it,
and importing it — see `docs/development-plan.md` §1.6.0.
**1.6.1** settled the project tempo box — a tempo applies once the edit settles
rather than on every spinner tick, typing a tempo commits, and entering the box
selects what is there — and tidied the file browser, where the now-playing bar
clears when the audition stops and a whole row is the click target.
**1.7.0** let a track carry the user's own
**VST3 effect plugins** as per-track inserts from a new Plugins tab: scanned out
of process so a plugin that fails to load cannot take the app down, saved with
the project and held in place when one is not installed, and rendered on export
exactly as the arrangement plays, with delay compensation and tempo/playhead
sync keeping them in time — see `docs/development-plan.md` §1.7.0. It also
dragged a file from the Files tab straight onto a track, and reopened the lower
panel on the tab it was left on.
Release **1.7.1** fixed clip timing arithmetic: a trimmed
edge no longer slides the audio inside the clip, the waveform is drawn from the
clip's exact position in the source so identical windows render identically, and
a clip's beat-grid phase became a per-clip fact, so correcting one clip's markers
moves the audio inside that clip alone and leaves both its position and its
siblings' markers where they were — see `docs/development-plan.md` §1.7.1.
The current release is **1.8.0**, which closes the gap between changing a tempo and
correcting one: **Edit BPM** — reached from a library item's context menu, the
Edit button on its information dialog, or the beat grid in the Clip Editor
opened on a timeline clip — rewrites the source tempo alone in one undoable step,
respacing that file's beat markers without moving a single clip, marker or
automation point, and reports what it re-warped and what it left alone. The
project tempo is never touched: it is the user's number, set in the transport
(ADR 0027, `docs/development-plan.md` §1.8.0). Detection itself also got more
accurate, so the correction is needed less often: the audio is conditioned to
emphasise percussive content before beat tracking, a disputed tempo is settled
by an independent second engine, and the grid is fitted to onset starts rather
than to onset-function peaks, which had been leaving markers a few milliseconds
late on bass-heavy material (ADR 0028).
Per-release detail lives in `CHANGELOG.md`.
Silverdaw is **publicly released** — installable from the
**Microsoft Store** (auto-updating), so existing installs, saved preferences,
and saved projects must keep working across every update (see ADR 0019).

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
  The **one** exception is a hosted VST3 plugin's own `processBlock`, which
  Silverdaw cannot police — ADR 0025 accepts that as a bounded risk. It licenses
  nothing in Silverdaw's own audio code, which stays strictly bound by ADR 0006.
- `CRITICAL` — **Backend `ValueTree` is the single source of truth** for project
  state; the renderer mirrors it. See ADR 0002.
- `CRITICAL` — **A clip has one original BPM and one warp target.** The renderer
  resolves it only via `libraryItemSourceBpm`, the engine only via
  `ProjectState::getLibraryItemBpm`, and the two share the same rules — including
  that a recorded musical length (`musicalBeats`) outranks any detected tempo, so
  a clip cut to a number of bars stays that number of bars. Never read
  `item.bpm` directly to draw, grid, warp or stretch. Beat *phase* is the
  exception and belongs to the clip (`CLIP.beatOffsetMs`), resolved through
  `resolveClipBeatGrid`. See ADR 0024.
- `CRITICAL` — **Non-destructive editing.** Tempo, pitch, trim, fades, reverse,
  and volume shape are clip settings — never mutate the user's source files.
  See ADR 0007.
- `CRITICAL` — **Backward compatibility is binding — the app is publicly
  released (Microsoft Store, auto-updating).** Persisted **project files** and
  **preferences** are versioned and read-old/write-latest; new fields are
  additive with safe defaults; never remove/repurpose a persisted key or make an
  older project or prefs file fail to open. Bump a version only on a semantic
  change and migrate it explicitly; code around changed features must degrade
  gracefully for older state. This applies to state produced by a released
  build; unreleased features may evolve until release, when their persisted
  semantics become binding. See ADR 0019 (and ADR 0015).
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

Match the existing harness — **never introduce a new test framework**. This binds
within a tier: no second unit framework beside Vitest, no second backend harness
beside `SilverdawBackendTests`. The backend uses a custom `SilverdawBackendTests`
harness wired into **CTest** (no Catch2/GoogleTest); the frontend uses **Vitest**
in a `node` environment (Vue Test Utils is not installed, so component behaviour
belongs to the e2e tier, not to a unit spec); **Playwright**
(`frontend/e2e/`, `pnpm test:e2e`) drives the
built app against a real backend for end-to-end journeys. The e2e tier
supplements the other two and replaces neither — keep it few, wide, and asserted
on the DOM, the filesystem, and saved project files, never on canvas pixels.

Rationale: ADR 0014. Commands and coverage tooling:
`docs/developer-guide.md#quality-gates`.

## Versioning & builds

- `CRITICAL` — **All native (C++) builds and `ctest` need the MSVC Developer
  environment.** Never run `cmake` / `ninja` / `ctest` from a bare shell
  (standard headers like `<algorithm>` fail to resolve). Wrap the command in
  `scripts/Invoke-DevShell.ps1 "<command>"`, which enters the latest VS x64 dev
  shell first (the same wrapper `.vscode/tasks.json` uses).
- **Two version numbers — bump both together on every release:**
  `backend/CMakeLists.txt` `project(... VERSION x.y.z)` is the backend source of
  truth (CMake generates `Version.h`; no source file hardcodes the number), and
  `frontend/package.json` `"version"` is the Electron app version. Setup,
  packaging, and release detail: `docs/developer-guide.md`.

## Diagnosing a reported problem

Runtime logs are the first place to look. Each run writes an ISO-timestamped
folder under `%USERPROFILE%\Silverdaw\Logs\` containing `main.log`,
`renderer.log`, and `backend.log` (verbose logging is opt-in via
**Preferences ▸ Developer**). Always-on startup and crash artifacts live
separately in `%USERPROFILE%\Silverdaw\Diagnostics\`. Detail:
`docs/developer-guide.md#startup-diagnostics-always-on`.

## Load on demand

_Read these only when the task touches them — not by default._

- Structure, boundaries, threading, data flow → `ARCHITECTURE.md`
- Significant decisions (the *why*, and what was rejected) → `DECISIONS.md`
- Per-language rules the AI must respect → `.github/copilot-instructions.md`
  and `.github/instructions/`
- Feature detail, roadmap, protocol catalogue → `docs/developer-guide.md`,
  `docs/development-plan.md`
