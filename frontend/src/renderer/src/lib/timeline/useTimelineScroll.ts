// Scroll state + derived scrollbar geometry for the timeline.
//
// The PixiJS canvas itself stays at the viewport size; we just translate
// what we draw inside it. The HTML scrollbar thumbs bind to the values
// returned here for thumb width / position and visible/hidden state.
// `clampScroll()` is exposed so the host component can re-pin the scroll
// after content changes (track add/remove, zoom, resize) and skip a
// redraw when nothing actually moved.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH
} from './constants'

export interface TimelineScroll {
  // ─── Raw scroll offsets (writable) ────────────────────────────────────
  scrollX: Ref<number>
  scrollY: Ref<number>
  // ─── Viewport size (written by usePixiApp on resize) ──────────────────
  viewportWidth: Ref<number>
  viewportHeight: Ref<number>
  // ─── Horizontal scrollbar geometry ────────────────────────────────────
  trackAreaWidth: ComputedRef<number>
  maxScrollX: ComputedRef<number>
  showScrollbar: ComputedRef<boolean>
  thumbWidthPx: ComputedRef<number>
  thumbLeftPx: ComputedRef<number>
  // ─── Vertical scrollbar geometry ──────────────────────────────────────
  tracksContentHeight: ComputedRef<number>
  trackAreaHeight: ComputedRef<number>
  vLaneHeight: ComputedRef<number>
  maxScrollY: ComputedRef<number>
  vThumbHeightPx: ComputedRef<number>
  vThumbTopPx: ComputedRef<number>
  /** Clamp `scrollX/Y` to valid range. Returns true iff anything changed. */
  clampScroll: () => boolean
}

export interface TimelineScrollOptions {
  /** Total horizontal content width past the header column. */
  contentPx: ComputedRef<number>
  /** Reactive width of the (user-resizable) track-header column. */
  headerWidthRef: ComputedRef<number>
  /** Total stacked height of all track rows (incl. inter-row gaps).
   *  Per-track heights live in `project.tracks[*].heightPx`, so the
   *  host passes a pre-computed reactive total rather than a row count
   *  — otherwise this composable would have to know about the project
   *  store. */
  tracksContentHeightPx: ComputedRef<number>
}

export function useTimelineScroll(opts: TimelineScrollOptions): TimelineScroll {
  const { contentPx, headerWidthRef, tracksContentHeightPx } = opts

  const scrollX = ref(0)
  const scrollY = ref(0)
  const viewportWidth = ref(0)
  const viewportHeight = ref(0)

  // Width of the scrollable lane: excludes the fixed header column AND
  // the permanently-reserved vertical scrollbar lane on the right.
  const trackAreaWidth = computed(() =>
    Math.max(0, viewportWidth.value - headerWidthRef.value - SCROLLBAR_WIDTH)
  )
  const maxScrollX = computed(() => Math.max(0, contentPx.value - trackAreaWidth.value))
  const showScrollbar = computed(() => maxScrollX.value > 0)
  const thumbWidthPx = computed(() => {
    if (!showScrollbar.value || contentPx.value === 0) return 0
    const ratio = trackAreaWidth.value / contentPx.value
    return Math.max(24, trackAreaWidth.value * ratio)
  })
  const thumbLeftPx = computed(() => {
    if (!showScrollbar.value) return 0
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return 0
    return (scrollX.value / maxScrollX.value) * travel
  })

  // Pixel height of all track rows stacked vertically (excludes the ruler row).
  const tracksContentHeight = computed(() => tracksContentHeightPx.value)
  // Visible height available for track rows: full host minus ruler minus
  // horizontal scrollbar lane (only when shown).
  const trackAreaHeight = computed(() => {
    const reservedBottom = showScrollbar.value ? SCROLLBAR_HEIGHT : 0
    return Math.max(0, viewportHeight.value - RULER_HEIGHT - reservedBottom)
  })
  // Visible length of the vertical scrollbar lane itself. Spans the full
  // canvas height (over the ruler row and over the horizontal-scrollbar
  // lane) so the thumb reads as a global "where am I" indicator.
  const vLaneHeight = computed(() => viewportHeight.value)
  const maxScrollY = computed(() => Math.max(0, tracksContentHeight.value - trackAreaHeight.value))
  const vThumbHeightPx = computed(() => {
    if (vLaneHeight.value === 0) return 0
    if (tracksContentHeight.value <= trackAreaHeight.value || trackAreaHeight.value === 0) {
      // Content fits (or there's no track area at all) — thumb fills the
      // whole lane so the scrollbar reads as "at rest".
      return vLaneHeight.value
    }
    const ratio = trackAreaHeight.value / tracksContentHeight.value
    return Math.max(24, vLaneHeight.value * ratio)
  })
  const vThumbTopPx = computed(() => {
    if (maxScrollY.value === 0) return 0
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return 0
    return (scrollY.value / maxScrollY.value) * travel
  })

  function clampScroll(): boolean {
    let changed = false
    const clampedX = Math.min(maxScrollX.value, Math.max(0, scrollX.value))
    if (clampedX !== scrollX.value) {
      scrollX.value = clampedX
      changed = true
    }
    const clampedY = Math.min(maxScrollY.value, Math.max(0, scrollY.value))
    if (clampedY !== scrollY.value) {
      scrollY.value = clampedY
      changed = true
    }
    return changed
  }

  return {
    scrollX,
    scrollY,
    viewportWidth,
    viewportHeight,
    trackAreaWidth,
    maxScrollX,
    showScrollbar,
    thumbWidthPx,
    thumbLeftPx,
    tracksContentHeight,
    trackAreaHeight,
    vLaneHeight,
    maxScrollY,
    vThumbHeightPx,
    vThumbTopPx,
    clampScroll
  }
}
