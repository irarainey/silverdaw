// Pure geometry for the on-waveform Volume Shape overlay.
//
// The Clip Editor draws the per-clip gain envelope directly over the
// waveform (rather than in a separate boxed editor) so the user can see
// exactly which part of the audio each breakpoint affects. The maths that
// maps a breakpoint between gain/time and canvas pixels — and the pointer
// hit-testing — lives here, isolated from the canvas so it can be unit
// tested without a DOM.
//
// Two coordinate spaces are involved:
//   • vertical: linear gain ↔ a dB display scale ↔ a y pixel. Unity (0 dB)
//     sits near the top with headroom for boost up to ENVELOPE_MAX_GAIN.
//   • horizontal: clip-local post-warp ms (the basis envelope breakpoints
//     are stored in) ↔ source-file ms (what the waveform canvas draws).

import { ENVELOPE_MAX_GAIN, ENVELOPE_MIN_GAIN } from '@/lib/envelope'

// dB display range for the overlay. +12 dB ≈ the linear ceiling of
// ENVELOPE_MAX_GAIN (≈3.98); -60 dB is the practical silence floor below
// which a dragged handle snaps to true zero.
export const OVERLAY_DB_MAX = 12
export const OVERLAY_DB_MIN = -60

/** Linear gain → clamped dB on the overlay scale. */
export function overlayGainToDb(gain: number): number {
  if (gain <= 0) return OVERLAY_DB_MIN
  return Math.min(OVERLAY_DB_MAX, Math.max(OVERLAY_DB_MIN, 20 * Math.log10(gain)))
}

/** Linear gain → y pixel within the band `[top, top + height]`. The band
 *  top is OVERLAY_DB_MAX (loudest), the bottom is OVERLAY_DB_MIN (silence). */
export function overlayGainToY(gain: number, top: number, height: number): number {
  const db = overlayGainToDb(gain)
  return top + ((OVERLAY_DB_MAX - db) / (OVERLAY_DB_MAX - OVERLAY_DB_MIN)) * height
}

/** y pixel → linear gain. Snaps to true zero near the silence floor so a
 *  handle dragged to the bottom reads as silence, not a tiny residual gain. */
export function overlayYToGain(y: number, top: number, height: number): number {
  const span = OVERLAY_DB_MAX - OVERLAY_DB_MIN
  const db = OVERLAY_DB_MAX - ((y - top) / Math.max(1, height)) * span
  if (db <= OVERLAY_DB_MIN + 0.5) return ENVELOPE_MIN_GAIN
  return Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, Math.pow(10, db / 20)))
}

/** Clip-local post-warp ms → source-file ms within the audible window.
 *  `baseSourceMs` is the source ms of the clip start; `ratio` is the warp
 *  ratio (source ms per timeline ms). */
export function volumeTimeToSourceMs(
  timelineMs: number,
  baseSourceMs: number,
  ratio: number
): number {
  const r = ratio > 0 ? ratio : 1
  return baseSourceMs + timelineMs * r
}

/** Source-file ms → clip-local post-warp ms (inverse of
 *  {@link volumeTimeToSourceMs}). */
export function sourceMsToVolumeTime(
  sourceMs: number,
  baseSourceMs: number,
  ratio: number
): number {
  const r = ratio > 0 ? ratio : 1
  return (sourceMs - baseSourceMs) / r
}

/** Index of the nearest handle within `hitRadius` pixels of `(px, py)`, or
 *  `null` when none is close enough. Ties resolve to the closest. */
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
