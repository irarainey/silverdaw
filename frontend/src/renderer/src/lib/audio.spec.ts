import { describe, expect, it } from 'vitest'
import { effectivePeaksPerSecond } from '@/lib/audio'

describe('audio peak helpers', () => {
  it('returns the actual peak rate after integer sample bucketing', () => {
    expect(effectivePeaksPerSecond(44_100, 500)).toBeCloseTo(44_100 / 88, 6)
  })

  it('matches the requested rate when the sample rate divides evenly', () => {
    expect(effectivePeaksPerSecond(48_000, 500)).toBe(500)
  })

  it('clamps to one sample per peak for very high requested rates', () => {
    expect(effectivePeaksPerSecond(8_000, 20_000)).toBe(8_000)
  })
})
