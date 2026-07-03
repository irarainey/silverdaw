// Per-clip warp helpers shared by drawing, hit-testing, drag/drop, and playback.
// `tempoRatio = projectBpm / sourceBpm`; backend Rubber Band time ratio is its inverse.
// Undefined `tempoRatio` follows project BPM; explicit values pin the clip.

export interface ClipWarpInputs {
  warpEnabled?: boolean
  tempoRatio?: number
  pendingAutoWarp?: boolean
  sourceBpm?: number
  projectBpm?: number
}

/** Epsilon for treating floating-point drag noise around 1.0 as bypass. */
export const WARP_BYPASS_EPSILON = 1e-4

/** True when enabled warp changes the effective tempo ratio. */
export function isWarpActive(inputs: ClipWarpInputs): boolean {
  if (inputs.warpEnabled !== true) return false
  const ratio = effectiveTempoRatio(inputs)
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
  if (!isWarpActive(inputs)) return nativeDurationMs
  const ratio = effectiveTempoRatio(inputs)
  if (ratio <= 0) return nativeDurationMs
  return nativeDurationMs / ratio
}

/**
 * Advisory copy shown when auto-warp is intentionally skipped because the
 * source has a variable tempo — no single stretch ratio can match it, so the
 * user is pointed at the manual split-and-warp workflow. Shared by the drop
 * path and the late-analysis path so the wording stays identical.
 */
export function variableTempoWarpSkippedMessage(sourceName?: string): string {
  const name = sourceName?.trim()
  const subject = name ? `"${name}"` : 'This clip'
  return `${subject} wasn't auto-warped — a variable tempo was detected. Split it into sections and warp each part manually.`
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

export interface LibraryItemForWarp {
  bpm?: number
}

export function clipEffectiveDurationMs(
  clip: ClipForWarp,
  libraryItem: LibraryItemForWarp | undefined,
  projectBpm: number | undefined
): number {
  return effectiveDurationMs(clip.durationMs, {
    warpEnabled: clip.warpEnabled,
    tempoRatio: clip.tempoRatio,
    sourceBpm: libraryItem?.bpm,
    projectBpm
  })
}
