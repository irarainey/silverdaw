// Pure geometry for a single timeline-waveform column's vertical excursion.
//
// The timeline waveform is painted column-by-column: each pixel column has a
// positive peak (`maxPeak` in [0, 1]) and a negative peak (`minPeak` in
// [-1, 0]) and is drawn as a vertical line about the lane centre, scaled by the
// lane half-height. A clip's volume envelope contributes a per-column gain
// multiplier so the rendered height visibly reflects the gain shape. This
// isolates the (clamped) excursion maths from the Pixi drawing so it can be
// unit tested without a canvas.

/**
 * Vertical excursion (in pixels, above and below the lane centre) for one
 * waveform column.
 *
 * - `minPeak` is the column's negative peak in `[-1, 0]`, `maxPeak` its
 *   positive peak in `[0, 1]` (the draw loop seeds both at 0, so they always
 *   straddle zero).
 * - `laneHalf` is the lane's half-height in pixels.
 * - `gain` is the volume-envelope multiplier at the column. `gain === 1`
 *   returns the unscaled excursion, so a clip with no envelope renders
 *   identically to before. Greater-than-unity boosts are clamped to `laneHalf`
 *   so the drawn line can never spill outside the clip block; a non-positive
 *   gain collapses the column to zero excursion.
 */
/**
 * Upward excursion (pixels above the lane centre) for one waveform column.
 * Allocation-free scalar form for the per-column hot loop; see
 * {@link waveformColumnExcursion} for the semantics of each argument.
 */
export function waveformColumnUp(maxPeak: number, laneHalf: number, gain: number): number {
  const g = gain > 0 ? gain : 0
  return Math.min(laneHalf, Math.max(0, maxPeak) * laneHalf * g)
}

/**
 * Downward excursion (pixels below the lane centre) for one waveform column.
 * Allocation-free scalar form for the per-column hot loop.
 */
export function waveformColumnDown(minPeak: number, laneHalf: number, gain: number): number {
  const g = gain > 0 ? gain : 0
  return Math.min(laneHalf, Math.max(0, -minPeak) * laneHalf * g)
}

export function waveformColumnExcursion(
  minPeak: number,
  maxPeak: number,
  laneHalf: number,
  gain: number
): { up: number; down: number } {
  return {
    up: waveformColumnUp(maxPeak, laneHalf, gain),
    down: waveformColumnDown(minPeak, laneHalf, gain)
  }
}

/**
 * Linearly interpolate the min/max peak envelope at a fractional bucket index.
 *
 * Used when a waveform is zoomed in past its peak resolution (fewer than one
 * peak per pixel): drawing each pixel column from the nearest single peak would
 * repeat that peak across many columns, giving a blocky "stair-step" look. Reading
 * a smoothly interpolated value at each column's fractional position instead makes
 * the drawn envelope follow a clean line between peaks.
 *
 * `peaks` is the interleaved `[min, max, min, max, …]` array and `pairs` its
 * bucket count. `fidx` is the fractional bucket index; it is clamped into range.
 * The caller owns `output` so pixel loops can reuse one result object.
 */
export interface InterpolatedPeak {
  min: number
  max: number
}

export function sampleInterpolatedPeak(
  peaks: Float32Array,
  pairs: number,
  fidx: number,
  output: InterpolatedPeak
): InterpolatedPeak {
  if (pairs <= 0) {
    output.min = 0
    output.max = 0
    return output
  }
  const clamped = fidx < 0 ? 0 : fidx > pairs - 1 ? pairs - 1 : fidx
  const i0 = Math.floor(clamped)
  const i1 = i0 + 1 <= pairs - 1 ? i0 + 1 : pairs - 1
  const frac = clamped - i0
  const lo0 = peaks[i0 * 2] || 0
  const hi0 = peaks[i0 * 2 + 1] || 0
  const lo1 = peaks[i1 * 2] || 0
  const hi1 = peaks[i1 * 2 + 1] || 0
  output.min = lo0 + (lo1 - lo0) * frac
  output.max = hi0 + (hi1 - hi0) * frac
  return output
}

/**
 * Half-open pixel-column range `[from, to)` of a clip lane that intersects the
 * horizontal draw band, expressed in the lane's own `0..w` column space.
 *
 * - `absX` is the lane's left edge in world pixels; `w` its full pixel width.
 * - `worldLeft`/`worldRight` are the draw-band edges in world pixels.
 *
 * Columns outside the band are never on screen, so the draw loop skips them —
 * this is what makes redraw cost scale with the viewport instead of the whole
 * clip width. The range is clamped to `[0, w]`, so a clip entirely outside the
 * band yields an empty range (`from >= to`).
 */
export function visibleColumnRange(
  absX: number,
  w: number,
  worldLeft: number,
  worldRight: number
): { from: number; to: number } {
  const from = Math.max(0, Math.floor(worldLeft - absX))
  const to = Math.min(w, worldRight - absX + 1)
  return { from, to }
}

/** Emits one merged waveform rect spanning `[startPx, endPxExclusive)`. */
export type WaveformRectSink = (
  startPx: number,
  endPxExclusive: number,
  yTop: number,
  yBot: number
) => void

export interface WaveformRunMerger {
  /** Add the column at `px`; extends the open run if its height is identical. */
  push: (px: number, yTop: number, yBot: number) => void
  /** Close the open run at `px` (exclusive) for a data gap; starts no new run. */
  breakRun: (endPxExclusive: number) => void
  /** Flush any open run at `endPxExclusive`; call once after the last column. */
  finish: (endPxExclusive: number) => void
}

/**
 * Merges consecutive waveform columns that share identical top/bottom pixels
 * into a single wider rect, emitting via `sink`. At high zoom many adjacent
 * pixels read the same peak (and gain), so they collapse to one rect — the
 * output is pixel-identical to one rect per column but far cheaper to tessellate.
 *
 * Allocation-free per column (number compares only); allocate one merger per
 * lane. A run is contiguous in `px`, so callers must call `breakRun` at any
 * skipped/out-of-data column so a run never spans a gap.
 */
export function createWaveformRunMerger(sink: WaveformRectSink): WaveformRunMerger {
  let startPx = -1
  let top = 0
  let bot = 0
  const flush = (endPxExclusive: number): void => {
    if (startPx < 0) return
    sink(startPx, endPxExclusive, top, bot)
    startPx = -1
  }
  return {
    push(px, yTop, yBot) {
      if (startPx >= 0 && yTop === top && yBot === bot) return
      flush(px)
      startPx = px
      top = yTop
      bot = yBot
    },
    breakRun: flush,
    finish: flush
  }
}
