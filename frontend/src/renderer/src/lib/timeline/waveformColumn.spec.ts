import { describe, it, expect } from 'vitest'
import { waveformColumnExcursion } from './waveformColumn'

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
})
