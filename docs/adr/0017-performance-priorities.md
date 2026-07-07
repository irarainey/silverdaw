# ADR 0017 — Performance priorities: audio playback is first-class

- **Date:** 2026-06-08 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

- **Audio playback performance is always a first-class priority.** Anything that
  risks glitches, dropouts, or playhead/scheduling jitter is treated as a
  correctness problem, not a nice-to-have — reinforcing the real-time audio-thread
  guarantees in ADR 0006.
- **JUCE-level optimisation is warranted and expected on the audio path**
  (allocation-free callbacks, lock-free publication, buffer handling,
  cache-friendly data) and should be applied deliberately where it protects
  playback.
- **Balanced against readable, maintainable code (ADR 0016).** Optimise the hot
  path with intent and comment the *why*; keep cold paths clear and simple. Don't
  trade clarity for micro-optimisation off the audio path, and don't trade
  playback integrity for tidiness on it.
- Firm figures and the concrete rendering discipline (O(1) scroll layers, peaks
  LOD pyramid, pooled PixiJS display objects, 60 Hz playhead envelopes, ~30 Hz
  draft coalescing, sub-2 ms loopback round-trip) live in
  `docs/developer-guide.md#rendering-performance` and
  `docs/development-plan.md` → Key Engineering Risks — read them when the task
  touches performance.

## Why

A DAW is judged first on whether audio plays back cleanly. ADR 0006 already makes
the audio thread non-negotiable; this makes the surrounding priority explicit, so
performance work on the audio path is expected while the general maintainability
gate (ADR 0016) still governs everywhere else.

## Rejected alternatives

- **Maintainability above all, even on the audio path.** Readable code that
  glitches is a failed DAW.
- **Optimise everywhere.** Micro-optimising cold paths just erodes clarity for no
  user-visible gain — the priority is the audio path specifically.
