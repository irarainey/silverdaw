import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useClipEditorCropHistory } from './useClipEditorCropHistory'
import type { CropSnapshot } from '@/lib/clipEditor/useClipEditorViewport'

function makeHarness() {
  // A tiny fake of the viewport crop state so snapshot capture/restore behave
  // like the real composable (capture reads the live values; restore writes them).
  const state = {
    cropViewInMs: 0,
    cropViewDurationMs: 0,
    selectionInMs: 0,
    selectionDurationMs: 0
  }
  const cropViewInMs = ref(0)
  const cropViewDurationMs = ref(0)
  const selectionInMs = ref(0)
  const selectionDurationMs = ref(0)

  // Keep the ref-backed view bounds mirrored into the snapshot state so a
  // capture taken after onApplyCrop reflects the committed view.
  function syncFromRefs(): void {
    state.cropViewInMs = cropViewInMs.value
    state.cropViewDurationMs = cropViewDurationMs.value
    state.selectionInMs = selectionInMs.value
    state.selectionDurationMs = selectionDurationMs.value
  }

  const captureCropSnapshot = vi.fn((): CropSnapshot => {
    syncFromRefs()
    return { ...state }
  })
  const restoreCropSnapshot = vi.fn((snap: CropSnapshot): void => {
    cropViewInMs.value = snap.cropViewInMs
    cropViewDurationMs.value = snap.cropViewDurationMs
    selectionInMs.value = snap.selectionInMs
    selectionDurationMs.value = snap.selectionDurationMs
  })
  const resetZoom = vi.fn()
  const redraw = vi.fn()
  const reloadPreview = vi.fn()
  const canApply = ref(true)

  const history = useClipEditorCropHistory({
    canApplyCrop: () => canApply.value,
    captureCropSnapshot,
    restoreCropSnapshot,
    cropViewInMs,
    cropViewDurationMs,
    selectionInMs: () => selectionInMs.value,
    selectionDurationMs: () => selectionDurationMs.value,
    resetZoom,
    redraw,
    reloadPreview
  })

  return {
    history,
    cropViewInMs,
    cropViewDurationMs,
    selectionInMs,
    selectionDurationMs,
    canApply,
    captureCropSnapshot,
    restoreCropSnapshot,
    resetZoom,
    redraw,
    reloadPreview
  }
}

describe('useClipEditorCropHistory', () => {
  let h: ReturnType<typeof makeHarness>

  beforeEach(() => {
    h = makeHarness()
  })

  it('starts with empty undo/redo state', () => {
    expect(h.history.canUndoCrop.value).toBe(false)
    expect(h.history.canRedoCrop.value).toBe(false)
  })

  it('onApplyCrop commits the selection as the new view and pushes undo', () => {
    h.selectionInMs.value = 1000
    h.selectionDurationMs.value = 500

    h.history.onApplyCrop()

    expect(h.cropViewInMs.value).toBe(1000)
    expect(h.cropViewDurationMs.value).toBe(500)
    expect(h.resetZoom).toHaveBeenCalledTimes(1)
    expect(h.redraw).toHaveBeenCalledTimes(1)
    expect(h.reloadPreview).toHaveBeenCalledTimes(1)
    expect(h.history.canUndoCrop.value).toBe(true)
    expect(h.history.canRedoCrop.value).toBe(false)
  })

  it('onApplyCrop clamps negative selection bounds to zero', () => {
    h.selectionInMs.value = -50
    h.selectionDurationMs.value = -10

    h.history.onApplyCrop()

    expect(h.cropViewInMs.value).toBe(0)
    expect(h.cropViewDurationMs.value).toBe(0)
  })

  it('onApplyCrop is a no-op when canApplyCrop is false', () => {
    h.canApply.value = false
    h.history.onApplyCrop()

    expect(h.history.canUndoCrop.value).toBe(false)
    expect(h.redraw).not.toHaveBeenCalled()
    expect(h.resetZoom).not.toHaveBeenCalled()
  })

  it('undo restores the prior snapshot and enables redo', () => {
    h.selectionInMs.value = 200
    h.selectionDurationMs.value = 100
    h.history.onApplyCrop()
    expect(h.cropViewInMs.value).toBe(200)

    h.history.undoCropLocal()

    // restored back to the pre-apply view (0/0)
    expect(h.cropViewInMs.value).toBe(0)
    expect(h.cropViewDurationMs.value).toBe(0)
    expect(h.history.canUndoCrop.value).toBe(false)
    expect(h.history.canRedoCrop.value).toBe(true)
    expect(h.restoreCropSnapshot).toHaveBeenCalledTimes(1)
  })

  it('redo re-applies an undone crop', () => {
    h.selectionInMs.value = 200
    h.selectionDurationMs.value = 100
    h.history.onApplyCrop()
    h.history.undoCropLocal()

    h.history.redoCropLocal()

    expect(h.cropViewInMs.value).toBe(200)
    expect(h.cropViewDurationMs.value).toBe(100)
    expect(h.history.canUndoCrop.value).toBe(true)
    expect(h.history.canRedoCrop.value).toBe(false)
  })

  it('a new crop clears the redo stack', () => {
    h.selectionInMs.value = 200
    h.selectionDurationMs.value = 100
    h.history.onApplyCrop()
    h.history.undoCropLocal()
    expect(h.history.canRedoCrop.value).toBe(true)

    h.selectionInMs.value = 300
    h.selectionDurationMs.value = 80
    h.history.onApplyCrop()

    expect(h.history.canRedoCrop.value).toBe(false)
    expect(h.history.canUndoCrop.value).toBe(true)
  })

  it('undo/redo are safe no-ops when the stacks are empty', () => {
    h.history.undoCropLocal()
    h.history.redoCropLocal()

    expect(h.restoreCropSnapshot).not.toHaveBeenCalled()
    expect(h.redraw).not.toHaveBeenCalled()
  })

  it('resetCropHistory clears both stacks', () => {
    h.selectionInMs.value = 200
    h.selectionDurationMs.value = 100
    h.history.onApplyCrop()
    h.history.undoCropLocal()
    expect(h.history.canRedoCrop.value).toBe(true)

    h.history.resetCropHistory()

    expect(h.history.canUndoCrop.value).toBe(false)
    expect(h.history.canRedoCrop.value).toBe(false)
  })
})
