// Per-clip warp/pitch settings dialog, opened from the timeline clip context
// menu. Controls: enable toggle, mode (rhythmic/tonal/complex), and tempo
// (follow project BPM or pin to a value). Edits are held locally until Save;
// Cancel/Escape/backdrop discard the draft like the app's other modal editors.

import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { libraryItemDisplayName, useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { keyBadgeClass } from '@/lib/keyBadge'
import { keyPresetsFor, shiftedKey } from '@/lib/pitchKey'
import { effectiveTempoRatio } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

export type ClipWarpDialogProps = {
  open: boolean
  clipId?: string | null
  itemId?: string | null
  panel?: 'tempo' | 'pitch'
}

export function useClipWarpDialogController(
  props: Readonly<ClipWarpDialogProps>,
  emit: (e: 'close') => void,
  dialogEl: Ref<HTMLDivElement | null>
) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()

  const clip = computed(() => (props.clipId ? project.clips[props.clipId] : undefined))
  const libItem = computed(() =>
    props.itemId
      ? library.byId[props.itemId]
      : clip.value ? library.byId[clip.value!.libraryItemId] : undefined
  )

  const sourceBpm = computed(() => libItem.value?.bpm)
  const projectBpm = computed(() => transport.bpm)
  const dialogTitle = computed(() => props.panel === 'pitch' ? 'Pitch' : 'Warp')
  // True when the dialog's target is a saved-clip library item — either
  // opened directly via `itemId`, or opened via a `clipId` whose parent
  // library entry is a saved-clip (the "linked" timeline-clip case).
  // Routing through `library.updateSavedClipWarp` in both cases keeps the
  // semantic identical to editing the library item from the Clip Editor:
  // the library entry's defaults move AND every linked timeline instance
  // stays in lockstep.
  const isLinkedTarget = computed(() => libItem.value?.kind === 'saved-clip')
  const clipTitle = computed(() => {
    const custom = clip.value?.name?.trim()
    if (custom) return custom
    return libItem.value ? libraryItemDisplayName(libItem.value) : 'clip'
  })

  const draftEnabled = ref(false)
  const draftMode = ref<ClipWarpMode>('rhythmic')
  const draftTempoPinned = ref(false)
  const draftPinnedBpm = ref(120)
  const draftSemitones = ref(0)
  const draftCents = ref(0)

  const sourceKey = computed(() => {
    const item = libItem.value
    if (!item) return undefined
    if (item.key || item.metadata?.key) return item.key ?? item.metadata?.key
    const sourceId = item.derivedFrom?.sourceItemId
    if (!sourceId) return undefined
    const source = library.byId[sourceId]
    return source?.key ?? source?.metadata?.key
  })
  const keyPresets = computed(() => keyPresetsFor(sourceKey.value))
  const currentPitchKey = computed(() => shiftedKey(sourceKey.value, draftSemitones.value, draftCents.value))

  // Tempo source: either "follow project BPM" (no `tempoRatio` on the
  // clip) or "pin to a specific source BPM" (`tempoRatio` is set).
  const tempoFollowsProject = computed(() => !draftTempoPinned.value)

  /** When pinned, the BPM the clip plays AT — derived from `tempoRatio`
   *  and the source BPM via `pinnedBpm = sourceBpm * tempoRatio`. We
   *  surface BPM rather than ratio in the UI because the user thinks
   *  in tempos, not in stretch factors. */
  function followProjectBpm(): void {
    draftTempoPinned.value = false
  }

  function pinTempo(): void {
    const src = sourceBpm.value
    const proj = projectBpm.value
    if (typeof src !== 'number' || src <= 0 || typeof proj !== 'number' || proj <= 0) return
    // Pin at the current effective ratio (which is `projectBpm/sourceBpm`
    // if not already pinned) so flipping the toggle on doesn't audibly
    // change anything until the user moves the slider.
    draftTempoPinned.value = true
    if (!Number.isFinite(draftPinnedBpm.value) || draftPinnedBpm.value <= 0) {
      draftPinnedBpm.value = Math.round(proj * 100) / 100
    }
  }

  function pitchNeedsProcessor(semitonesValue: number, centsValue: number): boolean {
    return semitonesValue !== 0 || centsValue !== 0
  }

  function applyKeyPreset(semitones: number): void {
    draftSemitones.value = semitones
    draftCents.value = 0
  }

  const effectiveRatio = computed(() =>
    effectiveTempoRatio({
      tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : undefined,
      sourceBpm: sourceBpm.value,
      projectBpm: projectBpm.value
    })
  )

  const effectiveBpm = computed(() => {
    const src = sourceBpm.value
    if (typeof src !== 'number' || src <= 0) return null
    return Math.round(src * effectiveRatio.value * 100) / 100
  })

  function clampNumber(v: number, lo: number, hi: number): number {
    if (!Number.isFinite(v)) return 0
    return Math.max(lo, Math.min(hi, v))
  }

  function tempoRatioFromPinnedBpm(): number | undefined {
    const src = sourceBpm.value
    if (typeof src !== 'number' || src <= 0) return undefined
    const bpm = clampNumber(draftPinnedBpm.value, 20, 300)
    return Math.max(0.25, Math.min(4, bpm / src))
  }

  function initialiseDraft(): void {
    const c = clip.value ?? libItem.value
    draftEnabled.value = c?.warpEnabled === true
    draftMode.value = c?.warpMode ?? 'rhythmic'
    draftTempoPinned.value = typeof c?.tempoRatio === 'number' && c.tempoRatio > 0
    const src = sourceBpm.value
    if (draftTempoPinned.value && typeof src === 'number' && src > 0 && typeof c?.tempoRatio === 'number') {
      draftPinnedBpm.value = Math.round(src * c.tempoRatio * 100) / 100
    } else {
      draftPinnedBpm.value = Math.round((projectBpm.value ?? 120) * 100) / 100
    }
    draftSemitones.value = c?.semitones ?? 0
    draftCents.value = c?.cents ?? 0
  }

  function save(): void {
    if (props.panel === 'tempo') {
      const patch = {
        warpEnabled: draftEnabled.value,
        warpMode: draftMode.value,
        tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : null
      }
      if (isLinkedTarget.value && libItem.value) {
        // Library item (either opened directly OR opened via a linked
        // timeline clip): propagates to the saved-clip entry and every
        // linked timeline instance in lockstep.
        library.updateSavedClipWarp(libItem.value.id, patch)
      } else if (props.clipId) {
        // Unlinked timeline clip: edit only this clip.
        project.setClipWarp(props.clipId, patch)
      }
    } else {
      const nextSemitones = clampNumber(draftSemitones.value, -12, 12)
      const nextCents = clampNumber(draftCents.value, -100, 100)
      const patch = {
        semitones: nextSemitones,
        cents: nextCents,
        warpEnabled: pitchNeedsProcessor(nextSemitones, nextCents) ? true : undefined
      }
      if (isLinkedTarget.value && libItem.value) {
        library.updateSavedClipWarp(libItem.value.id, patch)
      } else if (props.clipId) {
        project.setClipWarp(props.clipId, patch)
      }
    }
    emit('close')
  }

  function cancel(): void {
    emit('close')
  }

  // Suppress global Spacebar play / Esc handlers while the dialog is open.
  // Same plumbing the Clip Editor uses; we lean on it to keep slider
  // drags from accidentally toggling playback.
  watch(
    () => props.open,
    (now) => {
      ui.clipEditorOpen = now
      if (now) {
        initialiseDraft()
        void dialogEl.value?.focus()
      }
    }
  )

  watch(
    () => [props.clipId, props.itemId, props.panel] as const,
    () => {
      if (props.open) initialiseDraft()
    }
  )

  onMounted(() => {
    if (props.open) ui.clipEditorOpen = true
  })

  onBeforeUnmount(() => {
    if (props.open) ui.clipEditorOpen = false
  })

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      cancel()
    }
  }

  return {
    clip,
    libItem,
    sourceBpm,
    projectBpm,
    dialogTitle,
    isLinkedTarget,
    clipTitle,
    draftEnabled,
    draftMode,
    draftPinnedBpm,
    draftSemitones,
    draftCents,
    sourceKey,
    keyPresets,
    currentPitchKey,
    tempoFollowsProject,
    followProjectBpm,
    pinTempo,
    applyKeyPreset,
    effectiveRatio,
    effectiveBpm,
    keyBadgeClass,
    save,
    cancel,
    onKeydown
  }
}
