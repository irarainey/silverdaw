import { describe, it, expect } from 'vitest'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  findClipSlot
} from './clipTiming'

describe('effectiveClipDurationMs', () => {
  it('falls back to source durationMs when no warp footprint', () => {
    expect(effectiveClipDurationMs({ durationMs: 1000 })).toBe(1000)
    expect(effectiveClipDurationMs({ durationMs: 1000, effectiveDurationMs: 0 })).toBe(1000)
  })

  it('prefers a positive effectiveDurationMs', () => {
    expect(effectiveClipDurationMs({ durationMs: 1000, effectiveDurationMs: 1500 })).toBe(1500)
  })
})

describe('effectiveClipTempoRatio', () => {
  it('defaults to 1 when absent or non-positive', () => {
    expect(effectiveClipTempoRatio({})).toBe(1)
    expect(effectiveClipTempoRatio({ effectiveTempoRatio: 0 })).toBe(1)
    expect(effectiveClipTempoRatio({ effectiveTempoRatio: -2 })).toBe(1)
  })

  it('returns a positive ratio', () => {
    expect(effectiveClipTempoRatio({ effectiveTempoRatio: 1.25 })).toBe(1.25)
  })
})

describe('isClipTempoWarpActive', () => {
  it('is true only when explicitly active', () => {
    expect(isClipTempoWarpActive({ effectiveWarpActive: true })).toBe(true)
    expect(isClipTempoWarpActive({ effectiveWarpActive: false })).toBe(false)
    expect(isClipTempoWarpActive({})).toBe(false)
  })
})

describe('findClipSlot', () => {
  const state = (
    clips: Record<string, { startMs: number; durationMs: number; effectiveDurationMs?: number }>,
    clipIds: string[]
  ) => ({ tracks: [{ id: 't1', clipIds }], clips })

  it('returns null for an unknown track', () => {
    expect(findClipSlot(state({}, []), 'missing', 'x', 0, 100)).toBeNull()
  })

  it('returns the desired position on an empty track', () => {
    expect(findClipSlot(state({}, []), 't1', 'x', 500, 100)).toBe(500)
  })

  it('clamps a negative desired position to 0', () => {
    expect(findClipSlot(state({}, []), 't1', 'x', -200, 100)).toBe(0)
  })

  it('bumps up against an occupied neighbour', () => {
    const s = state({ a: { startMs: 0, durationMs: 1000 } }, ['a'])
    // Desired overlaps 'a' (ends at 1000); closest non-overlapping is 1000.
    expect(findClipSlot(s, 't1', 'x', 500, 200)).toBe(1000)
  })

  it('ignores the excluded (dragged) clip', () => {
    const s = state({ a: { startMs: 0, durationMs: 1000 } }, ['a'])
    expect(findClipSlot(s, 't1', 'a', 200, 100)).toBe(200)
  })

  it('uses resolveDurationMs for occupied footprints', () => {
    const s = state(
      { a: { startMs: 0, durationMs: 1000, effectiveDurationMs: 1500 } },
      ['a']
    )
    // With warp footprint 1500, desired 1000 is still inside 'a' → bump to 1500.
    expect(findClipSlot(s, 't1', 'x', 1000, 100, effectiveClipDurationMs)).toBe(1500)
  })

  it('picks the gap closest to the desired position', () => {
    const s = state(
      { a: { startMs: 0, durationMs: 1000 }, b: { startMs: 2000, durationMs: 1000 } },
      ['a', 'b']
    )
    // Gap [1000,2000) holds a 500ms clip; desired 1200 fits directly.
    expect(findClipSlot(s, 't1', 'x', 1200, 500)).toBe(1200)
    // Desired 1700 would overflow the gap → clamp to 1500 (2000 - 500).
    expect(findClipSlot(s, 't1', 'x', 1700, 500)).toBe(1500)
  })
})
