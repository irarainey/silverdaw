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

## Maintainability rules (enforce strongly)

- **Keep files small and single-purpose.** A file should represent **one
  coherent unit of thought** — a class, a module, a component, a domain concept.
  If you can't describe what a file does in one short sentence, it's doing too
  much. Line count is a *symptom, not the goal*: a 1,000-line pure data/schema
  table can be fine, while a 300-line file with 8 responsibilities is a mess.
  Real signals a file is too long: more than one primary class/concept, an
  enormous import block, you scroll past unrelated code to find things, it's a
  frequent merge-conflict hot-spot. Soft ceilings (scrutinise above these):
  - **Vue SFC** ~250 lines · **TS module** ~350 · **TS type/schema-only** longer
    is OK · **C++ header** ~250 (declarations only) · **C++ `.cpp`** ~500
    (≥800 warrants serious scrutiny) · any **function** > ~50 lines or deeply
    nested.
  - **Hard review trigger: ANY file > 800 lines must be seriously considered for
    splitting unless there is a very good, explicitly-stated reason** (e.g. a
    genuinely cohesive real-time DSP `processBlock` chain, or a pure
    generated/data table). Don't split a cohesive real-time audio path purely to
    chase a line count — that's worse than leaving it together.
  - When a file is over budget, **propose a concrete split** (by responsibility /
    feature / adapter), preferring a stable barrel/facade re-export so importers
    don't churn, and **extract via pure mechanical moves** (no behaviour change)
    with build + tests green at each step.
  **Resist adding new code to an already-oversized file** (e.g.
  `projectStore.ts`) — extract into a focused unit instead of growing the god
  file, even for a small addition.
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

### Before you add code (authoring-time gate)

God files are not created in one commit — they grow one "small, related"
addition at a time. Stop them at the point of *writing*, not at review. The
path-specific `File Size and Single Responsibility` sections under
`.github/instructions/` describe the ceilings; this is the proactive check that
must fire **before every edit that adds code to an existing file**:

1. **Check where it's going first.** Note the target file's current length and
   its soft ceiling. If the file is already at or over budget, the default is a
   new focused unit — do not grow it further.
2. **Name the responsibility you're adding.** If it is a *second reason to
   change* (a new concern, domain, or concept), it belongs in its own
   file / composable / module — independent of the current line count.
3. **Reject the easy excuses.** "It's only a few lines", "it's related",
   "I'll extract it later", and "just for now" are never sufficient grounds to
   append to a file that shouldn't grow. Extract the seam first, then add.
4. **If your change pushes a file past a soft ceiling, split in the same
   change** — pure mechanical move, stable facade / barrel re-export so
   importers don't churn, build + tests green. Never leave a newly-oversized
   file behind for "later".
5. **When unsure, extract rather than grow.** A few small, well-named files are
   always preferable to one god file. The burden of proof is on *keeping code
   together*, not on splitting it.

The one exception remains a genuinely cohesive real-time path (e.g. a single
DSP `processBlock` chain or a tight timing/warp pipeline): don't fragment it
purely to chase a line count.

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
