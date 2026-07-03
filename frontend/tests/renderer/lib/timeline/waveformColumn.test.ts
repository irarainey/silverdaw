import { describe, it, expect } from 'vitest'
import {
  waveformColumnExcursion,
  waveformColumnUp,
  waveformColumnDown,
  visibleColumnRange,
  createWaveformRunMerger,
  sampleInterpolatedPeak
} from '@/lib/timeline/waveformColumn'

describe('waveformColumnExcursion', () => {
  it('returns the unscaled excursion at unity gain (no-envelope parity)', () => {
    // At gain 1 the result must match the previous `max * laneHalf` /
    // `-min * laneHalf` mapping exactly so unenveloped clips are unchanged.
    expect(waveformColumnExcursion(-0.5, 0.8, 20, 1)).toEqual({ up: 16, down: 10 })
  })

  it('scales the excursion down for sub-unity gain', () => {
    expect(waveformColumnExcursion(-1, 1, 20, 0.5)).toEqual({ up: 10, down: 10 })
  })

  it('collapses to zero excursion at zero (or negative) gain', () => {
    expect(waveformColumnExcursion(-1, 1, 20, 0)).toEqual({ up: 0, down: 0 })
    expect(waveformColumnExcursion(-1, 1, 20, -3)).toEqual({ up: 0, down: 0 })
  })

  it('clamps a greater-than-unity boost to the lane half-height', () => {
    // 0.8 * 20 * 4 = 64 → clamped to 20; -0.5 * -1 ... -min=0.5, 0.5*20*4=40 → 20.
    expect(waveformColumnExcursion(-0.5, 0.8, 20, 4)).toEqual({ up: 20, down: 20 })
  })

  it('treats a flat (all-zero) column as zero excursion regardless of gain', () => {
    expect(waveformColumnExcursion(0, 0, 20, 4)).toEqual({ up: 0, down: 0 })
  })

  it('handles asymmetric peaks independently', () => {
    expect(waveformColumnExcursion(-0.25, 0.75, 40, 1)).toEqual({ up: 30, down: 10 })
  })

  it('matches the allocation-free scalar helpers exactly', () => {
    const cases: ReadonlyArray<[number, number, number, number]> = [
      [-0.5, 0.8, 20, 1],
      [-1, 1, 20, 0.5],
      [-1, 1, 20, 0],
      [-0.5, 0.8, 20, 4],
      [0, 0, 20, 4],
      [-0.25, 0.75, 40, 1]
    ]
    for (const [min, max, half, gain] of cases) {
      const obj = waveformColumnExcursion(min, max, half, gain)
      expect(waveformColumnUp(max, half, gain)).toBe(obj.up)
      expect(waveformColumnDown(min, half, gain)).toBe(obj.down)
    }
  })
})

describe('visibleColumnRange', () => {
  it('returns the full clip when it sits entirely inside the band', () => {
    // Clip at absX=100, width 200 → columns 0..199; band 0..1000 covers it all.
    expect(visibleColumnRange(100, 200, 0, 1000)).toEqual({ from: 0, to: 200 })
  })

  it('clips the right edge when the clip extends past the band', () => {
    // Band ends at worldRight=250; lane left at absX=100 → last visible col = 150.
    expect(visibleColumnRange(100, 200, 0, 250)).toEqual({ from: 0, to: 151 })
  })

  it('clips the left edge when the clip starts before the band', () => {
    // Band starts at worldLeft=400; lane left at absX=100 → first visible col 300.
    expect(visibleColumnRange(100, 1000, 400, 2000)).toEqual({ from: 300, to: 1000 })
  })

  it('windows to an interior band on a very wide clip', () => {
    // A 50_000px clip with a 1500px band centred well inside it.
    expect(visibleColumnRange(0, 50_000, 10_000, 11_500)).toEqual({ from: 10_000, to: 11_501 })
  })

  it('yields an empty range for a clip entirely left of the band', () => {
    const { from, to } = visibleColumnRange(0, 100, 500, 1500)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  it('yields an empty range for a clip entirely right of the band', () => {
    // Lane starts at absX=2000, band ends at 1500 → to clamps below from (0).
    const { from, to } = visibleColumnRange(2000, 100, 0, 1500)
    expect(from).toBeGreaterThanOrEqual(to)
  })
})

describe('createWaveformRunMerger', () => {
  type Rect = [start: number, end: number, top: number, bot: number]
  const collect = (
    drive: (m: ReturnType<typeof createWaveformRunMerger>) => void
  ): Rect[] => {
    const rects: Rect[] = []
    const merger = createWaveformRunMerger((s, e, t, b) => rects.push([s, e, t, b]))
    drive(merger)
    return rects
  }

  it('merges consecutive equal-height columns into one wider rect', () => {
    const rects = collect((m) => {
      for (let px = 0; px < 4; px++) m.push(px, 10, 20)
      m.finish(4)
    })
    expect(rects).toEqual([[0, 4, 10, 20]])
  })

  it('emits one rect per column when every height differs (no merging)', () => {
    const rects = collect((m) => {
      m.push(0, 10, 20)
      m.push(1, 11, 19)
      m.push(2, 9, 21)
      m.finish(3)
    })
    expect(rects).toEqual([
      [0, 1, 10, 20],
      [1, 2, 11, 19],
      [2, 3, 9, 21]
    ])
  })

  it('breaks a run at a data gap so a rect never spans it', () => {
    const rects = collect((m) => {
      m.push(0, 10, 20)
      m.push(1, 10, 20)
      m.breakRun(2) // gap column at px=2
      m.push(3, 10, 20)
      m.push(4, 10, 20)
      m.finish(5)
    })
    expect(rects).toEqual([
      [0, 2, 10, 20],
      [3, 5, 10, 20]
    ])
  })

  it('is a no-op when nothing was pushed', () => {
    expect(collect((m) => m.finish(10))).toEqual([])
    expect(collect((m) => m.breakRun(10))).toEqual([])
  })

  it('closes the prior run and opens a new one on a height change', () => {
    const rects = collect((m) => {
      m.push(0, 10, 20)
      m.push(1, 10, 20)
      m.push(2, 12, 18)
      m.finish(3)
    })
    expect(rects).toEqual([
      [0, 2, 10, 20],
      [2, 3, 12, 18]
    ])
  })
})

describe('sampleInterpolatedPeak', () => {
  // Two buckets: [min,max] = [-0.2, 0.4] then [-0.6, 0.8]. Values are compared
  // with toBeCloseTo because a Float32Array quantises them.
  const peaks = new Float32Array([-0.2, 0.4, -0.6, 0.8])
  const expectClose = (
    actual: { min: number; max: number },
    min: number,
    max: number
  ): void => {
    expect(actual.min).toBeCloseTo(min, 5)
    expect(actual.max).toBeCloseTo(max, 5)
  }

  it('returns the exact peak at an integer bucket index', () => {
    expectClose(sampleInterpolatedPeak(peaks, 2, 0), -0.2, 0.4)
    expectClose(sampleInterpolatedPeak(peaks, 2, 1), -0.6, 0.8)
  })

  it('linearly interpolates the min and max between adjacent buckets', () => {
    expectClose(sampleInterpolatedPeak(peaks, 2, 0.5), -0.4, 0.6)
    expectClose(sampleInterpolatedPeak(peaks, 2, 0.25), -0.3, 0.5)
  })

  it('clamps a fractional index below zero to the first bucket', () => {
    expectClose(sampleInterpolatedPeak(peaks, 2, -3), -0.2, 0.4)
  })

  it('clamps a fractional index past the end to the last bucket', () => {
    expectClose(sampleInterpolatedPeak(peaks, 2, 5), -0.6, 0.8)
  })

  it('returns a flat zero column when there are no peaks', () => {
    expect(sampleInterpolatedPeak(new Float32Array(), 0, 0)).toEqual({ min: 0, max: 0 })
  })
})
