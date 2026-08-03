// Per-clip warp helpers shared by drawing, hit-testing, drag/drop, and playback.
// `tempoRatio = projectBpm / sourceBpm`; backend Rubber Band time ratio is its inverse.
// Undefined `tempoRatio` follows project BPM; explicit values pin the clip.

export interface ClipWarpInputs {
  warpEnabled?: boolean
  tempoRatio?: number
  pendingAutoWarp?: boolean
  sourceBpm?: number
  projectBpm?: number
  /**
   * Native clip length, used to judge whether the ratio moves anything. Optional
   * only because a few call sites have no clip in hand; supply it whenever you can.
   */
  nativeDurationMs?: number
}

export interface DropAutoWarpInputs {
  preferenceEnabled: boolean
  /**
   * Whether the project tempo is established (the backend's `bpmSeeded`).
   *
   * This used to ask "does the timeline hold another clip?" as a stand-in, on the
   * reasoning that the first clip seeds the tempo so there is nothing real to warp
   * to yet. That proxy is wrong for a project whose tempo is already established
   * but whose timeline is empty — a saved project reopened, or one whose clips were
   * all deleted — where the first clip dropped would silently refuse to warp.
   */
  projectBpmSeeded: boolean
  sourceKind?: 'source' | 'clip' | 'stem' | 'sample'
  sourceIsSimple: boolean
  sourceBpm?: number
  projectBpm?: number
  variableTempo?: boolean
  /** Native length of what is being dropped, used to size the tempo mismatch. */
  sourceDurationMs?: number
}

/** Epsilon for treating floating-point drag noise around 1.0 as bypass. */
export const WARP_BYPASS_EPSILON = 1e-4

/**
 * Drift small enough to leave a clip unwarped: under a millisecond across its
 * whole length, well inside a single audio buffer.
 */
export const WARP_NEGLIGIBLE_DRIFT_MS = 1

/**
 * How far a tempo ratio pulls the end of a clip, in milliseconds.
 *
 * Whether a tempo mismatch is worth warping is a question about the clip, not about
 * the ratio: a fixed ratio band is duration-blind, so a band wide enough to ignore
 * drag noise on a two-bar loop also swallows a fifth of a second on a three-minute
 * stem. A stem reanalysed from 94.05 to 94.0446 BPM was dropped unwarped for exactly
 * that reason and ended up ~10 ms off the grid by its end.
 */
export function warpDriftMs(nativeDurationMs: number | undefined, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  if (typeof nativeDurationMs !== 'number' || !Number.isFinite(nativeDurationMs) || nativeDurationMs <= 0) {
    // Length unknown: fall back to the ratio alone rather than silently skipping.
    return Math.abs(ratio - 1) > 1e-9 ? Number.POSITIVE_INFINITY : 0
  }
  return Math.abs(nativeDurationMs / ratio - nativeDurationMs)
}

/** True when warping at `ratio` would move the clip's end audibly. */
export function warpChangesTiming(nativeDurationMs: number | undefined, ratio: number): boolean {
  return warpDriftMs(nativeDurationMs, ratio) >= WARP_NEGLIGIBLE_DRIFT_MS
}

/** Variable-tempo sources use their detected representative BPM and remain eligible. */
export function shouldAutoWarpOnDrop(inputs: DropAutoWarpInputs): boolean {
  if (
    !inputs.preferenceEnabled ||
    !inputs.projectBpmSeeded ||
    inputs.sourceKind === 'clip' ||
    inputs.sourceIsSimple ||
    typeof inputs.sourceBpm !== 'number' ||
    inputs.sourceBpm <= 0 ||
    typeof inputs.projectBpm !== 'number' ||
    inputs.projectBpm <= 0
  ) {
    return false
  }
  // Matching tempos need no warp; the same drift test the drop itself applies, so
  // the ghost, the collision check and the landed clip can't disagree (ADR 0024).
  return warpChangesTiming(inputs.sourceDurationMs, inputs.projectBpm / inputs.sourceBpm)
}

/**
 * True when enabled warp actually moves the clip.
 *
 * Judged on the drift the ratio produces across the clip, not on the ratio alone —
 * a stem warped from 94.0446 to 94.05 BPM sits inside any usable ratio epsilon yet
 * shifts its end by ~10 ms, and reporting it inactive left the timeline drawing and
 * scheduling a native-length clip the engine was already stretching. The ratio
 * epsilon remains the fallback for the few callers with no length in hand.
 */
export function isWarpActive(inputs: ClipWarpInputs): boolean {
  if (inputs.warpEnabled !== true) return false
  const ratio = effectiveTempoRatio(inputs)
  if (typeof inputs.nativeDurationMs === 'number' && inputs.nativeDurationMs > 0) {
    return warpChangesTiming(inputs.nativeDurationMs, ratio)
  }
  return Math.abs(ratio - 1) > WARP_BYPASS_EPSILON
}

/** True while auto/follow-project warp is waiting for BPM analysis. */
export function isWarpPending(inputs: ClipWarpInputs): boolean {
  if (inputs.pendingAutoWarp === true) return true
  if (inputs.warpEnabled !== true) return false
  if (typeof inputs.tempoRatio === 'number' && inputs.tempoRatio > 0) return false
  const src = inputs.sourceBpm
  const proj = inputs.projectBpm
  return typeof src !== 'number' || src <= 0 || typeof proj !== 'number' || proj <= 0
}

/** Resolve clip tempo ratio: explicit pin, live `projectBpm / sourceBpm`, or no stretch. */
export function effectiveTempoRatio(inputs: ClipWarpInputs): number {
  if (typeof inputs.tempoRatio === 'number' && inputs.tempoRatio > 0) {
    return inputs.tempoRatio
  }
  const src = inputs.sourceBpm
  const proj = inputs.projectBpm
  if (typeof src !== 'number' || src <= 0) return 1
  if (typeof proj !== 'number' || proj <= 0) return 1
  return proj / src
}

/** Project source-time duration onto the timeline; source fields stay unchanged. */
export function effectiveDurationMs(nativeDurationMs: number, inputs: ClipWarpInputs): number {
  // The caller's own length is the authority here, so it always drives the test.
  if (!isWarpActive({ ...inputs, nativeDurationMs })) return nativeDurationMs
  const ratio = effectiveTempoRatio(inputs)
  if (ratio <= 0) return nativeDurationMs
  return nativeDurationMs / ratio
}

/** Combined pitch scale: `2^((semitones + cents / 100) / 12)`. */
export function effectivePitchScale(semitones: number | undefined, cents: number | undefined): number {
  const s = typeof semitones === 'number' ? semitones : 0
  const c = typeof cents === 'number' ? cents : 0
  if (s === 0 && c === 0) return 1
  return Math.pow(2, (s + c / 100) / 12)
}

// Store-agnostic wrapper so drawing, drag, drop, and collision share the same math.
export interface ClipForWarp {
  durationMs: number
  warpEnabled?: boolean
  tempoRatio?: number
  libraryItemId?: string
}
