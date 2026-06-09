import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

export const ENVELOPE_MIN_GAIN = 0
export const ENVELOPE_MAX_GAIN = 4

// ≈ -100 dB; matches backend interpolation toward true-zero breakpoints.
const GAIN_FLOOR = 1e-5

/** Match backend envelope normalisation: finite, clamped, sorted, de-duped. */
export function sanitizeEnvelopePoints(
  points: readonly ClipEnvelopePoint[]
): ClipEnvelopePoint[] {
  const cleaned = points
    .filter((p) => Number.isFinite(p.timeMs) && Number.isFinite(p.gain))
    .map((p) => ({
      timeMs: Math.max(0, p.timeMs),
      gain: Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, p.gain))
    }))
    .sort((a, b) => a.timeMs - b.timeMs)

  const out: ClipEnvelopePoint[] = []
  for (const p of cleaned) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(p.timeMs - prev.timeMs) < 1e-3) continue
    out.push(p)
  }
  return out
}

/** Value-equality within backend change-detection tolerances. */
export function envelopesEqual(
  a: readonly ClipEnvelopePoint[] | undefined,
  b: readonly ClipEnvelopePoint[] | undefined
): boolean {
  const aa = a ?? []
  const bb = b ?? []
  if (aa.length !== bb.length) return false
  for (let i = 0; i < aa.length; i++) {
    const pa = aa[i]
    const pb = bb[i]
    if (!pa || !pb) return false
    if (Math.abs(pa.timeMs - pb.timeMs) > 1e-3) return false
    if (Math.abs(pa.gain - pb.gain) > 1e-4) return false
  }
  return true
}

/** Linear-in-dB gain at clip-local `ms`, matching backend playback. */
export function envelopeGainAtMs(points: readonly ClipEnvelopePoint[], ms: number): number {
  const n = points.length
  const first = points[0]
  if (!first) return 1
  if (n === 1) return first.gain
  const last = points[n - 1]
  if (!last) return first.gain
  if (ms <= first.timeMs) return first.gain
  if (ms >= last.timeMs) return last.gain

  let seg = 0
  while (seg < n - 2) {
    const nextPt = points[seg + 1]
    if (!nextPt || ms < nextPt.timeMs) break
    seg++
  }
  const a = points[seg]
  const b = points[seg + 1]
  if (!a || !b) return 1
  if (ms <= a.timeMs) return a.gain
  if (ms >= b.timeMs) return b.gain

  const aDb = 20 * Math.log10(Math.max(a.gain, GAIN_FLOOR))
  const bDb = 20 * Math.log10(Math.max(b.gain, GAIN_FLOOR))
  const frac = (ms - a.timeMs) / (b.timeMs - a.timeMs)
  return Math.pow(10, (aDb + (bDb - aDb) * frac) / 20)
}

/** True when an envelope has no audible shape and should not be persisted. */
export function isFlatUnityEnvelope(points: readonly ClipEnvelopePoint[]): boolean {
  if (points.length < 2) return true
  return points.every((p) => Math.abs(p.gain - 1) <= 1e-4)
}

/** Default two-point flat-unity shape spanning the clip. */
export function defaultEnvelope(durationMs: number): ClipEnvelopePoint[] {
  const end = Math.max(1, durationMs)
  return [
    { timeMs: 0, gain: 1 },
    { timeMs: end, gain: 1 }
  ]
}

/** Insert or replace a breakpoint, returning the sorted envelope and touched index. */
export function insertEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  timeMs: number,
  gain: number
): { points: ClipEnvelopePoint[]; index: number } {
  const t = Math.max(0, timeMs)
  const g = Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, gain))
  const next = points.map((p) => ({ ...p }))
  const existing = next.findIndex((p) => Math.abs(p.timeMs - t) < 1e-3)
  if (existing >= 0) {
    next[existing] = { timeMs: next[existing]!.timeMs, gain: g }
    return { points: next, index: existing }
  }
  next.push({ timeMs: t, gain: g })
  next.sort((a, b) => a.timeMs - b.timeMs)
  return { points: next, index: next.findIndex((p) => Math.abs(p.timeMs - t) < 1e-3) }
}

/** Minimum width (ms) of a hard envelope edge; an inaudible ramp that reads as
 *  an instant transition while staying clear of the 1e-3 ms de-dup tolerance. */
export const ENVELOPE_EDGE_EPSILON_MS = 1

/**
 * Flatten `[startMs, endMs]` to `gain` with hard step edges, leaving the rest of
 * the envelope intact. Produces a held gate (e.g. silence a region) instead of a
 * ramp, with near-vertical transitions into and out of the gated span.
 */
export function applyEnvelopeGate(
  points: readonly ClipEnvelopePoint[],
  startMs: number,
  endMs: number,
  gain: number,
  epsilonMs: number = ENVELOPE_EDGE_EPSILON_MS
): ClipEnvelopePoint[] {
  const lo = Math.max(0, Math.min(startMs, endMs))
  const hi = Math.max(startMs, endMs)
  const endTime = points[points.length - 1]?.timeMs ?? hi
  if (hi - lo < epsilonMs) return points.map((p) => ({ ...p }))

  // Sample the original shape just outside the span so the edges don't disturb
  // the rest of the envelope.
  const beforeGain = envelopeGainAtMs(points, Math.max(0, lo - epsilonMs))
  const afterGain = envelopeGainAtMs(points, hi + epsilonMs)
  const atStart = lo <= epsilonMs
  const atEnd = hi >= endTime - epsilonMs

  // Drop interior breakpoints inside the span; pinned endpoints stay.
  let next = points
    .map((p) => ({ ...p }))
    .filter((p, i, arr) => {
      if (i === 0 || i === arr.length - 1) return true
      return p.timeMs < lo - 1e-3 || p.timeMs > hi + 1e-3
    })

  if (atStart) {
    next = insertEnvelopePoint(next, 0, gain).points
  } else {
    next = insertEnvelopePoint(next, Math.max(0, lo - epsilonMs), beforeGain).points
    next = insertEnvelopePoint(next, lo, gain).points
  }
  if (atEnd) {
    next = insertEnvelopePoint(next, endTime, gain).points
  } else {
    next = insertEnvelopePoint(next, hi, gain).points
    next = insertEnvelopePoint(next, hi + epsilonMs, afterGain).points
  }
  return next
}

/** Remove an interior breakpoint; pinned endpoints are kept. */
export function removeEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  index: number
): ClipEnvelopePoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map((p) => ({ ...p }))
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }))
}

/** Move a breakpoint; endpoints keep time and interior points stay strictly sorted. */
export function moveEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  index: number,
  timeMs: number,
  gain: number
): ClipEnvelopePoint[] {
  const next = points.map((p) => ({ ...p }))
  const pt = next[index]
  if (!pt) return next
  const g = Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, gain))
  const isEndpoint = index === 0 || index === next.length - 1
  if (isEndpoint) {
    next[index] = { timeMs: pt.timeMs, gain: g }
    return next
  }
  const prev = next[index - 1]
  const after = next[index + 1]
  const lo = (prev?.timeMs ?? 0) + 1e-3
  const hi = (after?.timeMs ?? timeMs) - 1e-3
  const t = Math.min(Math.max(timeMs, lo), Math.max(lo, hi))
  next[index] = { timeMs: t, gain: g }
  return next
}
