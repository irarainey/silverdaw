# ADR 0020 — Exclude inaudible tracks from rendering

- **Date:** 2026-07-12 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Tracks with zero effective gain because they are muted, excluded by solo, or
fully attenuated do not perform per-track audio work:

- Live playback omits them from immutable `BusGraph` render snapshots. Their
  clips are not read, so warp, pitch, clip effects, track effects, sends, and
  metering do not run.
- Mixdown omits them before building offline clips and track processing.
- A live mute renders one final gain-ramp block before exclusion to avoid a
  discontinuity. No new signal enters the shared Reverb or Delay afterward.
  Tails already accumulated in those shared processors may continue because
  they can also contain contributions from audible tracks.
- Project and effect state remains editable while a track is excluded. Before
  live playback includes it again, its transports are aligned to the master
  playhead and stale read-ahead is rebuilt.
- Graph exclusion is the execution boundary. Excluded
  `AudioTransportSource` instances are not synchronously stopped because JUCE
  waits for another source pull to complete `stop()`, but exclusion deliberately
  prevents that pull and would block the message thread.

The audio callback observes inclusion changes only through lock-free published
snapshots. It does not lock, allocate, wait, or mutate project state.

## Why

Muted audio is intentionally unobservable, so spending the callback budget on
its source reads, time stretching, pitch shifting, effects, sends, and meters
cannot improve output. Excluding the whole track protects playback performance,
especially when one track contains several warped clips.

The exclusion must not weaken live editing. Mute and solo are temporary mix
choices, not lifecycle operations: users can still change effects, clips, warp,
pitch, and routing while a track is silent and hear the current state when it
returns.

Using immutable render snapshots keeps this policy compatible with the
real-time constraints in ADR 0006 and the playback priority in ADR 0017.

## Rejected alternatives

- **Render the complete track and multiply its output by zero.** This preserves
  silence but still pays for every source read, warp processor, effect, send,
  and meter.
- **Destroy and rebuild the track whenever mute or solo changes.** This loses
  useful processor and read-ahead state, makes rapid toggles expensive, and
  complicates live editing.
- **Synchronously stop every excluded transport.** JUCE waits for a subsequent
  callback to acknowledge the stop. An excluded transport receives no callback,
  so this blocks the message thread for about one second per clip.
- **Reject edits while a track is excluded.** This would make mute and solo
  interrupt the normal live-editing workflow.
