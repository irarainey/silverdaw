import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

export const ENVELOPE_MIN_GAIN = 0
export const ENVELOPE_MAX_GAIN = 4

// ≈ -100 dB; matches backend interpolation toward true-zero breakpoints.
const GAIN_FLOOR = 1e-5

/** Stable ordering preserves the incoming and outgoing sides of a step. */
export function sanitizeEnvelopePoints(
  points: readonly ClipEnvelopePoint[]
): ClipEnvelopePoint[] {
  return points
    .filter((p) => Number.isFinite(p.timeMs) && Number.isFinite(p.gain))
    .map((p) => ({
      timeMs: Math.max(0, p.timeMs),
      gain: Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, p.gain))
    }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** Compare the ordered shape, matching backend change detection. */
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
    if (pa.timeMs !== pb.timeMs || pa.gain !== pb.gain) return false
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
  if (ms < first.timeMs) return first.gain
  if (ms >= last.timeMs) return last.gain

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (points[mid]!.timeMs <= ms) lo = mid
    else hi = mid
  }
  const a = points[lo]!
  const b = points[hi]!
  if (ms === a.timeMs || a.gain === b.gain) return a.gain

  const aDb = 20 * Math.log10(Math.max(a.gain, GAIN_FLOOR))
  const bDb = 20 * Math.log10(Math.max(b.gain, GAIN_FLOOR))
  const frac = (ms - a.timeMs) / (b.timeMs - a.timeMs)
  return Math.pow(10, (aDb + (bDb - aDb) * frac) / 20)
}

/**
 * Cut a volume shape in two at clip-local `atMs`, as a timeline split does.
 *
 * The backend evaluates breakpoints against elapsed playback time from the clip's
 * start (OffsetSource: `timelineSample - clipStart`), so this axis is the clip's
 * timeline footprint and is unaffected by reverse. Both halves gain a boundary
 * breakpoint sampled from the original curve, so the pair reproduces the source
 * shape exactly across the seam. The right half is re-based to its own zero.
 *
 * Returns `undefined` for a half whose shape carries no audible information.
 */
export function splitEnvelopeAtMs(
  points: readonly ClipEnvelopePoint[] | undefined,
  atMs: number,
  durationMs: number
): { left: ClipEnvelopePoint[] | undefined; right: ClipEnvelopePoint[] | undefined } {
  const source = points ? sanitizeEnvelopePoints(points) : []
  if (source.length < 2 || !Number.isFinite(atMs) || atMs <= 0) {
    return { left: undefined, right: undefined }
  }

  const seamGain = envelopeGainAtMs(source, atMs)
  const incoming = source.find((p) => p.timeMs === atMs)
  const left = source.filter((p) => p.timeMs < atMs)
  if (!left.length) left.push({ timeMs: 0, gain: source[0]!.gain })
  left.push({ timeMs: atMs, gain: incoming?.gain ?? seamGain })
  const right = source.filter((p) => p.timeMs >= atMs)
    .map((p) => ({ timeMs: p.timeMs - atMs, gain: p.gain }))
  if (!incoming) right.unshift({ timeMs: 0, gain: seamGain })
  if (right.at(-1)?.timeMs === 0 && durationMs > atMs) {
    right.push({ timeMs: durationMs - atMs, gain: seamGain })
  }

  return {
    left: isFlatUnityEnvelope(left) ? undefined : left,
    right: isFlatUnityEnvelope(right) ? undefined : right
  }
}

/**
 * Rescale a volume shape onto a new clip footprint, keeping each breakpoint at the
 * same relative position within the clip.
 *
 * Breakpoints live on the clip's *timeline footprint* (see `splitEnvelopeAtMs`), so
 * anything that re-stretches the clip — a project tempo change re-deriving the warp
 * ratio, most of all — moves the audio out from under a shape left in milliseconds.
 * A fade written across the last bar would end up somewhere in the middle.
 *
 * Gains are untouched: only the time axis is a function of the clip's length.
 */
export function scaleEnvelopePoints(
  points: readonly ClipEnvelopePoint[],
  scale: number
): ClipEnvelopePoint[] {
  if (!Number.isFinite(scale) || scale <= 0) return sanitizeEnvelopePoints(points)
  return sanitizeEnvelopePoints(points.map((p) => ({ timeMs: p.timeMs * scale, gain: p.gain })))
}

/** Only an unedited unity line is implicit; extra handles are editable data. */
export function isFlatUnityEnvelope(points: readonly ClipEnvelopePoint[]): boolean {
  if (points.length < 2) return true
  return points.length === 2 && points[0]!.timeMs !== points[1]!.timeMs &&
    points.every((p) => p.gain === 1)
}

/** Default two-point flat-unity shape spanning the clip. */
export function defaultEnvelope(durationMs: number): ClipEnvelopePoint[] {
  const end = Math.max(1, durationMs)
  return [
    { timeMs: 0, gain: 1 },
    { timeMs: end, gain: 1 }
  ]
}

/** Insert after equal-time peers, keeping the outer endpoints pinned. */
export function insertEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  timeMs: number,
  gain: number
): { points: ClipEnvelopePoint[]; index: number } {
  const t = Math.max(points[0]?.timeMs ?? 0, Math.min(points.at(-1)?.timeMs ?? timeMs, timeMs))
  const g = Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, gain))
  const next = points.map((p) => ({ ...p }))
  const after = next.findIndex((p) => p.timeMs > t)
  const index = after >= 0 ? after : Math.max(0, next.length - 1)
  next.splice(index, 0, { timeMs: t, gain: g })
  return { points: next, index }
}

/**
 * Flatten `[startMs, endMs]` to `gain` with hard step edges, leaving the rest of
 * the envelope intact. Produces a held gate (e.g. silence a region) instead of a
 * ramp, with instantaneous transitions into and out of the gated span.
 */
export function applyEnvelopeGate(
  points: readonly ClipEnvelopePoint[],
  startMs: number,
  endMs: number,
  gain: number,
  durationMs = points.at(-1)?.timeMs ?? 0
): ClipEnvelopePoint[] {
  const lo = Math.max(0, Math.min(startMs, endMs))
  const hi = Math.min(durationMs, Math.max(startMs, endMs))
  if (!(hi > lo)) return points.slice()
  const level = Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, gain))
  const next = points.filter((p) => p.timeMs < lo)
  if (lo > 0) {
    const incoming = points.find((p) => p.timeMs === lo)?.gain ?? envelopeGainAtMs(points, lo)
    next.push({ timeMs: lo, gain: incoming })
  }
  next.push({ timeMs: lo, gain: level }, { timeMs: hi, gain: level })
  if (hi < durationMs) next.push({ timeMs: hi, gain: envelopeGainAtMs(points, hi) })
  for (const p of points) if (p.timeMs > hi) next.push(p)
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

/** Stop at distinct neighbours; any member of a stack can detach to either side. */
export function moveEnvelopePoint(
  points: readonly ClipEnvelopePoint[],
  index: number,
  timeMs: number,
  gain: number
): { points: ClipEnvelopePoint[]; index: number } {
  const next = points.map((p) => ({ ...p }))
  const pt = next[index]
  if (!pt) return { points: next, index }
  pt.gain = Math.min(ENVELOPE_MAX_GAIN, Math.max(ENVELOPE_MIN_GAIN, gain))
  if (index > 0 && index < next.length - 1) {
    let left = index - 1
    let right = index + 1
    while (left > 0 && next[left]!.timeMs === pt.timeMs) left--
    while (right < next.length - 1 && next[right]!.timeMs === pt.timeMs) right++
    pt.timeMs = Math.min(next[right]!.timeMs, Math.max(next[left]!.timeMs, timeMs))
    next.sort((a, b) => a.timeMs - b.timeMs)
  }
  return { points: next, index: next.indexOf(pt) }
}
