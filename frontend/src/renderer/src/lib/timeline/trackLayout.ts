// Per-track vertical layout helpers.
//
// Tracks default to `TRACK_HEIGHT` but each can have its own `heightPx`
// override (driven by the resize handle in TrackHeaderPanel). The helpers
// here are the single source of truth for "where does row N start" and
// "how tall is row N" — every module that needs to position a row or
// hit-test against the vertical track stack imports through here so the
// canvas, headers, drag handlers, drop zones, and scroll geometry stay
// pixel-aligned.

import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT, RULER_HEIGHT, TRACK_GAP, TRACK_HEIGHT } from './constants'

interface TrackLike {
  heightPx?: number
}

/** Effective vertical height of a single track row in CSS pixels. A stored
 *  override is clamped to [MIN_TRACK_HEIGHT, MAX_TRACK_HEIGHT] so legacy or
 *  out-of-range values never render the header controls overlapped. */
export function trackHeightOf(track: TrackLike | undefined | null): number {
  if (!track) return TRACK_HEIGHT
  const h = track.heightPx
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return TRACK_HEIGHT
  return Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, h))
}

/** World-space (i.e. unscrolled) top y of track at `index`, including
 *  the ruler offset and inter-row gaps. Returns `RULER_HEIGHT` for
 *  index 0 or an empty array. */
export function trackTopWorldYAt(tracks: readonly TrackLike[], index: number): number {
  let y = RULER_HEIGHT
  const upTo = Math.min(index, tracks.length)
  for (let i = 0; i < upTo; i++) {
    y += trackHeightOf(tracks[i]) + TRACK_GAP
  }
  return y
}

/** Total content height for the whole stack of tracks: sum of heights
 *  plus inter-row gaps (no gap after the last row). Returns 0 for an
 *  empty array. */
export function tracksContentHeight(tracks: readonly TrackLike[]): number {
  if (tracks.length === 0) return 0
  let total = 0
  for (const t of tracks) total += trackHeightOf(t)
  total += TRACK_GAP * (tracks.length - 1)
  return total
}

/** Pre-computed `{ top, height }` for every row in world space. Cheaper
 *  than calling `trackTopWorldYAt` N times in a drawing pass. */
export function buildTrackRowLayout(
  tracks: readonly TrackLike[]
): { readonly top: number; readonly height: number }[] {
  const rows: { top: number; height: number }[] = []
  let y = RULER_HEIGHT
  for (const t of tracks) {
    const h = trackHeightOf(t)
    rows.push({ top: y, height: h })
    y += h + TRACK_GAP
  }
  return rows
}

/** Find the track row containing the world-space y coordinate `worldY`.
 *  Returns the index, top, and height of that row, or `null` if `worldY`
 *  is in the ruler, in an inter-row gap, or below the last row. */
export function trackIndexAtWorldY(
  tracks: readonly TrackLike[],
  worldY: number
): { index: number; rowTop: number; rowHeight: number } | null {
  if (worldY < RULER_HEIGHT) return null
  let y = RULER_HEIGHT
  for (let i = 0; i < tracks.length; i++) {
    const h = trackHeightOf(tracks[i])
    if (worldY >= y && worldY < y + h) {
      return { index: i, rowTop: y, rowHeight: h }
    }
    y += h + TRACK_GAP
  }
  return null
}
