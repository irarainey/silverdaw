import { describe, it, expect } from 'vitest'
import {
  applySliceGuards,
  generateGridSlices,
  DIVISIONS_PER_BEAT,
  MAX_SLICES,
  type GridSliceParams,
  type SliceSubdivision
} from '@/lib/clipEditor/loopSlice'

// 120 BPM → 500 ms/beat. Window covers source 0..4000 ms unless overridden.
function gridParams(overrides: Partial<GridSliceParams> = {}): GridSliceParams {
  return {
    sourceBpm: 120,
    anchorSec: 0,
    subdivision: '1/4',
    windowInMs: 0,
    windowDurationMs: 4000,
    ...overrides
  }
}

describe('generateGridSlices', () => {
  it('lays interior markers on the beat grid (head/tail implicit)', () => {
    // 1/4 at 120 BPM = every 500 ms; interior of 0..4000 → 500..3500.
    expect(generateGridSlices(gridParams())).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500])
  })

  it('subdivides per the requested division', () => {
    // 1/8 = every 250 ms across 0..1000 → 250, 500, 750.
    expect(
      generateGridSlices(gridParams({ subdivision: '1/8', windowDurationMs: 1000 }))
    ).toEqual([250, 500, 750])
  })

  it('respects the source beat anchor', () => {
    // anchor 0.1 s → grid at 100, 600, 1100, ... within 0..2000.
    expect(generateGridSlices(gridParams({ anchorSec: 0.1, windowDurationMs: 2000 }))).toEqual([
      100, 600, 1100, 1600
    ])
  })

  it('emits markers in source-absolute space for an offset window', () => {
    // Window 1000..3000; grid lines at 1500, 2000, 2500 are interior.
    expect(
      generateGridSlices(gridParams({ windowInMs: 1000, windowDurationMs: 2000 }))
    ).toEqual([1500, 2000, 2500])
  })

  it('returns nothing without a usable tempo or anchor', () => {
    expect(generateGridSlices(gridParams({ sourceBpm: undefined }))).toEqual([])
    expect(generateGridSlices(gridParams({ sourceBpm: 0 }))).toEqual([])
    expect(generateGridSlices(gridParams({ anchorSec: undefined }))).toEqual([])
  })

  it('drops grid lines closer than the min slice to a window edge', () => {
    // Window 0..515 with the default 20 ms guard: the only grid line (500) sits
    // 15 ms from the tail (515), inside the guard, so it is dropped.
    expect(generateGridSlices(gridParams({ windowDurationMs: 515 }))).toEqual([])
  })

  it('caps a long fine chop at MAX_SLICES', () => {
    // 1/32 at 120 BPM = every 62.5 ms; a 60 s window would yield ~960 lines.
    const times = generateGridSlices(
      gridParams({ subdivision: '1/32', windowDurationMs: 60_000 })
    )
    expect(times.length).toBe(MAX_SLICES)
  })

  it('lays bar-spaced cuts for a whole-bar subdivision', () => {
    // 4/4 at 120 BPM: 1 bar = 4 beats = 2000 ms. Interior of 0..8000 → 2000/4000/6000.
    expect(
      generateGridSlices(gridParams({ subdivision: '1 bar', windowDurationMs: 8000 }))
    ).toEqual([2000, 4000, 6000])
  })

  it('lays half-bar cuts for a 1/2-bar subdivision', () => {
    // 1/2 bar = 2 beats = 1000 ms. Interior of 0..4000 → 1000/2000/3000.
    expect(
      generateGridSlices(gridParams({ subdivision: '1/2 bar', windowDurationMs: 4000 }))
    ).toEqual([1000, 2000, 3000])
  })

  it('exposes the documented divisions-per-beat table', () => {
    const expected: Record<SliceSubdivision, number> = {
      '1 bar': 0.25,
      '1/2 bar': 0.5,
      '1/4': 1,
      '1/8': 2,
      '1/16': 4,
      '1/32': 8
    }
    expect(DIVISIONS_PER_BEAT).toEqual(expected)
  })
})

describe('applySliceGuards', () => {
  it('sorts and keeps only interior markers', () => {
    expect(applySliceGuards([3000, 500, 1500], 0, 4000)).toEqual([500, 1500, 3000])
  })

  it('drops markers within the min slice of an edge', () => {
    // Edges at 0 and 1000; 10 and 995 are inside 20 ms of an edge.
    expect(applySliceGuards([10, 500, 995], 0, 1000)).toEqual([500])
  })

  it('thins neighbours closer than the min slice, keeping the earlier one', () => {
    expect(applySliceGuards([500, 510, 700], 0, 2000, { minSliceMs: 20 })).toEqual([500, 700])
  })

  it('de-duplicates identical markers', () => {
    expect(applySliceGuards([500, 500, 1500], 0, 4000)).toEqual([500, 1500])
  })

  it('honours a custom min slice and max count', () => {
    expect(applySliceGuards([400, 800, 1200, 1600], 0, 4000, { maxSlices: 2 })).toEqual([400, 800])
  })

  it('returns nothing when the window is narrower than two min-slices', () => {
    expect(applySliceGuards([15, 25], 0, 30, { minSliceMs: 20 })).toEqual([])
  })
})
