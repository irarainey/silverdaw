import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  useClipEditorViewport
} from '@/lib/clipEditor/useClipEditorViewport'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'item',
    kind: 'source',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 10_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    ...overrides
  } as LibraryItem
}

function makeLibraryClipItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return makeItem({
    id: 'saved',
    kind: 'clip',
    durationMs: 2_000,
    derivedFrom: { sourceItemId: 'src', sourceClipId: '', inMs: 1_000, durationMs: 2_000 },
    ...overrides
  })
}

function makeTimelineClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId: 'src',
    filePath: 'C:\\src.wav',
    fileName: 'src.wav',
    startMs: 0,
    inMs: 500,
    durationMs: 1_500,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

function makeVp(opts: {
  editorItem?: LibraryItem | null
  editsExistingClip?: boolean
  timelineClip?: Clip | null
  sourceDurationMs?: number
  uiZoomPxPerSecond?: number
} = {}): ReturnType<typeof useClipEditorViewport> {
  return useClipEditorViewport({
    editorItem: ref(opts.editorItem ?? null) as never,
    editsExistingClip: ref(opts.editsExistingClip ?? false) as never,
    timelineClip: ref(opts.timelineClip ?? null) as never,
    sourceDurationMs: ref(opts.sourceDurationMs ?? 10_000) as never,
    uiZoomPxPerSecond: ref(opts.uiZoomPxPerSecond ?? 100) as never
  })
}

describe('useClipEditorViewport — view bounds', () => {
  it('reports zero bounds when no item is loaded', () => {
    const vp = makeVp({ editorItem: null })
    expect(vp.viewInMs.value).toBe(0)
    expect(vp.viewDurationMs.value).toBe(0)
    expect(vp.viewEndMs.value).toBe(0)
  })

  it('source mode: view spans the full source duration', () => {
    const vp = makeVp({
      editorItem: makeItem(),
      editsExistingClip: false,
      sourceDurationMs: 8_000
    })
    expect(vp.viewInMs.value).toBe(0)
    expect(vp.viewDurationMs.value).toBe(8_000)
    expect(vp.viewEndMs.value).toBe(8_000)
  })

  it('library-clip mode collapsed: view tracks the cropped window', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip(),
      sourceDurationMs: 10_000
    })
    vp.initialiseForItem()
    expect(vp.viewInMs.value).toBe(500)
    expect(vp.viewDurationMs.value).toBe(1_500)
  })

  it('library-clip mode expanded: view spans the full source', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip(),
      sourceDurationMs: 10_000
    })
    vp.initialiseForItem()
    vp.viewExpanded.value = true
    expect(vp.viewInMs.value).toBe(0)
    expect(vp.viewDurationMs.value).toBe(10_000)
  })
})

describe('useClipEditorViewport — initialiseForItem', () => {
  it('seeds library-clip view from the timeline clip when provided', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip({ inMs: 750, durationMs: 1_250 })
    })
    vp.initialiseForItem()
    expect(vp.cropViewInMs.value).toBe(750)
    expect(vp.cropViewDurationMs.value).toBe(1_250)
    expect(vp.selectionInMs.value).toBe(750)
    expect(vp.selectionDurationMs.value).toBe(1_250)
  })

  it('falls back to derivedFrom when no timeline clip exists', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: null
    })
    vp.initialiseForItem()
    expect(vp.cropViewInMs.value).toBe(1_000)
    expect(vp.cropViewDurationMs.value).toBe(2_000)
  })

  it('source mode: opens with no selection over the full source', () => {
    const vp = makeVp({
      editorItem: makeItem(),
      editsExistingClip: false,
      sourceDurationMs: 5_000
    })
    vp.initialiseForItem()
    expect(vp.cropViewInMs.value).toBe(0)
    expect(vp.cropViewDurationMs.value).toBe(5_000)
    expect(vp.selectionInMs.value).toBe(0)
    expect(vp.selectionDurationMs.value).toBe(0)
  })
})

describe('useClipEditorViewport — base scale', () => {
  it('source mode opens at the timeline px/s scale', () => {
    const vp = makeVp({ editorItem: makeItem(), editsExistingClip: false, uiZoomPxPerSecond: 120 })
    vp.canvasCssWidth.value = 1000
    expect(vp.basePxPerMs.value).toBeCloseTo(0.12)
  })

  it('a short saved clip scales to fill the canvas width', () => {
    // 1.5s clip in a 1000px canvas at 100 px/s timeline scale: fit (0.667) > timeline (0.1).
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip({ inMs: 0, durationMs: 1_500 }),
      uiZoomPxPerSecond: 100
    })
    vp.initialiseForItem()
    vp.canvasCssWidth.value = 1000
    expect(vp.basePxPerMs.value).toBeCloseTo(1000 / 1500)
    // Whole clip is visible at zoom 1 (no scroll).
    expect(vp.visibleDurationMs.value).toBeCloseTo(1_500)
    expect(vp.maxScrollMs.value).toBe(0)
  })

  it('a long saved clip opens at the timeline scale and scrolls instead of shrinking', () => {
    // 60s clip in a 1000px canvas at 100 px/s: fit (0.0167) < timeline (0.1) → use timeline.
    const vp = makeVp({
      editorItem: makeLibraryClipItem({ durationMs: 60_000 }),
      editsExistingClip: true,
      timelineClip: makeTimelineClip({ inMs: 0, durationMs: 60_000 }),
      sourceDurationMs: 120_000,
      uiZoomPxPerSecond: 100
    })
    vp.initialiseForItem()
    vp.canvasCssWidth.value = 1000
    expect(vp.basePxPerMs.value).toBeCloseTo(0.1)
    // At zoom 1, a 1000px canvas shows 10s of the 60s clip; the rest scrolls.
    expect(vp.visibleDurationMs.value).toBeCloseTo(10_000)
    expect(vp.maxScrollMs.value).toBeCloseTo(50_000)
  })
})

describe('useClipEditorViewport — zoom math', () => {
  it('clamps zoom into [MIN_ZOOM, MAX_ZOOM]', () => {
    const vp = makeVp({ editorItem: makeItem() })
    vp.canvasCssWidth.value = 1000
    vp.setZoomAnchored(0.1, 5000)
    expect(vp.zoom.value).toBe(MIN_ZOOM)
    vp.setZoomAnchored(10_000, 5000)
    expect(vp.zoom.value).toBe(MAX_ZOOM)
  })

  it('does not produce NaN when canvasCssWidth is 0', () => {
    const vp = makeVp({ editorItem: makeItem() })
    vp.canvasCssWidth.value = 0
    vp.setZoomAnchored(4, 5000)
    expect(vp.zoom.value).toBe(4)
    expect(Number.isFinite(vp.scrollMs.value)).toBe(true)
  })

  it('anchors the zoom around the supplied ms so the anchor stays under the cursor', () => {
    const vp = makeVp({ editorItem: makeItem(), sourceDurationMs: 10_000, uiZoomPxPerSecond: 100 })
    vp.canvasCssWidth.value = 1000
    // pre: visible = 10s, anchor at 5s sits at the centre (fraction 0.5).
    vp.setZoomAnchored(2, 5000)
    expect(vp.zoom.value).toBe(2)
    // visible duration halves → 5s; anchor stays at 0.5 → left edge = 5 - 2.5 = 2.5s.
    expect(vp.visibleDurationMs.value).toBeCloseTo(5_000)
    expect(vp.scrollMs.value).toBeCloseTo(2_500, 0)
  })

  it('resetZoom resets both zoom and scroll', () => {
    const vp = makeVp({ editorItem: makeItem() })
    vp.canvasCssWidth.value = 1000
    vp.setZoomAnchored(4, 5000)
    vp.scrollMs.value = 1234
    vp.resetZoom()
    expect(vp.zoom.value).toBe(1)
    expect(vp.scrollMs.value).toBe(0)
  })

  it('zoomIn / zoomOut step around the current visible centre', () => {
    const vp = makeVp({ editorItem: makeItem() })
    vp.canvasCssWidth.value = 1000
    vp.zoomIn()
    expect(vp.zoom.value).toBeCloseTo(1.5)
    vp.zoomOut()
    expect(vp.zoom.value).toBeCloseTo(1)
  })
})

describe('useClipEditorViewport — scroll clamping', () => {
  it('clamps scrollMs back when the view duration shrinks after a crop', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip(),
      sourceDurationMs: 10_000
    })
    vp.initialiseForItem()
    vp.canvasCssWidth.value = 1000
    vp.viewExpanded.value = true
    vp.setZoomAnchored(4, 5000)
    expect(vp.scrollMs.value).toBeGreaterThan(0)
    // Collapse back to a small cropped view — scroll must clamp.
    vp.viewExpanded.value = false
    vp.cropViewInMs.value = 0
    vp.cropViewDurationMs.value = 500
    expect(vp.scrollMs.value).toBeLessThanOrEqual(vp.maxScrollMs.value)
  })
})

describe('useClipEditorViewport — selection / playback range', () => {
  it('hasPlaybackSelection is false when the selection equals the full view', () => {
    const vp = makeVp({ editorItem: makeItem(), sourceDurationMs: 5_000 })
    vp.selectionInMs.value = 0
    vp.selectionDurationMs.value = 5_000
    expect(vp.hasPlaybackSelection.value).toBe(false)
    expect(vp.playbackStartMs.value).toBe(0)
    expect(vp.playbackEndMs.value).toBe(5_000)
  })

  it('playback range narrows when the selection is strictly inside the view', () => {
    const vp = makeVp({ editorItem: makeItem(), sourceDurationMs: 5_000 })
    vp.selectionInMs.value = 1_000
    vp.selectionDurationMs.value = 2_000
    expect(vp.hasPlaybackSelection.value).toBe(true)
    expect(vp.playbackStartMs.value).toBe(1_000)
    expect(vp.playbackEndMs.value).toBe(3_000)
  })
})

describe('useClipEditorViewport — crop snapshot + viewExpanded transitions', () => {
  it('snapCropViewToSelection moves the cropped view to the current selection', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip()
    })
    vp.initialiseForItem()
    vp.selectionInMs.value = 200
    vp.selectionDurationMs.value = 800
    vp.snapCropViewToSelection()
    expect(vp.cropViewInMs.value).toBe(200)
    expect(vp.cropViewDurationMs.value).toBe(800)
  })

  it('snapCropViewToSelection is a no-op when the selection has been cleared', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip()
    })
    vp.initialiseForItem()
    const beforeIn = vp.cropViewInMs.value
    const beforeDur = vp.cropViewDurationMs.value
    vp.selectionDurationMs.value = 0
    vp.snapCropViewToSelection()
    expect(vp.cropViewInMs.value).toBe(beforeIn)
    expect(vp.cropViewDurationMs.value).toBe(beforeDur)
  })

  it('captureCropSnapshot / restoreCropSnapshot round-trips view and selection', () => {
    const vp = makeVp({
      editorItem: makeLibraryClipItem(),
      editsExistingClip: true,
      timelineClip: makeTimelineClip()
    })
    vp.initialiseForItem()
    const snap = vp.captureCropSnapshot()
    vp.cropViewInMs.value = 5_000
    vp.cropViewDurationMs.value = 100
    vp.selectionInMs.value = 5_000
    vp.selectionDurationMs.value = 100
    vp.zoom.value = 5
    vp.scrollMs.value = 80
    vp.restoreCropSnapshot(snap)
    expect(vp.cropViewInMs.value).toBe(snap.cropViewInMs)
    expect(vp.cropViewDurationMs.value).toBe(snap.cropViewDurationMs)
    expect(vp.selectionInMs.value).toBe(snap.selectionInMs)
    expect(vp.selectionDurationMs.value).toBe(snap.selectionDurationMs)
    // restoreCropSnapshot also resets zoom.
    expect(vp.zoom.value).toBe(1)
    expect(vp.scrollMs.value).toBe(0)
  })
})
