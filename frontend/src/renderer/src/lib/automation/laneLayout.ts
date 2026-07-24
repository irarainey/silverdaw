// Shared automation-lane row-height getter. Used by every trackLayout caller so
// clip geometry, scroll extent, hit-testing, and the header overlay stay aligned.

import { automationLanesHeight } from '@/lib/automation/automationLanes'
import { useUiStore } from '@/stores/uiStore'
import type { LaneHeightOf } from '@/lib/timeline/trackLayout'

export function makeLaneHeightOf(): LaneHeightOf {
  const ui = useUiStore()
  return (track) => (track.id ? automationLanesHeight(ui.automationLanes[track.id]) : 0)
}
