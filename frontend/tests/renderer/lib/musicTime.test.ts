import { describe, expect, it } from 'vitest'
import {
  barPositionDisplay,
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_SUBS_PER_BEAT,
  formatTime,
  msPerSubBeat,
  parseTime
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
