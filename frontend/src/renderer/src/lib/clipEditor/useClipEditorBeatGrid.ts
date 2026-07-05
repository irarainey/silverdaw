// Clip Editor manual-tempo fallback: lets the user pin a BPM for the source
// item and slide its rigid beat grid over the waveform to align the phase.
// Detection failures or wrong-phase results no longer leave the user stuck —
// they can set a known BPM and drag the grid onto the beats by hand.
//
// The grid renders from the source item's (bpm, beatAnchorSec); this composable
// just drives those two values through the library store. Sliding updates the
// anchor locally for a live redraw, then persists once on pointer release.

import { ref, watch, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

export interface ClipEditorBeatGridDeps {
  /** The source library item backing the clip, or null when unavailable. */
  sourceItem: () => LibraryItem | null
}

export interface ClipEditorBeatGrid {
  /** When true, dragging the waveform slides the beat grid instead of selecting. */
  alignActive: Ref<boolean>
  /**
   * The beat-grid BPM shown in (and edited via) the tempo field. Kept in sync with
   * the source's current tempo unless the user is actively editing it.
   */
  manualBpmInput: Ref<number | null>
  /**
   * The source tempo captured when the editor opened, so the user can see what
   * they started from and revert to it. Null until a valid BPM is first observed.
   */
  originalBpm: Ref<number | null>
  /** Whether the source currently has a tempo grid to align. */
  hasGrid: () => boolean
  /** Whether the current BPM differs from the captured original (restore is possible). */
  canRestore: () => boolean
  /**
   * Whether the user has changed the source grid (set a manual BPM or slid the
   * anchor) during this editor session. Drives the Clip Editor's dirty / Save
   * affordance even though the change is already persisted to the source item.
   */
  hasGridChanged: () => boolean
  /** Toggle slide-to-align mode (no-op without a grid). */
  toggleAlign: () => void
  /** Mark the tempo field as being edited so external tempo changes don't clobber typing. */
  beginTempoEdit: () => void
  /**
   * Commit the typed tempo, keeping the current phase anchor. Reverts to the current
   * tempo when the entry is empty or out of range. Pass `endEditing` on blur to release
   * the edit lock so the field resumes tracking the source tempo.
   */
  commitTempoEdit: (endEditing?: boolean) => void
  /** Restore the source tempo to the value captured when the editor opened. */
  restoreOriginalBpm: () => void
  /** Halve / double the source BPM (octave fix), keeping the phase anchor. */
  halveBpm: () => void
  doubleBpm: () => void
  /** Nudge the grid phase by a few milliseconds (fine alignment the drag lacks). */
  nudgeAnchorMs: (deltaMs: number) => void
  /** Shift the grid by half a beat to flip an on-beat/off-beat lock. */
  nudgeHalfBeat: (direction: -1 | 1) => void
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
  // The tempo the source had when the editor opened. Snapshotted once so the user
  // can always see the value they started from and restore it after an override.
  const originalBpm = ref<number | null>(null)
  // Set once the user pins a BPM or slides the grid; the source change is
  // persisted immediately, but the Clip Editor still needs a dirty signal so
  // Save enables and gives the edit explicit closure.
  const gridEdited = ref(false)
  // True while the user is typing in the tempo field, so external tempo changes
  // (octave, restore, backend echo) don't overwrite what they are entering.
  let tempoEditing = false

  function currentBpm(): number | undefined {
    const bpm = deps.sourceItem()?.bpm
    return typeof bpm === 'number' && bpm > 0 ? bpm : undefined
  }

  function syncTempoField(): void {
    if (tempoEditing) return
    const cur = currentBpm()
    manualBpmInput.value = cur !== undefined ? Math.round(cur * 100) / 100 : null
  }

  watch(
    () => deps.sourceItem()?.bpm,
    (bpm) => {
      if (originalBpm.value === null && typeof bpm === 'number' && bpm > 0) {
        originalBpm.value = bpm
      }
      syncTempoField()
    },
    { immediate: true }
  )

  function hasGrid(): boolean {
    const item = deps.sourceItem()
    return !!item && typeof item.bpm === 'number' && item.bpm > 0
  }

  function canRestore(): boolean {
    const item = deps.sourceItem()
    const orig = originalBpm.value
    return !!item && typeof item.bpm === 'number' && orig !== null && Math.abs(item.bpm - orig) > 1e-6
  }

  function hasGridChanged(): boolean {
    return gridEdited.value
  }

  function toggleAlign(): void {
    if (!hasGrid()) {
      alignActive.value = false
      return
    }
    alignActive.value = !alignActive.value
  }

  function beginTempoEdit(): void {
    tempoEditing = true
  }

  function commitTempoEdit(endEditing = false): void {
    const item = deps.sourceItem()
    const bpm = manualBpmInput.value
    if (item && typeof bpm === 'number' && bpm >= MIN_BPM && bpm <= MAX_BPM) {
      if (typeof item.bpm !== 'number' || Math.abs(item.bpm - bpm) > 1e-6) {
        library.setItemManualTempo(item.id, bpm, currentAnchorSec(item))
        gridEdited.value = true
      }
      manualBpmInput.value = Math.round(bpm * 100) / 100
    } else if (!tempoEditing || endEditing) {
      // Empty / out-of-range entry: revert the field to the current tempo.
      const cur = currentBpm()
      manualBpmInput.value = cur !== undefined ? Math.round(cur * 100) / 100 : null
    }
    if (endEditing) tempoEditing = false
  }

  function restoreOriginalBpm(): void {
    const item = deps.sourceItem()
    const orig = originalBpm.value
    if (!item || orig === null || orig < MIN_BPM || orig > MAX_BPM) return
    library.setItemManualTempo(item.id, orig, currentAnchorSec(item))
    manualBpmInput.value = Math.round(orig * 100) / 100
    gridEdited.value = true
  }

  // Re-anchor on the same phase so a halve/double doesn't jump the grid origin.
  function scaleBpm(factor: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    const next = item.bpm * factor
    if (next < MIN_BPM || next > MAX_BPM) return
    library.setItemManualTempo(item.id, next, currentAnchorSec(item))
    manualBpmInput.value = Math.round(next * 100) / 100
    gridEdited.value = true
  }

  function halveBpm(): void {
    scaleBpm(0.5)
  }

  function doubleBpm(): void {
    scaleBpm(2)
  }

  function nudgeAnchorMs(deltaMs: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0 || !Number.isFinite(deltaMs)) return
    library.setItemManualTempo(item.id, item.bpm, currentAnchorSec(item) + deltaMs / 1000)
    gridEdited.value = true
  }

  function nudgeHalfBeat(direction: -1 | 1): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    const halfBeatSec = 30 / item.bpm
    library.setItemManualTempo(item.id, item.bpm, currentAnchorSec(item) + direction * halfBeatSec)
    gridEdited.value = true
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
    gridEdited.value = true
  }

  return {
    alignActive,
    manualBpmInput,
    originalBpm,
    hasGrid,
    canRestore,
    hasGridChanged,
    toggleAlign,
    beginTempoEdit,
    commitTempoEdit,
    restoreOriginalBpm,
    halveBpm,
    doubleBpm,
    nudgeAnchorMs,
    nudgeHalfBeat,
    previewAnchorSec,
    commitAnchorSec
  }
}
