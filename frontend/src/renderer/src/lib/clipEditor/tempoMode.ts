// Single source of truth for the Clip Editor's tempo-mode maths, shared by the
// Warp panel (`useClipEditorWarpDraft`) and the standalone Warp dialog
// (`useClipWarpDialogController`) so the bounds and ratio rules can't drift
// between the two surfaces.
//
// The persisted clip carries only `tempoRatio` (undefined ⇒ follow project;
// explicit ⇒ a manual warp). A clip with a known source BPM shows the manual
// warp as a pinned BPM; without one it shows a free stretch percentage (e.g.
// spoken word). `tempoRatio` has no mode discriminator, so pin↔stretch is
// resolved purely by whether a source BPM exists.

import { effectiveTempoRatio } from '@/lib/warp'

/** How the clip's playback tempo is chosen. */
export type ClipTempoMode = 'follow' | 'pin' | 'stretch'

/** Shared bounds for the pinned BPM and the stretch ratio/percentage. */
export const MIN_TEMPO_RATIO = 0.25
export const MAX_TEMPO_RATIO = 4
export const MIN_STRETCH_PERCENT = MIN_TEMPO_RATIO * 100
export const MAX_STRETCH_PERCENT = MAX_TEMPO_RATIO * 100
export const MIN_PINNED_BPM = 20
export const MAX_PINNED_BPM = 300

export function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(lo, Math.min(hi, v))
}

export interface DerivedTempoMode {
  mode: ClipTempoMode
  pinnedBpm: number
  stretchPercent: number
}

/**
 * Map a clip's persisted warp fields onto the editor's tempo-mode UI state.
 * An absent/neutral `tempoRatio` is "follow project"; an explicit ratio is a
 * manual warp shown as a pinned BPM when the source tempo is known (so beat
 * clips read in BPM) or as a stretch percentage otherwise (e.g. spoken word).
 * Shared by the draft's `initialise` and the dirty-state comparison.
 */
export function deriveTempoModeFromClip(
  current: { tempoRatio?: number },
  sourceBpm: number | undefined,
  projectBpm: number
): DerivedTempoMode {
  const ratio =
    typeof current.tempoRatio === 'number' && current.tempoRatio > 0 && current.tempoRatio !== 1
      ? current.tempoRatio
      : undefined
  const defaultBpm = Math.round(projectBpm * 100) / 100
  if (ratio === undefined) {
    return { mode: 'follow', pinnedBpm: defaultBpm, stretchPercent: 100 }
  }
  const stretchPercent = Math.round(ratio * 100 * 100) / 100
  if (typeof sourceBpm === 'number' && sourceBpm > 0) {
    return { mode: 'pin', pinnedBpm: Math.round(sourceBpm * ratio * 100) / 100, stretchPercent }
  }
  return { mode: 'stretch', pinnedBpm: defaultBpm, stretchPercent }
}

export interface ManualTempoInputs {
  pinnedBpm: number
  stretchPercent: number
  sourceBpm: number | undefined
}

/** Explicit tempo ratio for a manual (pin/stretch) mode; undefined for follow or an unresolvable pin. */
export function manualTempoRatio(mode: ClipTempoMode, inputs: ManualTempoInputs): number | undefined {
  if (mode === 'stretch') {
    return clampNumber(inputs.stretchPercent, MIN_STRETCH_PERCENT, MAX_STRETCH_PERCENT) / 100
  }
  if (mode === 'pin') {
    const src = inputs.sourceBpm
    if (typeof src !== 'number' || src <= 0) return undefined
    const bpm = clampNumber(inputs.pinnedBpm, MIN_PINNED_BPM, MAX_PINNED_BPM)
    return Math.max(MIN_TEMPO_RATIO, Math.min(MAX_TEMPO_RATIO, bpm / src))
  }
  return undefined
}

export interface EffectiveRatioInputs extends ManualTempoInputs {
  enabled: boolean
  mode: ClipTempoMode
  projectBpm: number
}

/** The tempo ratio that would be applied: `1` when disabled, else per mode. */
export function computeEffectiveRatio(p: EffectiveRatioInputs): number {
  if (!p.enabled) return 1
  if (p.mode === 'stretch') return manualTempoRatio('stretch', p) ?? 1
  return effectiveTempoRatio({
    tempoRatio: p.mode === 'pin' ? manualTempoRatio('pin', p) : undefined,
    sourceBpm: p.sourceBpm,
    projectBpm: p.projectBpm
  })
}
