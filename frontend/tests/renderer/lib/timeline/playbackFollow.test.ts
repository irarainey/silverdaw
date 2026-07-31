import { describe, expect, it } from 'vitest'
import {
  followFrame,
  followTargetScrollX,
  isPlayheadOffScreen,
  type FollowFrameParams
} from '@/lib/timeline/playbackFollow'

// A 1000 px viewport with a 200 px track header, so the track area spans
// viewport x 200..1000 and its centre sits at 600.
const HEADER = 200
const VIEWPORT = 1000
const BASE = {
  viewportWidth: VIEWPORT,
  headerWidth: HEADER,
  pxPerSecond: 100,
  dtSec: 1 / 60,
  startedFollowing: false,
  recovering: false
}

/** Runs follow frames until the scroll settles, returning the path taken. */
function runFollow(start: Partial<FollowFrameParams>, maxFrames = 600): number[] {
  const params: FollowFrameParams = { ...BASE, playheadX: 0, scrollX: 0, ...start }
  const path: number[] = []
  let scrollX = params.scrollX
  let recovering = params.recovering
  let startedFollowing = params.startedFollowing
  for (let i = 0; i < maxFrames; i++) {
    const frame = followFrame({ ...params, scrollX, recovering, startedFollowing })
    startedFollowing = false
    recovering = frame.recovering
    if (frame.scrollX === null) break
    scrollX = frame.scrollX
    path.push(scrollX)
  }
  return path
}

describe('followTargetScrollX', () => {
  it('centres the playhead in the track area', () => {
    expect(
      followTargetScrollX({ playheadX: 5000, viewportWidth: VIEWPORT, headerWidth: HEADER })
    ).toBe(4400)
  })

  it('never returns a negative scroll near the start of the project', () => {
    expect(
      followTargetScrollX({ playheadX: 210, viewportWidth: VIEWPORT, headerWidth: HEADER })
    ).toBe(0)
  })
})

describe('isPlayheadOffScreen', () => {
  const view = { viewportWidth: VIEWPORT, headerWidth: HEADER }

  it('is false while the playhead is inside the track area', () => {
    expect(isPlayheadOffScreen({ ...view, playheadX: 5000, scrollX: 4400 })).toBe(false)
  })

  it('is true when the view has been scrolled past the playhead', () => {
    expect(isPlayheadOffScreen({ ...view, playheadX: 5000, scrollX: 9000 })).toBe(true)
  })

  it('is true when the playhead is beyond the right edge', () => {
    expect(isPlayheadOffScreen({ ...view, playheadX: 5000, scrollX: 0 })).toBe(true)
  })
})

describe('followFrame steady-state follow', () => {
  it('does not move the view when the playhead is at or behind the centre', () => {
    // Playhead left of centre: easing forward would scroll the wrong way.
    expect(followFrame({ ...BASE, playheadX: 5000, scrollX: 4600 }).scrollX).toBeNull()
  })

  it('eases forward as the playhead drifts past the centre', () => {
    // desired 4400, gap 400 -> rate max(300, 2000) = 2000 px/s over 1/60 s.
    const frame = followFrame({ ...BASE, playheadX: 5000, scrollX: 4000 })
    expect(frame.scrollX).toBeCloseTo(4000 + 2000 / 60, 6)
    expect(frame.recovering).toBe(false)
  })

  it('never overshoots the centre in one frame', () => {
    expect(followFrame({ ...BASE, playheadX: 5000, scrollX: 4399, dtSec: 10 }).scrollX).toBe(4400)
  })

  it('ignores an off-screen playhead once follow is already under way', () => {
    // Not a start-of-follow frame, so the backward gap stays blocked.
    expect(followFrame({ ...BASE, playheadX: 5000, scrollX: 9000 }).scrollX).toBeNull()
  })
})

describe('followFrame off-screen recovery', () => {
  // Regression: zooming or panning while stopped can strand the playhead outside
  // the viewport. Steady-state follow only travels forward, so starting playback
  // with the view scrolled past the playhead appeared to do nothing at all.

  it('starts recovering when follow begins with the playhead off screen', () => {
    const frame = followFrame({
      ...BASE,
      playheadX: 5000,
      scrollX: 9000,
      startedFollowing: true
    })
    expect(frame.recovering).toBe(true)
    expect(frame.scrollX).not.toBeNull()
  })

  it('scrolls smoothly rather than jumping to the target', () => {
    const path = runFollow({ playheadX: 5000, scrollX: 9000, startedFollowing: true })
    expect(path.length).toBeGreaterThan(10)
    // No single frame covers more than a fraction of the 4600 px journey.
    const largestStep = Math.max(...path.map((x, i) => Math.abs(x - (path[i - 1] ?? 9000))))
    expect(largestStep).toBeLessThan(4600 / 4)
  })

  it('decelerates into the target instead of arriving at full speed', () => {
    const path = runFollow({ playheadX: 5000, scrollX: 9000, startedFollowing: true })
    const step = (i: number): number => Math.abs((path[i] ?? 0) - (path[i - 1] ?? 9000))
    expect(step(path.length - 1)).toBeLessThan(step(0))
  })

  it('settles centred on the playhead when the view was scrolled past it', () => {
    const path = runFollow({ playheadX: 5000, scrollX: 9000, startedFollowing: true })
    expect(path[path.length - 1]).toBeCloseTo(4400, 0)
  })

  it('settles centred on a playhead stranded beyond the right edge', () => {
    const path = runFollow({ playheadX: 5000, scrollX: 0, startedFollowing: true })
    expect(path[path.length - 1]).toBeCloseTo(4400, 0)
  })

  it('keeps recovering across frames without a fresh start flag', () => {
    const frame = followFrame({ ...BASE, playheadX: 5000, scrollX: 9000, recovering: true })
    expect(frame.recovering).toBe(true)
    // Recovery is the only mode that may scroll backwards.
    expect(frame.scrollX).toBeLessThan(9000)
  })

  it('hands back to steady-state follow once it reaches the target', () => {
    const frame = followFrame({ ...BASE, playheadX: 5000, scrollX: 4400, recovering: true })
    expect(frame.recovering).toBe(false)
    expect(frame.scrollX).toBeNull()
  })

  it('does not recover when the playhead is already visible', () => {
    // Visible but left of centre — starting playback must not yank the view.
    const frame = followFrame({
      ...BASE,
      playheadX: 5000,
      scrollX: 4600,
      startedFollowing: true
    })
    expect(frame.recovering).toBe(false)
    expect(frame.scrollX).toBeNull()
  })
})
