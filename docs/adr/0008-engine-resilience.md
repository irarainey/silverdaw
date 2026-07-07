# ADR 0008 — Out-of-process engine resilience and recovery

- **Date:** 2026-06-04 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Because the engine is a separate process (ADR 0001), "the engine went away" is
treated as a normal, recoverable event, never surfaced as the front/back split.
Four cooperating mechanisms:

- **Supervisor (main)** — respawns the backend on the same port/token after a
  short backoff; bounded to `MAX_CONSECUTIVE_FAILURES` (8) before a terminal
  `failed` state; a respawn stable past ~10 s resets the budget.
- **Watchdog (renderer)** — after an idle spell sends `PING`, expects `PONG`
  answered **on the JUCE message thread** (proves the command thread is live);
  N missed replies trigger a supervised restart. Suppressed during playback and
  known-heavy work; large positive clock drift is read as OS sleep/resume.
- **Recovery coordinator (renderer)** — reloads the open project into the fresh,
  empty engine; generation-tagged so stale continuations can't corrupt a fresh
  attempt; per-phase deadlines end in a terminal `unavailable` (Try again/Quit).
  Completion is confirmed only by the reload's own `reset=true` snapshot. It
  prefers the matching autosave bucket (ADR 0018) over the last saved file.
- **In-handler guardrail (backend)** — each envelope dispatched inside try/catch;
  a caught fault surfaces as a **non-fatal** `ENGINE_ERROR` and keeps the engine
  alive. A possibly-imperfect edit beats a dead engine.

Always-on startup diagnostics (`startup.log`, `backend.log`, `backend-crash.log`
via `SetUnhandledExceptionFilter` with a phase breadcrumb) make a
failure-to-start diagnosable without a debugger.

## Why

Out-of-process isolation is only a benefit if a lost engine is recoverable;
otherwise it is just an extra failure mode. Reconnecting a socket is not the same
as recovering a session, so completion is gated on the reloaded snapshot.

## Rejected alternatives

- **Treat an engine exit as a fatal crash.** Wastes the isolation ADR 0001 buys.
- **Trust process status alone for recovery.** A reconnected socket lands on an
  empty engine; only the reloaded snapshot proves the session is back.
