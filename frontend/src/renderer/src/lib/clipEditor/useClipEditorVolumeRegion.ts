// Clip Editor volume-region editing: the gain-envelope edit-mode flag, its
// availability/active derived state, and the selection gate / reset actions.
// Extracted from the controller so volume-region behaviour is one cohesive unit.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { sourceMsToVolumeTime } from '@/lib/clipEditor/volumeOverlay'
import { ENVELOPE_MIN_GAIN } from '@/lib/envelope'
import type { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'

export interface ClipEditorVolumeRegionDeps {
  editsTimelineClip: () => boolean
  viewExpanded: Ref<boolean>
  volumeShapeDurationMs: () => number
  volumeShapeDraft: ReturnType<typeof useClipEditorVolumeShapeDraft>
  hasPlaybackSelection: () => boolean
  draftEffectiveRatio: () => number
  viewInMs: () => number
  selectionInMs: () => number
  selectionEndMs: () => number
}

export interface ClipEditorVolumeRegion {
  /** Volume mode edits the gain envelope instead of the selection in Clip view. */
  volumeEditMode: Ref<boolean>
  volumeShapeAvailable: ComputedRef<boolean>
  volumeEditActive: ComputedRef<boolean>
  canResetVolumeShape: ComputedRef<boolean>
  onResetVolumeShape: () => void
  canGateSelection: ComputedRef<boolean>
  onGateSelection: (gain: number) => void
  onSilenceSelection: () => void
  onFullSelection: () => void
}

export function useClipEditorVolumeRegion(deps: ClipEditorVolumeRegionDeps): ClipEditorVolumeRegion {
  const { volumeShapeDraft } = deps

  // Volume mode edits the gain envelope instead of the selection in Clip view.
  const volumeEditMode = ref(false)

  const volumeShapeAvailable = computed(
    () => deps.editsTimelineClip() && !deps.viewExpanded.value && deps.volumeShapeDurationMs() > 0
  )
  const volumeEditActive = computed(() => volumeEditMode.value && volumeShapeAvailable.value)

  // Reset is offered only while actively shaping a clip that has a non-flat draft.
  const canResetVolumeShape = computed(
    () => volumeShapeAvailable.value && !volumeShapeDraft.isFlat.value
  )
  function onResetVolumeShape(): void {
    volumeShapeDraft.reset(deps.volumeShapeDurationMs())
  }

  // Region gate: flatten the current selection to silence/full with hard edges.
  const canGateSelection = computed(
    () => volumeShapeAvailable.value && deps.hasPlaybackSelection()
  )
  function onGateSelection(gain: number): void {
    if (!canGateSelection.value) return
    const ratio = deps.draftEffectiveRatio()
    const base = deps.viewInMs()
    const durMs = deps.volumeShapeDurationMs()
    const clampLocal = (sourceMs: number): number =>
      Math.max(0, Math.min(durMs, sourceMsToVolumeTime(sourceMs, base, ratio)))
    volumeShapeDraft.gateRange(clampLocal(deps.selectionInMs()), clampLocal(deps.selectionEndMs()), gain)
    if (!volumeEditMode.value) volumeEditMode.value = true
  }
  function onSilenceSelection(): void {
    onGateSelection(ENVELOPE_MIN_GAIN)
  }
  function onFullSelection(): void {
    onGateSelection(1)
  }

  return {
    volumeEditMode,
    volumeShapeAvailable,
    volumeEditActive,
    canResetVolumeShape,
    onResetVolumeShape,
    canGateSelection,
    onGateSelection,
    onSilenceSelection,
    onFullSelection
  }
}
