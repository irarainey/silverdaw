import { describe, it, expect } from 'vitest'
import { snapTimelineMsToBeat, type BeatSnapContext } from '@/lib/clipEditor/envelopeBeatSnap'

// 120 BPM → 500ms/beat. Unwarped clip (ratio 1) starting at source 0.
function ctx(overrides: Partial<BeatSnapContext> = {}): BeatSnapContext {
  return {
    baseSourceMs: 0,
    ratio: 1,
    sourceBpm: 120,
    anchorSec: 0,
    durationMs: 4000,
    ...overrides
  }
}

describe('snapTimelineMsToBeat', () => {
  it('snaps to the nearest beat on an unwarped clip', () => {
    expect(snapTimelineMsToBeat(240, ctx())).toBe(0)
    expect(snapTimelineMsToBeat(260, ctx())).toBe(500)
    expect(snapTimelineMsToBeat(740, ctx())).toBe(500)
    expect(snapTimelineMsToBeat(760, ctx())).toBe(1000)
  })

  it('respects the source beat anchor offset', () => {
    // anchor 0.1s → beats at 100, 600, 1100, ...
    expect(snapTimelineMsToBeat(580, ctx({ anchorSec: 0.1 }))).toBe(600)
    expect(snapTimelineMsToBeat(120, ctx({ anchorSec: 0.1 }))).toBe(100)
  })

  it('snaps in source space for a warped clip then maps back to clip time', () => {
    // ratio 2 (source ms = 2 × timeline ms); beats every 500ms source = 250ms timeline.
    expect(snapTimelineMsToBeat(260, ctx({ ratio: 2 }))).toBe(250)
    expect(snapTimelineMsToBeat(110, ctx({ ratio: 2 }))).toBe(0)
  })

  it('accounts for the clip start offset in source space', () => {
    // clip starts at source 200ms; clip time 0 → source 200 → nearest beat 0 →
    // clip time -200, clamped to 0.
    expect(snapTimelineMsToBeat(0, ctx({ baseSourceMs: 200 }))).toBe(0)
    // clip time 350 → source 550 → nearest beat 500 → clip time 300.
    expect(snapTimelineMsToBeat(350, ctx({ baseSourceMs: 200 }))).toBe(300)
  })

  it('clamps the result to the clip duration', () => {
    expect(snapTimelineMsToBeat(3900, ctx())).toBe(4000)
    expect(snapTimelineMsToBeat(-100, ctx())).toBe(0)
  })

  it('returns the clamped input when tempo or anchor is missing', () => {
    expect(snapTimelineMsToBeat(260, ctx({ sourceBpm: undefined }))).toBe(260)
    expect(snapTimelineMsToBeat(260, ctx({ sourceBpm: 0 }))).toBe(260)
    expect(snapTimelineMsToBeat(260, ctx({ anchorSec: undefined }))).toBe(260)
    expect(snapTimelineMsToBeat(5000, ctx({ sourceBpm: undefined }))).toBe(4000)
  })
})
