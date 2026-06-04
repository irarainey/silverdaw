// Timeline zoom control, extracted from TimelineView.vue. Owns both zoom
// entry points and their shared "re-pin the anchor time under a fixed screen
// pixel after the zoom" math:
//   - applyZoomRequest — keyboard shortcut / View-menu request; anchors on the
//     playhead when visible, otherwise the viewport centre.
//   - onWheel          — Ctrl-free wheel = zoom anchored under the pointer;
//     horizontal / Shift-wheel = horizontal pan.
// The SFC keeps the watch that forwards `ui.timelineZoomRequest` here.
import type { Ref } from 'vue'
import type { TimelineZoomRequest } from '@/stores/uiStore'
import {
  DEFAULT_PX_PER_SECOND,
  SCROLLBAR_WIDTH,
  ZOOM_STEP_PX_PER_SECOND
} from '@/lib/timeline/constants'

export interface TimelineZoomDeps {
  // PixiJS renderer screen width, or null when the app isn't ready.
  getScreenWidth: () => number | null
  // Host element bounding rect, or null when the canvas isn't mounted.
  getHostRect: () => DOMRect | null
  headerWidth: () => number
  pxPerSecond: () => number
  // Horizontal scroll offset — read and written during a re-pin.
  scrollX: Ref<number>
  maxScrollX: () => number
  trackAreaWidth: () => number
  // Commits a new zoom and returns the clamped px/sec actually applied.
  setPxPerSecond: (value: number) => number
  getPlayheadPositionMs: () => number
  getTrackCount: () => number
  applyScroll: () => void
  redraw: () => void
  updatePlayhead: () => void
}

export interface TimelineZoom {
  applyZoomRequest: (request: TimelineZoomRequest) => void
  onWheel: (e: WheelEvent) => void
}

export function useTimelineZoom(deps: TimelineZoomDeps): TimelineZoom {
  function applyZoomRequest(request: TimelineZoomRequest): void {
    const prev = deps.pxPerSecond()
    const target =
      request.kind === 'absolute'
        ? request.pxPerSecond
        : request.action === 'reset'
          ? DEFAULT_PX_PER_SECOND
          : prev + (request.action === 'in' ? ZOOM_STEP_PX_PER_SECOND : -ZOOM_STEP_PX_PER_SECOND)
    const next = deps.setPxPerSecond(target)
    if (next === prev) return

    // Anchor on the playhead position (in viewport pixels) when visible,
    // otherwise on the viewport centre. Same re-pin math as the wheel
    // handler: solve for scrollX so the anchor world-time stays at the
    // same on-screen pixel after the zoom.
    const screenWidth = deps.getScreenWidth()
    if (screenWidth === null) return
    const headerWidth = deps.headerWidth()
    const width = screenWidth - SCROLLBAR_WIDTH
    const absPlayheadX = headerWidth + (deps.getPlayheadPositionMs() / 1000) * prev
    const viewportPlayheadX = absPlayheadX - deps.scrollX.value
    const anchorX =
      viewportPlayheadX >= headerWidth && viewportPlayheadX <= width
        ? viewportPlayheadX
        : headerWidth + (width - headerWidth) / 2
    const trackLocalX = anchorX - headerWidth
    const timeAtAnchorSec = (deps.scrollX.value + trackLocalX) / prev
    const newScroll = timeAtAnchorSec * next - trackLocalX
    deps.scrollX.value = Math.max(0, Math.min(deps.maxScrollX(), newScroll))

    deps.redraw()
    deps.updatePlayhead()
  }

  function onWheel(e: WheelEvent): void {
    const hostRect = deps.getHostRect()
    if (!hostRect) return
    e.preventDefault()
    if (deps.getTrackCount() === 0) return

    // Treat as a horizontal pan when the dominant axis is horizontal OR
    // the user is holding Shift. Both branches consume the event so the
    // OS-level scroll bubbling doesn't move the page.
    const absX = Math.abs(e.deltaX)
    const absY = Math.abs(e.deltaY)
    const wantsPan = absX > absY || (e.shiftKey && absY > 0)
    if (wantsPan) {
      // Use deltaX when it's non-zero (trackpad horizontal swipe); fall
      // back to deltaY when Shift was the trigger on a vertical wheel.
      const panBy = absX > 0 ? e.deltaX : e.deltaY
      if (panBy === 0) return
      const next = Math.max(0, Math.min(deps.maxScrollX(), deps.scrollX.value + panBy))
      if (next === deps.scrollX.value) return
      deps.scrollX.value = next
      deps.applyScroll()
      return
    }

    const delta = e.deltaY
    if (delta === 0) return

    const prev = deps.pxPerSecond()
    const next = deps.setPxPerSecond(
      prev + (delta < 0 ? ZOOM_STEP_PX_PER_SECOND : -ZOOM_STEP_PX_PER_SECOND)
    )
    if (next === prev) return

    // Determine the anchor (in track-area-local pixels) and the time it
    // currently sits at, so we can re-pin the same time under the pointer
    // after applying the new zoom.
    const pointerXInHost = e.clientX - hostRect.left
    const trackLocalX = Math.max(0, Math.min(deps.trackAreaWidth(), pointerXInHost - deps.headerWidth()))
    const timeAtAnchorSec = (deps.scrollX.value + trackLocalX) / prev

    // Re-anchor: solve for scrollX so the same time sits at the same
    // pointer-local x. `maxScrollX` is reactive on `pxPerSecond`, so by the
    // time we read it here it reflects the new zoom.
    const newScroll = timeAtAnchorSec * next - trackLocalX
    deps.scrollX.value = Math.max(0, Math.min(deps.maxScrollX(), newScroll))

    deps.redraw()
    deps.updatePlayhead()
  }

  return { applyZoomRequest, onWheel }
}
