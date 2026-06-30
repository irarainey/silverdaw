// Pure geometry for the on-waveform loop-slice marker overlay.
//
// Slice markers are vertical lines at source-absolute ms positions, so the
// mapping is 1-D: source ms ↔ canvas x, plus a nearest-marker hit test. The
// viewport supplies `visibleInMs` (the source ms at x=0) and `pxPerMs` (the
// effective scale, base × zoom). Kept separate from the 2-D Volume Shape overlay
// because markers carry no vertical/gain dimension.

/** Source-file ms → canvas x (CSS px) for the current viewport. */
export function sliceSourceMsToX(sourceMs: number, visibleInMs: number, pxPerMs: number): number {
  return (sourceMs - visibleInMs) * pxPerMs
}

/** Canvas x (CSS px) → source-file ms for the current viewport. */
export function sliceXToSourceMs(x: number, visibleInMs: number, pxPerMs: number): number {
  const px = pxPerMs > 0 ? pxPerMs : 1
  return visibleInMs + x / px
}

/**
 * Index of the marker whose screen x is nearest `px` within `hitRadiusPx`, or
 * `null`. `markerXs` are precomputed marker x positions (CSS px); ties pick the
 * closest. A 1-D analogue of the Volume Shape `hitTestHandle`.
 */
export function hitTestSliceMarker(
  markerXs: readonly number[],
  px: number,
  hitRadiusPx: number
): number | null {
  let best: number | null = null
  let bestD = hitRadiusPx
  for (let i = 0; i < markerXs.length; i++) {
    const mx = markerXs[i]
    if (mx === undefined) continue
    const d = Math.abs(mx - px)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
