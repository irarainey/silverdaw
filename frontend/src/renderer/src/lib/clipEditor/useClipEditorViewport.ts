// Clip Editor viewport, selection, zoom, and scroll state.
// Raw refs stay mutable for dialog gestures; helpers handle multi-field transitions.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'

export interface CropSnapshot {
  cropViewInMs: number
  cropViewDurationMs: number
  selectionInMs: number
  selectionDurationMs: number
}

export interface UseClipEditorViewportInputs {
  /** Library item being edited. */
  editorItem: Ref<LibraryItem | null | undefined> | ComputedRef<LibraryItem | null | undefined>
  /** True for persisted clip or library-clip editing. */
  editsExistingClip: Ref<boolean> | ComputedRef<boolean>
  /** Timeline clip being edited, when present. */
  timelineClip: Ref<Clip | null | undefined> | ComputedRef<Clip | null | undefined>
  /** Full duration of the underlying source file. */
  sourceDurationMs: Ref<number> | ComputedRef<number>
  /** Timeline px/s base scale so full-source zoom=1 matches the timeline. */
  uiZoomPxPerSecond: Ref<number> | ComputedRef<number>
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 64

export interface ClipEditorViewport {
  // View toggle (cropped clip view vs full source).
  viewExpanded: Ref<boolean>

  // Cropped working view for existing clips and saved clips.
  cropViewInMs: Ref<number>
  cropViewDurationMs: Ref<number>

  // Selection inside [viewInMs, viewEndMs].
  selectionInMs: Ref<number>
  selectionDurationMs: Ref<number>

  // Zoom / scroll / canvas measurement.
  zoom: Ref<number>
  scrollMs: Ref<number>
  canvasCssWidth: Ref<number>

  // Derived view bounds.
  viewInMs: ComputedRef<number>
  viewDurationMs: ComputedRef<number>
  viewEndMs: ComputedRef<number>

  // Derived scroll/zoom geometry.
  basePxPerMs: ComputedRef<number>
  visibleDurationMs: ComputedRef<number>
  maxScrollMs: ComputedRef<number>
  visibleInMs: ComputedRef<number>
  visibleEndMs: ComputedRef<number>
  zoomPercent: ComputedRef<number>

  // Derived selection.
  selectionEndMs: ComputedRef<number>
  hasPlaybackSelection: ComputedRef<boolean>
  playbackStartMs: ComputedRef<number>
  playbackEndMs: ComputedRef<number>

  // Helpers.
  resetZoom(): void
  resetZoomAndScroll(): void
  setZoomAnchored(nextZoom: number, anchorMs: number): void
  zoomIn(): void
  zoomOut(): void
  zoomToFit(): void

  // Multi-field transitions.
  initialiseForItem(): void
  snapCropViewToSelection(): void
  captureCropSnapshot(): CropSnapshot
  restoreCropSnapshot(snap: CropSnapshot): void
}

export function useClipEditorViewport(inputs: UseClipEditorViewportInputs): ClipEditorViewport {
  const { editorItem, editsExistingClip, timelineClip, sourceDurationMs, uiZoomPxPerSecond } = inputs

  const viewExpanded = ref(false)
  const cropViewInMs = ref(0)
  const cropViewDurationMs = ref(0)

  const selectionInMs = ref(0)
  const selectionDurationMs = ref(0)

  const zoom = ref(1)
  const scrollMs = ref(0)
  const canvasCssWidth = ref(0)

  const viewInMs = computed(() => {
    if (!editorItem.value) return 0
    if (!viewExpanded.value) return cropViewInMs.value
    return 0
  })
  const viewDurationMs = computed(() => {
    if (!editorItem.value) return 0
    if (!viewExpanded.value) {
      return cropViewDurationMs.value
    }
    return sourceDurationMs.value
  })
  const viewEndMs = computed(() => viewInMs.value + viewDurationMs.value)

  const basePxPerMs = computed(() => {
    if (!editorItem.value) return 0
    // Timeline px/s so a clip opens at the same scale the user sees on the track.
    const timelinePxPerMs = Math.max(0.001, (uiZoomPxPerSecond.value || 100) / 1000)
    // Fit the current (cropped) range to the canvas, but never zoom out past the
    // timeline scale: a short range fills the width, while a long range opens at
    // track-view scale and scrolls instead of being shrunk to fit. Applies to both
    // editable clips and the source preview so Trim narrows the view identically.
    const w = canvasCssWidth.value
    const dur = viewDurationMs.value
    const fitPxPerMs = w > 0 && dur > 0 ? w / dur : 0
    return Math.max(fitPxPerMs, timelinePxPerMs)
  })

  const visibleDurationMs = computed(() => {
    const w = canvasCssWidth.value
    const px = basePxPerMs.value
    const fullDur = viewDurationMs.value
    if (w <= 0 || px <= 0 || fullDur <= 0) return fullDur
    const dur = w / (px * zoom.value)
    return Math.min(fullDur, dur)
  })
  const maxScrollMs = computed(() => Math.max(0, viewDurationMs.value - visibleDurationMs.value))
  const visibleInMs = computed(
    () => viewInMs.value + Math.min(maxScrollMs.value, Math.max(0, scrollMs.value))
  )
  const visibleEndMs = computed(() => visibleInMs.value + visibleDurationMs.value)
  const zoomPercent = computed(() => Math.round(zoom.value * 100))

  const selectionEndMs = computed(() => selectionInMs.value + selectionDurationMs.value)
  const hasPlaybackSelection = computed(() => {
    if (selectionDurationMs.value <= 0) return false
    return (
      selectionInMs.value > viewInMs.value + 0.5 ||
      selectionEndMs.value < viewEndMs.value - 0.5
    )
  })
  const playbackStartMs = computed(() =>
    hasPlaybackSelection.value ? selectionInMs.value : viewInMs.value
  )
  const playbackEndMs = computed(() =>
    hasPlaybackSelection.value ? selectionEndMs.value : viewEndMs.value
  )

  // Clamp scroll synchronously when view bounds or zoom shrink.
  watch(
    maxScrollMs,
    (next) => {
      if (scrollMs.value > next) scrollMs.value = Math.max(0, next)
      else if (scrollMs.value < 0) scrollMs.value = 0
    },
    { flush: 'sync' }
  )

  function resetZoom(): void {
    zoom.value = 1
    scrollMs.value = 0
  }

  function resetZoomAndScroll(): void {
    resetZoom()
    scrollMs.value = 0
  }

  function setZoomAnchored(nextZoom: number, anchorMs: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
    if (z === zoom.value) return
    const w = canvasCssWidth.value
    const px = basePxPerMs.value
    const fullDur = viewDurationMs.value
    if (w <= 0 || px <= 0 || fullDur <= 0) {
      zoom.value = z
      return
    }
    const prevVisibleDur = Math.min(fullDur, w / (px * zoom.value))
    const anchorFrac = prevVisibleDur > 0
      ? (anchorMs - visibleInMs.value) / prevVisibleDur
      : 0.5
    zoom.value = z
    const newVisibleDur = Math.min(fullDur, w / (px * z))
    const newLeftMs = (anchorMs - viewInMs.value) - anchorFrac * newVisibleDur
    const maxScroll = Math.max(0, fullDur - newVisibleDur)
    scrollMs.value = Math.max(0, Math.min(maxScroll, newLeftMs))
  }

  function zoomIn(): void {
    const center = visibleInMs.value + visibleDurationMs.value / 2
    setZoomAnchored(zoom.value * 1.5, center)
  }
  function zoomOut(): void {
    const center = visibleInMs.value + visibleDurationMs.value / 2
    setZoomAnchored(zoom.value / 1.5, center)
  }

  // Fit the entire working view (cropped clip or full source) into the canvas
  // width and scroll to the start. Unlike the +/- controls — which never zoom
  // out past the timeline scale so a long range opens at track-view scale and
  // scrolls — an explicit fit is allowed to drop the effective scale below that
  // floor so the whole clip / source can be seen end-to-end. Clip-edit and
  // source-preview dialogs share this so both behave identically.
  function zoomToFit(): void {
    scrollMs.value = 0
    const w = canvasCssWidth.value
    const px = basePxPerMs.value
    const fullDur = viewDurationMs.value
    if (w <= 0 || px <= 0 || fullDur <= 0) {
      zoom.value = MIN_ZOOM
      return
    }
    // Zoom that makes the visible window span the whole view: w / (px·zoom) = fullDur.
    zoom.value = Math.min(MAX_ZOOM, w / (px * fullDur))
  }

  function initialiseForItem(): void {
    const entry = editorItem.value
    if (!entry) {
      selectionInMs.value = 0
      selectionDurationMs.value = 0
      cropViewInMs.value = 0
      cropViewDurationMs.value = 0
      return
    }
    const clip = timelineClip.value
    if (editsExistingClip.value) {
      const persistedIn = clip?.inMs ?? entry.derivedFrom?.inMs ?? 0
      const persistedDur = clip?.durationMs ?? entry.derivedFrom?.durationMs ?? entry.durationMs
      cropViewInMs.value = persistedIn
      cropViewDurationMs.value = persistedDur
      selectionInMs.value = persistedIn
      selectionDurationMs.value = persistedDur
    } else {
      cropViewInMs.value = 0
      cropViewDurationMs.value = sourceDurationMs.value
      selectionInMs.value = 0
      selectionDurationMs.value = 0
    }
  }

  function snapCropViewToSelection(): void {
    if (selectionDurationMs.value <= 0) return
    cropViewInMs.value = Math.max(0, selectionInMs.value)
    cropViewDurationMs.value = Math.max(0, selectionDurationMs.value)
  }

  function captureCropSnapshot(): CropSnapshot {
    return {
      cropViewInMs: cropViewInMs.value,
      cropViewDurationMs: cropViewDurationMs.value,
      selectionInMs: selectionInMs.value,
      selectionDurationMs: selectionDurationMs.value
    }
  }

  function restoreCropSnapshot(snap: CropSnapshot): void {
    cropViewInMs.value = snap.cropViewInMs
    cropViewDurationMs.value = snap.cropViewDurationMs
    selectionInMs.value = snap.selectionInMs
    selectionDurationMs.value = snap.selectionDurationMs
    resetZoom()
  }

  return {
    viewExpanded,
    cropViewInMs,
    cropViewDurationMs,
    selectionInMs,
    selectionDurationMs,
    zoom,
    scrollMs,
    canvasCssWidth,
    viewInMs,
    viewDurationMs,
    viewEndMs,
    basePxPerMs,
    visibleDurationMs,
    maxScrollMs,
    visibleInMs,
    visibleEndMs,
    zoomPercent,
    selectionEndMs,
    hasPlaybackSelection,
    playbackStartMs,
    playbackEndMs,
    resetZoom,
    resetZoomAndScroll,
    setZoomAnchored,
    zoomIn,
    zoomOut,
    zoomToFit,
    initialiseForItem,
    snapCropViewToSelection,
    captureCropSnapshot,
    restoreCropSnapshot
  }
}
