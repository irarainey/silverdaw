// Horizontal edge auto-scroll pressure, shared by clip dragging (pointer-driven) and
// library drag-and-drop (HTML5 dragover). Given a host-local x (pixels from the timeline
// canvas's left), it returns the per-frame `scrollX` delta to apply: negative near the
// left edge, positive near the right, and 0 in the clear middle. Callers decide when
// there is room to scroll and clamp the result to `[0, maxScrollX]`.

/** Horizontal edge zone (px) that triggers auto-scroll while dragging. */
export const EDGE_AUTOSCROLL_ZONE_PX = 72
/** Maximum horizontal auto-scroll speed, in pixels per animation frame. */
export const EDGE_AUTOSCROLL_MAX_PX_PER_FRAME = 42

/**
 * Auto-scroll delta for a host-local x between `leftEdge` (the track area's left, i.e.
 * just right of the header) and `rightEdge` (just left of the scrollbar). Pressure ramps
 * linearly from 0 at the zone's inner boundary to full speed at the edge.
 */
export function edgeAutoScrollDelta(localX: number, leftEdge: number, rightEdge: number): number {
  if (localX < leftEdge + EDGE_AUTOSCROLL_ZONE_PX) {
    const pressure = Math.min(1, (leftEdge + EDGE_AUTOSCROLL_ZONE_PX - localX) / EDGE_AUTOSCROLL_ZONE_PX)
    return -Math.ceil(EDGE_AUTOSCROLL_MAX_PX_PER_FRAME * pressure)
  }
  if (localX > rightEdge - EDGE_AUTOSCROLL_ZONE_PX) {
    const pressure = Math.min(1, (localX - (rightEdge - EDGE_AUTOSCROLL_ZONE_PX)) / EDGE_AUTOSCROLL_ZONE_PX)
    return Math.ceil(EDGE_AUTOSCROLL_MAX_PX_PER_FRAME * pressure)
  }
  return 0
}
