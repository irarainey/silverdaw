import { describe, it, expect } from 'vitest'
import {
  BEATS_PER_BAR,
  DEFAULT_SNAP_GRID,
  SNAP_GRIDS,
  beatsPerSnapStep,
  gridSubdivisionsPerBeat,
  isSnapGrid,
  snapsFreely,
  toSnapGrid
} from '@shared/snapGrid'
import { msPerSnapUnit, snapMs } from '@/lib/musicTime'

describe('snapGrid model', () => {
  it('defaults to a quarter beat so existing behaviour is preserved', () => {
    expect(DEFAULT_SNAP_GRID).toBe('quarter')
    expect(gridSubdivisionsPerBeat(DEFAULT_SNAP_GRID)).toBe(4)
  })

  it('recognises only the known grids', () => {
    for (const grid of SNAP_GRIDS) expect(isSnapGrid(grid)).toBe(true)
    expect(isSnapGrid('sixteenth')).toBe(false)
    expect(isSnapGrid(undefined)).toBe(false)
    expect(isSnapGrid(4)).toBe(false)
  })

  it('falls back to the default for anything unrecognised', () => {
    expect(toSnapGrid('bar')).toBe('bar')
    expect(toSnapGrid('nonsense')).toBe(DEFAULT_SNAP_GRID)
    expect(toSnapGrid(undefined)).toBe(DEFAULT_SNAP_GRID)
    expect(toSnapGrid(null)).toBe(DEFAULT_SNAP_GRID)
  })

  it('spans a bar, beat and fractions of a beat', () => {
    expect(beatsPerSnapStep('bar')).toBe(BEATS_PER_BAR)
    expect(beatsPerSnapStep('beat')).toBe(1)
    expect(beatsPerSnapStep('half')).toBe(0.5)
    expect(beatsPerSnapStep('quarter')).toBe(0.25)
  })

  it('treats only Free as unsnapped', () => {
    expect(snapsFreely('free')).toBe(true)
    for (const grid of SNAP_GRIDS.filter((g) => g !== 'free')) {
      expect(snapsFreely(grid)).toBe(false)
    }
  })

  it('keeps drawn subdivisions to values the integer tick maths can use', () => {
    for (const grid of SNAP_GRIDS) {
      expect([1, 2, 4]).toContain(gridSubdivisionsPerBeat(grid))
    }
  })

  it('suppresses the fine tier at beat and bar, and keeps it for Free', () => {
    expect(gridSubdivisionsPerBeat('bar')).toBe(1)
    expect(gridSubdivisionsPerBeat('beat')).toBe(1)
    expect(gridSubdivisionsPerBeat('half')).toBe(2)
    expect(gridSubdivisionsPerBeat('free')).toBe(4)
  })
})

describe('msPerSnapUnit', () => {
  it('scales each grid from the beat length', () => {
    // 120 BPM: one beat is 500 ms.
    expect(msPerSnapUnit(120, 'bar')).toBeCloseTo(2000, 6)
    expect(msPerSnapUnit(120, 'beat')).toBeCloseTo(500, 6)
    expect(msPerSnapUnit(120, 'half')).toBeCloseTo(250, 6)
    expect(msPerSnapUnit(120, 'quarter')).toBeCloseTo(125, 6)
  })

  it('reports Free as zero so callers must branch rather than divide', () => {
    expect(msPerSnapUnit(120, 'free')).toBe(0)
  })

  it('clamps a nonsensical BPM instead of returning infinity', () => {
    expect(Number.isFinite(msPerSnapUnit(0, 'beat'))).toBe(true)
  })
})

describe('snapMs', () => {
  it('quantises to the selected grid', () => {
    expect(snapMs(1100, 120, 'beat', false)).toBe(1000)
    expect(snapMs(1300, 120, 'beat', false)).toBe(1500)
    expect(snapMs(1100, 120, 'bar', false)).toBe(2000)
    expect(snapMs(1100, 120, 'quarter', false)).toBe(1125)
  })

  it('places exactly under Alt fine mode', () => {
    expect(snapMs(1103.4, 120, 'beat', true)).toBe(1103)
  })

  it('places exactly on a Free grid, so Alt is a no-op rather than an inversion', () => {
    expect(snapMs(1103.4, 120, 'free', false)).toBe(1103)
    expect(snapMs(1103.4, 120, 'free', true)).toBe(1103)
  })

  it('never returns a negative position', () => {
    expect(snapMs(-500, 120, 'beat', false)).toBe(0)
    expect(snapMs(-500, 120, 'free', false)).toBe(0)
  })
})
