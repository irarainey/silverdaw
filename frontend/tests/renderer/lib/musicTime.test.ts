import { describe, expect, it } from 'vitest'
import {
  barPositionDisplay,
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_SUBS_PER_BEAT,
  formatRulerTime,
  formatTime,
  freeGridStepMs,
  msPerSubBeat,
  parseTime,
  startMsForAlignedBeat,
  stepToGridMs
} from '@/lib/musicTime'

describe('formatTime', () => {
  it('formats 0 ms as 00:00', () => {
    expect(formatTime(0)).toBe('00:00')
  })

  it('formats sub-minute durations as mm:ss', () => {
    expect(formatTime(65_500)).toBe('01:05')
  })

  it('switches to h:mm:ss when over an hour', () => {
    expect(formatTime(3_661_000)).toBe('1:01:01')
  })

  it('clamps negative values to zero', () => {
    expect(formatTime(-1234)).toBe('00:00')
  })
})

describe('formatRulerTime', () => {
  it('keeps minute-and-second labels when sub-second precision is needed', () => {
    expect(formatRulerTime(5_430, 100)).toBe('0:05.4')
    expect(formatRulerTime(65_430, 50)).toBe('1:05.43')
  })

  it('rounds sub-second labels across a minute boundary', () => {
    expect(formatRulerTime(59_999, 100)).toBe('1:00.0')
  })

  it('omits fractional seconds for coarse ruler ticks', () => {
    expect(formatRulerTime(65_430, 1_000)).toBe('1:05')
  })
})

describe('parseTime', () => {
  it('parses bare seconds', () => {
    expect(parseTime('5')).toBe(5_000)
  })

  it('parses mm:ss', () => {
    expect(parseTime('1:30')).toBe(90_000)
  })

  it('parses h:mm:ss', () => {
    expect(parseTime('1:02:03')).toBe(3_723_000)
  })

  it('returns null for garbage input', () => {
    expect(parseTime('abc')).toBeNull()
  })

  it('returns null for negative components', () => {
    expect(parseTime('-1')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseTime('   ')).toBeNull()
  })
})

describe('msPerSubBeat', () => {
  it('returns 125 ms at 120 BPM with 4 subs/beat', () => {
    expect(msPerSubBeat(120, 4)).toBeCloseTo(125, 6)
  })

  it('defaults to DEFAULT_SUBS_PER_BEAT when omitted', () => {
    expect(msPerSubBeat(120)).toBeCloseTo(60_000 / (120 * DEFAULT_SUBS_PER_BEAT), 6)
  })

  it('clamps bpm to >= 1 so it never divides by zero', () => {
    expect(Number.isFinite(msPerSubBeat(0))).toBe(true)
  })
})

describe('freeGridStepMs', () => {
  it('borrows the quarter-beat step so Free is not a 1 ms crawl', () => {
    expect(freeGridStepMs(120)).toBeCloseTo(125, 6)
  })

  it('scales with tempo', () => {
    expect(freeGridStepMs(60)).toBeCloseTo(250, 6)
  })

  it('clamps bpm to >= 1 so it never divides by zero', () => {
    expect(Number.isFinite(freeGridStepMs(0))).toBe(true)
  })
})

describe('stepToGridMs', () => {
  // 120 bpm: beat = 500 ms, quarter beat = 125 ms, bar = 2000 ms.
  it('always moves, even from a position already on a grid line', () => {
    expect(stepToGridMs(500, 120, 'beat', 1)).toBeCloseTo(1000, 6)
    expect(stepToGridMs(500, 120, 'beat', -1)).toBeCloseTo(0, 6)
  })

  it('lands on the enclosing lines from a position between two', () => {
    expect(stepToGridMs(600, 120, 'beat', 1)).toBeCloseTo(1000, 6)
    expect(stepToGridMs(600, 120, 'beat', -1)).toBeCloseTo(500, 6)
  })

  it('honours the grid size', () => {
    expect(stepToGridMs(0, 120, 'quarter', 1)).toBeCloseTo(125, 6)
    expect(stepToGridMs(0, 120, 'half', 1)).toBeCloseTo(250, 6)
    expect(stepToGridMs(0, 120, 'bar', 1)).toBeCloseTo(2000, 6)
  })

  it('never returns a negative position', () => {
    expect(stepToGridMs(0, 120, 'beat', -1)).toBe(0)
    expect(stepToGridMs(10, 120, 'free', -1)).toBe(0)
  })

  it('steps relatively on a Free grid, preserving the off-grid offset', () => {
    // The whole point of Free: 613 must not be pulled onto a 125 ms line.
    expect(stepToGridMs(613, 120, 'free', 1)).toBeCloseTo(738, 6)
    expect(stepToGridMs(613, 120, 'free', -1)).toBeCloseTo(488, 6)
  })

  it('uses the same step size on Free as a quarter beat', () => {
    const from = 1000
    const quarter = stepToGridMs(from, 120, 'quarter', 1) - from
    const free = stepToGridMs(from, 120, 'free', 1) - from
    expect(free).toBeCloseTo(quarter, 6)
  })
})

describe('barPositionDisplay', () => {
  it('shows 0.0.0 at position 0', () => {
    expect(barPositionDisplay(0, 120)).toBe('0.0.0')
  })

  it('rolls up to the next bar at an exact bar boundary (no float drift)', () => {
    // At 120 BPM with 4/4, one bar = 4 beats * 500 ms = 2000 ms.
    expect(barPositionDisplay(2000, 120)).toBe('1.0.0')
  })

  it('renders mid-bar positions with bar.beat.sub', () => {
    // At 120 BPM with 4 subs/beat, one sub = 125 ms.
    // 125 ms after bar 1 = bar 1, beat 0, sub 1.
    expect(barPositionDisplay(2125, 120)).toBe('1.0.1')
  })

  it('respects custom beats-per-bar', () => {
    // 3/4: one bar = 3 beats. At 120 BPM that's 1500 ms.
    expect(barPositionDisplay(1500, 120, { beatsPerBar: 3 })).toBe('1.0.0')
    // Sanity: same constants exposed for callers
    expect(DEFAULT_BEATS_PER_BAR).toBe(4)
  })
})

// Beat-aware placement snaps the clip's first source beat, not its left edge, so the
// start can resolve before the timeline origin. Clamping that to 0 used to leave the
// beat off the line by the whole offset — and always in the same direction, which is
// what made a clip dropped at the very start draw its first marker slightly ahead of
// bar 1 no matter how carefully it was placed.
describe('startMsForAlignedBeat', () => {
  const BPM = 94.05
  const beatMs = 60_000 / BPM

  it('backs the offset out of a grid position that clears the origin', () => {
    expect(startMsForAlignedBeat(beatMs, 61, BPM, 'quarter')).toBeCloseTo(beatMs - 61, 9)
  })

  it('steps forward a whole snap unit rather than clamping to the origin', () => {
    const subMs = beatMs / 4
    const start = startMsForAlignedBeat(0, 61, BPM, 'quarter')
    expect(start).toBeGreaterThan(0)
    // The beat still lands on a grid line — the whole point of aligning it.
    expect(((start + 61) / subMs) % 1).toBeCloseTo(0, 9)
    expect(start).toBeCloseTo(subMs - 61, 9)
  })

  it('steps far enough for an offset longer than one snap unit', () => {
    const subMs = beatMs / 4
    const offset = subMs * 2.5
    const start = startMsForAlignedBeat(0, offset, BPM, 'quarter')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(((start + offset) / subMs) % 1).toBeCloseTo(0, 9)
  })

  it('clamps on a Free grid, which has no line to step to', () => {
    expect(startMsForAlignedBeat(0, 61, BPM, 'free')).toBe(0)
  })
})

