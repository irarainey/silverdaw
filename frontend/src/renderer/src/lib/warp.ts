// Per-clip warp helpers shared between drawing, drag/drop, and the
// (forthcoming) Rubber Band-backed audio engine on the backend.
//
// Conventions:
//   - `tempoRatio = projectBpm / sourceBpm` — i.e. "how many times faster
//     than its native rate this clip should play". `2.0` plays at double
//     speed; `0.5` plays at half speed; `1.0` is no stretching.
//   - Rubber Band's `setTimeRatio()` expects **output / input** so it's
//     fed `1 / tempoRatio`; the conversion is centralised in the backend
//     `WarpedClipSource` to avoid sprinkling the inversion across the
//     renderer.
//   - When a clip's `tempoRatio` is **undefined** the effective ratio is
//     derived live from the active project BPM + the source's detected
//     BPM. When the clip has an explicit `tempoRatio` it's a pinned
//     override that survives subsequent project-BPM edits.
//
// The renderer uses the same helpers everywhere a clip's visible
// timeline width or world position matters (drawing, hit-test, drag-
// snap, drop collision) so the entire UI stays consistent with what
// the audio engine will produce.

export interface ClipWarpInputs {
  warpEnabled?: boolean
  tempoRatio?: number
  pendingAutoWarp?: boolean
  /** Source BPM from the library item (when known). */
  sourceBpm?: number
  /** Active project BPM. */
  projectBpm?: number
}

/** Tiny epsilon for "ratio is effectively 1" tests. Picked so that
 *  drag-time floating noise around 1.0 doesn't keep flipping the warp
 *  engine in and out of bypass. */
export const WARP_BYPASS_EPSILON = 1e-4

/** True iff the warp would actually do anything audible — `warpEnabled`
 *  is on AND the effective tempo ratio differs from 1.0. Used by the
 *  drawing code to decide whether to render the ↔ badge and to skip the
 *  effective-duration math when warp is a no-op. */
export function isWarpActive(inputs: ClipWarpInputs): boolean {
  if (inputs.warpEnabled !== true) return false
  const ratio = effectiveTempoRatio(inputs)
  return Math.abs(ratio - 1) > WARP_BYPASS_EPSILON
}

/** True while the clip is waiting for the information needed to build
 *  its effective warp. This covers the auto-warp import path where BPM
 *  analysis is still running, plus manual "follow project BPM" warp
 *  settings before the source BPM is known. */
export function isWarpPending(inputs: ClipWarpInputs): boolean {
  if (inputs.pendingAutoWarp === true) return true
  if (inputs.warpEnabled !== true) return false
  if (typeof inputs.tempoRatio === 'number' && inputs.tempoRatio > 0) return false
  const src = inputs.sourceBpm
  const proj = inputs.projectBpm
  return typeof src !== 'number' || src <= 0 || typeof proj !== 'number' || proj <= 0
}

/**
 * Resolve the effective tempo ratio for a clip. Explicit `tempoRatio`
 * pin wins; otherwise the live `projectBpm / sourceBpm` is used.
 * Returns `1` when either BPM is missing/zero — the audio engine
 * gracefully falls back to no stretching in that case so the clip
 * stays audible while analysis is in flight.
 */
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

/**
 * Effective timeline duration of a clip in milliseconds — what the
 * user sees on the ruler — given the warp state and the clip's
 * native (source-time) duration.
 *
 * Native source-time fields (`inMs`, `durationMs`) stay unchanged when
 * warp toggles; only the timeline projection changes. This lets the
 * audio engine seek to the right source position from the timeline
 * position via `sourceOffset = inMs + (timelineOffset * tempoRatio)`.
 */
export function effectiveDurationMs(nativeDurationMs: number, inputs: ClipWarpInputs): number {
  if (!isWarpActive(inputs)) return nativeDurationMs
  const ratio = effectiveTempoRatio(inputs)
  if (ratio <= 0) return nativeDurationMs
  return nativeDurationMs / ratio
}

/**
 * Combined pitch scale from semitones + cents. `2^((semitones + cents/100) / 12)`
 * — fed straight into Rubber Band's `setPitchScale`. Returns `1` when both
 * are zero, so the engine can cheaply bypass pitch shifting.
 */
export function effectivePitchScale(semitones: number | undefined, cents: number | undefined): number {
  const s = typeof semitones === 'number' ? semitones : 0
  const c = typeof cents === 'number' ? cents : 0
  if (s === 0 && c === 0) return 1
  return Math.pow(2, (s + c / 100) / 12)
}

/**
 * Convenience: effective timeline duration for a clip, resolving the
 * project BPM and source BPM via the supplied stores. Centralised so
 * the timeline drawing / drag / drop / collision code paths all agree
 * on the same number for any given clip.
 *
 * The caller passes the already-loaded library item and project BPM
 * rather than re-importing the stores here — keeps `warp.ts` free of
 * Pinia dependencies (it's also used by the vitest suite).
 */
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
