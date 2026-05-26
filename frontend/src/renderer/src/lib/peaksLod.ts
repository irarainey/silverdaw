/**
 * Level-of-detail (LOD) peak pyramids for waveform rendering.
 *
 * Peaks arrive from the backend (or the renderer's audio decoder) as
 * interleaved `min, max` float pairs at a fixed `peaksPerSecond` rate
 * — typically 500. Drawing a long clip at low zoom forces the timeline
 * to scan dozens of peaks per pixel column; drawing at very high zoom
 * spreads the same peak across many pixels (a stair-stepped look).
 *
 * Building a small mipmap-style pyramid of progressively coarser peak
 * arrays lets the renderer pick the LOD nearest to one peak per pixel
 * for the current zoom level. The inner draw loop then becomes
 * roughly O(visible pixels) instead of O(visible peaks).
 *
 * Each LOD is the min-of-mins / max-of-maxes downsample of the level
 * above it. Generation is one O(N) walk per level; total derived
 * storage is `~1.33 × base` so the memory cost is bounded.
 */

/** How many source peaks each derived level summarises. 4 is a good
 *  balance: each step is one zoom octave, and at this ratio three
 *  derived levels span the practical zoom range from a 5-minute song
 *  at 10 px/s down to a beat at 4000 px/s. */
export const PEAKS_LOD_STEP = 4

/** Target ratio of peaks to pixels at the picked LOD. > 1 ensures each
 *  pixel column has at least one peak to read; values up to ~2 give a
 *  small safety margin without measurably increasing scan cost. */
export const PEAKS_LOD_TARGET_PER_PIXEL = 1.5

/** Hysteresis window around the LOD boundary so a continuous zoom drag
 *  doesn't ping-pong between two levels. We only switch up a level
 *  when the ratio exceeds the upper bound, and switch down when it
 *  falls below the lower bound. */
export const PEAKS_LOD_BOUNDARY_LOW = 0.9
export const PEAKS_LOD_BOUNDARY_HIGH = 1.4

/**
 * A single LOD layer in a pyramid. `peaks` is the same interleaved
 * `min, max` float layout used everywhere else; `peaksPerSecond` is
 * the actual rate (a level summarising 4 buckets of an 501.14 ppS
 * base will report 125.28 ppS, not 125).
 */
export interface PeaksLodLayer {
  readonly peaks: Float32Array
  readonly peaksPerSecond: number
}

/**
 * Down-sample `src` by `step` (must be ≥ 2). Each output bucket is
 * the min of `step` source min values and the max of `step` source
 * max values. The output length is `ceil(srcLen / step)`. Returns the
 * source unchanged when there is no work to do.
 */
export function downsamplePeaks(src: Float32Array, step: number): Float32Array {
  if (step <= 1 || src.length < 4) return src
  const srcBuckets = src.length >>> 1
  const dstBuckets = Math.ceil(srcBuckets / step)
  const dst = new Float32Array(dstBuckets * 2)
  for (let outIdx = 0; outIdx < dstBuckets; outIdx++) {
    const srcStart = outIdx * step
    const srcEnd = Math.min(srcBuckets, srcStart + step)
    let min = src[srcStart * 2]!
    let max = src[srcStart * 2 + 1]!
    for (let i = srcStart + 1; i < srcEnd; i++) {
      const lo = src[i * 2]!
      const hi = src[i * 2 + 1]!
      if (lo < min) min = lo
      if (hi > max) max = hi
    }
    dst[outIdx * 2] = min
    dst[outIdx * 2 + 1] = max
  }
  return dst
}

/**
 * Build a LOD pyramid from a base peak array. Returned levels are
 * ordered fine → coarse: index 0 is `base`, subsequent entries are
 * progressively `PEAKS_LOD_STEP`-times coarser. Stops when a level
 * would contain fewer than `minBuckets` peaks (below that it's
 * cheaper for the draw loop to walk the level above).
 */
export function buildPeaksLodPyramid(
  base: Float32Array,
  basePeaksPerSecond: number,
  options: { step?: number; maxLevels?: number; minBuckets?: number } = {}
): PeaksLodLayer[] {
  const step = options.step ?? PEAKS_LOD_STEP
  const maxLevels = options.maxLevels ?? 4
  const minBuckets = options.minBuckets ?? 16
  const layers: PeaksLodLayer[] = []
  if (basePeaksPerSecond <= 0 || base.length < 4) {
    layers.push({ peaks: base, peaksPerSecond: basePeaksPerSecond })
    return layers
  }
  layers.push({ peaks: base, peaksPerSecond: basePeaksPerSecond })
  let current = base
  let currentPpS = basePeaksPerSecond
  for (let level = 1; level < maxLevels; level++) {
    const nextBuckets = Math.ceil((current.length >>> 1) / step)
    if (nextBuckets < minBuckets) break
    const next = downsamplePeaks(current, step)
    if (next === current) break
    currentPpS = currentPpS / step
    layers.push({ peaks: next, peaksPerSecond: currentPpS })
    current = next
  }
  return layers
}

/**
 * Pick the LOD layer best matched to the current draw scale.
 *
 * `pxPerSecond` is the timeline's current px-per-source-second
 * (already including warp, because `useTimelineDrawing` passes the
 * warped pixel width down). `currentPeaksPerSecond` (optional) is the
 * level last picked for this clip — passed in so we can apply
 * hysteresis on the boundary and avoid ping-ponging between two
 * levels during continuous zoom drags.
 */
export function pickPeaksLod(
  layers: ReadonlyArray<PeaksLodLayer>,
  pxPerSecond: number,
  currentPeaksPerSecond?: number
): PeaksLodLayer {
  if (layers.length === 0) {
    return { peaks: new Float32Array(), peaksPerSecond: 0 }
  }
  if (layers.length === 1 || pxPerSecond <= 0) return layers[0]!
  const desired = pxPerSecond * PEAKS_LOD_TARGET_PER_PIXEL
  // If we already have a level picked and we're inside the hysteresis
  // band, keep it.
  if (typeof currentPeaksPerSecond === 'number' && currentPeaksPerSecond > 0) {
    const currentLayer = layers.find((l) => Math.abs(l.peaksPerSecond - currentPeaksPerSecond) < 1e-3)
    if (currentLayer) {
      const ratio = currentLayer.peaksPerSecond / desired
      if (ratio >= PEAKS_LOD_BOUNDARY_LOW && ratio <= PEAKS_LOD_BOUNDARY_HIGH) {
        return currentLayer
      }
    }
  }
  // Otherwise pick the smallest level whose ppS still meets the
  // target. Layers are fine → coarse, so iterate from the coarsest
  // upward and stop at the first level that's fine enough.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    if (layer.peaksPerSecond >= desired) return layer
  }
  return layers[0]!
}
