// Clip Editor manual-tempo fallback: lets the user pin a BPM for the source
// item and slide its rigid beat grid over the waveform to align the phase.
// Detection failures or wrong-phase results no longer leave the user stuck —
// they can set a known BPM and drag the grid onto the beats by hand.
//
// The grid renders from the source item's (bpm, beatAnchorSec); this composable
// just drives those two values through the library store. Sliding updates the
// anchor locally for a live redraw, then persists once on pointer release.

import { ref, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

export interface ClipEditorBeatGridDeps {
  /** The source library item backing the clip, or null when unavailable. */
  sourceItem: () => LibraryItem | null
}

export interface ClipEditorBeatGrid {
  /** When true, dragging the waveform slides the beat grid instead of selecting. */
  alignActive: Ref<boolean>
  /** Two-way bound BPM the user types before applying. */
  manualBpmInput: Ref<number | null>
  /** Whether the source currently has a tempo grid to align. */
  hasGrid: () => boolean
  /** Whether `manualBpmInput` is a valid, applicable BPM. */
  canApply: () => boolean
  /** Toggle slide-to-align mode (no-op without a grid). */
  toggleAlign: () => void
  /** Apply the typed BPM, keeping the current phase anchor. */
  applyManualBpm: () => void
  /** Live local anchor update during a drag (seconds). */
  previewAnchorSec: (anchorSec: number) => void
  /** Persist the final anchor after a drag (seconds). */
  commitAnchorSec: (anchorSec: number) => void
}

const MIN_BPM = 20
const MAX_BPM = 300

function currentAnchorSec(item: LibraryItem): number {
  return item.beatAnchorSec ?? item.beats?.[0] ?? 0
}

export function useClipEditorBeatGrid(deps: ClipEditorBeatGridDeps): ClipEditorBeatGrid {
  const library = useLibraryStore()
  const alignActive = ref(false)
  const manualBpmInput = ref<number | null>(null)

  function hasGrid(): boolean {
    const item = deps.sourceItem()
    return !!item && typeof item.bpm === 'number' && item.bpm > 0
  }

  function canApply(): boolean {
    const bpm = manualBpmInput.value
    return !!deps.sourceItem() && typeof bpm === 'number' && bpm >= MIN_BPM && bpm <= MAX_BPM
  }

  function toggleAlign(): void {
    if (!hasGrid()) {
      alignActive.value = false
      return
    }
    alignActive.value = !alignActive.value
  }

  function applyManualBpm(): void {
    const item = deps.sourceItem()
    const bpm = manualBpmInput.value
    if (!item || typeof bpm !== 'number' || bpm < MIN_BPM || bpm > MAX_BPM) return
    library.setItemManualTempo(item.id, bpm, currentAnchorSec(item))
  }

  function previewAnchorSec(anchorSec: number): void {
    const item = deps.sourceItem()
    if (!item) return
    library.setItemBeatAnchorLocal(item.id, anchorSec)
  }

  function commitAnchorSec(anchorSec: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    library.setItemManualTempo(item.id, item.bpm, anchorSec)
  }

  return {
    alignActive,
    manualBpmInput,
    hasGrid,
    canApply,
    toggleAlign,
    applyManualBpm,
    previewAnchorSec,
    commitAnchorSec
  }
}
