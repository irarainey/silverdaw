import { describe, it, expect } from 'vitest'
import {
  EDGE_AUTOSCROLL_MAX_PX_PER_FRAME,
  EDGE_AUTOSCROLL_ZONE_PX,
  edgeAutoScrollDelta
} from '@/lib/timeline/edgeAutoScroll'

const LEFT = 100 // header width
const RIGHT = 800 // just left of the scrollbar

describe('edgeAutoScrollDelta', () => {
  it('is zero in the clear middle of the track area', () => {
    expect(edgeAutoScrollDelta(400, LEFT, RIGHT)).toBe(0)
  })

  it('is zero exactly at each zone inner boundary', () => {
    expect(edgeAutoScrollDelta(LEFT + EDGE_AUTOSCROLL_ZONE_PX, LEFT, RIGHT)).toBe(0)
    expect(edgeAutoScrollDelta(RIGHT - EDGE_AUTOSCROLL_ZONE_PX, LEFT, RIGHT)).toBe(0)
  })

  it('scrolls left (negative) near/at the left edge, at full speed when at or past it', () => {
    expect(edgeAutoScrollDelta(LEFT, LEFT, RIGHT)).toBe(-EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
    expect(edgeAutoScrollDelta(0, LEFT, RIGHT)).toBe(-EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
    // Halfway into the zone → about half speed.
    const half = edgeAutoScrollDelta(LEFT + EDGE_AUTOSCROLL_ZONE_PX / 2, LEFT, RIGHT)
    expect(half).toBeLessThan(0)
    expect(half).toBeGreaterThan(-EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
  })

  it('scrolls right (positive) near/at the right edge, at full speed when at or past it', () => {
    expect(edgeAutoScrollDelta(RIGHT, LEFT, RIGHT)).toBe(EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
    expect(edgeAutoScrollDelta(RIGHT + 50, LEFT, RIGHT)).toBe(EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
    const half = edgeAutoScrollDelta(RIGHT - EDGE_AUTOSCROLL_ZONE_PX / 2, LEFT, RIGHT)
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(EDGE_AUTOSCROLL_MAX_PX_PER_FRAME)
  })
})
