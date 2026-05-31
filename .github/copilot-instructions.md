# Silverdaw — Copilot instructions

Silverdaw is an open-source Windows DAW for bedroom DJs, producers, and mixers
making remixes and mashups. It is a studio creation tool, not a live-performance
instrument. Two surfaces:

- **Backend** (`backend/`): headless JUCE 8 audio engine + WebSocket bridge,
  C++17, CMake, MSVC. Builds `SilverdawBackend.exe`.
- **Frontend** (`frontend/`): Electron 31 + Vue 3.5 (`<script setup lang="ts">`)
  + Pinia 2 + PixiJS 8 + Tailwind v4, TypeScript 5.x / ES2022, electron-vite.

They communicate over a loopback WebSocket using `{ type, payload }` JSON
envelopes. The zod schema in `frontend/src/shared/bridge-protocol.ts` is the
**single source of truth** for the wire protocol.

## Review priorities (in order)

correctness → **maintainability / best practice** → security → performance →
micro-optimisation.

Maintainability is a first-class gate, not a nice-to-have. Treat the rules below
as blocking-class review findings, not stylistic suggestions.

## Rubber-duck rule

All serious review work must be rubber-ducked across **three models**: the model
in use (**opus-4.8**), **gpt-5.5**, and **gpt-5.3-codex**. Run major/critical
findings and any patch touching real-time audio, Electron IPC, the bridge
contract, persistence/recovery, or timeline rendering past all three, reconcile
disagreement, and note which perspectives were consulted. If one is genuinely
unavailable, say so and proceed with the rest.

## Maintainability rules (enforce strongly)

- **Keep files small and single-purpose.** Flag oversized files and **propose a
  concrete split** (by responsibility / feature / adapter). Heuristics, not
  dogma: Vue SFC > ~250 lines, TS module > ~350 lines, C++ translation unit
  > ~500 lines, any function > ~50 lines or deeply nested → scrutinise.
  **Resist adding new code to already-oversized files** (e.g. `Main.cpp`) —
  extract into a focused unit instead of growing the god file.
- **No duplication.** Duplicated logic, dispatch branches, payload shapes, regex,
  or magic constants are defects. Require a single source of truth and a dedupe
  strategy (shared helper / composable / base type / enum). Reuse before
  reinventing; check whether a helper already exists first.
- **Single responsibility & clear boundaries.** One reason to change per
  module / component / store. Keep audio-thread, message-thread, and I/O
  concerns separated on the backend; presentation ↔ store ↔ preload ↔ main ↔
  backend separated on the frontend.
- **SOLID / DRY / KISS / YAGNI.** Prefer composition and small focused units,
  guard clauses over deep nesting, and no speculative generality.
- **Names carry intent.** Files, types, functions, variables, and bridge `type`
  strings should be self-explanatory. Comment the *why*, never the *what*.

## Project invariants (never violate)

- **Audio thread is real-time:** no allocation, locking, throwing, or blocking
  I/O in the audio callback. Hand data to the audio thread via a lock-free
  publication (e.g. `atomic<const T*>` + retire queue), not `shared_ptr` swaps.
- **Bridge contract:** every envelope is `{ type, payload }`. Add a new message
  to the zod schema first, then validate on both ends — never hand-write a
  parallel TypeScript type that can drift from the runtime guard. The backend
  validates `juce::var` shapes via the `tryGetString`-style helpers rather than
  coercing objects/arrays/numbers silently.
- **Dynamic bridge port:** Electron main probes a free loopback port and spawns
  the backend with `--port <N>`. The backend has **no default** and refuses to
  start without it (exit code 2). Never hardcode a port number. AUTH is a
  per-session token; the first envelope on every socket must be `AUTH { token }`.
- **Electron hardening:** context isolation on, `nodeIntegration` off, sandboxed
  renderer, restrictive CSP, validated IPC, least-privilege preload surface,
  `setWindowOpenHandler` deny. Validate/clamp file paths on import.
- **Types:** no `any`; discriminated unions for bridge messages and player
  events; no `I`-prefixed interface names; `Readonly<T>` for inputs where it fits.
- **Non-destructive editing:** tempo, pitch, trim, fades, and volume shape are
  stored as clip settings — never mutate the user's source files.

## Testing reality

- Backend uses a **custom harness** `SilverdawBackendTests` wired into CTest
  (no Catch2 / GoogleTest dependency). Frontend uses **Vitest** (+ Playwright
  for Electron e2e, planned). Match the existing harness — do not introduce a
  new test framework.

## Language standards

Defer to the path-specific instruction files under `.github/instructions/`
(auto-applied by glob): C++/JUCE audio, TypeScript 5 / ES2022, audio/waveform
TS, Vue 3, Markdown, and documentation. Do not restate their contents here.

## Documentation constraint

No references or comparisons to any other DAW product in any document — nothing
should look copied. Naming streaming / sharing services (Spotify, SoundCloud,
Mixcloud, YouTube) as feature targets is fine.
