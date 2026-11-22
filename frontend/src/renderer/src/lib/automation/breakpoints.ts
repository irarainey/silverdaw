// Generic timeline breakpoint-curve maths, shared by track automation lanes (and
// available to the per-clip volume envelope, which keeps its own dB-domain hot
// path). A breakpoint is `{ timeMs, value }`; values are stored in each
// parameter's native unit (dB, signed position, 0..1, …) and interpolated in the
// domain the parameter declares. Pure and allocation-light so it can back both
// editing and rendering.

export interface Breakpoint {
  /** Timeline-absolute milliseconds (sorted ascending). */
  timeMs: number
  /** Value in the parameter's native unit. */
  value: number
}

/** How values interpolate between breakpoints. `linear` covers signed positions,
 *  0..1 ranges, and already-logarithmic units (dB); `decibel` interpolates a
 *  linear gain in log space (used by the clip volume envelope). */
export type InterpDomain = 'linear' | 'decibel'

/** ≈ -100 dB floor so true-zero gains fade smoothly in the `decibel` domain. */
const DECIBEL_FLOOR = 1e-5

const DEFAULT_TIME_TOL_MS = 1e-3
const DEFAULT_VALUE_TOL = 1e-4

export interface ValueClamp {
  min: number
  max: number
}

function clampValue(value: number, clamp: ValueClamp): number {
  return Math.min(clamp.max, Math.max(clamp.min, value))
}

/** Stable sorting retains the incoming and outgoing sides of an equal-time step. */
export function sanitizeBreakpoints(
  points: readonly Breakpoint[],
  clamp: ValueClamp
): Breakpoint[] {
  return points
    .filter((p) => Number.isFinite(p.timeMs) && Number.isFinite(p.value))
    .map((p) => ({ timeMs: Math.max(0, p.timeMs), value: clampValue(p.value, clamp) }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** Value-equality within tolerances. */
export function breakpointsEqual(
  a: readonly Breakpoint[] | undefined,
  b: readonly Breakpoint[] | undefined,
  valueTol: number = DEFAULT_VALUE_TOL,
  timeTolMs: number = DEFAULT_TIME_TOL_MS
): boolean {
  const aa = a ?? []
  const bb = b ?? []
  if (aa.length !== bb.length) return false
  for (let i = 0; i < aa.length; i++) {
    const pa = aa[i]
    const pb = bb[i]
    if (!pa || !pb) return false
    if (Math.abs(pa.timeMs - pb.timeMs) > timeTolMs) return false
    if (Math.abs(pa.value - pb.value) > valueTol) return false
  }
  return true
}

/** Interpolated value at timeline-absolute `ms`, clamping to the end values
 *  outside the curve's span. Matches the backend `BreakpointCurve` sampler. */
export function sampleBreakpoints(
  points: readonly Breakpoint[],
  ms: number,
  domain: InterpDomain = 'linear'
): number {
  const n = points.length
  const first = points[0]
  if (!first) return 0
  if (n === 1) return first.value
  const last = points[n - 1]
  if (!last) return first.value
  if (ms < first.timeMs) return first.value
  if (ms >= last.timeMs) return last.value

  let seg = 0
  while (seg < n - 2) {
    const nextPt = points[seg + 1]
    if (!nextPt || ms < nextPt.timeMs) break
    seg++
  }
  const a = points[seg]
  const b = points[seg + 1]
  if (!a || !b) return first.value
  if (ms <= a.timeMs) return a.value
  if (ms >= b.timeMs) return b.value

  const frac = (ms - a.timeMs) / (b.timeMs - a.timeMs)
  if (domain === 'decibel') {
    const aDb = 20 * Math.log10(Math.max(a.value, DECIBEL_FLOOR))
    const bDb = 20 * Math.log10(Math.max(b.value, DECIBEL_FLOOR))
    return Math.pow(10, (aDb + (bDb - aDb) * frac) / 20)
  }
  return a.value + (b.value - a.value) * frac
}

/** Pointer insertion appends a step; setting a value at the playhead edits its outgoing side. */
export function insertBreakpoint(
  points: readonly Breakpoint[],
  timeMs: number,
  value: number,
  clamp: ValueClamp,
  mode: 'insert' | 'set' = 'insert'
): { points: Breakpoint[]; index: number } {
  const t = Math.max(0, timeMs)
  const v = clampValue(value, clamp)
  const next = points.map((p) => ({ ...p }))
  let index = next.findIndex(p => p.timeMs > t)
  if (index < 0) index = next.length
  const outgoing = next[index - 1]
  if (outgoing?.timeMs === t && (mode === 'set' || outgoing.value === v)) {
    outgoing.value = v
    return { points: next, index: index - 1 }
  }
  next.splice(index, 0, { timeMs: t, value: v })
  return { points: next, index }
}

/** Remove an interior breakpoint; the pinned endpoints are kept. */
export function removeBreakpoint(points: readonly Breakpoint[], index: number): Breakpoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map((p) => ({ ...p }))
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }))
}

/** Move a breakpoint; endpoints keep their time, interior points stay sorted. */
export function moveBreakpoint(
  points: readonly Breakpoint[],
  index: number,
  timeMs: number,
  value: number,
  clamp: ValueClamp
): { points: Breakpoint[]; index: number } {
  const next = points.map((p) => ({ ...p }))
  const pt = next[index]
  if (!pt) return { points: next, index }
  const v = clampValue(value, clamp)
  const isEndpoint = index === 0 || index === next.length - 1
  if (isEndpoint) {
    next[index] = { timeMs: pt.timeMs, value: v }
    return { points: next, index }
  }
  // Stop at distinct neighbours, but let any handle already in a step detach
  // to either side. The outer endpoints remain pinned.
  let left = index - 1
  let right = index + 1
  while (left > 0 && next[left]!.timeMs === pt.timeMs) left--
  while (right < next.length - 1 && next[right]!.timeMs === pt.timeMs) right++
  pt.timeMs = Math.min(next[right]!.timeMs, Math.max(next[left]!.timeMs, timeMs))
  pt.value = v
  next.sort((a, b) => a.timeMs - b.timeMs)
  return { points: next, index: next.indexOf(pt) }
}

/** Two-point flat curve at `value` spanning `[0, durationMs]`. */
export function flatCurve(durationMs: number, value: number): Breakpoint[] {
  const end = Math.max(1, durationMs)
  return [
    { timeMs: 0, value },
    { timeMs: end, value }
  ]
}
