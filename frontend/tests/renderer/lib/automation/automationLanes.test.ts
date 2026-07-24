import { describe, expect, it } from 'vitest'
import {
  automationLaneOffset,
  automationLanesHeight,
  findAutomationLaneAt
} from '@/lib/automation/automationLanes'

const lanes = [
  { paramId: 'filter' as const, heightPx: 96 },
  { paramId: 'pan' as const, heightPx: 160 }
]

describe('automation lane layout', () => {
  it('stacks visible lanes and resolves the target lane from world Y', () => {
    expect(automationLanesHeight(lanes)).toBe(256)
    expect(automationLaneOffset(lanes, 0)).toBe(0)
    expect(automationLaneOffset(lanes, 1)).toBe(96)

    expect(findAutomationLaneAt(lanes, 100, 120, 250)).toMatchObject({
      lane: lanes[0],
      top: 220,
      bottom: 316
    })
    expect(findAutomationLaneAt(lanes, 100, 120, 320)).toMatchObject({
      lane: lanes[1],
      top: 316,
      bottom: 476
    })
  })
})
