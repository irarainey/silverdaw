// Pure geometry for the on-waveform Volume Shape overlay.
// Vertical uses gain ↔ dB ↔ y; horizontal maps clip-local post-warp ms ↔ source ms.

import { ENVELOPE_MAX_GAIN, ENVELOPE_MIN_GAIN } from '@/lib/envelope'

// Overlay dB range: +12 dB headroom, -60 dB silence floor.
export const OVERLAY_DB_MAX = 12
export const OVERLAY_DB_MIN = -60

/** Linear gain → clamped dB on the overlay scale. */
export function overlayGainToDb(gain: number): number {
  if (gain <= 0) return OVERLAY_DB_MIN
  return Math.min(OVERLAY_DB_MAX, Math.max(OVERLAY_DB_MIN, 20 * Math.log10(gain)))
}

/** Linear gain → y pixel within `[top, top + height]`. */
export function overlayGainToY(gain: number, top: number, height: number): number {
  const db = overlayGainToDb(gain)
  return top + ((OVERLAY_DB_MAX - db) / (OVERLAY_DB_MAX - OVERLAY_DB_MIN)) * height
}

/** y pixel → linear gain, snapping the silence floor to true zero. */
export function overlayYToGain(y: number, top: number, height: number): number {
  const span = OVERLAY_DB_MAX - OVERLAY_DB_MIN
  const db = OVERLAY_DB_MAX - ((y - top) / Math.max(1, height)) * span
  if (db <= OVERLAY_DB_MIN + 0.5) return ENVELOPE_MIN_GAIN
  return Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, Math.pow(10, db / 20)))
}

/** Clip-local post-warp ms → source-file ms. */
export function volumeTimeToSourceMs(
  timelineMs: number,
  baseSourceMs: number,
  ratio: number
): number {
  const r = ratio > 0 ? ratio : 1
  return baseSourceMs + timelineMs * r
}

/** Source-file ms → clip-local post-warp ms. */
export function sourceMsToVolumeTime(
  sourceMs: number,
  baseSourceMs: number,
  ratio: number
): number {
  const r = ratio > 0 ? ratio : 1
  return (sourceMs - baseSourceMs) / r
}

/** Nearest handle within `hitRadius`, or `null`; ties choose the closest. */
export function hitTestHandle(
  positions: readonly { x: number; y: number }[],
  px: number,
  py: number,
  hitRadius: number
): number | null {
  let best: number | null = null
  let bestD = hitRadius * hitRadius
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]
    if (!p) continue
    const dx = p.x - px
    const dy = p.y - py
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** A horizontal band the Volume Shape overlay is drawn into. */
export interface OverlayLane {
  top: number
  height: number
}

/** Envelope bands: one full-height summary lane, or mirrored stereo lanes. */
export function volumeOverlayLanes(top: number, height: number, stereo: boolean): OverlayLane[] {
  if (!stereo) return [{ top, height }]
  const laneH = height / 2
  return [
    { top, height: laneH },
    { top: top + laneH, height: laneH }
  ]
}

/** Lane hit-test; shared seams belong to the lower lane, and out-of-range y clamps. */
export function overlayLaneIndexForY(y: number, lanes: readonly OverlayLane[]): number {
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    if (!lane) continue
    const isLast = i === lanes.length - 1
    if (isLast || y < lane.top + lane.height) return i
  }
  return Math.max(0, lanes.length - 1)
}

/** Map y to gain in the nearest lane so edge drags still clamp to max/min. */
export function overlayYToGainForLanes(y: number, lanes: readonly OverlayLane[]): number {
  const idx = overlayLaneIndexForY(y, lanes)
  const chosen = lanes[idx]
  if (!chosen) return overlayYToGain(y, 0, 1)
  return overlayYToGain(y, chosen.top, chosen.height)
}
