// Transactional Clip Editor warp and pitch draft state.
// Preview uses this draft immediately; Save commits it and Cancel discards it.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

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

export interface ClipEditorWarpDraft {
  // ─── Draft state (mutable refs the inspector binds to) ───
  draftTempoEnabled: Ref<boolean>
  draftMode: Ref<ClipWarpMode>
  draftTempoPinned: Ref<boolean>
  draftPinnedBpm: Ref<number>
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
  /** True when the "Follow project BPM" radio is selected. */
  tempoFollowsProject: ComputedRef<boolean>

  // ─── Helpers ───
  /** Convert pinned BPM to `tempoRatio`; undefined without source BPM. */
  tempoRatioFromPinnedBpm: () => number | undefined
  /** Preview tempo ratio: undefined bypasses processing, `1` means pitch-only. */
  previewTempoRatio: () => number | undefined

  // ─── Lifecycle ───
  /** Seed the draft for the current editor target. */
  initialise: (current: Clip | LibraryItem | null, editsExistingClip: boolean) => void
  /** "Follow project BPM" radio handler. */
  followProjectBpm: () => void
  /** "Pin to" radio handler. No-op when source BPM is unknown. */
  pinTempo: () => void
  /** Apply a key-preset semitone offset (also resets cents). */
  applyKeyPreset: (semitones: number) => void
}

export function useClipEditorWarpDraft(
  sourceBpmRef: ComputedRef<number | undefined>
): ClipEditorWarpDraft {
  const transport = useTransportStore()

  const draftTempoEnabled = ref(false)
  const draftMode = ref<ClipWarpMode>('rhythmic')
  const draftTempoPinned = ref(false)
  const draftPinnedBpm = ref(120)
  const draftSemitones = ref(0)
  const draftCents = ref(0)

  function tempoRatioFromPinnedBpm(): number | undefined {
    const src = sourceBpmRef.value
    if (typeof src !== 'number' || src <= 0) return undefined
    const bpm = clampNumber(draftPinnedBpm.value, 20, 300)
    return Math.max(0.25, Math.min(4, bpm / src))
  }

  const draftEffectiveRatio = computed(() => {
    if (!draftTempoEnabled.value) return 1
    return effectiveTempoRatio({
      tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : undefined,
      sourceBpm: sourceBpmRef.value,
      projectBpm: transport.bpm
    })
  })

  const draftEffectiveBpm = computed(() => {
    const src = sourceBpmRef.value
    if (typeof src !== 'number' || src <= 0) return null
    return Math.round(src * draftEffectiveRatio.value * 100) / 100
  })

  const draftTempoWarpActive = computed(() =>
    isWarpActive({
      warpEnabled: draftTempoEnabled.value,
      tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : undefined,
      sourceBpm: sourceBpmRef.value,
      projectBpm: transport.bpm
    })
  )

  const draftProcessorEnabled = computed(
    () => draftTempoEnabled.value || pitchNeedsProcessor(draftSemitones.value, draftCents.value)
  )

  const tempoFollowsProject = computed(() => !draftTempoPinned.value)

  function previewTempoRatio(): number | undefined {
    if (draftTempoEnabled.value) return draftEffectiveRatio.value
    return pitchNeedsProcessor(draftSemitones.value, draftCents.value) ? 1 : undefined
  }

  function initialise(current: Clip | LibraryItem | null, editsExistingClip: boolean): void {
    if (!current || !editsExistingClip) {
      draftTempoEnabled.value = false
      draftMode.value = 'rhythmic'
      draftTempoPinned.value = false
      draftPinnedBpm.value = Math.round(transport.bpm * 100) / 100
      draftSemitones.value = 0
      draftCents.value = 0
      return
    }
    draftTempoEnabled.value = currentHasTempoWarp(current)
    draftMode.value = current.warpMode ?? 'rhythmic'
    draftTempoPinned.value =
      typeof current.tempoRatio === 'number' && current.tempoRatio > 0 && current.tempoRatio !== 1
    const src = sourceBpmRef.value
    if (
      draftTempoPinned.value &&
      typeof src === 'number' &&
      src > 0 &&
      typeof current.tempoRatio === 'number'
    ) {
      draftPinnedBpm.value = Math.round(src * current.tempoRatio * 100) / 100
    } else {
      draftPinnedBpm.value = Math.round(transport.bpm * 100) / 100
    }
    draftSemitones.value = current.semitones ?? 0
    draftCents.value = current.cents ?? 0
  }

  function followProjectBpm(): void {
    draftTempoPinned.value = false
  }

  function pinTempo(): void {
    const src = sourceBpmRef.value
    const proj = transport.bpm
    if (typeof src !== 'number' || src <= 0 || typeof proj !== 'number' || proj <= 0) return
    draftTempoPinned.value = true
    if (!Number.isFinite(draftPinnedBpm.value) || draftPinnedBpm.value <= 0) {
      draftPinnedBpm.value = Math.round(proj * 100) / 100
    }
  }

  function applyKeyPreset(semitones: number): void {
    draftSemitones.value = semitones
    draftCents.value = 0
  }

  return {
    draftTempoEnabled,
    draftMode,
    draftTempoPinned,
    draftPinnedBpm,
    draftSemitones,
    draftCents,
    draftEffectiveRatio,
    draftEffectiveBpm,
    draftTempoWarpActive,
    draftProcessorEnabled,
    tempoFollowsProject,
    tempoRatioFromPinnedBpm,
    previewTempoRatio,
    initialise,
    followProjectBpm,
    pinTempo,
    applyKeyPreset
  }
}

// Shared clamp rule for preview-bound draft values.
export { clampNumber }
