import { describe, it, expect } from 'vitest'
import {
  effectiveDurationMs,
  effectivePitchScale,
  effectiveTempoRatio,
  isWarpActive,
  isWarpPending,
  shouldAutoWarpOnDrop,
  warpChangesTiming,
  warpDriftMs
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

    it('reports a near-miss tempo as active on a long stem', () => {
      // The reported bug: a drum stem reanalysed to 94.0446 against a 94.05 project
      // was warped by the engine yet reported inactive, so the timeline drew it at
      // native length with no WARP badge and beat markers on the unwarped grid.
      expect(
        isWarpActive({
          warpEnabled: true,
          sourceBpm: 94.04458826555116,
          projectBpm: 94.05,
          nativeDurationMs: 177397
        })
      ).toBe(true)
    })

    it('reports the same near-miss tempo as inactive on a short loop', () => {
      expect(
        isWarpActive({
          warpEnabled: true,
          sourceBpm: 94.04458826555116,
          projectBpm: 94.05,
          nativeDurationMs: 5104
        })
      ).toBe(false)
    })

    it('is inactive at an exact tempo match however long the clip', () => {
      expect(
        isWarpActive({
          warpEnabled: true,
          sourceBpm: 94.05,
          projectBpm: 94.05,
          nativeDurationMs: 177397
        })
      ).toBe(false)
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

  describe('shouldAutoWarpOnDrop', () => {
    const eligible = {
      preferenceEnabled: true,
      projectBpmSeeded: true,
      sourceKind: 'source' as const,
      sourceIsSimple: false,
      sourceBpm: 100,
      projectBpm: 120
    }

    it('keeps variable-tempo music eligible when a representative BPM exists', () => {
      expect(shouldAutoWarpOnDrop({ ...eligible, variableTempo: true })).toBe(true)
    })

    it('honours the preference and existing sample/saved-clip exclusions', () => {
      expect(shouldAutoWarpOnDrop({ ...eligible, preferenceEnabled: false })).toBe(false)
      expect(shouldAutoWarpOnDrop({ ...eligible, sourceIsSimple: true })).toBe(false)
      expect(shouldAutoWarpOnDrop({ ...eligible, sourceKind: 'clip' })).toBe(false)
    })

    it('requires a seeded project tempo and usable source/project BPM values', () => {
      expect(shouldAutoWarpOnDrop({ ...eligible, projectBpmSeeded: false })).toBe(false)
      expect(shouldAutoWarpOnDrop({ ...eligible, sourceBpm: undefined })).toBe(false)
      expect(shouldAutoWarpOnDrop({ ...eligible, projectBpm: 0 })).toBe(false)
    })

    it('warps the first clip dropped into a project whose tempo is already settled', () => {
      // The old gate asked "is another clip on the timeline?", which refused to warp
      // the first drop into a reopened project that already had an established tempo.
      expect(shouldAutoWarpOnDrop(eligible)).toBe(true)
    })

    it('warps a near-miss tempo on a long stem and leaves an exact match alone', () => {
      // A drum stem reanalysed from 94.05 to 94.0446 BPM sits inside any sane ratio
      // band, but drifts ~10 ms across its three minutes — so it must still warp.
      const nearMiss = {
        ...eligible,
        sourceBpm: 94.04458826555116,
        projectBpm: 94.05,
        sourceDurationMs: 177397
      }
      expect(shouldAutoWarpOnDrop(nearMiss)).toBe(true)
      // The same mismatch across a two-bar loop moves nothing worth warping for.
      expect(shouldAutoWarpOnDrop({ ...nearMiss, sourceDurationMs: 5000 })).toBe(false)
      // Tempos that already agree need no warp at any length.
      expect(
        shouldAutoWarpOnDrop({ ...nearMiss, sourceBpm: 94.05, sourceDurationMs: 177397 })
      ).toBe(false)
    })
  })

  describe('warpDriftMs', () => {
    it('measures how far the ratio pulls the end of the clip', () => {
      expect(warpDriftMs(4000, 2)).toBeCloseTo(2000, 6)
      expect(warpDriftMs(4000, 1)).toBe(0)
    })

    it('treats an unknown length as "warp unless the tempos agree"', () => {
      expect(warpChangesTiming(undefined, 1.05)).toBe(true)
      expect(warpChangesTiming(undefined, 1)).toBe(false)
      expect(warpChangesTiming(0, 1.05)).toBe(true)
    })

    it('ignores a non-positive ratio rather than reporting nonsense drift', () => {
      expect(warpDriftMs(4000, 0)).toBe(0)
      expect(warpDriftMs(4000, Number.NaN)).toBe(0)
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
