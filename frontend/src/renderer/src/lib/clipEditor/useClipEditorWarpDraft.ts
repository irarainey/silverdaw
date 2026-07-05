// Transactional Clip Editor warp and pitch draft state.
// Preview uses this draft immediately; Save commits it and Cancel discards it.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveTempoRatio, WARP_BYPASS_EPSILON } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

/** How the clip's playback tempo is chosen. */
export type ClipTempoMode = 'follow' | 'pin' | 'stretch'

/** Lower/upper bounds shared by the pinned BPM and the stretch ratio. */
const MIN_TEMPO_RATIO = 0.25
const MAX_TEMPO_RATIO = 4
const MIN_STRETCH_PERCENT = MIN_TEMPO_RATIO * 100
const MAX_STRETCH_PERCENT = MAX_TEMPO_RATIO * 100

/** True when pitch shift requires the processor even without tempo warp. */
export function pitchNeedsProcessor(
  semitones: number | undefined,
  cents: number | undefined
): boolean {
  return (semitones ?? 0) !== 0 || (cents ?? 0) !== 0
}

/** True when warp changes tempo, not just pitch with `tempoRatio === 1`. */
export function currentHasTempoWarp(current: {
  warpEnabled?: boolean
  tempoRatio?: number
  semitones?: number
  cents?: number
}): boolean {
  const pitchOnlyProcessor =
    pitchNeedsProcessor(current.semitones, current.cents) && current.tempoRatio === 1
  return current.warpEnabled === true && !pitchOnlyProcessor
}

function clampNumber(v: number, lo: number, hi: number): number {
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

export interface ClipEditorWarpDraft {
  // ─── Draft state (mutable refs the inspector binds to) ───
  draftTempoEnabled: Ref<boolean>
  draftMode: Ref<ClipWarpMode>
  /** How playback tempo is chosen: follow project, pin to a BPM, or free stretch %. */
  draftTempoMode: Ref<ClipTempoMode>
  draftPinnedBpm: Ref<number>
  /** Free time-stretch percentage (100 = original) for material without a tempo. */
  draftStretchPercent: Ref<number>
  draftSemitones: Ref<number>
  draftCents: Ref<number>

  // ─── Derived view ───
  /** Effective tempo ratio if committed; `1` when inactive. */
  draftEffectiveRatio: ComputedRef<number>
  /** Effective BPM for the inspector, or `null` without source BPM. */
  draftEffectiveBpm: ComputedRef<number | null>
  /** True when tempo warp is audible. */
  draftTempoWarpActive: ComputedRef<boolean>
  /** True when tempo or pitch processing is needed. */
  draftProcessorEnabled: ComputedRef<boolean>

  // ─── Helpers ───
  /** Explicit tempo ratio for a manual (pin/stretch) mode; undefined for follow or an unresolvable pin. */
  resolveManualRatio: () => number | undefined
  /** Preview tempo ratio: undefined bypasses processing, `1` means pitch-only. */
  previewTempoRatio: () => number | undefined

  // ─── Lifecycle ───
  /** Seed the draft for the current editor target. */
  initialise: (current: Clip | LibraryItem | null, editsExistingClip: boolean) => void
  /** Switch tempo mode; follow/pin are no-ops without a source BPM (stretch always works). */
  setTempoMode: (mode: ClipTempoMode) => void
  /** Apply a key-preset semitone offset (also resets cents). */
  applyKeyPreset: (semitones: number) => void
}

export function useClipEditorWarpDraft(
  sourceBpmRef: ComputedRef<number | undefined>
): ClipEditorWarpDraft {
  const transport = useTransportStore()

  const draftTempoEnabled = ref(false)
  const draftMode = ref<ClipWarpMode>('rhythmic')
  const draftTempoMode = ref<ClipTempoMode>('follow')
  const draftPinnedBpm = ref(120)
  const draftStretchPercent = ref(100)
  const draftSemitones = ref(0)
  const draftCents = ref(0)

  function hasSourceBpm(): boolean {
    const src = sourceBpmRef.value
    return typeof src === 'number' && src > 0
  }

  function resolveManualRatio(): number | undefined {
    if (draftTempoMode.value === 'stretch') {
      const pct = clampNumber(draftStretchPercent.value, MIN_STRETCH_PERCENT, MAX_STRETCH_PERCENT)
      return pct / 100
    }
    if (draftTempoMode.value === 'pin') {
      const src = sourceBpmRef.value
      if (typeof src !== 'number' || src <= 0) return undefined
      const bpm = clampNumber(draftPinnedBpm.value, 20, 300)
      return Math.max(MIN_TEMPO_RATIO, Math.min(MAX_TEMPO_RATIO, bpm / src))
    }
    return undefined
  }

  const draftEffectiveRatio = computed(() => {
    if (!draftTempoEnabled.value) return 1
    if (draftTempoMode.value === 'stretch') {
      return resolveManualRatio() ?? 1
    }
    return effectiveTempoRatio({
      tempoRatio: draftTempoMode.value === 'pin' ? resolveManualRatio() : undefined,
      sourceBpm: sourceBpmRef.value,
      projectBpm: transport.bpm
    })
  })

  const draftEffectiveBpm = computed(() => {
    const src = sourceBpmRef.value
    if (typeof src !== 'number' || src <= 0) return null
    return Math.round(src * draftEffectiveRatio.value * 100) / 100
  })

  const draftTempoWarpActive = computed(
    () => draftTempoEnabled.value && Math.abs(draftEffectiveRatio.value - 1) > WARP_BYPASS_EPSILON
  )

  const draftProcessorEnabled = computed(
    () => draftTempoEnabled.value || pitchNeedsProcessor(draftSemitones.value, draftCents.value)
  )

  function previewTempoRatio(): number | undefined {
    if (draftTempoEnabled.value) return draftEffectiveRatio.value
    return pitchNeedsProcessor(draftSemitones.value, draftCents.value) ? 1 : undefined
  }

  function initialise(current: Clip | LibraryItem | null, editsExistingClip: boolean): void {
    if (!current || !editsExistingClip) {
      draftTempoEnabled.value = false
      draftMode.value = 'rhythmic'
      draftTempoMode.value = 'follow'
      draftPinnedBpm.value = Math.round(transport.bpm * 100) / 100
      draftStretchPercent.value = 100
      draftSemitones.value = 0
      draftCents.value = 0
      return
    }
    draftTempoEnabled.value = currentHasTempoWarp(current)
    draftMode.value = current.warpMode ?? 'rhythmic'
    const derived = deriveTempoModeFromClip(current, sourceBpmRef.value, transport.bpm)
    draftTempoMode.value = derived.mode
    draftPinnedBpm.value = derived.pinnedBpm
    draftStretchPercent.value = derived.stretchPercent
    draftSemitones.value = current.semitones ?? 0
    draftCents.value = current.cents ?? 0
  }

  function setTempoMode(mode: ClipTempoMode): void {
    // Follow and pin are BPM-relative and need a source tempo; stretch always works.
    if ((mode === 'follow' || mode === 'pin') && !hasSourceBpm()) return
    draftTempoMode.value = mode
    if (mode === 'pin' && (!Number.isFinite(draftPinnedBpm.value) || draftPinnedBpm.value <= 0)) {
      draftPinnedBpm.value = Math.round(transport.bpm * 100) / 100
    }
    if (mode === 'stretch' && (!Number.isFinite(draftStretchPercent.value) || draftStretchPercent.value <= 0)) {
      draftStretchPercent.value = 100
    }
  }

  function applyKeyPreset(semitones: number): void {
    draftSemitones.value = semitones
    draftCents.value = 0
  }

  return {
    draftTempoEnabled,
    draftMode,
    draftTempoMode,
    draftPinnedBpm,
    draftStretchPercent,
    draftSemitones,
    draftCents,
    draftEffectiveRatio,
    draftEffectiveBpm,
    draftTempoWarpActive,
    draftProcessorEnabled,
    resolveManualRatio,
    previewTempoRatio,
    initialise,
    setTempoMode,
    applyKeyPreset
  }
}

// Shared clamp rule for preview-bound draft values.
export { clampNumber }
