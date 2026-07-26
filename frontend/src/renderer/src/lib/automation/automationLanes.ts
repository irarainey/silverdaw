import type { AutomationParamId } from '@shared/bridge-protocol'
import { AUTOMATION_LANE_HEIGHT } from '@/lib/timeline/constants'

export interface AutomationLane {
  paramId: AutomationParamId
  heightPx: number
}

export const MIN_AUTOMATION_LANE_HEIGHT = 80
export const MAX_AUTOMATION_LANE_HEIGHT = 220

export function clampAutomationLaneHeight(heightPx: number): number {
  return Math.max(
    MIN_AUTOMATION_LANE_HEIGHT,
    Math.min(MAX_AUTOMATION_LANE_HEIGHT, Math.round(heightPx))
  )
}

export function createAutomationLane(paramId: AutomationParamId): AutomationLane {
  return { paramId, heightPx: AUTOMATION_LANE_HEIGHT }
}

export function automationLanesHeight(lanes: readonly AutomationLane[] | undefined): number {
  return lanes?.reduce((height, lane) => height + lane.heightPx, 0) ?? 0
}

export function automationLaneOffset(
  lanes: readonly AutomationLane[],
  laneIndex: number
): number {
  return lanes.slice(0, laneIndex).reduce((height, lane) => height + lane.heightPx, 0)
}

export function findAutomationLaneAt(
  lanes: readonly AutomationLane[] | undefined,
  rowTop: number,
  clipHeight: number,
  worldY: number
): { lane: AutomationLane; top: number; bottom: number } | null {
  let top = rowTop + clipHeight
  for (const lane of lanes ?? []) {
    const bottom = top + lane.heightPx
    if (worldY >= top && worldY <= bottom) return { lane, top, bottom }
    top = bottom
  }
  return null
}

export function findAutomationLane(
  lanes: readonly AutomationLane[] | undefined,
  paramId: AutomationParamId,
  rowTop: number,
  clipHeight: number
): { lane: AutomationLane; top: number; bottom: number } | null {
  let top = rowTop + clipHeight
  for (const lane of lanes ?? []) {
    const bottom = top + lane.heightPx
    if (lane.paramId === paramId) return { lane, top, bottom }
    top = bottom
  }
  return null
}
