// Draft warp + pitch state for the Clip Editor.
//
// The dialog is transactional: every warp / pitch control change is held
// in this draft until the user clicks **Save**. Save commits it to the
// library item (and propagates to linked clips); Cancel discards the
// draft entirely. The draft is also what the preview voice plays back
// while editing, so changing a slider is audible immediately even
// though nothing is persisted yet.
//
// `useClipEditorWarpDraft` extracts that state machinery from
// `ClipEditorDialog.vue` so the dialog shell, the inline
// warp/pitch panel, and the future test suite all read from one
// place. The dialog still owns the lifecycle (call `initialise()`
// every time the editor opens on a new target; the values are
// passive otherwise).

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

/** Returns true when the given warp settings include a non-trivial
 *  pitch shift (which requires the Rubber Band processor even when
 *  tempo warp is disabled). */
export function pitchNeedsProcessor(
  semitones: number | undefined,
  cents: number | undefined
): boolean {
  return (semitones ?? 0) !== 0 || (cents ?? 0) !== 0
}

/** Determine whether a clip / library item has *audible tempo warp*
 *  applied — i.e. warp is enabled and the source isn't just being used
 *  as a pitch-only host (where `tempoRatio === 1` means "pitch shift,
 *  no tempo change"). */
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
  /** Effective tempo ratio if the current draft were committed. `1.0`
   *  when warp is disabled or the tempo would resolve to 1×. */
  draftEffectiveRatio: ComputedRef<number>
  /** Effective BPM (source BPM × ratio) for the inspector's read-out.
   *  `null` when no source BPM has been detected. */
  draftEffectiveBpm: ComputedRef<number | null>
  /** True when warp is enabled AND the resulting ratio is audibly
   *  different from 1.0. Drives the WARP pill in the editor header. */
  draftTempoWarpActive: ComputedRef<boolean>
  /** True when the Rubber Band processor must be installed — either
   *  warp is on OR pitch is shifted (a pitch-only run still needs the
   *  processor at tempoRatio 1). */
  draftProcessorEnabled: ComputedRef<boolean>
  /** True when the "Follow project BPM" radio is selected. */
  tempoFollowsProject: ComputedRef<boolean>

  // ─── Helpers ───
  /** Convert the pinned-BPM draft into a Rubber Band `tempoRatio`.
   *  Returns `undefined` if the source has no detected BPM (so no ratio
   *  can be derived). */
  tempoRatioFromPinnedBpm: () => number | undefined
  /** The tempo ratio to push to the preview voice for the current
   *  draft. Returns `undefined` when the processor should be bypassed
   *  on the preview path, `1` when only pitch is active. */
  previewTempoRatio: () => number | undefined

  // ─── Lifecycle ───
  /** Seed the draft from a clip / library item — usually called every
   *  time the dialog opens on a fresh target. Resets to defaults when
   *  the editor is opened on a `source-library` item. */
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

// Re-exported clamp helper so the dialog can apply the same rounding
// to draft values it ships to the preview voice without duplicating
// the rule.
export { clampNumber }
