// Decides what playback should do as the reported playhead reaches a boundary: the end
// of an armed timeline range, or the end of the project. Kept pure and separate from the
// transport bar's watcher so the rules can be tested directly — they depend on subtle
// engine behaviour (the engine streams on past a boundary until a pause fade lands) that
// is easy to regress.

// The engine wraps a looped range on its own clock, so the renderer sees the reported
// position jump back to near the range start. Anything further back than this is a user
// seek, which must not drag the view to the loop start. Wide enough to absorb the
// playhead's output-latency compensation plus one emit interval.
export const LOOP_WRAP_TOLERANCE_MS = 250

export interface PlaybackBoundaryInput {
  positionMs: number
  previousPositionMs: number
  /** The armed timeline range, or null when none is selected. */
  selection: { startMs: number; endMs: number } | null
  loopSelection: boolean
  projectDurationMs: number
}

export type PlaybackBoundaryAction =
  /** Nothing to do — playback continues. */
  | { kind: 'none' }
  /** The engine wrapped a looped range; only the view has to follow it back. */
  | { kind: 'followLoopWrap'; positionMs: number }
  /** Playback has reached a boundary and must stop, parked exactly on it. */
  | { kind: 'stop'; positionMs: number }

export function playbackBoundaryAction(input: PlaybackBoundaryInput): PlaybackBoundaryAction {
  const { positionMs, previousPositionMs, selection, projectDurationMs } = input

  if (selection && input.loopSelection) {
    const wrapped =
      positionMs < previousPositionMs &&
      Math.abs(positionMs - selection.startMs) <= LOOP_WRAP_TOLERANCE_MS
    return wrapped ? { kind: 'followLoopWrap', positionMs: selection.startMs } : { kind: 'none' }
  }

  // A one-shot range stops at its end, even when that is short of the project end.
  if (selection && positionMs >= selection.endMs) {
    return { kind: 'stop', positionMs: selection.endMs }
  }

  if (projectDurationMs <= 0 || positionMs < projectDurationMs) return { kind: 'none' }
  return { kind: 'stop', positionMs: projectDurationMs }
}
