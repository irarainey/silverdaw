// Loop-slicer slice-point model (v1: grid + manual).
//
// Slice markers are held in SOURCE-ABSOLUTE ms — the Clip Editor's native
// coordinate space — so they stay glued to the audio regardless of warp; the
// timeline commit converts them once (see slice-to-timeline). These helpers are
// pure: marker generation and the shared guard pipeline, with no UI or store
// coupling, so both the grid generator and manual edits enforce identical rules.

/** Musical subdivisions offered for grid slicing (coarse bars → fine notes). */
export type SliceSubdivision = '1 bar' | '1/2 bar' | '1/4' | '1/8' | '1/16' | '1/32'

/**
 * Grid lines per quarter-note beat for each subdivision (4/4 assumed). Bar
 * values use a fraction < 1 (a whole bar spans four beats → 0.25 lines/beat).
 */
export const DIVISIONS_PER_BEAT: Record<SliceSubdivision, number> = {
  '1 bar': 0.25,
  '1/2 bar': 0.5,
  '1/4': 1,
  '1/8': 2,
  '1/16': 4,
  '1/32': 8
}

/** Default smallest allowed slice — avoids zero-length / click-prone fragments. */
export const DEFAULT_MIN_SLICE_MS = 20

/** Hard ceiling on slice count — guards the backend against a runaway fine chop. */
export const MAX_SLICES = 128

export interface SliceGuardOptions {
  /** Smallest allowed gap to a window edge or a neighbour. Defaults to 20 ms. */
  minSliceMs?: number
  /** Cap on returned markers. Defaults to 128. */
  maxSlices?: number
}

export interface GridSliceParams extends SliceGuardOptions {
  /** Source-file tempo; generation yields nothing when missing or non-positive. */
  sourceBpm: number | undefined
  /** Beat-grid anchor in seconds; generation yields nothing when undefined. */
  anchorSec: number | undefined
  /** Subdivision to lay slices on. */
  subdivision: SliceSubdivision
  /** Clip in-point in source ms (the slice window start). */
  windowInMs: number
  /** Clip source-time length; the window end is `windowInMs + windowDurationMs`. */
  windowDurationMs: number
}

/**
 * Sort, de-duplicate, clamp to the interior, and thin a set of source-ms slice
 * markers so none sits within `minSliceMs` of a window edge or its neighbour, and
 * no more than `maxSlices` survive. Head and tail are implicit boundaries (never
 * emitted as markers), so committing never yields a zero-length sibling.
 */
export function applySliceGuards(
  timesSourceMs: readonly number[],
  windowInMs: number,
  windowDurationMs: number,
  options: SliceGuardOptions = {}
): number[] {
  const minSliceMs = options.minSliceMs ?? DEFAULT_MIN_SLICE_MS
  const maxSlices = options.maxSlices ?? MAX_SLICES
  const windowEndMs = windowInMs + windowDurationMs

  const interiorLow = windowInMs + minSliceMs
  const interiorHigh = windowEndMs - minSliceMs
  if (interiorLow >= interiorHigh) return []

  const sorted = [...timesSourceMs].sort((a, b) => a - b)
  const kept: number[] = []
  for (const t of sorted) {
    if (t < interiorLow || t > interiorHigh) continue
    const last = kept[kept.length - 1]
    if (last !== undefined && t - last < minSliceMs) continue
    kept.push(t)
    if (kept.length >= maxSlices) break
  }
  return kept
}

/**
 * Generate interior slice markers (source ms, ascending) on the source beat grid
 * for the given subdivision, constrained to the clip's window and passed through
 * {@link applySliceGuards}. Returns `[]` when the source has no usable tempo /
 * anchor.
 */
export function generateGridSlices(params: GridSliceParams): number[] {
  const { sourceBpm, anchorSec, subdivision, windowInMs, windowDurationMs } = params
  if (!sourceBpm || sourceBpm <= 0 || anchorSec === undefined) return []

  const beatSpacingMs = (60 / sourceBpm) * 1000
  const stepMs = beatSpacingMs / DIVISIONS_PER_BEAT[subdivision]
  if (stepMs <= 0) return []

  const anchorMs = anchorSec * 1000
  const windowEndMs = windowInMs + windowDurationMs

  // First grid line strictly past the window start; iterate to the window end.
  // Bound the loop independently of the guard cap so a pathological step can't spin.
  const maxLines = MAX_SLICES * 4
  const firstIndex = Math.floor((windowInMs - anchorMs) / stepMs) + 1
  const raw: number[] = []
  for (let i = 0; i < maxLines; i++) {
    const t = anchorMs + (firstIndex + i) * stepMs
    if (t >= windowEndMs) break
    raw.push(t)
  }

  return applySliceGuards(raw, windowInMs, windowDurationMs, {
    minSliceMs: params.minSliceMs,
    maxSlices: params.maxSlices
  })
}
