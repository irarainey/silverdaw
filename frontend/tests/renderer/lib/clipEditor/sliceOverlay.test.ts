import { describe, it, expect } from 'vitest'
import {
  sliceSourceMsToX,
  sliceXToSourceMs,
  hitTestSliceMarker
} from '@/lib/clipEditor/sliceOverlay'

describe('slice overlay geometry', () => {
  it('maps source ms to x and back at a given scale', () => {
    // visibleInMs=1000, pxPerMs=0.2 → source 2000 ms sits at (2000-1000)*0.2 = 200 px.
    expect(sliceSourceMsToX(2000, 1000, 0.2)).toBe(200)
    expect(sliceXToSourceMs(200, 1000, 0.2)).toBe(2000)
  })

  it('round-trips through the inverse', () => {
    const x = sliceSourceMsToX(3456, 500, 0.13)
    expect(sliceXToSourceMs(x, 500, 0.13)).toBeCloseTo(3456, 6)
  })

  it('guards against a non-positive scale in the inverse', () => {
    expect(Number.isFinite(sliceXToSourceMs(100, 0, 0))).toBe(true)
  })

  it('hit-tests the nearest marker within the radius', () => {
    const xs = [50, 120, 300]
    expect(hitTestSliceMarker(xs, 124, 6)).toBe(1)
    expect(hitTestSliceMarker(xs, 55, 6)).toBe(0)
  })

  it('returns null when no marker is within the radius', () => {
    expect(hitTestSliceMarker([50, 300], 180, 6)).toBeNull()
  })

  it('breaks ties toward the closest marker', () => {
    expect(hitTestSliceMarker([100, 110], 106, 8)).toBe(1)
    expect(hitTestSliceMarker([100, 110], 104, 8)).toBe(0)
  })
})
