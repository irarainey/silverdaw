import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, type Ref } from 'vue'
import {
  useClipEditorCanvasInteraction,
  type ClipEditorCanvasInteractionDeps
} from '@/lib/clipEditor/useClipEditorCanvasInteraction'
import type { LibraryItem } from '@/stores/libraryStore'

interface Harness {
  api: ReturnType<typeof useClipEditorCanvasInteraction>
  selectionInMs: Ref<number>
  selectionDurationMs: Ref<number>
  scrollMs: Ref<number>
  preview: { seek: ReturnType<typeof vi.fn> }
  setZoomAnchored: ReturnType<typeof vi.fn>
  state: {
    viewInMs: number
    viewEndMs: number
    viewDurationMs: number
    visibleInMs: number
    visibleDurationMs: number
    maxScrollMs: number
    playheadAbsMs: number
    hasPlaybackSelection: boolean
    zoom: number
    sourceItem: LibraryItem | null
  }
}

function makeHarness(): Harness {
  const selectionInMs = ref(0)
  const selectionDurationMs = ref(0)
  const scrollMs = ref(0)
  const preview = { seek: vi.fn() }
  const setZoomAnchored = vi.fn()
  const state: Harness['state'] = {
    viewInMs: 0,
    viewEndMs: 10000,
    viewDurationMs: 10000,
    visibleInMs: 0,
    visibleDurationMs: 10000,
    maxScrollMs: 0,
    playheadAbsMs: 1000,
    hasPlaybackSelection: false,
    zoom: 1,
    sourceItem: null
  }

  const deps: ClipEditorCanvasInteractionDeps = {
    getCanvas: () => null,
    preview: preview as unknown as ClipEditorCanvasInteractionDeps['preview'],
    volumeShapeDraft: {} as unknown as ClipEditorCanvasInteractionDeps['volumeShapeDraft'],
    sliceDraft: {} as unknown as ClipEditorCanvasInteractionDeps['sliceDraft'],
    sliceEditActive: () => false,
    selectionInMs,
    selectionDurationMs,
    scrollMs,
    waveformStereoLanes: ref(false),
    viewInMs: () => state.viewInMs,
    viewEndMs: () => state.viewEndMs,
    viewDurationMs: () => state.viewDurationMs,
    visibleInMs: () => state.visibleInMs,
    visibleDurationMs: () => state.visibleDurationMs,
    selectionEndMs: () => selectionInMs.value + selectionDurationMs.value,
    maxScrollMs: () => state.maxScrollMs,
    playheadAbsMs: () => state.playheadAbsMs,
    hasPlaybackSelection: () => state.hasPlaybackSelection,
    volumeEditActive: () => false,
    volumeShapeDurationMs: () => 0,
    draftEffectiveRatio: () => 1,
    sourceItem: () => state.sourceItem,
    zoom: () => state.zoom,
    gridAlignActive: () => false,
    previewGridAnchorSec: () => {},
    commitGridAnchorSec: () => {},
    setZoomAnchored
  }

  return {
    api: useClipEditorCanvasInteraction(deps),
    selectionInMs,
    selectionDurationMs,
    scrollMs,
    preview,
    setZoomAnchored,
    state
  }
}

function makeWheel(opts: {
  deltaX?: number
  deltaY?: number
  shiftKey?: boolean
  clientX?: number
}): WheelEvent {
  return {
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
    shiftKey: opts.shiftKey ?? false,
    clientX: opts.clientX ?? 0,
    preventDefault: vi.fn()
  } as unknown as WheelEvent
}

describe('useClipEditorCanvasInteraction — playhead & selection', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('clearSelection resets the selection to the whole view', () => {
    h.state.viewInMs = 200
    h.state.viewDurationMs = 5000
    h.selectionInMs.value = 1000
    h.selectionDurationMs.value = 500

    h.api.clearSelection()

    expect(h.selectionInMs.value).toBe(200)
    expect(h.selectionDurationMs.value).toBe(5000)
  })

  it('seekPlayheadToSourceMs seeks relative to the view start, clamped', () => {
    h.state.viewInMs = 1000
    h.state.viewDurationMs = 4000
    // via nudge with no snap (1ms step) from a known playhead
    h.state.playheadAbsMs = 2000
    h.api.nudgePlayhead(1, false)
    expect(h.preview.seek).toHaveBeenCalledWith(1001) // (2001 - 1000)
  })

  it('nudgePlayhead clamps to the view end', () => {
    h.state.viewInMs = 0
    h.state.viewEndMs = 3000
    h.state.viewDurationMs = 3000
    h.state.playheadAbsMs = 3000
    h.api.nudgePlayhead(1, false)
    // clamped at viewEnd 3000 → rel 3000
    expect(h.preview.seek).toHaveBeenCalledWith(3000)
  })

  it('extendSelection from no selection anchors at the playhead (forward)', () => {
    h.state.hasPlaybackSelection = false
    h.state.playheadAbsMs = 1000
    h.api.extendSelection(1, false)
    expect(h.selectionInMs.value).toBe(1000)
    expect(h.selectionDurationMs.value).toBe(1) // 1ms step
    expect(h.preview.seek).toHaveBeenCalledWith(1001)
  })

  it('extendSelection from no selection anchors at the playhead (backward)', () => {
    h.state.hasPlaybackSelection = false
    h.state.playheadAbsMs = 1000
    h.api.extendSelection(-1, false)
    expect(h.selectionInMs.value).toBe(999)
    expect(h.selectionDurationMs.value).toBe(1)
  })

  it('extendSelection grows an existing selection at its end edge', () => {
    h.state.hasPlaybackSelection = true
    h.selectionInMs.value = 1000
    h.selectionDurationMs.value = 500 // end = 1500
    h.api.extendSelection(1, false)
    expect(h.selectionDurationMs.value).toBe(501) // end 1501 - in 1000
  })

  it('beat-snapping nudge jumps to the next beat on the grid', () => {
    // 120 BPM → 500ms/beat, anchor at 0
    h.state.sourceItem = { bpm: 120, beatAnchorSec: 0 } as unknown as LibraryItem
    h.state.viewInMs = 0
    h.state.viewEndMs = 10000
    h.state.playheadAbsMs = 600 // between beat 1 (500) and beat 2 (1000)
    h.api.nudgePlayhead(1, true)
    expect(h.preview.seek).toHaveBeenCalledWith(1000) // next beat
  })
})

describe('useClipEditorCanvasInteraction — wheel', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('Shift+wheel pans by scrolling, clamped to maxScroll', () => {
    h.state.visibleDurationMs = 1000
    h.state.maxScrollMs = 5000
    h.scrollMs.value = 0
    // No canvas → getBoundingClientRect needs a fake; supply one via getCanvas
    const rect = { left: 0, width: 100, height: 50 } as DOMRect
    const fakeCanvas = { getBoundingClientRect: () => rect } as unknown as HTMLCanvasElement
    // rebuild harness deps with a canvas: simplest is to re-run with a wrapper
    const api = makeWheelHarness(h, fakeCanvas)
    api.onCanvasWheel(makeWheel({ deltaY: 100, shiftKey: true }))
    // msPerPx = 1000/100 = 10; next = 0 + 100*10 = 1000
    expect(h.scrollMs.value).toBe(1000)
    expect(h.setZoomAnchored).not.toHaveBeenCalled()
  })

  it('plain wheel zooms anchored at the pointer', () => {
    h.state.visibleInMs = 0
    h.state.visibleDurationMs = 1000
    h.state.zoom = 2
    const rect = { left: 0, width: 100, height: 50 } as DOMRect
    const fakeCanvas = { getBoundingClientRect: () => rect } as unknown as HTMLCanvasElement
    const api = makeWheelHarness(h, fakeCanvas)
    api.onCanvasWheel(makeWheel({ deltaY: -100, clientX: 50 }))
    // zoom in factor 1.2 → 2.4; pointerMs = 0 + 0.5*1000 = 500
    expect(h.setZoomAnchored).toHaveBeenCalledWith(2.4, 500)
  })
})

// Rebuild a canvas-interaction instance that shares the harness refs/state but
// has a real canvas, so wheel geometry can be exercised.
function makeWheelHarness(
  h: Harness,
  canvas: HTMLCanvasElement
): ReturnType<typeof useClipEditorCanvasInteraction> {
  const deps: ClipEditorCanvasInteractionDeps = {
    getCanvas: () => canvas,
    preview: h.preview as unknown as ClipEditorCanvasInteractionDeps['preview'],
    volumeShapeDraft: {} as unknown as ClipEditorCanvasInteractionDeps['volumeShapeDraft'],
    sliceDraft: {} as unknown as ClipEditorCanvasInteractionDeps['sliceDraft'],
    sliceEditActive: () => false,
    selectionInMs: h.selectionInMs,
    selectionDurationMs: h.selectionDurationMs,
    scrollMs: h.scrollMs,
    waveformStereoLanes: ref(false),
    viewInMs: () => h.state.viewInMs,
    viewEndMs: () => h.state.viewEndMs,
    viewDurationMs: () => h.state.viewDurationMs,
    visibleInMs: () => h.state.visibleInMs,
    visibleDurationMs: () => h.state.visibleDurationMs,
    selectionEndMs: () => h.selectionInMs.value + h.selectionDurationMs.value,
    maxScrollMs: () => h.state.maxScrollMs,
    playheadAbsMs: () => h.state.playheadAbsMs,
    hasPlaybackSelection: () => h.state.hasPlaybackSelection,
    volumeEditActive: () => false,
    volumeShapeDurationMs: () => 0,
    draftEffectiveRatio: () => 1,
    sourceItem: () => h.state.sourceItem,
    zoom: () => h.state.zoom,
    gridAlignActive: () => false,
    previewGridAnchorSec: () => {},
    commitGridAnchorSec: () => {},
    setZoomAnchored: h.setZoomAnchored
  }
  return useClipEditorCanvasInteraction(deps)
}
