// Transactional Clip Editor warp and pitch draft state.
// Preview uses this draft immediately; Save commits it and Cancel discards it.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import {
  computeEffectiveRatio,
  deriveTempoModeFromClip,
  manualTempoRatio,
  type ClipTempoMode
} from '@/lib/clipEditor/tempoMode'
import { WARP_BYPASS_EPSILON } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

// Re-exported so existing importers (save, dirty-state) keep a single import site.
export { deriveTempoModeFromClip, clampNumber, type ClipTempoMode } from '@/lib/clipEditor/tempoMode'

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
    return manualTempoRatio(draftTempoMode.value, {
      pinnedBpm: draftPinnedBpm.value,
      stretchPercent: draftStretchPercent.value,
      sourceBpm: sourceBpmRef.value
    })
  }

  const draftEffectiveRatio = computed(() =>
    computeEffectiveRatio({
      enabled: draftTempoEnabled.value,
      mode: draftTempoMode.value,
      pinnedBpm: draftPinnedBpm.value,
      stretchPercent: draftStretchPercent.value,
      sourceBpm: sourceBpmRef.value,
      projectBpm: transport.bpm
    })
  )

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
    // Modes must match source availability: follow/pin are BPM-relative and need
    // a source tempo; stretch is the free-ratio fallback for material without one.
    const source = hasSourceBpm()
    if ((mode === 'follow' || mode === 'pin') && !source) return
    if (mode === 'stretch' && source) return
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
