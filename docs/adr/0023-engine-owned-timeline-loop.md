# ADR 0023 — Engine-owned loop wrapping

- **Date:** 2026-07-28 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

When a loop is enabled — a timeline range with **Loop Selection**, or the Clip
Editor's **Loop** toggle — the **engine** performs the loop restart. The
renderer never issues a seek to wrap playback.

### Timeline transport

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

### Preview voice (Clip Editor)

- `PREVIEW_SET_LOOP` arms `AudioEngine::setPreviewLoop` with the active playback
  window — the selection if there is one, otherwise the whole preview window —
  in preview-relative ms, the same domain as `PREVIEW_SEEK`. The Clip Editor
  re-arms it whenever the Loop toggle, the selection, or the preview window
  changes, and disarms it on close; `unloadPreview` drops it too, because a loop
  window belongs to the loaded voice.
- The wrap mirrors the timeline: the same 2 ms message-thread poll, compared
  against the engine's own preview position, restarting via
  `setPreviewPositionMs` with no fade.
- Two details are specific to the preview voice. A loop end that sits on the
  window end is reached as true EOF, which auto-stops the JUCE transport, so the
  wrap also restarts it and the poll runs off a *play intent* flag rather than
  `isPreviewPlaying()`. And `PlayheadEmitter` must not treat the window end as
  an end while a loop is armed, or it would stop the voice and raise
  `PREVIEW_ENDED` in a race with the wrap.

### Renderer's remaining role

The renderer keeps only view concerns: it scrolls back when it observes the
position jump to the loop start, because auto-follow only eases forward.
Pausing at the end of a **non**-looped range or selection also stays
renderer-side, as a one-shot stop is not latency-critical.

The poll runs on the message thread and reads a published position; the audio
callback is unchanged and still does not lock, allocate, or wait (ADR 0006).

## Why

A loop restart is audible. Any delay, gap, or ramp at the wrap point is heard as
a click or a stutter on every pass, which defeats the purpose of auditioning a
range while tuning an edit. Two properties of the two-process split (ADR 0001)
make a renderer-driven wrap unable to be seamless:

- **Round trip.** The renderer would have to wait for a `PLAYHEAD_UPDATE` (or
  `PREVIEW_POSITION` / `PREVIEW_ENDED`), then send a seek back across the
  bridge. The wrap would land late by at least the update interval plus the
  round trip.
- **Latency compensation.** The renderer's playhead is latency-compensated by
  design, so it only reaches the loop end after the engine has already rendered
  and queued audio past it. The renderer therefore cannot ask for the seek early
  enough, however fast the bridge is.

Placing the wrap next to the transport that owns the position removes both. It
also lets the wrap opt out of the seek fade: `setPositionMs` while playing
deliberately fades out, waits for the ramp, seeks, then fades in, which is right
for a user-initiated seek and wrong for a loop boundary.

The preview voice was originally left on the renderer-driven design, which is
why the same clip could loop cleanly on the timeline and glitch in the Clip
Editor. Applying one rule to both voices removes that inconsistency and means a
single place has to be correct.

This follows the playback-first priority in ADR 0017 — a correctness and
audible-quality problem is solved where the audio actually is, and the renderer
keeps only the parts that are purely visual.

## Rejected alternatives

- **Renderer watches `PLAYHEAD_UPDATE` and sends `TRANSPORT_SEEK`.** The
  original implementation. Simple and entirely in TypeScript, but it wraps late
  by a bridge round trip and, because the renderer position is
  latency-compensated, it can only ever request the seek after audio beyond the
  loop end has been rendered. Both are audible on every pass.
- **Keep the preview voice on the renderer wrap because it is "only a
  preview".** The Clip Editor is where loop auditioning matters most, and the
  glitch was audible on every pass; leaving two different rules for the same
  user-facing feature also invites the next bug.
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
