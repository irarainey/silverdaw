/**
 * LOD peak pyramids let waveform drawing scan near one bucket per pixel.
 * Each layer stores min-of-mins/max-of-maxes; derived storage is bounded.
 */

/** Source buckets per derived level; 4 balances zoom span and memory. */
export const PEAKS_LOD_STEP = 4

/** Target peaks per pixel at the picked LOD. */
export const PEAKS_LOD_TARGET_PER_PIXEL = 1.5

/** LOD hysteresis window to avoid ping-pong during continuous zoom. */
export const PEAKS_LOD_BOUNDARY_LOW = 0.9
export const PEAKS_LOD_BOUNDARY_HIGH = 1.4

/** A pyramid layer using the shared interleaved `min, max` peak layout. */
export interface PeaksLodLayer {
  readonly peaks: Float32Array
  readonly peaksPerSecond: number
}

/** Downsample by min-of-mins/max-of-maxes over `step` source buckets. */
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

/** Build fine→coarse LOD layers until a level would be too small to help. */
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

/** Pick the draw-scale-matched LOD, preserving the current level inside hysteresis. */
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
  // Keep the current level inside the hysteresis band.
  if (typeof currentPeaksPerSecond === 'number' && currentPeaksPerSecond > 0) {
    const currentLayer = layers.find((l) => Math.abs(l.peaksPerSecond - currentPeaksPerSecond) < 1e-3)
    if (currentLayer) {
      const ratio = currentLayer.peaksPerSecond / desired
      if (ratio >= PEAKS_LOD_BOUNDARY_LOW && ratio <= PEAKS_LOD_BOUNDARY_HIGH) {
        return currentLayer
      }
    }
  }
  // Pick the coarsest level that still meets the target.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    if (layer.peaksPerSecond >= desired) return layer
  }
  return layers[0]!
}
