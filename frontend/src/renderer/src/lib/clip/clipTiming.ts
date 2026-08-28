// Pure clip timeline-geometry helpers, extracted from the project store so the
// geometry logic is independently testable and the store stays focused on
// state + actions. Uses only local structural types (no import from the store)
// so there is no module cycle; the store re-exports the `effective*` helpers as
// a stable facade for existing importers.

/** Sub-millisecond tolerance for clip-fit/overlap tests. Clip durations are
 *  derived from sample counts while drag/snap positions come from the BPM grid,
 *  so an "exact-size" gap can be off by a fraction of a millisecond. Anything
 *  within this tolerance is treated as a perfect fit rather than an overlap
 *  (1 ms ≈ 44 samples at 44.1 kHz — imperceptible and far below any usable gap). */
export const CLIP_FIT_EPSILON_MS = 1

/** A clip's warp-scaled timeline footprint, in ms. Prefers the backend-derived
 *  `effectiveDurationMs` (set when a tempo warp is active) and falls back to
 *  the raw source `durationMs` for un-warped clips. */
export function effectiveClipDurationMs(clip: {
  durationMs: number
  effectiveDurationMs?: number
}): number {
  return typeof clip.effectiveDurationMs === 'number' && clip.effectiveDurationMs > 0
    ? clip.effectiveDurationMs
    : clip.durationMs
}

/** The clip's effective tempo ratio (`source / timeline`), defaulting to 1 for
 *  un-warped clips or a non-positive/absent value. */
export function effectiveClipTempoRatio(clip: { effectiveTempoRatio?: number }): number {
  return typeof clip.effectiveTempoRatio === 'number' && clip.effectiveTempoRatio > 0
    ? clip.effectiveTempoRatio
    : 1
}

/** True when a tempo warp is actively reshaping the clip's timeline footprint. */
export function isClipTempoWarpActive(clip: { effectiveWarpActive?: boolean }): boolean {
  return clip.effectiveWarpActive === true
}

/**
 * Convert a timeline-time delta to the source-time delta it covers, and back.
 *
 * A warped clip keeps `inMs` / `durationMs` in SOURCE time while every gesture arrives
 * in TIMELINE time, so edits have to cross the ratio — and the pair must stay exact
 * inverses. Trim used to round each direction to whole milliseconds independently,
 * which broke that: `inMs` advanced by the rounded source delta while `startMs` advanced
 * by a separately rounded timeline delta, so the audio slid under the clip by up to
 * 0.5 ms per gesture and a snapped edge never quite landed on the line it snapped to.
 * Rounding also cannot represent a musical length at all — one beat of a 105.8 BPM
 * source is 567.0852 ms — so a clip trimmed to a beat came out a fraction long and every
 * duplicate of it walked further off the grid. These carry no rounding: the fields are
 * doubles all the way to the engine, which quantises to samples once, at the end.
 */
export function sourceDeltaMsFromTimeline(timelineDeltaMs: number, ratio: number): number {
  return ratio > 0 ? timelineDeltaMs * ratio : timelineDeltaMs
}

/** Timeline-time delta for a source-time delta at `ratio`. Inverse of the above. */
export function timelineDeltaMsFromSource(sourceDeltaMs: number, ratio: number): number {
  return ratio > 0 ? sourceDeltaMs / ratio : sourceDeltaMs
}

/** Minimal clip shape `findClipSlot` needs — the store's full `Clip` is
 *  structurally compatible. */
export interface ClipSlotInput {
  startMs: number
  durationMs: number
  effectiveDurationMs?: number
}

/** Minimal track shape `findClipSlot` needs. */
export interface TrackSlotInput {
  id: string
  clipIds: string[]
}

/**
 * Return the position closest to `desiredStartMs` on `trackId` where a clip of
 * `durationMs` fits without overlapping any existing clip (excluding the one
 * identified by `excludeClipId`, which is the dragged clip itself). The track
 * timeline is decomposed into free gaps; for each gap that can hold the clip we
 * compute the closest valid `startMs` and keep the best one overall.
 *
 * Picks the gap whose closest-valid position is nearest the desired one — this
 * yields "bump against the neighbour" behaviour during drag (the clip slides up
 * against the wall and stays there as long as the cursor pushes that way),
 * while still letting the user move the clip to a different gap by dragging the
 * cursor decisively past the obstruction. Returns `null` if no gap is big
 * enough.
 */
export function findClipSlot(
  state: { tracks: readonly TrackSlotInput[]; clips: Record<string, ClipSlotInput> },
  trackId: string,
  excludeClipId: string,
  desiredStartMs: number,
  durationMs: number,
  resolveDurationMs?: (clip: ClipSlotInput) => number
): number | null {
  const track = state.tracks.find((t) => t.id === trackId)
  if (!track) return null
  // Collect occupied intervals (excluding the dragged clip).
  const intervals: { start: number; end: number }[] = []
  for (const id of track.clipIds) {
    if (id === excludeClipId) continue
    const c = state.clips[id]
    if (!c) continue
    const effectiveDurationMs = resolveDurationMs ? resolveDurationMs(c) : c.durationMs
    intervals.push({ start: c.startMs, end: c.startMs + effectiveDurationMs })
  }
  intervals.sort((a, b) => a.start - b.start)
  // Build complementary "free gaps".
  const gaps: { start: number; end: number }[] = []
  let cursor = 0
  for (const iv of intervals) {
    if (iv.start > cursor) gaps.push({ start: cursor, end: iv.start })
    cursor = Math.max(cursor, iv.end)
  }
  gaps.push({ start: cursor, end: Number.POSITIVE_INFINITY })

  const desired = Math.max(0, desiredStartMs)
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const g of gaps) {
    const gapLen = g.end - g.start
    if (gapLen < durationMs - CLIP_FIT_EPSILON_MS) continue
    const lo = g.start
    const hi =
      g.end === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(lo, g.end - durationMs)
    const candidate = Math.min(Math.max(desired, lo), hi)
    const dist = Math.abs(candidate - desired)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}
