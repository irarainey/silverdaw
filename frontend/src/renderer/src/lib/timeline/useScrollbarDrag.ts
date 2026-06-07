// Pointer-event-driven thumb + track drag handlers for the timeline's custom
// horizontal and vertical scrollbars. Native scrollbars can't give the
// pixel-precise thumb geometry (from `useTimelineScroll`) and dark-chrome
// styling needed here; PointerEvents give one path for mouse/trackpad/touch.
// Extracted from TimelineView.vue, which it shares nothing with.

import type { ComputedRef, Ref } from 'vue'

export interface ScrollbarDragOptions {
  // ─── Horizontal axis ──────────────────────────────────────────────────
  scrollX: Ref<number>
  maxScrollX: ComputedRef<number>
  trackAreaWidth: ComputedRef<number>
  thumbWidthPx: ComputedRef<number>
  showScrollbar: ComputedRef<boolean>
  /**
   * Template-ref to the horizontal scrollbar lane `<div>`. Owned by the
   * host component so the `ref="..."` binding is visible in its script
   * scope; we just read `.value.getBoundingClientRect()` here.
   */
  scrollbarTrack: Ref<HTMLDivElement | null>
  // ─── Vertical axis ────────────────────────────────────────────────────
  scrollY: Ref<number>
  maxScrollY: ComputedRef<number>
  vLaneHeight: ComputedRef<number>
  vThumbHeightPx: ComputedRef<number>
  /** Template-ref to the vertical scrollbar lane `<div>`. See `scrollbarTrack`. */
  vScrollbarTrack: Ref<HTMLDivElement | null>
  /**
   * Fires whenever `scrollX` or `scrollY` was changed by a drag / track
   * click. Lets the host trigger a repaint + playhead update without the
   * composable having to know anything about the scene graph.
   */
  onScroll: () => void
}

export interface ScrollbarDrag {
  // ─── Horizontal thumb / track handlers ────────────────────────────────
  onThumbPointerDown: (e: PointerEvent) => void
  onThumbPointerMove: (e: PointerEvent) => void
  onThumbPointerUp: (e: PointerEvent) => void
  onTrackPointerDown: (e: PointerEvent) => void
  // ─── Vertical thumb / track handlers ──────────────────────────────────
  onVThumbPointerDown: (e: PointerEvent) => void
  onVThumbPointerMove: (e: PointerEvent) => void
  onVThumbPointerUp: (e: PointerEvent) => void
  onVTrackPointerDown: (e: PointerEvent) => void
}

export function useScrollbarDrag(opts: ScrollbarDragOptions): ScrollbarDrag {
  const {
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    trackAreaWidth,
    thumbWidthPx,
    vLaneHeight,
    vThumbHeightPx,
    showScrollbar,
    scrollbarTrack,
    vScrollbarTrack,
    onScroll
  } = opts

  // ─── Horizontal scrollbar ─────────────────────────────────────────────
  let dragStartPointerX = 0
  let dragStartScrollX = 0
  let draggingPointerId: number | null = null

  function onThumbPointerDown(e: PointerEvent): void {
    if (!showScrollbar.value) return
    e.preventDefault()
    draggingPointerId = e.pointerId
    dragStartPointerX = e.clientX
    dragStartScrollX = scrollX.value
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onThumbPointerMove(e: PointerEvent): void {
    if (draggingPointerId !== e.pointerId) return
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return
    const deltaPx = e.clientX - dragStartPointerX
    // Map thumb travel → content travel.
    const scrollDelta = (deltaPx / travel) * maxScrollX.value
    const next = Math.min(maxScrollX.value, Math.max(0, dragStartScrollX + scrollDelta))
    if (next === scrollX.value) return
    scrollX.value = next
    onScroll()
  }

  function onThumbPointerUp(e: PointerEvent): void {
    if (draggingPointerId !== e.pointerId) return
    draggingPointerId = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  /**
   * Click on the scrollbar track (not the thumb) → jump so the thumb is
   * centred under the click. Mirrors native scrollbar behaviour for "page
   * to here".
   */
  function onTrackPointerDown(e: PointerEvent): void {
    if (!showScrollbar.value || !scrollbarTrack.value) return
    const rect = scrollbarTrack.value.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return
    const targetThumbLeft = Math.min(travel, Math.max(0, localX - thumbWidthPx.value / 2))
    const next = (targetThumbLeft / travel) * maxScrollX.value
    if (next === scrollX.value) return
    scrollX.value = next
    onScroll()
  }

  // ─── Vertical scrollbar (mirrors the horizontal axis) ─────────────────
  let vDragStartPointerY = 0
  let vDragStartScrollY = 0
  let vDraggingPointerId: number | null = null

  function onVThumbPointerDown(e: PointerEvent): void {
    if (maxScrollY.value === 0) return
    e.preventDefault()
    vDraggingPointerId = e.pointerId
    vDragStartPointerY = e.clientY
    vDragStartScrollY = scrollY.value
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onVThumbPointerMove(e: PointerEvent): void {
    if (vDraggingPointerId !== e.pointerId) return
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return
    const deltaPx = e.clientY - vDragStartPointerY
    const scrollDelta = (deltaPx / travel) * maxScrollY.value
    const next = Math.min(maxScrollY.value, Math.max(0, vDragStartScrollY + scrollDelta))
    if (next === scrollY.value) return
    scrollY.value = next
    onScroll()
  }

  function onVThumbPointerUp(e: PointerEvent): void {
    if (vDraggingPointerId !== e.pointerId) return
    vDraggingPointerId = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  function onVTrackPointerDown(e: PointerEvent): void {
    if (maxScrollY.value === 0 || !vScrollbarTrack.value) return
    const rect = vScrollbarTrack.value.getBoundingClientRect()
    const localY = e.clientY - rect.top
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return
    const targetThumbTop = Math.min(travel, Math.max(0, localY - vThumbHeightPx.value / 2))
    const next = (targetThumbTop / travel) * maxScrollY.value
    if (next === scrollY.value) return
    scrollY.value = next
    onScroll()
  }

  return {
    onThumbPointerDown,
    onThumbPointerMove,
    onThumbPointerUp,
    onTrackPointerDown,
    onVThumbPointerDown,
    onVThumbPointerMove,
    onVThumbPointerUp,
    onVTrackPointerDown
  }
}
