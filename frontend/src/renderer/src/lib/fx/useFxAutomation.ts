// Links a Track FX control to its automation lane (Option A: the static control
// sets the resting value; the lane overlays a curve on the same parameter). Each
// FX module calls `automate(paramId)` to open that param's lane on the timeline,
// and reads `isAutomated(paramId)` to dim its static control while a curve owns
// the value (so users see which surface is in charge — Option D framing).

import { computed, type Ref } from 'vue'
import { useUiStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { sampleBreakpoints } from '@/lib/automation/breakpoints'
import type { AutomationParamId } from '@shared/bridge-protocol'

export function useFxAutomation(trackId: Ref<string | null>) {
  const ui = useUiStore()
  const project = useProjectStore()
  const transport = useTransportStore()

  /** A drawn curve (>=2 points) owns the parameter and overrides the static value. */
  function isAutomated(paramId: AutomationParamId): boolean {
    const id = trackId.value
    if (!id) return false
    const pts = project.tracks.find((t) => t.id === id)?.automation?.[paramId]
    return Array.isArray(pts) && pts.length >= 2
  }

  /** Value to SHOW on the static control. When a curve owns the parameter, this
   *  is the curve's value at the current playhead (so the slider follows the
   *  automation live during playback / scrub); otherwise the static value the
   *  caller passes. Reactive to `transport.positionMs`. */
  function displayValue(paramId: AutomationParamId, staticValue: number): number {
    const id = trackId.value
    if (!id) return staticValue
    const pts = project.tracks.find((t) => t.id === id)?.automation?.[paramId]
    if (Array.isArray(pts) && pts.length >= 2) {
      return sampleBreakpoints(pts, transport.positionMs)
    }
    return staticValue
  }

  /** True when the lane is currently showing this parameter. */
  function isLaneOpen(paramId: AutomationParamId): boolean {
    const id = trackId.value
    return !!id && ui.automationLanes[id]?.some((lane) => lane.paramId === paramId) === true
  }

  /** Toggle this parameter's lane without hiding the other visible curves. */
  function automate(paramId: AutomationParamId): void {
    const id = trackId.value
    if (!id) return
    project.selectTrack(id)
    ui.toggleTrackAutomationLane(id, paramId)
    ui.requestRevealTrack(id)
  }

  const anyAutomated = computed(() => {
    const id = trackId.value
    const map = id ? project.tracks.find((t) => t.id === id)?.automation : undefined
    return !!map && Object.values(map).some((p) => Array.isArray(p) && p.length >= 2)
  })

  return { isAutomated, displayValue, isLaneOpen, automate, anyAutomated }
}
