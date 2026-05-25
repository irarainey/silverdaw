import { describe, it, expect } from 'vitest'
import {
  clipEffectiveDurationMs,
  effectiveDurationMs,
  effectivePitchScale,
  effectiveTempoRatio,
  isWarpActive,
  isWarpPending
} from '@/lib/warp'

describe('warp helpers', () => {
  describe('effectiveTempoRatio', () => {
    it('returns 1 when neither pin nor BPMs are set', () => {
      expect(effectiveTempoRatio({})).toBe(1)
    })

    it('honours an explicit pin over the live derivation', () => {
      expect(effectiveTempoRatio({ tempoRatio: 1.5, sourceBpm: 120, projectBpm: 60 })).toBe(1.5)
    })

    it('derives from project / source BPM when no pin is set', () => {
      expect(effectiveTempoRatio({ sourceBpm: 120, projectBpm: 90 })).toBeCloseTo(0.75, 6)
    })

    it('falls back to 1 if source BPM is missing or zero', () => {
      expect(effectiveTempoRatio({ projectBpm: 120 })).toBe(1)
      expect(effectiveTempoRatio({ sourceBpm: 0, projectBpm: 120 })).toBe(1)
    })

    it('falls back to 1 if project BPM is missing or zero', () => {
      expect(effectiveTempoRatio({ sourceBpm: 120 })).toBe(1)
      expect(effectiveTempoRatio({ sourceBpm: 120, projectBpm: 0 })).toBe(1)
    })

    it('rejects non-positive pinned ratios in favour of live derivation', () => {
      expect(
        effectiveTempoRatio({ tempoRatio: -1, sourceBpm: 120, projectBpm: 90 })
      ).toBeCloseTo(0.75, 6)
    })
  })

  describe('isWarpActive', () => {
    it('is false when warpEnabled is unset', () => {
      expect(isWarpActive({ sourceBpm: 120, projectBpm: 90 })).toBe(false)
    })

    it('is false when warpEnabled is true but ratio rounds to 1', () => {
      expect(isWarpActive({ warpEnabled: true, sourceBpm: 120, projectBpm: 120 })).toBe(false)
    })

    it('is true when warpEnabled is true and ratio differs meaningfully', () => {
      expect(isWarpActive({ warpEnabled: true, sourceBpm: 120, projectBpm: 90 })).toBe(true)
    })
  })

  describe('isWarpPending', () => {
    it('is true while auto-warp is waiting for analysis', () => {
      expect(isWarpPending({ pendingAutoWarp: true })).toBe(true)
    })

    it('is true for follow-project warp before source BPM is known', () => {
      expect(isWarpPending({ warpEnabled: true, projectBpm: 120 })).toBe(true)
    })

    it('is false once a follow-project warp has the needed BPMs', () => {
      expect(isWarpPending({ warpEnabled: true, sourceBpm: 100, projectBpm: 120 })).toBe(false)
    })

    it('is false for pinned ratios because no source BPM is needed', () => {
      expect(isWarpPending({ warpEnabled: true, tempoRatio: 1.2 })).toBe(false)
    })
  })

  describe('effectiveDurationMs', () => {
    it('returns the native duration when warp is inactive', () => {
      expect(effectiveDurationMs(4000, { sourceBpm: 120, projectBpm: 90 })).toBe(4000)
    })

    it('shortens a slow clip dragged into a fast project', () => {
      // 120 source -> 180 project: ratio 1.5, clip plays in 4000/1.5 ≈ 2666 ms
      expect(
        effectiveDurationMs(4000, { warpEnabled: true, sourceBpm: 120, projectBpm: 180 })
      ).toBeCloseTo(4000 / 1.5, 3)
    })

    it('lengthens a fast clip dragged into a slow project', () => {
      // 180 source -> 90 project: ratio 0.5, clip plays in 4000/0.5 = 8000 ms
      expect(
        effectiveDurationMs(4000, { warpEnabled: true, sourceBpm: 180, projectBpm: 90 })
      ).toBe(8000)
    })

    it('respects an explicit tempoRatio pin', () => {
      expect(
        effectiveDurationMs(2000, { warpEnabled: true, tempoRatio: 2.0, sourceBpm: 120, projectBpm: 60 })
      ).toBe(1000)
    })

    it('uses the same effective duration helper shape as clips and library items', () => {
      expect(
        clipEffectiveDurationMs(
          { durationMs: 4000, warpEnabled: true },
          { bpm: 120 },
          180
        )
      ).toBeCloseTo(4000 / 1.5, 3)
    })
  })

  describe('effectivePitchScale', () => {
    it('returns 1 for the zero-shift identity', () => {
      expect(effectivePitchScale(0, 0)).toBe(1)
      expect(effectivePitchScale(undefined, undefined)).toBe(1)
    })

    it('shifts by one octave = ratio 2 / 0.5', () => {
      expect(effectivePitchScale(12, 0)).toBeCloseTo(2, 6)
      expect(effectivePitchScale(-12, 0)).toBeCloseTo(0.5, 6)
    })

    it('combines semitones and cents', () => {
      // 7 semitones + 50 cents = 7.5 semitones above
      expect(effectivePitchScale(7, 50)).toBeCloseTo(Math.pow(2, 7.5 / 12), 6)
    })

    it('clamps to a finite ratio for extreme inputs (sanity check)', () => {
      const scale = effectivePitchScale(24, 100)
      expect(Number.isFinite(scale)).toBe(true)
      expect(scale).toBeGreaterThan(0)
    })
  })
})
