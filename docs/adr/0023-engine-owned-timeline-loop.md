# ADR 0023 — Engine-owned timeline loop wrapping

- **Date:** 2026-07-28 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

When a timeline range has **Loop Selection** enabled, the **engine** performs
the loop restart. The renderer never issues a seek to wrap playback.

- `PROJECT_SET_VIEW` and project load call `syncTimelineLoop`, which arms
  `AudioEngine::setTimelineLoop` with the range, or clears it when the range is
  removed or its loop flag is off. The armed range is engine state derived from
  the project view state, not a second source of truth (ADR 0002).
- While the transport is playing and a loop is armed, a message-thread timer
  polls every `kTimelineLoopPollMs` (2 ms) and restarts playback as soon as the
  engine's own position reaches the loop end.
- The restart uses the immediate `setPositionMsNow` seek path with
  `resetEffects` false. There is no output fade-out or fade-in ramp, and shared
  Reverb and Delay tails carry across the wrap.
- The engine compares against its **uncompensated** position, so the restart
  lands at the loop end in the rendered stream rather than at the
  latency-compensated position the user sees.
- A pending pause, stop, or seek fade owns the transport, so the poll defers to
  it rather than competing for the playhead.
- The renderer keeps only view concerns: it scrolls back when it observes the
  position jump to the range start, because auto-follow only eases forward.
  Pausing at the end of a **non**-looped range also stays renderer-side, as a
  one-shot stop is not latency-critical.

The poll runs on the message thread and reads a published position; the audio
callback is unchanged and still does not lock, allocate, or wait (ADR 0006).

## Why

A loop restart is audible. Any delay, gap, or ramp at the wrap point is heard as
a click or a stutter on every pass, which defeats the purpose of auditioning a
range while tuning an edit. Two properties of the two-process split (ADR 0001)
make a renderer-driven wrap unable to be seamless:

- **Round trip.** The renderer would have to wait for a `PLAYHEAD_UPDATE`, then
  send `TRANSPORT_SEEK` back across the bridge. The wrap would land late by at
  least the update interval plus the round trip.
- **Latency compensation.** The renderer's playhead is latency-compensated by
  design, so it only reaches the loop end after the engine has already rendered
  and queued audio past it. The renderer therefore cannot ask for the seek early
  enough, however fast the bridge is.

Placing the wrap next to the transport that owns the position removes both. It
also lets the wrap opt out of the seek fade: `setPositionMs` while playing
deliberately fades out, waits for the ramp, seeks, then fades in, which is right
for a user-initiated seek and wrong for a loop boundary.

This follows the playback-first priority in ADR 0017 — a correctness and
audible-quality problem is solved where the audio actually is, and the renderer
keeps only the parts that are purely visual.

## Rejected alternatives

- **Renderer watches `PLAYHEAD_UPDATE` and sends `TRANSPORT_SEEK`.** The
  original implementation. Simple and entirely in TypeScript, but it wraps late
  by a bridge round trip and, because the renderer position is
  latency-compensated, it can only ever request the seek after audio beyond the
  loop end has been rendered. Both are audible on every pass.
- **Reuse the normal `setPositionMs` seek for the wrap.** Consistent with every
  other seek, but its fade-out / poll / fade-in sequence inserts an audible gap
  at each loop boundary.
- **Reset shared effect state on wrap.** Gives each pass an identical tail, but
  cuts Reverb and Delay abruptly at the boundary, which is more noticeable than
  the tail carrying over.
- **Wrap from the audio callback.** The lowest possible latency, but seeking
  involves transport and source work that must not run on the real-time thread
  (ADR 0006). The 2 ms message-thread poll is inaudible in comparison.
- **Duplicate the loop range in engine state independently of the project view
  state.** Avoids the sync call, but creates a second source of truth for the
  range and would drift from the saved project (ADR 0002).
