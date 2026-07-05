import { describe, expect, it } from 'vitest'
import {
  computeEffectiveRatio,
  deriveTempoModeFromClip,
  manualTempoRatio
} from '@/lib/clipEditor/tempoMode'

describe('deriveTempoModeFromClip', () => {
  it('treats an absent or neutral tempoRatio as follow', () => {
    expect(deriveTempoModeFromClip({}, 120, 128).mode).toBe('follow')
    expect(deriveTempoModeFromClip({ tempoRatio: 1 }, 120, 128).mode).toBe('follow')
    expect(deriveTempoModeFromClip({ tempoRatio: 0 }, 120, 128).mode).toBe('follow')
  })

  it('shows an explicit ratio as a pinned BPM when the source tempo is known', () => {
    const d = deriveTempoModeFromClip({ tempoRatio: 1.5 }, 100, 128)
    expect(d.mode).toBe('pin')
    expect(d.pinnedBpm).toBeCloseTo(150, 2)
    expect(d.stretchPercent).toBeCloseTo(150, 2)
  })

  it('shows an explicit ratio as a stretch % when there is no source tempo', () => {
    const d = deriveTempoModeFromClip({ tempoRatio: 1.1 }, undefined, 128)
    expect(d.mode).toBe('stretch')
    expect(d.stretchPercent).toBeCloseTo(110, 2)
  })
})

describe('manualTempoRatio', () => {
  it('derives a pin ratio from BPM and source, clamped to [0.25, 4]', () => {
    expect(manualTempoRatio('pin', { pinnedBpm: 150, stretchPercent: 100, sourceBpm: 100 })).toBeCloseTo(1.5, 3)
    // 300 / 50 = 6 → clamped to 4.
    expect(manualTempoRatio('pin', { pinnedBpm: 300, stretchPercent: 100, sourceBpm: 50 })).toBe(4)
  })

  it('returns undefined for a pin without a source BPM', () => {
    expect(manualTempoRatio('pin', { pinnedBpm: 120, stretchPercent: 100, sourceBpm: undefined })).toBeUndefined()
  })

  it('derives a stretch ratio from percent, clamped to [25, 400]%', () => {
    expect(manualTempoRatio('stretch', { pinnedBpm: 0, stretchPercent: 110, sourceBpm: undefined })).toBeCloseTo(1.1, 3)
    expect(manualTempoRatio('stretch', { pinnedBpm: 0, stretchPercent: 1000, sourceBpm: undefined })).toBe(4)
    expect(manualTempoRatio('stretch', { pinnedBpm: 0, stretchPercent: 1, sourceBpm: undefined })).toBe(0.25)
  })

  it('returns undefined for follow', () => {
    expect(manualTempoRatio('follow', { pinnedBpm: 120, stretchPercent: 100, sourceBpm: 120 })).toBeUndefined()
  })
})

describe('computeEffectiveRatio', () => {
  const base = { pinnedBpm: 100, stretchPercent: 100, sourceBpm: 100, projectBpm: 128 }

  it('is 1 when warp is disabled', () => {
    expect(computeEffectiveRatio({ ...base, enabled: false, mode: 'follow' })).toBe(1)
  })

  it('follows the project tempo when synced', () => {
    expect(computeEffectiveRatio({ ...base, enabled: true, mode: 'follow' })).toBeCloseTo(1.28, 3)
  })

  it('uses the pinned ratio when pinned', () => {
    expect(
      computeEffectiveRatio({ ...base, enabled: true, mode: 'pin', pinnedBpm: 150, sourceBpm: 100 })
    ).toBeCloseTo(1.5, 3)
  })

  it('uses the stretch ratio without a source BPM', () => {
    expect(
      computeEffectiveRatio({ ...base, enabled: true, mode: 'stretch', stretchPercent: 90, sourceBpm: undefined })
    ).toBeCloseTo(0.9, 3)
  })

  it('round-trips a pinned clip: derive → resolve reproduces the ratio', () => {
    const ratio = 1.5
    const d = deriveTempoModeFromClip({ tempoRatio: ratio }, 100, 128)
    const back = manualTempoRatio(d.mode, { pinnedBpm: d.pinnedBpm, stretchPercent: d.stretchPercent, sourceBpm: 100 })
    expect(back).toBeCloseTo(ratio, 3)
  })
})
