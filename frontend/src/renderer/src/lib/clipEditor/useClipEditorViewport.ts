// Viewport / selection state for the Clip Editor.
//
// Centralises the view bounds, zoom, scroll, canvas measurement,
// and selection refs along with all the derived geometry the canvas
// draw + mouse handlers need. Owning this state in a composable
// rather than in `ClipEditorDialog.vue` makes the math
// unit-testable and stops the dialog `<script setup>` from being
// the only source of truth.
//
// Design notes:
//
// - Raw refs (`zoom`, `scrollMs`, `selectionInMs`, …) are exposed
//   directly because the dialog mutates them in many places
//   (mouse handlers, keyboard nudges, crop apply/undo). Wrapping
//   every mutation in a setter would balloon the contract without
//   clear safety wins — instead we provide intentful helpers for
//   the multi-field transitions (`initialiseForItem`,
//   `snapCropViewToSelection`, `captureCropSnapshot`,
//   `restoreCropSnapshot`, `resetZoomAndScroll`).
//
// - An internal watcher clamps `scrollMs` whenever any bound that
//   affects `maxScrollMs` changes. This stops stale scroll values
//   from surviving crop or zoom transitions and removes the need
//   for every call site to remember to clamp.
//
// - DOM concerns (canvas element ref, ResizeObserver, draw, mouse
//   handlers) live in the dialog. The composable only takes
//   reactive *inputs* and returns refs + computeds.

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
  /** The library item currently being edited (timeline-clip's source,
   *  saved-clip itself, or the main library entry). Drives the view
   *  bounds when `editsExistingClip` is false (full-source view). */
  editorItem: Ref<LibraryItem | null | undefined> | ComputedRef<LibraryItem | null | undefined>
  /** True when the dialog is editing a persisted clip or a
   *  saved-clip library entry. Toggles the cropped working view. */
  editsExistingClip: Ref<boolean> | ComputedRef<boolean>
  /** The timeline clip being edited (when editing one). Used by
   *  `initialiseForItem` to seed the persisted window. */
  timelineClip: Ref<Clip | null | undefined> | ComputedRef<Clip | null | undefined>
  /** Full duration of the underlying source file. */
  sourceDurationMs: Ref<number> | ComputedRef<number>
  /** The main-timeline's pixels-per-second setting. Used as the
   *  base scale for the full-source view so zoom=1 matches the
   *  timeline. Pass `toRef(ui, 'zoomPxPerSecond')` so the base
   *  scale reactively tracks timeline zoom. */
  uiZoomPxPerSecond: Ref<number> | ComputedRef<number>
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 64

export interface ClipEditorViewport {
  // View toggle (cropped clip view vs full source).
  viewExpanded: Ref<boolean>

  // Cropped working view (saved-clip mode). Snaps to the persisted
  // `derivedFrom` on initialise, updated on `snapCropViewToSelection`,
  // `setCropView`, and `restoreCropSnapshot`.
  cropViewInMs: Ref<number>
  cropViewDurationMs: Ref<number>

  // Selection inside the view. Lives in [viewInMs, viewEndMs].
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
    if (editsExistingClip.value && !viewExpanded.value) return cropViewInMs.value
    return 0
  })
  const viewDurationMs = computed(() => {
    if (!editorItem.value) return 0
    if (editsExistingClip.value && !viewExpanded.value) {
      return cropViewDurationMs.value
    }
    return sourceDurationMs.value
  })
  const viewEndMs = computed(() => viewInMs.value + viewDurationMs.value)

  const basePxPerMs = computed(() => {
    if (!editorItem.value) return 0
    if (!editsExistingClip.value) {
      // Match the timeline's px/s. Fall back to 100 px/s (the default) if
      // we haven't observed a live value yet.
      return Math.max(0.001, (uiZoomPxPerSecond.value || 100) / 1000)
    }
    // saved-clip: fit the cropped range exactly into the canvas.
    const w = canvasCssWidth.value
    const dur = viewDurationMs.value
    return w > 0 && dur > 0 ? w / dur : 0
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

  // Whenever the bounds shift, `scrollMs` may now exceed `maxScrollMs`
  // (e.g. crop view shrinks, zoom drops). Clamp it back in-range so
  // every caller doesn't have to remember. `flush: 'sync'` makes the
  // clamp visible immediately to any synchronous reader (callers and
  // tests that mutate bounds and then read scroll).
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
    initialiseForItem,
    snapCropViewToSelection,
    captureCropSnapshot,
    restoreCropSnapshot
  }
}
