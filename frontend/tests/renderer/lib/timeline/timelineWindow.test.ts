import { describe, it, expect } from 'vitest'
import {
  OVERSCAN_FRACTION,
  REBUILD_OVERSCAN_FRACTION,
  horizontalOverscanPx,
  exceedsRebuildThreshold,
  visibleSubRange
} from '@/lib/timeline/timelineWindow'

describe('horizontalOverscanPx', () => {
  it('is the configured fraction of the viewport width, rounded', () => {
    expect(horizontalOverscanPx(1000)).toBe(Math.round(1000 * OVERSCAN_FRACTION))
    expect(horizontalOverscanPx(801)).toBe(Math.round(801 * OVERSCAN_FRACTION))
  })

  it('never returns a negative value', () => {
    expect(horizontalOverscanPx(-200)).toBe(0)
    expect(horizontalOverscanPx(0)).toBe(0)
  })
})

describe('exceedsRebuildThreshold', () => {
  const viewWidth = 1000
  const overscan = horizontalOverscanPx(viewWidth)
  const threshold = overscan * REBUILD_OVERSCAN_FRACTION

  it('always rebuilds when never built (NaN)', () => {
    expect(exceedsRebuildThreshold(0, Number.NaN, viewWidth)).toBe(true)
    expect(exceedsRebuildThreshold(9999, Number.NaN, viewWidth)).toBe(true)
  })

  it('does not rebuild while scroll stays inside the threshold', () => {
    expect(exceedsRebuildThreshold(100, 100, viewWidth)).toBe(false)
    expect(exceedsRebuildThreshold(100 + threshold - 1, 100, viewWidth)).toBe(false)
    expect(exceedsRebuildThreshold(100 - (threshold - 1), 100, viewWidth)).toBe(false)
  })

  it('rebuilds once scroll reaches the threshold in either direction', () => {
    expect(exceedsRebuildThreshold(100 + threshold, 100, viewWidth)).toBe(true)
    expect(exceedsRebuildThreshold(100 - threshold, 100, viewWidth)).toBe(true)
  })
})

describe('visibleSubRange', () => {
  it('windows to the viewport plus overscan, clamped to [0, lastSub]', () => {
    const viewWidth = 1000
    const pxPerSub = 50
    const lastSub = 1000
    const overscan = horizontalOverscanPx(viewWidth)

    const scrollX = 5000
    const { first, last } = visibleSubRange(scrollX, viewWidth, pxPerSub, lastSub)
    expect(first).toBe(Math.floor((scrollX - overscan) / pxPerSub))
    expect(last).toBe(Math.ceil((scrollX + viewWidth + overscan) / pxPerSub))
  })

  it('clamps the lower bound to 0 at the project start', () => {
    const { first } = visibleSubRange(0, 1000, 50, 1000)
    expect(first).toBe(0)
  })

  it('clamps the upper bound to lastSub at the project end', () => {
    const lastSub = 20
    const { last } = visibleSubRange(100000, 1000, 50, lastSub)
    expect(last).toBe(lastSub)
  })

  it('returns an empty range for non-positive pxPerSub or negative lastSub', () => {
    expect(visibleSubRange(0, 1000, 0, 100)).toEqual({ first: 0, last: -1 })
    expect(visibleSubRange(0, 1000, 50, -1)).toEqual({ first: 0, last: -1 })
  })
})
