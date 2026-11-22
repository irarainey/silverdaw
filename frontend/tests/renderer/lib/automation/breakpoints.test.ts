import { describe, it, expect } from 'vitest'
import { automationHandleAt, valueToLaneY } from '@/lib/timeline/automationLaneRenderer'
import {
  sanitizeBreakpoints,
  breakpointsEqual,
  sampleBreakpoints,
  insertBreakpoint,
  removeBreakpoint,
  moveBreakpoint,
  flatCurve,
  type Breakpoint
} from '@/lib/automation/breakpoints'

const SIGNED: { min: number; max: number } = { min: -1, max: 1 }

describe('sanitizeBreakpoints', () => {
  it('clamps values/time and sorts without dropping short ramps', () => {
    const out = sanitizeBreakpoints(
      [
        { timeMs: 100, value: 5 },
        { timeMs: -10, value: -5 },
        { timeMs: 100.0005, value: 0.2 },
        { timeMs: 50, value: 0.5 }
      ],
      SIGNED
    )
    expect(out).toEqual([
      { timeMs: 0, value: -1 },
      { timeMs: 50, value: 0.5 },
      { timeMs: 100, value: 1 },
      { timeMs: 100.0005, value: 0.2 }
    ])
  })

  it('drops non-finite points', () => {
    const out = sanitizeBreakpoints(
      [
        { timeMs: 0, value: 0 },
        { timeMs: Number.NaN, value: 1 },
        { timeMs: 10, value: Number.POSITIVE_INFINITY }
      ],
      SIGNED
    )
    expect(out).toEqual([{ timeMs: 0, value: 0 }])
  })
})

describe('breakpointsEqual', () => {
  it('is tolerant within thresholds and rejects beyond them', () => {
    const a: Breakpoint[] = [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 0.5 }]
    expect(breakpointsEqual(a, [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 0.50005 }])).toBe(true)
    expect(breakpointsEqual(a, [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 0.6 }])).toBe(false)
    expect(breakpointsEqual(a, undefined)).toBe(false)
    expect(breakpointsEqual(undefined, undefined)).toBe(true)
  })
})

describe('sampleBreakpoints', () => {
  it('linear-interpolates and clamps to endpoints', () => {
    const pts: Breakpoint[] = [
      { timeMs: 0, value: -1 },
      { timeMs: 1000, value: 1 }
    ]
    expect(sampleBreakpoints(pts, -100)).toBeCloseTo(-1, 6)
    expect(sampleBreakpoints(pts, 0)).toBeCloseTo(-1, 6)
    expect(sampleBreakpoints(pts, 500)).toBeCloseTo(0, 6)
    expect(sampleBreakpoints(pts, 1000)).toBeCloseTo(1, 6)
    expect(sampleBreakpoints(pts, 9999)).toBeCloseTo(1, 6)
  })

  it('decibel domain interpolates a linear gain in log space (geometric mean)', () => {
    const pts: Breakpoint[] = [
      { timeMs: 0, value: 1 },
      { timeMs: 1000, value: 0.25 }
    ]
    // dB interpolation is geometric: halfway between 1.0 and 0.25 is sqrt(0.25) = 0.5.
    expect(sampleBreakpoints(pts, 500, 'decibel')).toBeCloseTo(0.5, 4)
  })

  it('returns the single value for a one-point curve', () => {
    expect(sampleBreakpoints([{ timeMs: 0, value: 0.3 }], 999)).toBeCloseTo(0.3, 6)
  })
})

describe('insert/remove/move', () => {
  it('inserts a vertical step and sets its outgoing side at the playhead', () => {
    const base = flatCurve(1000, 0)
    const added = insertBreakpoint(base, 500, 0.5, SIGNED)
    expect(added.points).toHaveLength(3)
    expect(added.points[1]).toEqual({ timeMs: 500, value: 0.5 })
    const step = insertBreakpoint(added.points, 500, -0.5, SIGNED)
    expect(step.index).toBe(2)
    const replaced = insertBreakpoint(step.points, 500, -1, SIGNED, 'set')
    expect(replaced.points).toHaveLength(4)
    expect(sampleBreakpoints(replaced.points, 499.999)).toBeCloseTo(0.5)
    expect(sampleBreakpoints(replaced.points, 500)).toBe(-1)
  })

  it('remove keeps endpoints, drops interior', () => {
    const pts = insertBreakpoint(flatCurve(1000, 0), 500, 0.5, SIGNED).points
    expect(removeBreakpoint(pts, 0)).toHaveLength(3) // endpoint kept
    expect(removeBreakpoint(pts, 1)).toHaveLength(2) // interior removed
  })

  it('move clamps interior time between neighbours and clamps value', () => {
    const pts = insertBreakpoint(flatCurve(1000, 0), 500, 0, SIGNED).points
    const moved = moveBreakpoint(pts, 1, 5000, 9, SIGNED)
    expect(moved.points[1]).toEqual({ timeMs: 1000, value: 1 })
    expect(sampleBreakpoints(moved.points, 1000)).toBe(0)
  })

  it('move on an endpoint keeps its time but updates value', () => {
    const pts = flatCurve(1000, 0)
    const moved = moveBreakpoint(pts, 0, 400, 0.7, SIGNED)
    expect(moved.points[0]).toEqual({ timeMs: 0, value: 0.7 })
  })

  it('retains both handles on collision and tracks the chosen one when detaching across its peer', () => {
    const pts = [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 },
      { timeMs: 1005, value: -1 }, { timeMs: 5000, value: -1 }]
    const step = sanitizeBreakpoints(moveBreakpoint(pts, 2, 1000, -1, SIGNED).points, SIGNED)
    expect(step).toEqual(pts.map((p, i) => i === 2 ? { ...p, timeMs: 1000 } : p))
    const detached = moveBreakpoint(step, 2, 995, -1, SIGNED)
    expect(detached.index).toBe(1)
    expect(detached.points.slice(1, 3)).toEqual([{ timeMs: 995, value: -1 }, pts[1]])
  })
})

it('picks the closest visible handle in both axes in a resized lane', () => {
  const pts = [{ timeMs: 1000, value: 0 }, { timeMs: 1000, value: -6 }]
  const hit = (value: number) => automationHandleAt(pts, 'level', 1000,
    valueToLaneY('level', value, 230, 160), 230, 160, 120)
  expect(hit(0)).toBe(0)
  expect(hit(-6)).toBe(1)
  expect(hit(-50)).toBe(-1)
})
