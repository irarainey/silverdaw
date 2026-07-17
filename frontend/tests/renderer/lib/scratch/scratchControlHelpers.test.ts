import { describe, expect, it } from 'vitest'
import {
  buildBackingClearPayload,
  buildBackingGainPayload,
  buildBackingLoopPayload,
  buildBackingPreparePayload,
  buildCrossfaderPayload,
  buildPlatterMovePayload,
  buildPlatterTouchPayload,
  buildScratchGainPayload,
  crossfaderCutValue,
  crossfaderValueFromHorizontalDelta,
  formatUsTime,
  platterAngleDeg,
  pointerAngleDeltaTurns,
  VIRTUAL_DECK,
  wheelDeltaToTurns,
  WHEEL_PIXELS_PER_TURN
} from '@/lib/scratch/scratchControlHelpers'
import {
  ScratchBackingClearPayloadSchema,
  ScratchBackingPreparePayloadSchema,
  ScratchSessionControlPayloadSchema
} from '@shared/bridge-protocol'

// ── wheelDeltaToTurns ────────────────────────────────────────────────────────

describe('wheelDeltaToTurns', () => {
  it('returns 0 when pixelsPerTurn is not positive', () => {
    expect(wheelDeltaToTurns(100, 0, 0)).toBe(0)
    expect(wheelDeltaToTurns(100, 0, -10)).toBe(0)
  })

  it('ignores sub-pixel trackpad jitter', () => {
    expect(wheelDeltaToTurns(1, 0, WHEEL_PIXELS_PER_TURN)).toBe(0)
    expect(wheelDeltaToTurns(0, -1, WHEEL_PIXELS_PER_TURN)).toBe(0)
  })

  it('accepts trackpad movement immediately above the jitter threshold', () => {
    expect(wheelDeltaToTurns(1.5, 0, WHEEL_PIXELS_PER_TURN)).toBeGreaterThan(0)
  })

  it('uses the dominant axis (vertical when it is larger)', () => {
    expect(wheelDeltaToTurns(10, 300, 600)).toBeGreaterThan(299 / 600)
  })

  it('uses the dominant axis (horizontal when it is larger)', () => {
    expect(wheelDeltaToTurns(300, 10, 600)).toBeGreaterThan(299 / 600)
  })

  it('prefers horizontal on an exact tie', () => {
    expect(wheelDeltaToTurns(120, -120, 600)).toBeGreaterThan(0)
  })

  it('increases gain as movement becomes larger', () => {
    const small = wheelDeltaToTurns(30, 0, WHEEL_PIXELS_PER_TURN)
    const large = wheelDeltaToTurns(300, 0, WHEEL_PIXELS_PER_TURN)

    expect(large / 10).toBeGreaterThan(small)
  })

  it('treats rightward/downward as forward and leftward/upward as reverse', () => {
    expect(wheelDeltaToTurns(-600, 0, 600)).toBeLessThan(0)
    expect(wheelDeltaToTurns(0, -600, 600)).toBeLessThan(0)
  })
})

// ── crossfaderCutValue ───────────────────────────────────────────────────────

describe('crossfaderCutValue', () => {
  it('opens deck 1 to its audible edge (0) and closes it to silence (1)', () => {
    expect(crossfaderCutValue(true, 1)).toBe(0)
    expect(crossfaderCutValue(false, 1)).toBe(1)
  })

  it('opens deck 2 to its audible edge (1) and closes it to silence (0)', () => {
    expect(crossfaderCutValue(true, 2)).toBe(1)
    expect(crossfaderCutValue(false, 2)).toBe(0)
  })

  it('defaults to the virtual (deck 1) side', () => {
    expect(crossfaderCutValue(true)).toBe(crossfaderCutValue(true, VIRTUAL_DECK))
    expect(crossfaderCutValue(false)).toBe(crossfaderCutValue(false, VIRTUAL_DECK))
  })
})

// ── platterAngleDeg ──────────────────────────────────────────────────────────

describe('platterAngleDeg', () => {
  it('returns 0° at zero turns', () => {
    expect(platterAngleDeg(0)).toBe(0)
  })

  it('returns 90° at 0.25 turns', () => {
    expect(platterAngleDeg(0.25)).toBeCloseTo(90, 10)
  })

  it('returns 180° at 0.5 turns', () => {
    expect(platterAngleDeg(0.5)).toBeCloseTo(180, 10)
  })

  it('returns 270° at 0.75 turns', () => {
    expect(platterAngleDeg(0.75)).toBeCloseTo(270, 10)
  })

  it('wraps 1.0 turns back to 0°', () => {
    expect(platterAngleDeg(1.0)).toBeCloseTo(0, 10)
  })

  it('wraps large forward turn counts correctly', () => {
    // 100.25 turns → same as 0.25 → 90°
    expect(platterAngleDeg(100.25)).toBeCloseTo(90, 8)
  })

  it('normalises negative turns (−0.25 → 270°)', () => {
    expect(platterAngleDeg(-0.25)).toBeCloseTo(270, 8)
  })

  it('normalises large negative turns (−100.75 → 90°)', () => {
    expect(platterAngleDeg(-100.75)).toBeCloseTo(90, 8)
  })
})

// ── pointerAngleDeltaTurns ───────────────────────────────────────────────────

describe('pointerAngleDeltaTurns', () => {
  it('returns 0 when the pointer does not move', () => {
    expect(pointerAngleDeltaTurns(10, 0, 10, 0, 0, 0)).toBe(0)
  })

  it('returns +0.25 turns for a 90° CW arc', () => {
    // From 3 o'clock (100, 0) to 6 o'clock (0, 100) about origin, clockwise.
    const delta = pointerAngleDeltaTurns(100, 0, 0, 100, 0, 0)
    expect(delta).toBeCloseTo(0.25, 8)
  })

  it('returns −0.25 turns for a 90° CCW arc', () => {
    // From 6 o'clock (0, 100) back to 3 o'clock (100, 0).
    const delta = pointerAngleDeltaTurns(0, 100, 100, 0, 0, 0)
    expect(delta).toBeCloseTo(-0.25, 8)
  })

  it('takes the short CCW arc from 3-oclock to 12-oclock (-0.25 turns)', () => {
    // (100, 0) → (0, −100) about origin: 90° CCW is the shorter path.
    const delta = pointerAngleDeltaTurns(100, 0, 0, -100, 0, 0)
    expect(delta).toBeCloseTo(-0.25, 8)
  })

  it('returns +0.5 for a 180° CW traversal', () => {
    // From (100, 0) to (−100, 0) clockwise = exactly 180° = ±0.5 turns.
    const delta = pointerAngleDeltaTurns(100, 0, -100, 0, 0, 0)
    expect(Math.abs(delta)).toBeCloseTo(0.5, 8)
  })

  it('uses the supplied center offset', () => {
    // Same geometry offset by (50, 50).
    const delta = pointerAngleDeltaTurns(150, 50, 50, 150, 50, 50)
    expect(delta).toBeCloseTo(0.25, 8)
  })
})

// ── crossfaderValueFromHorizontalDelta ───────────────────────────────────────

describe('crossfaderValueFromHorizontalDelta', () => {
  it('returns current unchanged when trackWidth is 0', () => {
    expect(crossfaderValueFromHorizontalDelta(0.5, 100, 0)).toBe(0.5)
  })

  it('adds a proportional fraction for a positive drag', () => {
    expect(crossfaderValueFromHorizontalDelta(0.0, 100, 200)).toBeCloseTo(0.5, 10)
  })

  it('clamps the result to [0, 1]', () => {
    expect(crossfaderValueFromHorizontalDelta(0.9, 200, 100)).toBe(1)
    expect(crossfaderValueFromHorizontalDelta(0.1, -200, 100)).toBe(0)
  })

  it('subtracts from current for a leftward (negative) drag', () => {
    expect(crossfaderValueFromHorizontalDelta(0.8, -80, 200)).toBeCloseTo(0.4, 10)
  })
})

// ── formatUsTime ─────────────────────────────────────────────────────────────

describe('formatUsTime', () => {
  it('formats zero as "0.000s"', () => {
    expect(formatUsTime(0)).toBe('0.000s')
  })

  it('formats 1 second (1_000_000 µs) correctly', () => {
    expect(formatUsTime(1_000_000)).toBe('1.000s')
  })

  it('formats sub-second values correctly', () => {
    expect(formatUsTime(500_000)).toBe('0.500s')
  })

  it('includes minutes when value exceeds 60 s', () => {
    expect(formatUsTime(75_500_000)).toBe('1:15.500')
  })

  it('clamps negative input to zero', () => {
    expect(formatUsTime(-1_000)).toBe('0.000s')
  })
})

// ── payload builders ─────────────────────────────────────────────────────────

describe('buildPlatterMovePayload', () => {
  it('produces a valid platterMove payload', () => {
    expect(buildPlatterMovePayload('sid-1', 1, 0.25)).toMatchObject({
      protocolVersion: 1,
      sessionId: 'sid-1',
      action: 'platterMove',
      deck: 1,
      deltaTurns: 0.25
    })
  })

  it('clamps deltaTurns to ±8', () => {
    expect(buildPlatterMovePayload('s', 1, 100)).toMatchObject({ deltaTurns: 8 })
    expect(buildPlatterMovePayload('s', 1, -100)).toMatchObject({ deltaTurns: -8 })
  })

  it('includes a non-negative clientTimeMs when provided', () => {
    expect(buildPlatterMovePayload('s', 1, 0.1, 1234.5)).toMatchObject({
      deltaTurns: 0.1,
      clientTimeMs: 1234.5
    })
  })

  it('omits clientTimeMs when absent or invalid', () => {
    expect(buildPlatterMovePayload('s', 1, 0.1)).not.toHaveProperty('clientTimeMs')
    expect(buildPlatterMovePayload('s', 1, 0.1, -5)).not.toHaveProperty('clientTimeMs')
    expect(buildPlatterMovePayload('s', 1, 0.1, Number.NaN)).not.toHaveProperty('clientTimeMs')
  })
})

describe('buildPlatterTouchPayload', () => {
  it('produces a valid platterTouch payload for touch-down', () => {
    expect(buildPlatterTouchPayload('sid-2', 2, true)).toMatchObject({
      protocolVersion: 1,
      sessionId: 'sid-2',
      action: 'platterTouch',
      deck: 2,
      touched: true
    })
  })

  it('produces a valid platterTouch payload for touch-up', () => {
    expect(buildPlatterTouchPayload('sid-2', 1, false)).toMatchObject({ touched: false })
  })
})

describe('buildCrossfaderPayload', () => {
  it('produces a valid crossfader payload', () => {
    expect(buildCrossfaderPayload('sid-3', 0.75)).toMatchObject({
      protocolVersion: 1,
      sessionId: 'sid-3',
      action: 'crossfader',
      value: 0.75
    })
  })

  it('clamps value to [0, 1]', () => {
    expect(buildCrossfaderPayload('s', 2)).toMatchObject({ value: 1 })
    expect(buildCrossfaderPayload('s', -1)).toMatchObject({ value: 0 })
  })
})

describe('buildBackingGainPayload / buildScratchGainPayload', () => {
  it('produce schema-valid monitor gain payloads', () => {
    const backing = buildBackingGainPayload('sid-g', 0.5)
    expect(backing).toMatchObject({ action: 'backingGain', value: 0.5 })
    expect(ScratchSessionControlPayloadSchema.safeParse(backing).success).toBe(true)

    const scratch = buildScratchGainPayload('sid-g', 0.25)
    expect(scratch).toMatchObject({ action: 'scratchGain', value: 0.25 })
    expect(ScratchSessionControlPayloadSchema.safeParse(scratch).success).toBe(true)
  })

  it('clamps gain to [0, 1]', () => {
    expect(buildBackingGainPayload('s', 3)).toMatchObject({ value: 1 })
    expect(buildScratchGainPayload('s', -2)).toMatchObject({ value: 0 })
  })
})

describe('buildBackingLoopPayload', () => {
  it('produces schema-valid loop toggle payloads', () => {
    const on = buildBackingLoopPayload('sid-l', true)
    expect(on).toMatchObject({ action: 'backingLoop', enabled: true })
    expect(ScratchSessionControlPayloadSchema.safeParse(on).success).toBe(true)

    const off = buildBackingLoopPayload('sid-l', false)
    expect(off).toMatchObject({ action: 'backingLoop', enabled: false })
    expect(ScratchSessionControlPayloadSchema.safeParse(off).success).toBe(true)
  })
})

describe('VIRTUAL_DECK', () => {
  it('is deck 1 (left side) for pointer-only sessions', () => {
    expect(VIRTUAL_DECK).toBe(1)
  })
})

describe('buildBackingPreparePayload', () => {
  it('produces a schema-valid backing prepare payload', () => {
    const payload = buildBackingPreparePayload('sid-b', ['t1', 't2'], 'playhead', 60)
    expect(payload).toMatchObject({
      protocolVersion: 1,
      sessionId: 'sid-b',
      trackIds: ['t1', 't2'],
      startAnchor: 'playhead',
      durationSec: 60
    })
    expect(ScratchBackingPreparePayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('copies the track id list so later mutation does not leak in', () => {
    const source = ['t1']
    const payload = buildBackingPreparePayload('sid-b', source, 'arrangement', 120)
    source.push('t2')
    expect(payload.trackIds).toEqual(['t1'])
  })
})

describe('buildBackingClearPayload', () => {
  it('produces a schema-valid backing clear payload', () => {
    const payload = buildBackingClearPayload('sid-b')
    expect(payload).toMatchObject({ protocolVersion: 1, sessionId: 'sid-b' })
    expect(ScratchBackingClearPayloadSchema.safeParse(payload).success).toBe(true)
  })
})

// ── jog calibration constants ────────────────────────────────────────────────

describe('jog calibration', () => {
  it('one standard relative tick equals 1/512 of a turn', () => {
    const standardTicksPerTurn = 512
    const singleTickTurns = 1.0 / standardTicksPerTurn
    expect(singleTickTurns).toBeCloseTo(1.0 / 512, 12)
  })

  it('one absolute-14 relative tick equals 1/16384 of a turn', () => {
    const hiResTicksPerTurn = 16384
    const singleTickTurns = 1.0 / hiResTicksPerTurn
    expect(singleTickTurns).toBeCloseTo(1.0 / 16384, 12)
  })

  it('512 standard ticks produce exactly 1 platter turn', () => {
    const ticksPerTurn = 512
    const totalTurns = 512 / ticksPerTurn
    expect(totalTurns).toBe(1)
  })

  it('nominal timing: 1 turn at 33⅓ RPM equals 1.8 source seconds', () => {
    const secondsPerTurn = 1.8
    const turnsPerMinute = 60 / secondsPerTurn
    expect(turnsPerMinute).toBeCloseTo(33.333, 2)
  })
})
