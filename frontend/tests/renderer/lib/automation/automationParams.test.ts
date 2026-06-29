import { describe, it, expect } from 'vitest'
import {
  valueToFraction,
  fractionToValue,
  automationDescriptor
} from '@/lib/automation/automationParams'
import { laneRegion, valueToLaneY, laneYToValue, LANE_PX } from '@/lib/timeline/automationLaneRenderer'

describe('automation descriptors', () => {
  it('filter centre maps to mid lane; ends clamp', () => {
    expect(valueToFraction('filter', 0)).toBeCloseTo(0.5, 6)
    expect(valueToFraction('filter', -1)).toBe(0)
    expect(valueToFraction('filter', 1)).toBe(1)
    expect(fractionToValue('filter', 0.5)).toBeCloseTo(0, 6)
  })

  it('format reads musically', () => {
    expect(automationDescriptor('filter').format(0)).toBe('Off')
    expect(automationDescriptor('pan').format(0)).toBe('C')
  })
})

describe('lane geometry', () => {
  it('value <-> lane Y round-trips below the clip area', () => {
    const { top, bottom } = laneRegion(100, 120) // clips 120 tall -> lane below
    expect(top).toBe(220)
    expect(bottom).toBe(220 + LANE_PX)
    const y = valueToLaneY('filter', 0.5, top)
    expect(laneYToValue('filter', y, top)).toBeCloseTo(0.5, 4)
    // Extremes sit just inside the strip (padded), full at top, min at bottom.
    expect(valueToLaneY('filter', 1, top)).toBeLessThan(valueToLaneY('filter', -1, top))
    expect(laneYToValue('filter', valueToLaneY('filter', 1, top), top)).toBeCloseTo(1, 4)
    expect(laneYToValue('filter', valueToLaneY('filter', -1, top), top)).toBeCloseTo(-1, 4)
  })
})
