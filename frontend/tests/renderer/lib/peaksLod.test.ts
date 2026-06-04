import { describe, expect, it } from 'vitest'
import {
  PEAKS_LOD_STEP,
  buildPeaksLodPyramid,
  downsamplePeaks,
  pickPeaksLod
} from '@/lib/peaksLod'

function makePeaks(buckets: number, valueFn: (i: number) => [number, number]): Float32Array {
  const out = new Float32Array(buckets * 2)
  for (let i = 0; i < buckets; i++) {
    const [min, max] = valueFn(i)
    out[i * 2] = min
    out[i * 2 + 1] = max
  }
  return out
}

describe('downsamplePeaks', () => {
  it('returns the source unchanged for step <= 1 or tiny inputs', () => {
    const src = makePeaks(4, (i) => [-0.1 * i, 0.1 * i])
    expect(downsamplePeaks(src, 1)).toBe(src)
    expect(downsamplePeaks(new Float32Array([0, 1]), 4)).toEqual(new Float32Array([0, 1]))
  })

  it('takes min-of-mins and max-of-maxes across every step buckets', () => {
    const src = makePeaks(8, (i) => [-(i + 1), i + 1])
    // step 4 -> 2 dst buckets covering [0..3] and [4..7]
    const dst = downsamplePeaks(src, 4)
    expect(dst.length).toBe(4)
    expect(dst[0]).toBe(-4) // min of -1, -2, -3, -4
    expect(dst[1]).toBe(4) // max of 1, 2, 3, 4
    expect(dst[2]).toBe(-8)
    expect(dst[3]).toBe(8)
  })

  it('handles a non-multiple source length by truncating the tail bucket', () => {
    const src = makePeaks(5, (i) => [-i, i])
    const dst = downsamplePeaks(src, 4)
    expect(dst.length).toBe(4) // 2 dst buckets * 2 floats
    expect(dst[0]).toBe(-3) // min over 0,-1,-2,-3
    expect(dst[1]).toBe(3)
    expect(dst[2]).toBe(-4) // single-bucket tail
    expect(dst[3]).toBe(4)
  })
})

describe('buildPeaksLodPyramid', () => {
  it('returns just the base when the base is too small to downsample', () => {
    const base = makePeaks(2, (i) => [-i, i])
    const layers = buildPeaksLodPyramid(base, 500)
    expect(layers).toHaveLength(1)
    expect(layers[0]!.peaks).toBe(base)
    expect(layers[0]!.peaksPerSecond).toBe(500)
  })

  it('builds successively coarser layers separated by PEAKS_LOD_STEP', () => {
    // 1024 base buckets, default step=4, min-buckets=16 → 4 levels
    const base = makePeaks(1024, () => [-1, 1])
    const layers = buildPeaksLodPyramid(base, 500)
    expect(layers.length).toBeGreaterThanOrEqual(3)
    expect(layers[0]!.peaks.length).toBe(2048)
    expect(layers[0]!.peaksPerSecond).toBe(500)
    expect(layers[1]!.peaksPerSecond).toBeCloseTo(500 / PEAKS_LOD_STEP)
    expect(layers[2]!.peaksPerSecond).toBeCloseTo(500 / (PEAKS_LOD_STEP * PEAKS_LOD_STEP))
    expect(layers[1]!.peaks.length).toBeCloseTo(layers[0]!.peaks.length / PEAKS_LOD_STEP, -1)
  })

  it('stops adding levels once buckets drop below minBuckets', () => {
    // 50 base buckets / 4 = 13 < 16 → only the base layer
    const base = makePeaks(50, () => [-0.5, 0.5])
    const layers = buildPeaksLodPyramid(base, 500)
    expect(layers).toHaveLength(1)
  })

  it('preserves min/max envelopes across levels', () => {
    // Spike in the middle: every bucket is [-1,1] EXCEPT bucket 200
    // which has a [-1, 0.95] sample. The spike should survive all
    // downsample levels.
    const base = makePeaks(1024, (i) => (i === 200 ? [-1, 0.95] : [-0.1, 0.1]))
    const layers = buildPeaksLodPyramid(base, 500)
    for (const layer of layers) {
      let layerMax = -Infinity
      for (let i = 1; i < layer.peaks.length; i += 2) {
        if (layer.peaks[i]! > layerMax) layerMax = layer.peaks[i]!
      }
      expect(layerMax).toBeGreaterThanOrEqual(0.9)
    }
  })
})

describe('pickPeaksLod', () => {
  const layers = [
    { peaks: makePeaks(1000, () => [-1, 1]), peaksPerSecond: 500 },
    { peaks: makePeaks(250, () => [-1, 1]), peaksPerSecond: 125 },
    { peaks: makePeaks(63, () => [-1, 1]), peaksPerSecond: 31.25 },
    { peaks: makePeaks(16, () => [-1, 1]), peaksPerSecond: 7.8125 }
  ]

  it('returns the only layer when there is just one', () => {
    const picked = pickPeaksLod([layers[0]!], 100)
    expect(picked).toBe(layers[0])
  })

  it('returns empty placeholder when given no layers', () => {
    const picked = pickPeaksLod([], 100)
    expect(picked.peaks.length).toBe(0)
    expect(picked.peaksPerSecond).toBe(0)
  })

  it('picks the coarsest layer for very low zoom', () => {
    // 5 px/sec * 1.5 = 7.5 desired ppS → layer with 7.8125 ppS wins
    const picked = pickPeaksLod(layers, 5)
    expect(picked.peaksPerSecond).toBeCloseTo(7.8125)
  })

  it('picks the base layer for high zoom', () => {
    // 1000 px/sec * 1.5 = 1500 desired ppS; no layer offers that, so
    // the finest available (500 ppS base) wins.
    const picked = pickPeaksLod(layers, 1000)
    expect(picked.peaksPerSecond).toBe(500)
  })

  it('picks intermediate layers at mid zoom', () => {
    // 60 px/sec * 1.5 = 90 desired ppS → 125 ppS layer wins
    const picked = pickPeaksLod(layers, 60)
    expect(picked.peaksPerSecond).toBe(125)
  })

  it('keeps the current layer if inside the hysteresis band', () => {
    // 70 px/s * 1.5 = 105 desired ppS. 125 ppS gives ratio 125/105 ≈ 1.19
    // which is inside the [0.9, 1.4] hysteresis window, so a current
    // 125 ppS pick should stick.
    const stick = pickPeaksLod(layers, 70, 125)
    expect(stick.peaksPerSecond).toBe(125)
    // A 500 ppS pick on the same zoom would not be in the band (ratio
    // 500/105 = 4.76), so we'd switch down to 125.
    const switched = pickPeaksLod(layers, 70, 500)
    expect(switched.peaksPerSecond).toBe(125)
  })
})
