// Pure coordinate mapping helpers for the Scratch Notation Editor SVG.
// Maps between pointer/client coordinates, SVG viewBox coordinates, and
// domain values (timeUs, turns, crossfader value).

export interface NotationLayout {
  platterLaneHeight: number
  cfLaneHeight: number
  paddingX: number
  cfLaneTop: number
  turnsMargin: number
}

export const DEFAULT_NOTATION_LAYOUT: NotationLayout = {
  platterLaneHeight: 120,
  cfLaneHeight: 60,
  paddingX: 24,
  cfLaneTop: 132, // platterLaneHeight + 12
  turnsMargin: 8
}

/**
 * Map a client pointer event to SVG-local coordinates using the SVG element's
 * bounding rect and viewBox dimensions. This ensures coordinates are accurate
 * regardless of CSS transforms, scroll, or parent offsets.
 */
export function clientToSvgCoordinates(
  clientX: number,
  clientY: number,
  svgRect: DOMRect,
  viewBoxWidth: number,
  viewBoxHeight: number
): { x: number; y: number } {
  const relX = clientX - svgRect.left
  const relY = clientY - svgRect.top
  const scaleX = viewBoxWidth / svgRect.width
  const scaleY = viewBoxHeight / svgRect.height
  return {
    x: relX * scaleX,
    y: relY * scaleY
  }
}

/** Convert a time value in microseconds to an X coordinate in the SVG. */
export function timeToX(
  timeUs: number,
  durationUs: number,
  contentWidth: number,
  paddingX: number
): number {
  if (durationUs <= 0) return paddingX
  return paddingX + (timeUs / durationUs) * contentWidth
}

/** Convert an X coordinate in the SVG to a time value in microseconds. */
export function xToTime(
  x: number,
  durationUs: number,
  contentWidth: number,
  paddingX: number
): number {
  const rel = (x - paddingX) / contentWidth
  return Math.round(Math.max(0, Math.min(durationUs, rel * durationUs)))
}

/** Map platter turns to a Y coordinate within the platter lane. */
export function turnsToY(
  turns: number,
  minTurns: number,
  maxTurns: number,
  laneHeight: number,
  margin: number
): number {
  const range = maxTurns - minTurns || 1
  return margin + ((maxTurns - turns) / range) * (laneHeight - margin * 2)
}

/** Map a Y coordinate within the platter lane to platter turns. */
export function yToTurns(
  y: number,
  minTurns: number,
  maxTurns: number,
  laneHeight: number,
  margin: number
): number {
  const range = maxTurns - minTurns || 1
  return maxTurns - ((y - margin) / (laneHeight - margin * 2)) * range
}

/** Map a crossfader value [0,1] to a Y coordinate within the CF lane. */
export function cfValueToY(value: number, cfLaneTop: number, cfLaneHeight: number): number {
  return cfLaneTop + (1 - value) * (cfLaneHeight - 8)
}

/** Map a Y coordinate within the CF lane to a crossfader value [0,1]. */
export function yToCfValue(y: number, cfLaneTop: number, cfLaneHeight: number): number {
  return Math.max(0, Math.min(1, 1 - (y - cfLaneTop) / (cfLaneHeight - 8)))
}
