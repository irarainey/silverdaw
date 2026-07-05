// Clip Editor dirty-state derivations: compare the live selection, crop view,
// and warp/pitch/volume drafts against the persisted clip so the Save / Trim /
// Save-as-new affordances enable only on a genuine change. Dependency-injected
// so the gating rules (notably the single-timeline-clip volume carve-out) are
// unit-testable in isolation.
import { computed, type ComputedRef } from 'vue'
import type { Clip } from '@/stores/projectStore'
import type { LibraryItem } from '@/stores/libraryStore'
import type { ClipWarpMode } from '@shared/bridge-protocol'
import { currentHasTempoWarp, deriveTempoModeFromClip, type ClipTempoMode } from '@/lib/clipEditor/useClipEditorWarpDraft'

export interface ClipEditorDirtyStateDeps {
  editsExistingClip: () => boolean
  editsTimelineClip: () => boolean
  timelineClip: () => Clip | null
  editorItem: () => LibraryItem | null
  sourceItem: () => LibraryItem | null
  selectionInMs: () => number
  selectionDurationMs: () => number
  selectionEndMs: () => number
  cropViewInMs: () => number
  cropViewDurationMs: () => number
  draftTempoEnabled: () => boolean
  draftMode: () => ClipWarpMode
  draftTempoMode: () => ClipTempoMode
  draftPinnedBpm: () => number
  draftStretchPercent: () => number
  draftSemitones: () => number
  draftCents: () => number
  hasVolumeShapeChanged: () => boolean
  hasReverseChanged: () => boolean
  hasDjEffectChanged: () => boolean
  hasGridChanged: () => boolean
  sourceBpm: () => number | undefined
  projectBpm: () => number
}

export interface ClipEditorDirtyState {
  hasSelectionChanged: ComputedRef<boolean>
  hasWarpPitchChanged: ComputedRef<boolean>
  canSaveChanges: ComputedRef<boolean>
  canApplyCrop: ComputedRef<boolean>
  canSaveAsNew: ComputedRef<boolean>
}

export function useClipEditorDirtyState(
  deps: ClipEditorDirtyStateDeps
): ClipEditorDirtyState {
  // Dirty when either selection or cropped view differs from the persisted window.
  const hasSelectionChanged = computed(() => {
    if (!deps.editsExistingClip()) return false
    const clip = deps.timelineClip()
    const entry = deps.editorItem()
    if (!entry) return false
    const origIn = clip?.inMs ?? entry.derivedFrom?.inMs ?? 0
    const origDur = clip?.durationMs ?? entry.derivedFrom?.durationMs ?? entry.durationMs
    if (deps.selectionInMs() !== origIn || deps.selectionDurationMs() !== origDur) return true
    if (deps.cropViewInMs() !== origIn || deps.cropViewDurationMs() !== origDur) return true
    return false
  })

  const hasWarpPitchChanged = computed(() => {
    const current = deps.timelineClip() ?? deps.editorItem()
    if (!current || !deps.editsExistingClip()) return false
    const currentTempoEnabled = currentHasTempoWarp(current)
    if (deps.draftTempoEnabled() !== currentTempoEnabled) return true
    if (deps.draftMode() !== (current.warpMode ?? 'rhythmic')) return true
    if (deps.draftSemitones() !== (current.semitones ?? 0)) return true
    if (deps.draftCents() !== (current.cents ?? 0)) return true
    // Compare tempo-mode details only while warp is enabled.
    if (deps.draftTempoEnabled()) {
      const derived = deriveTempoModeFromClip(current, deps.sourceBpm(), deps.projectBpm())
      if (deps.draftTempoMode() !== derived.mode) return true
      if (deps.draftTempoMode() === 'pin' && Math.abs(deps.draftPinnedBpm() - derived.pinnedBpm) > 0.005) {
        return true
      }
      if (
        deps.draftTempoMode() === 'stretch' &&
        Math.abs(deps.draftStretchPercent() - derived.stretchPercent) > 0.005
      ) {
        return true
      }
    }
    return false
  })

  const canSaveChanges = computed(() => {
    if (!deps.editsExistingClip()) return false
    // Volume shaping is available for any placed timeline clip (linked or not);
    // linked edits persist to the shared saved clip and all its instances.
    const volumeShapeDirty = deps.editsTimelineClip() && deps.hasVolumeShapeChanged()
    const reverseDirty = deps.editsTimelineClip() && deps.hasReverseChanged()
    // Brake/backspin are tail effects on a placed timeline clip.
    const djEffectDirty = deps.editsTimelineClip() && deps.hasDjEffectChanged()
    // Beat-grid alignment edits the shared source item and is persisted on
    // commit; surface it as dirty so Save enables and the user can confirm/close.
    return (
      hasSelectionChanged.value ||
      hasWarpPitchChanged.value ||
      volumeShapeDirty ||
      reverseDirty ||
      djEffectDirty ||
      deps.hasGridChanged()
    )
  })

  // Non-destructive crop is enabled only for a narrowing selection.
  const canApplyCrop = computed(() => {
    if (!deps.editorItem()) return false
    if (deps.selectionDurationMs() <= 0) return false
    return (
      deps.selectionInMs() > deps.cropViewInMs() + 0.5 ||
      deps.selectionEndMs() < deps.cropViewInMs() + deps.cropViewDurationMs() - 0.5
    )
  })

  const canSaveAsNew = computed(() => {
    return !deps.editsExistingClip() && !!deps.sourceItem() && deps.selectionDurationMs() > 0
  })

  return {
    hasSelectionChanged,
    hasWarpPitchChanged,
    canSaveChanges,
    canApplyCrop,
    canSaveAsNew
  }
}
