// Pure helpers for scratch pattern notation editing.
// Interpolation, direction/hold classification, keyframe move/add/delete,
// crop/rebase, source-offset, and schema validation.

import {
  MAX_SCRATCH_PATTERN_POINTS,
  ScratchPatternSchema,
  type ScratchCrossfaderKeyframe,
  type ScratchPattern,
  type ScratchPlatterKeyframe
} from '@shared/bridge-protocol'

// ── Direction / hold classification ──────────────────────────────────────────

export type PlatterSegmentKind = 'forward' | 'reverse' | 'hold'

export interface PlatterSegment {
  kind: PlatterSegmentKind
  startIndex: number
  endIndex: number
  startTimeUs: number
  endTimeUs: number
}

/** Classify the platter motion between two adjacent keyframes. */
export function classifyPlatterSegment(
  a: ScratchPlatterKeyframe,
  b: ScratchPlatterKeyframe
): PlatterSegmentKind {
  const dt = b.turns - a.turns
  if (Math.abs(dt) < 1e-9) return 'hold'
  return dt > 0 ? 'forward' : 'reverse'
}

/** Build an array of contiguous segments from the platter lane. */
export function classifyPlatterLane(platter: readonly ScratchPlatterKeyframe[]): PlatterSegment[] {
  const segments: PlatterSegment[] = []
  for (let i = 0; i < platter.length - 1; i++) {
    const a = platter[i]!
    const b = platter[i + 1]!
    segments.push({
      kind: classifyPlatterSegment(a, b),
      startIndex: i,
      endIndex: i + 1,
      startTimeUs: a.timeUs,
      endTimeUs: b.timeUs
    })
  }
  return segments
}

// ── Linear interpolation helpers ─────────────────────────────────────────────

/** Interpolate platter turns at an arbitrary timeUs within the lane. */
export function interpolatePlatterAt(
  platter: readonly ScratchPlatterKeyframe[],
  timeUs: number
): { turns: number; touched: boolean } {
  const n = platter.length
  if (n === 0) return { turns: 0, touched: false }
  const first = platter[0]!
  if (n === 1 || timeUs <= first.timeUs) return { turns: first.turns, touched: first.touched }
  const last = platter[n - 1]!
  if (timeUs >= last.timeUs) return { turns: last.turns, touched: last.touched }

  let seg = 0
  while (seg < n - 2) {
    const next = platter[seg + 1]!
    if (timeUs < next.timeUs) break
    seg++
  }
  const a = platter[seg]!
  const b = platter[seg + 1]!
  const frac = (timeUs - a.timeUs) / (b.timeUs - a.timeUs)
  return {
    turns: a.turns + (b.turns - a.turns) * frac,
    touched: a.touched
  }
}

/** Interpolate crossfader value at an arbitrary timeUs. */
export function interpolateCrossfaderAt(
  crossfader: readonly ScratchCrossfaderKeyframe[],
  timeUs: number
): number {
  const n = crossfader.length
  if (n === 0) return 0.5
  const first = crossfader[0]!
  if (n === 1 || timeUs <= first.timeUs) return first.value
  const last = crossfader[n - 1]!
  if (timeUs >= last.timeUs) return last.value

  let seg = 0
  while (seg < n - 2) {
    const next = crossfader[seg + 1]!
    if (timeUs < next.timeUs) break
    seg++
  }
  const a = crossfader[seg]!
  const b = crossfader[seg + 1]!
  const frac = (timeUs - a.timeUs) / (b.timeUs - a.timeUs)
  return a.value + (b.value - a.value) * frac
}

// ── Keyframe move ────────────────────────────────────────────────────────────

/**
 * Move a platter keyframe in time and/or turns. Boundary keyframes (first/last)
 * keep their pinned time. Interior keyframes stay strictly ordered. Touch state
 * is preserved.
 */
export function movePlatterKeyframe(
  platter: readonly ScratchPlatterKeyframe[],
  index: number,
  timeUs: number,
  turns: number
): ScratchPlatterKeyframe[] {
  const next = platter.map((k) => ({ ...k }))
  const pt = next[index]
  if (!pt) return next
  const isBoundary = index === 0 || index === next.length - 1
  if (isBoundary) {
    next[index] = { ...pt, turns }
    return next
  }
  const prev = next[index - 1]!
  const after = next[index + 1]!
  const lo = prev.timeUs + 1
  const hi = after.timeUs - 1
  const t = Math.round(Math.min(Math.max(timeUs, lo), Math.max(lo, hi)))
  next[index] = { timeUs: t, turns, touched: pt.touched }
  return next
}

/**
 * Move a crossfader keyframe in time and/or value. Boundary keyframes keep
 * their pinned time. Value is clamped to [0, 1].
 */
export function moveCrossfaderKeyframe(
  crossfader: readonly ScratchCrossfaderKeyframe[],
  index: number,
  timeUs: number,
  value: number
): ScratchCrossfaderKeyframe[] {
  const next = crossfader.map((k) => ({ ...k }))
  const pt = next[index]
  if (!pt) return next
  const v = Math.max(0, Math.min(1, value))
  const isBoundary = index === 0 || index === next.length - 1
  if (isBoundary) {
    next[index] = { ...pt, value: v }
    return next
  }
  const prev = next[index - 1]!
  const after = next[index + 1]!
  const lo = prev.timeUs + 1
  const hi = after.timeUs - 1
  const t = Math.round(Math.min(Math.max(timeUs, lo), Math.max(lo, hi)))
  next[index] = { timeUs: t, value: v }
  return next
}

// ── Keyframe add ─────────────────────────────────────────────────────────────

/** Insert a platter keyframe, maintaining strict time order. Returns new array + index. */
export function addPlatterKeyframe(
  platter: readonly ScratchPlatterKeyframe[],
  timeUs: number,
  turns: number,
  touched: boolean
): { platter: ScratchPlatterKeyframe[]; index: number } | null {
  if (platter.length >= MAX_SCRATCH_PATTERN_POINTS) return null
  const t = Math.round(Math.max(0, timeUs))
  if (platter.some((k) => k.timeUs === t)) return null
  const next = [...platter.map((k) => ({ ...k })), { timeUs: t, turns, touched }]
  next.sort((a, b) => a.timeUs - b.timeUs)
  const index = next.findIndex((k) => k.timeUs === t)
  return { platter: next, index }
}

/** Insert a crossfader keyframe, maintaining strict time order. Returns new array + index. */
export function addCrossfaderKeyframe(
  crossfader: readonly ScratchCrossfaderKeyframe[],
  timeUs: number,
  value: number
): { crossfader: ScratchCrossfaderKeyframe[]; index: number } | null {
  if (crossfader.length >= MAX_SCRATCH_PATTERN_POINTS) return null
  const t = Math.round(Math.max(0, timeUs))
  const v = Math.max(0, Math.min(1, value))
  if (crossfader.some((k) => k.timeUs === t)) return null
  const next = [...crossfader.map((k) => ({ ...k })), { timeUs: t, value: v }]
  next.sort((a, b) => a.timeUs - b.timeUs)
  const index = next.findIndex((k) => k.timeUs === t)
  return { crossfader: next, index }
}

// ── Keyframe delete ──────────────────────────────────────────────────────────

/** Delete a non-boundary platter keyframe. Returns null if boundary. */
export function deletePlatterKeyframe(
  platter: readonly ScratchPlatterKeyframe[],
  index: number
): ScratchPlatterKeyframe[] | null {
  if (index <= 0 || index >= platter.length - 1) return null
  return platter.filter((_, i) => i !== index).map((k) => ({ ...k }))
}

/** Delete a non-boundary crossfader keyframe. Returns null if boundary. */
export function deleteCrossfaderKeyframe(
  crossfader: readonly ScratchCrossfaderKeyframe[],
  index: number
): ScratchCrossfaderKeyframe[] | null {
  if (index <= 0 || index >= crossfader.length - 1) return null
  return crossfader.filter((_, i) => i !== index).map((k) => ({ ...k }))
}

// ── Crop and rebase ──────────────────────────────────────────────────────────

/**
 * Crop a platter lane to [cropStartUs, cropEndUs], evaluating values at
 * boundaries, rebasing time to zero, and preserving touch state at crop start.
 */
export function cropPlatterLane(
  platter: readonly ScratchPlatterKeyframe[],
  cropStartUs: number,
  cropEndUs: number
): ScratchPlatterKeyframe[] {
  const duration = cropEndUs - cropStartUs
  if (duration <= 0) {
    const val = interpolatePlatterAt(platter, cropStartUs)
    return [{ timeUs: 0, turns: val.turns, touched: val.touched }]
  }

  const startVal = interpolatePlatterAt(platter, cropStartUs)
  const endVal = interpolatePlatterAt(platter, cropEndUs)

  const interior = platter
    .filter((k) => k.timeUs > cropStartUs && k.timeUs < cropEndUs)
    .map((k) => ({ ...k, timeUs: k.timeUs - cropStartUs }))

  return [
    { timeUs: 0, turns: startVal.turns, touched: startVal.touched },
    ...interior,
    { timeUs: duration, turns: endVal.turns, touched: endVal.touched }
  ]
}

/**
 * Crop a crossfader lane to [cropStartUs, cropEndUs], evaluating values at
 * boundaries and rebasing time to zero.
 */
export function cropCrossfaderLane(
  crossfader: readonly ScratchCrossfaderKeyframe[],
  cropStartUs: number,
  cropEndUs: number
): ScratchCrossfaderKeyframe[] {
  const duration = cropEndUs - cropStartUs
  if (duration <= 0) {
    const val = interpolateCrossfaderAt(crossfader, cropStartUs)
    return [{ timeUs: 0, value: val }]
  }

  const startVal = interpolateCrossfaderAt(crossfader, cropStartUs)
  const endVal = interpolateCrossfaderAt(crossfader, cropEndUs)

  const interior = crossfader
    .filter((k) => k.timeUs > cropStartUs && k.timeUs < cropEndUs)
    .map((k) => ({ ...k, timeUs: k.timeUs - cropStartUs }))

  return [
    { timeUs: 0, value: startVal },
    ...interior,
    { timeUs: duration, value: endVal }
  ]
}

/**
 * Compute the sourceOffsetTurns after cropping. The offset represents how far
 * the source has advanced from its original starting position at the new crop
 * start boundary.
 */
export function computeCroppedSourceOffset(
  originalSourceOffset: number,
  platter: readonly ScratchPlatterKeyframe[],
  cropStartUs: number
): number {
  const atCropStart = interpolatePlatterAt(platter, cropStartUs)
  return originalSourceOffset + atCropStart.turns - (platter[0]?.turns ?? 0)
}

/**
 * Produce a fully cropped ScratchPattern. Validates against the schema; returns
 * null if the result would be invalid.
 */
export function cropPattern(
  pattern: ScratchPattern,
  newCropStartUs: number,
  newCropEndUs: number
): ScratchPattern | null {
  const cropStart = Math.max(0, Math.min(newCropStartUs, pattern.durationUs))
  const cropEnd = Math.max(cropStart, Math.min(newCropEndUs, pattern.durationUs))
  const newDuration = cropEnd - cropStart

  const croppedPlatter = cropPlatterLane(pattern.platter, cropStart, cropEnd)
  const croppedCrossfader = cropCrossfaderLane(pattern.crossfader, cropStart, cropEnd)
  const newSourceOffset = computeCroppedSourceOffset(
    pattern.sourceOffsetTurns,
    pattern.platter,
    cropStart
  )

  const result: ScratchPattern = {
    ...pattern,
    durationUs: newDuration,
    cropStartUs: 0,
    cropEndUs: newDuration,
    sourceOffsetTurns: newSourceOffset,
    platter: croppedPlatter,
    crossfader: croppedCrossfader
  }

  const validation = ScratchPatternSchema.safeParse(result)
  if (!validation.success) return null
  return result
}

// ── Validation helper ────────────────────────────────────────────────────────

/** Validate a pattern edit against the schema. Returns the parsed result or null. */
export function validatePattern(pattern: ScratchPattern): ScratchPattern | null {
  const result = ScratchPatternSchema.safeParse(pattern)
  return result.success ? result.data : null
}

/**
 * Apply an edit to a pattern by replacing one lane; validates the result.
 * Returns null if the resulting pattern is invalid.
 */
export function applyPlatterEdit(
  pattern: ScratchPattern,
  platter: ScratchPlatterKeyframe[]
): ScratchPattern | null {
  const result: ScratchPattern = { ...pattern, platter }
  return validatePattern(result)
}

export function applyCrossfaderEdit(
  pattern: ScratchPattern,
  crossfader: ScratchCrossfaderKeyframe[]
): ScratchPattern | null {
  const result: ScratchPattern = { ...pattern, crossfader }
  return validatePattern(result)
}
