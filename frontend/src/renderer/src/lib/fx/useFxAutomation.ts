// Links a Track FX control to its automation lane (Option A: the static control
// sets the resting value; the lane overlays a curve on the same parameter). Each
// FX module calls `automate(paramId)` to open that param's lane on the timeline,
// and reads `isAutomated(paramId)` to dim its static control while a curve owns
// the value (so users see which surface is in charge — Option D framing).

import { computed, type Ref } from 'vue'
import { useUiStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import type { AutomationParamId } from '@shared/bridge-protocol'

export function useFxAutomation(trackId: Ref<string | null>) {
  const ui = useUiStore()
  const project = useProjectStore()

  /** A drawn curve (>=2 points) owns the parameter and overrides the static value. */
  function isAutomated(paramId: AutomationParamId): boolean {
    const id = trackId.value
    if (!id) return false
    const pts = project.tracks.find((t) => t.id === id)?.automation?.[paramId]
    return Array.isArray(pts) && pts.length >= 2
  }

  /** True when the lane is currently showing this parameter. */
  function isLaneOpen(paramId: AutomationParamId): boolean {
    const id = trackId.value
    return !!id && ui.automationLanes[id] === paramId
  }

  /** Open the param's lane on the timeline (or collapse it if already shown). */
  function automate(paramId: AutomationParamId): void {
    const id = trackId.value
    if (!id) return
    project.selectTrack(id)
    ui.setTrackAutomationLane(id, isLaneOpen(paramId) ? null : paramId)
    ui.requestRevealTrack(id)
  }

  const anyAutomated = computed(() => {
    const id = trackId.value
    const map = id ? project.tracks.find((t) => t.id === id)?.automation : undefined
    return !!map && Object.values(map).some((p) => Array.isArray(p) && p.length >= 2)
  })

  return { isAutomated, isLaneOpen, automate, anyAutomated }
}
