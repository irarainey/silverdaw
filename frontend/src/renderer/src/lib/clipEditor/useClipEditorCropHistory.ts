// Clip Editor dialog-local Crop undo/redo history, extracted from
// ClipEditorDialog.vue. Crop is purely non-destructive (it narrows the working
// view); committing the final result via Apply trim goes through the
// project-wide UndoManager and gets its own undo step there. This stack is
// scoped to the dialog so closing it discards any uncommitted crops — the
// library entry hasn't been touched.
import { ref, computed, type ComputedRef, type Ref } from 'vue'
import type { CropSnapshot } from '@/lib/clipEditor/useClipEditorViewport'

export interface ClipEditorCropHistoryDeps {
  canApplyCrop: () => boolean
  captureCropSnapshot: () => CropSnapshot
  restoreCropSnapshot: (snap: CropSnapshot) => void
  cropViewInMs: Ref<number>
  cropViewDurationMs: Ref<number>
  selectionInMs: () => number
  selectionDurationMs: () => number
  resetZoom: () => void
  redraw: () => void
  reloadPreview: () => void
}

export interface ClipEditorCropHistory {
  onApplyCrop: () => void
  undoCropLocal: () => void
  redoCropLocal: () => void
  resetCropHistory: () => void
  canUndoCrop: ComputedRef<boolean>
  canRedoCrop: ComputedRef<boolean>
}

export function useClipEditorCropHistory(
  deps: ClipEditorCropHistoryDeps
): ClipEditorCropHistory {
  const cropUndoStack = ref<CropSnapshot[]>([])
  const cropRedoStack = ref<CropSnapshot[]>([])

  const canUndoCrop = computed(() => cropUndoStack.value.length > 0)
  const canRedoCrop = computed(() => cropRedoStack.value.length > 0)

  function resetCropHistory(): void {
    cropUndoStack.value = []
    cropRedoStack.value = []
  }

  function applySnapshot(snap: CropSnapshot): void {
    deps.restoreCropSnapshot(snap)
    deps.redraw()
    deps.reloadPreview()
  }

  function onApplyCrop(): void {
    if (!deps.canApplyCrop()) return
    cropUndoStack.value.push(deps.captureCropSnapshot())
    cropRedoStack.value = []
    deps.cropViewInMs.value = Math.max(0, deps.selectionInMs())
    deps.cropViewDurationMs.value = Math.max(0, deps.selectionDurationMs())
    deps.resetZoom()
    deps.redraw()
    deps.reloadPreview()
  }

  function undoCropLocal(): void {
    const snap = cropUndoStack.value.pop()
    if (!snap) return
    cropRedoStack.value.push(deps.captureCropSnapshot())
    applySnapshot(snap)
  }

  function redoCropLocal(): void {
    const snap = cropRedoStack.value.pop()
    if (!snap) return
    cropUndoStack.value.push(deps.captureCropSnapshot())
    applySnapshot(snap)
  }

  return {
    onApplyCrop,
    undoCropLocal,
    redoCropLocal,
    resetCropHistory,
    canUndoCrop,
    canRedoCrop
  }
}
