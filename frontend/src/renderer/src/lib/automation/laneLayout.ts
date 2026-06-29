// Shared automation-lane row-height getter: a track adds the lane height to its
// row only while its lane is expanded (`uiStore.automationLanes`). Used by every
// trackLayout caller so clip geometry, scroll extent, hit-testing, and the header
// overlay stay aligned.

import { AUTOMATION_LANE_HEIGHT } from '@/lib/timeline/constants'
import { useUiStore } from '@/stores/uiStore'
import type { LaneHeightOf } from '@/lib/timeline/trackLayout'

export function makeLaneHeightOf(): LaneHeightOf {
  const ui = useUiStore()
  return (track) =>
    track.id && ui.automationLanes[track.id]
      ? ui.automationLaneHeights[track.id] ?? AUTOMATION_LANE_HEIGHT
      : 0
}
