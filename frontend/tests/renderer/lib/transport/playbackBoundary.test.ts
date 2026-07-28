import { describe, it, expect } from 'vitest'
import {
  LOOP_WRAP_TOLERANCE_MS,
  playbackBoundaryAction
} from '@/lib/transport/playbackBoundary'

function input(overrides: Partial<Parameters<typeof playbackBoundaryAction>[0]> = {}) {
  return {
    positionMs: 1_000,
    previousPositionMs: 900,
    selection: null,
    loopSelection: false,
    projectDurationMs: 10_000,
    ...overrides
  }
}

describe('playbackBoundaryAction', () => {
  it('does nothing mid-project with no range armed', () => {
    expect(playbackBoundaryAction(input())).toEqual({ kind: 'none' })
  })

  it('stops at the project end', () => {
    const action = playbackBoundaryAction(input({ positionMs: 10_050 }))
    expect(action).toEqual({ kind: 'stop', positionMs: 10_000 })
  })

  it('ignores the project end when the project has no length', () => {
    expect(playbackBoundaryAction(input({ projectDurationMs: 0 }))).toEqual({ kind: 'none' })
  })

  // The engine streams past the boundary until the pause fade lands, so the reported
  // position overshoots. The parked position must still be the boundary itself.
  it('stops a one-shot range on its end, not on the overshot position', () => {
    const action = playbackBoundaryAction(
      input({ positionMs: 5_040, selection: { startMs: 2_000, endMs: 5_000 } })
    )
    expect(action).toEqual({ kind: 'stop', positionMs: 5_000 })
  })

  it('stops a one-shot range that ends short of the project end', () => {
    const action = playbackBoundaryAction(
      input({ positionMs: 5_000, selection: { startMs: 2_000, endMs: 5_000 } })
    )
    expect(action).toEqual({ kind: 'stop', positionMs: 5_000 })
  })

  it('keeps playing inside a one-shot range', () => {
    const action = playbackBoundaryAction(
      input({ positionMs: 4_999, selection: { startMs: 2_000, endMs: 5_000 } })
    )
    expect(action).toEqual({ kind: 'none' })
  })

  // A looped range is wrapped by the engine, so the renderer must never pause it.
  it('never stops a looped range at its end', () => {
    const action = playbackBoundaryAction(
      input({
        positionMs: 5_000,
        selection: { startMs: 2_000, endMs: 5_000 },
        loopSelection: true
      })
    )
    expect(action).toEqual({ kind: 'none' })
  })

  it('follows the view back when the engine wraps a looped range', () => {
    const action = playbackBoundaryAction(
      input({
        positionMs: 2_020,
        previousPositionMs: 4_990,
        selection: { startMs: 2_000, endMs: 5_000 },
        loopSelection: true
      })
    )
    expect(action).toEqual({ kind: 'followLoopWrap', positionMs: 2_000 })
  })

  it('treats a backward jump far from the range start as a user seek, not a wrap', () => {
    const action = playbackBoundaryAction(
      input({
        positionMs: 2_000 + LOOP_WRAP_TOLERANCE_MS + 1,
        previousPositionMs: 4_990,
        selection: { startMs: 2_000, endMs: 5_000 },
        loopSelection: true
      })
    )
    expect(action).toEqual({ kind: 'none' })
  })

  it('does not stop a looped range at the project end', () => {
    const action = playbackBoundaryAction(
      input({
        positionMs: 10_000,
        selection: { startMs: 2_000, endMs: 10_000 },
        loopSelection: true
      })
    )
    expect(action).toEqual({ kind: 'none' })
  })
})
