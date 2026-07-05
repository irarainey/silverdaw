import { describe, expect, it } from 'vitest'
import { snapToDetent, parseDetentBinding } from '@/directives/vSliderDetent'

describe('snapToDetent', () => {
  it('snaps values within the detent band to the detent', () => {
    // Pan range -1..1: band = 2 * 0.03 = 0.06.
    expect(snapToDetent(0.05, 0, -1, 1)).toBe(0)
    expect(snapToDetent(-0.04, 0, -1, 1)).toBe(0)
  })

  it('leaves values outside the band unchanged', () => {
    expect(snapToDetent(0.2, 0, -1, 1)).toBe(0.2)
    expect(snapToDetent(-0.5, 0, -1, 1)).toBe(-0.5)
  })

  it('honours a non-zero detent inside the track', () => {
    // Range 0..100, band = 3; detent at 50.
    expect(snapToDetent(51, 50, 0, 100)).toBe(50)
    expect(snapToDetent(60, 50, 0, 100)).toBe(60)
  })

  it('does nothing when the detent is not strictly inside the track', () => {
    // Detent at the min (unipolar 0..100) never snaps.
    expect(snapToDetent(1, 0, 0, 100)).toBe(1)
    expect(snapToDetent(100, 100, 0, 100)).toBe(100)
  })

  it('scales the band with the range (cents -100..100)', () => {
    // band = 200 * 0.03 = 6.
    expect(snapToDetent(5, 0, -100, 100)).toBe(0)
    expect(snapToDetent(7, 0, -100, 100)).toBe(7)
  })

  it('returns the raw value for non-finite inputs', () => {
    expect(snapToDetent(Number.NaN, 0, -1, 1)).toBeNaN()
    expect(snapToDetent(0.01, Number.NaN, -1, 1)).toBe(0.01)
    expect(snapToDetent(0.01, 0, Number.NaN, 1)).toBe(0.01)
  })
})

describe('parseDetentBinding', () => {
  it('accepts a bare number as a snap-only detent', () => {
    expect(parseDetentBinding(0)).toEqual({ value: 0, reset: false })
    expect(parseDetentBinding(-3)).toEqual({ value: -3, reset: false })
  })

  it('accepts an object with an explicit reset flag', () => {
    expect(parseDetentBinding({ value: 0, reset: true })).toEqual({ value: 0, reset: true })
    expect(parseDetentBinding({ value: 0 })).toEqual({ value: 0, reset: false })
  })

  it('returns null when disabled or invalid', () => {
    expect(parseDetentBinding(undefined)).toBeNull()
    expect(parseDetentBinding(null)).toBeNull()
    expect(parseDetentBinding(Number.NaN)).toBeNull()
    expect(parseDetentBinding({})).toBeNull()
    expect(parseDetentBinding({ value: 'x' })).toBeNull()
  })
})
