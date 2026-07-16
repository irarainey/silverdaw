import { describe, expect, it } from 'vitest'
import {
  peakPairPositionForDisplayFraction,
  peakPairRangeForDisplaySpan
} from '@/lib/scratch/scratchWaveformMapping'

describe('peakPairPositionForDisplayFraction', () => {
  it('maps display fractions across the source window even when playback is warped', () => {
    const preparedDurationMs = 2_000
    const sourceDurationMs = 4_000
    const midpointDisplayFraction = 1_000 / preparedDurationMs

    expect(
      peakPairPositionForDisplayFraction(midpointDisplayFraction, 1_000, sourceDurationMs, 10, false)
    ).toBeCloseTo(30, 10)
  })

  it('maps the reversed waveform from the source-window end back to its start', () => {
    expect(peakPairPositionForDisplayFraction(0, 500, 2_000, 8, true)).toBeCloseTo(20, 10)
    expect(peakPairPositionForDisplayFraction(1, 500, 2_000, 8, true)).toBeCloseTo(4, 10)
  })

  it('clamps display fractions before sampling peaks', () => {
    expect(peakPairPositionForDisplayFraction(-1, 250, 1_000, 4, false)).toBeCloseTo(1, 10)
    expect(peakPairPositionForDisplayFraction(3, 250, 1_000, 4, false)).toBeCloseTo(5, 10)
  })
})

describe('peakPairRangeForDisplaySpan', () => {
  it('returns an ordered peak range for forward playback', () => {
    expect(peakPairRangeForDisplaySpan(0.25, 0.5, 0, 4_000, 10, false)).toEqual({
      startPair: 10,
      endPair: 20
    })
  })

  it('returns an ordered peak range for reversed playback', () => {
    expect(peakPairRangeForDisplaySpan(0.25, 0.5, 0, 4_000, 10, true)).toEqual({
      startPair: 20,
      endPair: 30
    })
  })
})
