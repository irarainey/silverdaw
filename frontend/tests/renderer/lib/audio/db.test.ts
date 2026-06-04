import { describe, expect, it } from 'vitest'
import {
  dbToLinear,
  formatDb,
  formatLinearAsDb,
  linearToDb,
  linearToTaperPosition,
  MAX_MASTER_DB,
  MAX_TRACK_DB,
  MAX_TRACK_GAIN_LINEAR,
  MIN_DISPLAY_DB,
  parseDbInput,
  taperDbToPosition,
  taperPositionToDb,
  taperPositionToLinear
} from '@/lib/audio/db'

describe('linearToDb / dbToLinear', () => {
  it('round-trips unity', () => {
    expect(linearToDb(1)).toBe(0)
    expect(dbToLinear(0)).toBe(1)
  })

  it('maps a true mute to -Infinity ↔ 0', () => {
    expect(linearToDb(0)).toBe(-Infinity)
    expect(dbToLinear(-Infinity)).toBe(0)
  })

  it('treats negative linear inputs as silence', () => {
    expect(linearToDb(-0.01)).toBe(-Infinity)
  })

  it('matches the canonical +6 dB ↔ ~1.9953 ratio', () => {
    expect(linearToDb(MAX_TRACK_GAIN_LINEAR)).toBeCloseTo(MAX_TRACK_DB, 6)
    expect(dbToLinear(MAX_TRACK_DB)).toBeCloseTo(MAX_TRACK_GAIN_LINEAR, 6)
  })

  it('matches the canonical -6 dB ↔ 0.5 ratio', () => {
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3)
  })
})

describe('formatDb', () => {
  it('renders -Infinity as -∞', () => {
    expect(formatDb(-Infinity)).toBe('-∞')
    expect(formatDb(-Infinity, { unit: true })).toBe('-∞ dB')
  })

  it('emits a leading + for non-negative values', () => {
    expect(formatDb(0)).toBe('+0.0')
    expect(formatDb(3.456)).toBe('+3.5')
  })

  it('renders attenuation with its native minus sign', () => {
    expect(formatDb(-3.5)).toBe('-3.5')
  })

  it('clamps below MIN_DISPLAY_DB to the floor (not to -∞)', () => {
    // A finite gain at -120 dB is still non-zero — the user shouldn't
    // confuse it with the muted state.
    expect(formatDb(-90)).toBe(`${MIN_DISPLAY_DB.toFixed(1)}`)
  })

  it('honours a custom decimals option', () => {
    expect(formatDb(0.123, { decimals: 2 })).toBe('+0.12')
  })
})

describe('formatLinearAsDb', () => {
  it('renders zero gain as -∞', () => {
    expect(formatLinearAsDb(0)).toBe('-∞')
  })

  it('renders unity as +0.0', () => {
    expect(formatLinearAsDb(1)).toBe('+0.0')
  })
})

describe('taperPositionToDb / taperDbToPosition', () => {
  it('maps position 0 to -Infinity', () => {
    expect(taperPositionToDb(0, MAX_TRACK_DB)).toBe(-Infinity)
  })

  it('maps position 1 to maxDb', () => {
    expect(taperPositionToDb(1, MAX_TRACK_DB)).toBe(MAX_TRACK_DB)
    expect(taperPositionToDb(1, MAX_MASTER_DB)).toBe(MAX_MASTER_DB)
  })

  it('puts 0 dB near the top of the track fader (above 0.9)', () => {
    const unityPos = taperDbToPosition(0, MAX_TRACK_DB)
    expect(unityPos).toBeGreaterThan(0.9)
    expect(unityPos).toBeLessThan(1)
  })

  it('puts 0 dB at exactly the top of the master fader', () => {
    expect(taperDbToPosition(0, MAX_MASTER_DB)).toBe(1)
  })

  it('round-trips a sample of dB values for track maxDb', () => {
    for (const db of [-60, -40, -20, -10, -6, -3, 0, 3, 6]) {
      const pos = taperDbToPosition(db, MAX_TRACK_DB)
      expect(taperPositionToDb(pos, MAX_TRACK_DB)).toBeCloseTo(db, 6)
    }
  })

  it('round-trips a sample of dB values for master maxDb', () => {
    for (const db of [-60, -40, -20, -6, 0]) {
      const pos = taperDbToPosition(db, MAX_MASTER_DB)
      expect(taperPositionToDb(pos, MAX_MASTER_DB)).toBeCloseTo(db, 6)
    }
  })

  it('is monotonic across the full range', () => {
    let prev = -Infinity
    for (let i = 0; i <= 100; i += 1) {
      const db = taperPositionToDb(i / 100, MAX_TRACK_DB)
      expect(db).toBeGreaterThanOrEqual(prev)
      prev = db
    }
  })

  it('round-trips -Infinity through the position layer', () => {
    expect(taperDbToPosition(-Infinity, MAX_TRACK_DB)).toBe(0)
    expect(taperPositionToDb(0, MAX_TRACK_DB)).toBe(-Infinity)
  })

  it('round-trips zero gain through the linear-position layer', () => {
    expect(linearToTaperPosition(0, MAX_TRACK_DB)).toBe(0)
    expect(taperPositionToLinear(0, MAX_TRACK_DB)).toBe(0)
  })

  it('round-trips unity through the linear-position layer', () => {
    const pos = linearToTaperPosition(1, MAX_TRACK_DB)
    expect(taperPositionToLinear(pos, MAX_TRACK_DB)).toBeCloseTo(1, 6)
  })
})

describe('parseDbInput', () => {
  it('accepts plain numbers', () => {
    expect(parseDbInput('0')).toBe(0)
    expect(parseDbInput('-3')).toBe(-3)
    expect(parseDbInput('+1.5')).toBe(1.5)
    expect(parseDbInput('  -12.25  ')).toBe(-12.25)
  })

  it('accepts an optional dB unit suffix', () => {
    expect(parseDbInput('-3 dB')).toBe(-3)
    expect(parseDbInput('+1.5db')).toBe(1.5)
    expect(parseDbInput('0 DB')).toBe(0)
  })

  it('recognises the canonical minus-infinity spellings', () => {
    expect(parseDbInput('-∞')).toBe(-Infinity)
    expect(parseDbInput('-inf')).toBe(-Infinity)
    expect(parseDbInput('-infinity')).toBe(-Infinity)
  })

  it('returns null on garbage', () => {
    expect(parseDbInput('hello')).toBeNull()
    expect(parseDbInput('')).toBeNull()
    expect(parseDbInput('   ')).toBeNull()
    expect(parseDbInput('NaN')).toBeNull()
  })
})
