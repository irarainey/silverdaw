// Correcting a mis-detected tempo from the Edit BPM dialog (ADR 0027).
//
// The Clip Editor reaches the same command through `useClipEditorBeatGrid`, but it has a
// whole grid-draft session to unwind first: the typed BPM is written locally onto the
// item being edited so the markers redraw live, and that draft has to be rolled back and
// re-applied to the tempo OWNER before the command is sent. The Edit BPM dialog has none
// of that. It shows one number, the user retypes it, and the correction goes straight
// out — so this is deliberately a separate, much smaller composable rather than a
// generalisation of the editor's.
//
// What it shares is the meaning: a tempo typed here is a statement that detection read
// the wrong number, never a musical instruction. There is no arrangement intent in the
// library, so this can only ever be a correction, and it therefore leaves every clip
// start, marker and automation point exactly where it is. It also never touches the
// project tempo, which is the user's own setting rather than a fact about any file.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

import { useLibraryStore } from '@/stores/libraryStore'
import {
  libraryItemDisplayName,
  resolveCorrectableTempoOwner,
  type CorrectableTempoOwner
} from '@/stores/libraryItemHelpers'
import { MAX_BPM, MIN_BPM } from '@/lib/musicTime'
import type { LibraryItem } from '@/stores/libraryTypes'

export interface LibraryItemTempoCorrection {
  /**
   * The tempo field's raw binding, so an in-progress entry is never reformatted
   * underneath. Vue's `v-model` on `<input type="number">` yields a number once the entry
   * parses and the empty string while it does not, so this is deliberately either — read
   * it through {@link LibraryItemTempoCorrection.typedBpm} rather than assuming a string.
   */
  bpmInput: Ref<string | number>
  /** The tempo the item resolves to now — the number believed to be wrong. */
  currentBpm: ComputedRef<number | null>
  /** The tempo the user has typed, NaN while it is unusable. */
  typedBpm: ComputedRef<number>
  /** The resolved owner, or null when nothing here owns a correctable tempo. */
  owner: ComputedRef<CorrectableTempoOwner | null>
  /** Set when the tempo is inherited, naming the item that actually owns it. */
  ownerName: ComputedRef<string | null>
  /** True when the owner's tempo comes from a recorded musical length. */
  fromMusicalLength: ComputedRef<boolean>
  /** Whether a correction is available: a correctable owner and a different, valid number. */
  canCorrect: ComputedRef<boolean>
  /** True when the item has a tempo that could be corrected, whatever is typed. */
  isCorrectable: ComputedRef<boolean>
  /** Send the correction. Returns false when it was not available. */
  apply: () => boolean
  /** Put the field back to the item's current tempo, abandoning what was typed. */
  reset: () => void
}

/**
 * Correction state for one library item.
 *
 * `item` is a getter rather than a value because the info dialog re-targets in place:
 * the same dialog instance is reused for the next item the user asks about.
 */
export function useLibraryItemTempoCorrection(
  item: () => LibraryItem | null | undefined
): LibraryItemTempoCorrection {
  const library = useLibraryStore()

  const bpmInput = ref<string | number>('')

  /** The entry as text, whichever of the two shapes `v-model` handed back. */
  const bpmText = computed(() => String(bpmInput.value).trim())

  const owner = computed<CorrectableTempoOwner | null>(() =>
    // A one-shot has no tempo to correct, and an item with none has nothing to correct
    // FROM — offering a field on either would write a number nothing ever draws.
    resolveCorrectableTempoOwner(item(), library.byId)
  )

  const currentBpm = computed<number | null>(() => owner.value?.bpm ?? null)

  const isCorrectable = computed(() => owner.value !== null)

  const ownerName = computed<string | null>(() => {
    const resolved = owner.value
    const target = item()
    if (!resolved || !target || resolved.ownerItemId === target.id) return null
    const owningItem = library.byId[resolved.ownerItemId]
    return owningItem ? libraryItemDisplayName(owningItem) : resolved.ownerItemId
  })

  const fromMusicalLength = computed(() => owner.value?.reason === 'musicalLength')

  const typedBpm = computed(() => Number(bpmText.value))

  const canCorrect = computed(() => {
    const current = currentBpm.value
    const typed = typedBpm.value
    if (!isCorrectable.value || current === null) return false
    if (bpmText.value === '' || !Number.isFinite(typed)) return false
    if (typed < MIN_BPM || typed > MAX_BPM) return false
    return Math.abs(typed - current) > 1e-6
  })

  function reset(): void {
    const current = currentBpm.value
    bpmInput.value = current !== null ? current.toFixed(2) : ''
  }

  function apply(): boolean {
    const resolved = owner.value
    if (!resolved || !canCorrect.value) return false
    const ownerItemId = resolved.ownerItemId

    // The correction targets the OWNER, so it must carry the owner's own phase: this
    // surface never edits phase, and pushing anything else would slide the grid of every
    // clip cut from that file while claiming to have only changed a number.
    const ownerItem = library.byId[ownerItemId]
    const anchorSec = ownerItem?.beatAnchorSec ?? ownerItem?.beats?.[0] ?? 0

    // `correctItemTempo` owns the optimistic write and its rollback, so a rejected
    // correction cannot leave this field showing a tempo the backend refused.
    if (!library.correctItemTempo(ownerItemId, typedBpm.value, anchorSec)) {
      return false
    }
    reset()
    return true
  }

  // Re-target cleanly: a number typed for the previous item must never be left standing
  // against a different one.
  watch(() => item()?.id, reset, { immediate: true })

  // Follow the backend's echo, but never while the user is mid-correction: their typed
  // number is the whole point of the field.
  watch(currentBpm, () => {
    if (!canCorrect.value) reset()
  })

  return {
    bpmInput,
    currentBpm,
    typedBpm,
    owner,
    ownerName,
    fromMusicalLength,
    canCorrect,
    isCorrectable,
    apply,
    reset
  }
}
