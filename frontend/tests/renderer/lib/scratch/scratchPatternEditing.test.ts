import { describe, expect, it } from 'vitest'
import {
  classifyPlatterSegment,
  classifyPlatterLane,
  interpolatePlatterAt,
  interpolateCrossfaderAt,
  movePlatterKeyframe,
  moveCrossfaderKeyframe,
  addPlatterKeyframe,
  addCrossfaderKeyframe,
  deletePlatterKeyframe,
  deleteCrossfaderKeyframe,
  validatePattern,
  applyPlatterEdit,
  applyCrossfaderEdit
} from '@/lib/scratch/scratchPatternEditing'
import type {
  ScratchPattern,
  ScratchPlatterKeyframe,
  ScratchCrossfaderKeyframe
} from '@shared/bridge-protocol'
import { SCRATCH_PATTERN_VERSION, SCRATCH_CROSSFADER_CURVE_VERSION, MAX_SCRATCH_PATTERN_POINTS } from '@shared/bridge-protocol'

function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'test-1',
    name: 'Test Pattern',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 2_000_000,
    cropStartUs: 0,
    cropEndUs: 2_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 0.5, touched: true },
      { timeUs: 2_000_000, turns: 1.0, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 0.5 },
      { timeUs: 2_000_000, value: 1 }
    ],
    ...overrides
  }
}

// ── Direction / Hold Classification ──────────────────────────────────────────

describe('classifyPlatterSegment', () => {
  it('forward when turns increase', () => {
    expect(classifyPlatterSegment(
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 100, turns: 1, touched: true }
    )).toBe('forward')
  })

  it('reverse when turns decrease', () => {
    expect(classifyPlatterSegment(
      { timeUs: 0, turns: 1, touched: true },
      { timeUs: 100, turns: 0, touched: true }
    )).toBe('reverse')
  })

  it('hold when turns unchanged', () => {
    expect(classifyPlatterSegment(
      { timeUs: 0, turns: 0.5, touched: true },
      { timeUs: 100, turns: 0.5, touched: true }
    )).toBe('hold')
  })

  it('hold for near-zero difference', () => {
    expect(classifyPlatterSegment(
      { timeUs: 0, turns: 0.5, touched: true },
      { timeUs: 100, turns: 0.5 + 1e-10, touched: true }
    )).toBe('hold')
  })
})

describe('classifyPlatterLane', () => {
  it('produces segments for each pair of adjacent keyframes', () => {
    const segments = classifyPlatterLane([
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 100, turns: 1, touched: true },
      { timeUs: 200, turns: 1, touched: true },
      { timeUs: 300, turns: 0, touched: false }
    ])
    expect(segments).toHaveLength(3)
    expect(segments[0]!.kind).toBe('forward')
    expect(segments[1]!.kind).toBe('hold')
    expect(segments[2]!.kind).toBe('reverse')
  })

  it('returns empty for single-point lane', () => {
    expect(classifyPlatterLane([{ timeUs: 0, turns: 0, touched: true }])).toHaveLength(0)
  })
})

// ── Interpolation ────────────────────────────────────────────────────────────

describe('interpolatePlatterAt', () => {
  const lane: ScratchPlatterKeyframe[] = [
    { timeUs: 0, turns: 0, touched: true },
    { timeUs: 1_000_000, turns: 1, touched: true },
    { timeUs: 2_000_000, turns: 0.5, touched: false }
  ]

  it('returns first value at or before start', () => {
    expect(interpolatePlatterAt(lane, 0)).toEqual({ turns: 0, touched: true })
    expect(interpolatePlatterAt(lane, -100)).toEqual({ turns: 0, touched: true })
  })

  it('returns last value at or after end', () => {
    expect(interpolatePlatterAt(lane, 2_000_000)).toEqual({ turns: 0.5, touched: false })
    expect(interpolatePlatterAt(lane, 3_000_000)).toEqual({ turns: 0.5, touched: false })
  })

  it('interpolates linearly between keyframes', () => {
    const result = interpolatePlatterAt(lane, 500_000)
    expect(result.turns).toBeCloseTo(0.5, 8)
    expect(result.touched).toBe(true)
  })

  it('interpolates in second segment', () => {
    const result = interpolatePlatterAt(lane, 1_500_000)
    expect(result.turns).toBeCloseTo(0.75, 8)
    expect(result.touched).toBe(true)
  })

  it('returns default for empty lane', () => {
    expect(interpolatePlatterAt([], 500)).toEqual({ turns: 0, touched: false })
  })

  it('returns single point value for one-element lane', () => {
    const single: ScratchPlatterKeyframe[] = [{ timeUs: 0, turns: 2, touched: true }]
    expect(interpolatePlatterAt(single, 1000)).toEqual({ turns: 2, touched: true })
  })
})

describe('interpolateCrossfaderAt', () => {
  const lane: ScratchCrossfaderKeyframe[] = [
    { timeUs: 0, value: 0 },
    { timeUs: 1_000_000, value: 1 }
  ]

  it('returns start value at 0', () => {
    expect(interpolateCrossfaderAt(lane, 0)).toBe(0)
  })

  it('returns end value at duration', () => {
    expect(interpolateCrossfaderAt(lane, 1_000_000)).toBe(1)
  })

  it('interpolates midpoint', () => {
    expect(interpolateCrossfaderAt(lane, 500_000)).toBeCloseTo(0.5, 8)
  })

  it('clamps before start', () => {
    expect(interpolateCrossfaderAt(lane, -100)).toBe(0)
  })

  it('clamps after end', () => {
    expect(interpolateCrossfaderAt(lane, 2_000_000)).toBe(1)
  })

  it('returns 0.5 for empty lane', () => {
    expect(interpolateCrossfaderAt([], 500)).toBe(0.5)
  })
})

// ── Move keyframes ───────────────────────────────────────────────────────────

describe('movePlatterKeyframe', () => {
  const platter: ScratchPlatterKeyframe[] = [
    { timeUs: 0, turns: 0, touched: true },
    { timeUs: 500_000, turns: 0.5, touched: true },
    { timeUs: 1_000_000, turns: 1, touched: false }
  ]

  it('boundary keyframes keep their time, only turns changes', () => {
    const result = movePlatterKeyframe(platter, 0, 999, 2.0)
    expect(result[0]!.timeUs).toBe(0)
    expect(result[0]!.turns).toBe(2.0)
  })

  it('last boundary keeps time', () => {
    const result = movePlatterKeyframe(platter, 2, 0, -1.0)
    expect(result[2]!.timeUs).toBe(1_000_000)
    expect(result[2]!.turns).toBe(-1.0)
  })

  it('interior point moves in time and value within bounds', () => {
    const result = movePlatterKeyframe(platter, 1, 300_000, 0.8)
    expect(result[1]!.timeUs).toBeGreaterThan(0)
    expect(result[1]!.timeUs).toBeLessThan(1_000_000)
    expect(result[1]!.turns).toBe(0.8)
  })

  it('interior point stays ordered (clamped)', () => {
    const result = movePlatterKeyframe(platter, 1, 0, 0.3)
    expect(result[1]!.timeUs).toBeGreaterThan(platter[0]!.timeUs)
  })

  it('preserves touch state', () => {
    const result = movePlatterKeyframe(platter, 1, 400_000, 0.6)
    expect(result[1]!.touched).toBe(true)
  })
})

describe('moveCrossfaderKeyframe', () => {
  const cf: ScratchCrossfaderKeyframe[] = [
    { timeUs: 0, value: 0 },
    { timeUs: 500_000, value: 0.5 },
    { timeUs: 1_000_000, value: 1 }
  ]

  it('clamps value to [0, 1]', () => {
    const result = moveCrossfaderKeyframe(cf, 1, 500_000, 1.5)
    expect(result[1]!.value).toBe(1)
    const result2 = moveCrossfaderKeyframe(cf, 1, 500_000, -0.5)
    expect(result2[1]!.value).toBe(0)
  })

  it('boundary keeps time', () => {
    const result = moveCrossfaderKeyframe(cf, 0, 999, 0.3)
    expect(result[0]!.timeUs).toBe(0)
    expect(result[0]!.value).toBe(0.3)
  })
})

// ── Add keyframes ────────────────────────────────────────────────────────────

describe('addPlatterKeyframe', () => {
  const platter: ScratchPlatterKeyframe[] = [
    { timeUs: 0, turns: 0, touched: true },
    { timeUs: 1_000_000, turns: 1, touched: false }
  ]

  it('inserts at correct position maintaining sort', () => {
    const result = addPlatterKeyframe(platter, 500_000, 0.5, true)
    expect(result).not.toBeNull()
    expect(result!.platter).toHaveLength(3)
    expect(result!.platter[1]!.timeUs).toBe(500_000)
    expect(result!.index).toBe(1)
  })

  it('rejects duplicate time', () => {
    const result = addPlatterKeyframe(platter, 0, 0.5, true)
    expect(result).toBeNull()
  })

  it('rejects when at max point count', () => {
    const maxPlatter = Array.from({ length: MAX_SCRATCH_PATTERN_POINTS }, (_, i) => ({
      timeUs: i,
      turns: 0,
      touched: true
    }))
    const result = addPlatterKeyframe(maxPlatter, MAX_SCRATCH_PATTERN_POINTS + 1, 0, true)
    expect(result).toBeNull()
  })

  it('rounds time to integer', () => {
    const result = addPlatterKeyframe(platter, 500_000.7, 0.5, true)
    expect(result).not.toBeNull()
    expect(result!.platter[1]!.timeUs).toBe(500_001)
  })
})

describe('addCrossfaderKeyframe', () => {
  const cf: ScratchCrossfaderKeyframe[] = [
    { timeUs: 0, value: 0 },
    { timeUs: 1_000_000, value: 1 }
  ]

  it('inserts and clamps value', () => {
    const result = addCrossfaderKeyframe(cf, 500_000, 1.5)
    expect(result).not.toBeNull()
    expect(result!.crossfader[1]!.value).toBe(1)
  })

  it('rejects negative time (clamped to 0, but 0 exists)', () => {
    const result = addCrossfaderKeyframe(cf, -100, 0.5)
    expect(result).toBeNull()
  })
})

// ── Delete keyframes ─────────────────────────────────────────────────────────

describe('deletePlatterKeyframe', () => {
  const platter: ScratchPlatterKeyframe[] = [
    { timeUs: 0, turns: 0, touched: true },
    { timeUs: 500_000, turns: 0.5, touched: true },
    { timeUs: 1_000_000, turns: 1, touched: false }
  ]

  it('deletes interior point', () => {
    const result = deletePlatterKeyframe(platter, 1)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
  })

  it('rejects boundary deletion (first)', () => {
    expect(deletePlatterKeyframe(platter, 0)).toBeNull()
  })

  it('rejects boundary deletion (last)', () => {
    expect(deletePlatterKeyframe(platter, 2)).toBeNull()
  })
})

describe('deleteCrossfaderKeyframe', () => {
  const cf: ScratchCrossfaderKeyframe[] = [
    { timeUs: 0, value: 0 },
    { timeUs: 500_000, value: 0.5 },
    { timeUs: 1_000_000, value: 1 }
  ]

  it('deletes interior point', () => {
    const result = deleteCrossfaderKeyframe(cf, 1)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
  })

  it('rejects boundary deletion', () => {
    expect(deleteCrossfaderKeyframe(cf, 0)).toBeNull()
    expect(deleteCrossfaderKeyframe(cf, 2)).toBeNull()
  })
})

// ── Schema validation ────────────────────────────────────────────────────────

describe('validatePattern', () => {
  it('accepts a valid pattern', () => {
    const p = makePattern()
    expect(validatePattern(p)).not.toBeNull()
  })

  it('rejects pattern with non-zero first timeUs', () => {
    const p = makePattern()
    p.platter[0] = { timeUs: 1, turns: 0, touched: true }
    expect(validatePattern(p)).toBeNull()
  })

  it('rejects pattern with last time != durationUs', () => {
    const p = makePattern()
    p.platter[p.platter.length - 1] = { timeUs: 1_999_999, turns: 1, touched: false }
    expect(validatePattern(p)).toBeNull()
  })

  it('rejects empty lane', () => {
    const p = makePattern()
    p.platter = []
    expect(validatePattern(p)).toBeNull()
  })

  it('rejects non-increasing timestamps', () => {
    const p = makePattern()
    p.platter = [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 500_000, turns: 0.5, touched: true },
      { timeUs: 400_000, turns: 0.4, touched: true },
      { timeUs: 2_000_000, turns: 1, touched: false }
    ]
    expect(validatePattern(p)).toBeNull()
  })
})

describe('applyPlatterEdit', () => {
  it('returns validated pattern on valid edit', () => {
    const p = makePattern()
    const newPlatter = [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 2_000_000, turns: 2, touched: false }
    ]
    const result = applyPlatterEdit(p, newPlatter)
    expect(result).not.toBeNull()
    expect(result!.platter).toEqual(newPlatter)
  })

  it('returns null on invalid edit', () => {
    const p = makePattern()
    const badPlatter = [
      { timeUs: 100, turns: 0, touched: true },
      { timeUs: 2_000_000, turns: 1, touched: false }
    ]
    expect(applyPlatterEdit(p, badPlatter)).toBeNull()
  })
})

describe('applyCrossfaderEdit', () => {
  it('returns validated pattern on valid edit', () => {
    const p = makePattern()
    const newCf = [
      { timeUs: 0, value: 0.5 },
      { timeUs: 2_000_000, value: 0.5 }
    ]
    const result = applyCrossfaderEdit(p, newCf)
    expect(result).not.toBeNull()
    expect(result!.crossfader).toEqual(newCf)
  })
})
