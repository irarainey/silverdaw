# Silverdaw — Copilot instructions

Silverdaw is an open-source Windows DAW for bedroom DJs, producers, and mixers
making remixes and mashups — a studio creation tool, not a live-performance
instrument. Two processes: a headless JUCE 8 C++ audio engine (`backend/`) and
an Electron 42 + Vue 3 UI (`frontend/`), linked by a text-only loopback
WebSocket bridge.

## Context — read this first

The durable knowledge base is the primary source of truth. Do not restate it
here; read it and work from it.

- **`CONTEXT.md`** (repo root) is the small, always-on source of truth for goals,
  current state, and constraints. Read it first; do not ask for what it contains.
- **Treat anything tagged `CRITICAL` as binding.** If a change would contradict
  it, stop and flag it rather than working around it.
- **Open linked documents only when the task touches them:** `ARCHITECTURE.md`
  (structure, boundaries, threading, data flow), `DECISIONS.md` → `docs/adr/`
  (the *why* and rejected alternatives), and `docs/developer-guide.md` /
  `docs/development-plan.md` (feature detail, roadmap, protocol catalogue).

## How to help

- **Read before you write.** Base changes on the code that is actually there;
  reference the files and functions you rely on. Check for an existing helper
  before adding one — no duplicated logic, payload shapes, dispatch branches, or
  magic constants.
- **Explain the *why*.** State the reasoning and main alternatives behind a
  non-trivial proposal. For work touching a `CRITICAL` constraint or an ADR,
  propose — do not decide.
- **Match effort to the task.** Trivial/repetitive: produce output. Non-trivial:
  propose an approach first. Small, focused changes over broad rewrites.
- **Ask when ambiguous** rather than guessing.

## Review priorities (in order)

correctness → **maintainability / best practice** → security → performance →
micro-optimisation. Maintainability is a first-class, blocking-class gate.

## Maintainability

A first-class, blocking-class gate. The full policy — single-responsibility /
domain separation, no duplication, the authoring-time "Before you add code" gate,
per-file-type ceilings, the ~800-line hard trigger, and the real-time-path
exception — is **ADR 0016** (`docs/adr/0016-maintainability-file-size.md`).
Follow it; the path-specific files carry only their language's ceiling.

## Testing

Backend uses a custom `SilverdawBackendTests` harness (CTest, no
Catch2/GoogleTest); frontend uses Vitest. See **ADR 0014**
(`docs/adr/0014-testing-strategy.md`) for what to test and how to run it. Match
the existing harness/framework — never introduce a new one.

## Language standards

Path-specific instruction files under `.github/instructions/` (auto-applied by
glob) cover C++/JUCE audio, TypeScript 5 / ES2022, audio/waveform TS, Vue 3,
UI/UX styling, Markdown, and documentation. Defer to them.

## Never

- Include secrets, credentials, tokens, or customer data in output.
- Disable security controls, auth checks, or input validation as a shortcut, or
  use `--no-verify` / `--force` to bypass safety checks.
- Reference or compare to any other DAW product in any document.
