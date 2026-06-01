import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

/** Linear-gain bounds for a volume-shape breakpoint (≈ `-∞ .. +12 dB`). */
export const ENVELOPE_MIN_GAIN = 0
export const ENVELOPE_MAX_GAIN = 4

// ≈ -100 dB. Mirrors `EnvelopeSnapshot::kGainFloor` on the backend so a
// true-zero breakpoint interpolates as a smooth ramp toward silence
// rather than an instantaneous drop.
const GAIN_FLOOR = 1e-5

/**
 * Clamp, sort ascending by `timeMs`, and drop near-duplicate times.
 * Mirrors the backend `ProjectState` normalisation so the optimistic UI
 * state matches what will actually be stored.
 */
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

/** Value-equality for two (possibly absent) envelopes, within the same
 *  tolerances the backend uses for change detection. */
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

/**
 * Linear-in-dB gain at clip-local `ms`. Mirrors the backend
 * `EnvelopeSnapshot::gainAtMs` so the rendered shape matches what is
 * heard. Clamps to the endpoint gains outside the breakpoint range and
 * returns unity when there are fewer than two points.
 */
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

/**
 * True when an envelope carries no audible shape — fewer than two points,
 * or every breakpoint sits at unity gain. Such an envelope is semantically
 * "no shape" and is cleared rather than persisted, keeping a freshly-opened
 * (flat) editor from marking the project dirty.
 */
export function isFlatUnityEnvelope(points: readonly ClipEnvelopePoint[]): boolean {
  if (points.length < 2) return true
  return points.every((p) => Math.abs(p.gain - 1) <= 1e-4)
}

/**
 * Return a default two-point "flat unity" shape spanning the clip — the
 * starting canvas the user then bends. Endpoints are pinned to the clip
 * start (0) and end (`durationMs`).
 */
export function defaultEnvelope(durationMs: number): ClipEnvelopePoint[] {
  const end = Math.max(1, durationMs)
  return [
    { timeMs: 0, gain: 1 },
    { timeMs: end, gain: 1 }
  ]
}

/**
 * Insert a breakpoint at (`timeMs`, `gain`), returning a fresh sorted
 * array. Interior insertions land between the bracketing endpoints; a
 * time coinciding (within 1 ms) with an existing point replaces that
 * point's gain instead of creating a duplicate. Returns the index of the
 * inserted / updated point alongside the new array.
 */
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

/**
 * Remove the breakpoint at `index`. The two endpoints (first and last)
 * are pinned and cannot be removed — the original array is returned
 * unchanged in that case.
 */
export function removeEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  index: number
): ClipEnvelopePoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map((p) => ({ ...p }))
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }))
}

/**
 * Move the breakpoint at `index` to (`timeMs`, `gain`). Endpoints keep
 * their pinned time (only their gain moves); interior points are clamped
 * strictly between their immediate neighbours so the array stays sorted
 * and never produces duplicate times.
 */
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
