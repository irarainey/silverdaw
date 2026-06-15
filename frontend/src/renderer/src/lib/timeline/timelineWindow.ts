// Horizontal virtualization geometry shared by the timeline grid, ruler ticks,
// clip columns, and the scroll-driven rebuild trigger.
//
// Building only the visible viewport plus a fixed fraction of overscan each side
// keeps redraw cost tied to the viewport width instead of project-duration ×
// zoom. The rebuild threshold then lets horizontal scroll and playback
// auto-follow translate the already-built band (an O(1) layer move) until it has
// consumed enough overscan to need re-centring — so most scroll frames do no
// scene rebuild at all, which is what keeps panning and playback jitter-free.

/** Overscan built each side of the viewport, as a fraction of viewport width. */
export const OVERSCAN_FRACTION = 0.5
/** Rebuild once horizontal scroll has consumed this fraction of the overscan. */
export const REBUILD_OVERSCAN_FRACTION = 0.5

/** Overscan in pixels for a given viewport width (never negative). */
export function horizontalOverscanPx(viewWidth: number): number {
  return Math.round(Math.max(0, viewWidth) * OVERSCAN_FRACTION)
}

/**
 * True when the world band built at `lastBuiltScrollX` no longer safely covers
 * the viewport at `scrollX` and must be rebuilt. A NaN `lastBuiltScrollX` (never
 * built) always needs a rebuild.
 */
export function exceedsRebuildThreshold(
  scrollX: number,
  lastBuiltScrollX: number,
  viewWidth: number
): boolean {
  if (Number.isNaN(lastBuiltScrollX)) return true
  const threshold = horizontalOverscanPx(viewWidth) * REBUILD_OVERSCAN_FRACTION
  return Math.abs(scrollX - lastBuiltScrollX) >= threshold
}

/**
 * Inclusive `[first, last]` subdivision indices whose world X falls within the
 * viewport-plus-overscan band, clamped to `[0, lastSub]`. Subdivision `s` sits
 * at world X `originX + s * pxPerSub`, and the layer is translated by `-scrollX`,
 * so a sub is visible when `scrollX <= s * pxPerSub <= scrollX + viewWidth`.
 * Returns an empty range (`last < first`) when there is nothing to draw.
 */
export function visibleSubRange(
  scrollX: number,
  viewWidth: number,
  pxPerSub: number,
  lastSub: number
): { first: number; last: number } {
  if (!(pxPerSub > 0) || lastSub < 0) return { first: 0, last: -1 }
  const overscan = horizontalOverscanPx(viewWidth)
  const first = Math.max(0, Math.floor((scrollX - overscan) / pxPerSub))
  const last = Math.min(lastSub, Math.ceil((scrollX + viewWidth + overscan) / pxPerSub))
  return { first, last }
}
