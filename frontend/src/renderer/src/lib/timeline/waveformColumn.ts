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
export function waveformColumnExcursion(
  minPeak: number,
  maxPeak: number,
  laneHalf: number,
  gain: number
): { up: number; down: number } {
  const g = gain > 0 ? gain : 0
  const up = Math.min(laneHalf, Math.max(0, maxPeak) * laneHalf * g)
  const down = Math.min(laneHalf, Math.max(0, -minPeak) * laneHalf * g)
  return { up, down }
}
