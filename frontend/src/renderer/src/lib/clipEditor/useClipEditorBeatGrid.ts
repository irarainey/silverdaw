// Clip Editor manual-tempo fallback: lets the user pin a BPM for the source
// item and slide its rigid beat grid over the waveform to align the phase.
// Detection failures or wrong-phase results no longer leave the user stuck —
// they can set a known BPM and drag the grid onto the beats by hand.
//
// The grid renders from the source item's (bpm, beatAnchorSec); this composable
// just drives those two values through the library store. Edits are kept local to
// the editor session (a live redraw with no bridge round-trip) and committed to the
// backend as a single undoable edit on Save, or discarded on Cancel.

import { ref, watch, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem, type LibraryItemGridSnapshot } from '@/stores/libraryStore'

export interface ClipEditorBeatGridDeps {
  /** The source library item backing the clip, or null when unavailable. */
  sourceItem: () => LibraryItem | null
}

export interface ClipEditorBeatGrid {
  /** When true, dragging the waveform slides the beat grid instead of selecting. */
  alignActive: Ref<boolean>
  /**
   * The beat-grid BPM shown in the tempo field. Browser edits may be numeric; synchronized and
   * committed values are strings formatted to two decimals (e.g. "120.00").
   */
  manualBpmInput: Ref<string | number>
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
  /** Step the source BPM by `delta` (e.g. wheel ±1, or ±0.01 fine), keeping the phase anchor. */
  bumpBpm: (delta: number) => void
  /** Nudge the grid phase by a few milliseconds (fine alignment the drag lacks). */
  nudgeAnchorMs: (deltaMs: number) => void
  /** Shift the grid by half a beat to flip an on-beat/off-beat lock. */
  nudgeHalfBeat: (direction: -1 | 1) => void
  /** Live local anchor update during a drag (seconds). */
  previewAnchorSec: (anchorSec: number) => void
  /** Update the draft anchor after a drag (seconds). Local only — persisted on Save. */
  commitAnchorSec: (anchorSec: number) => void
  /**
   * Persist the session's final grid (bpm + anchor) as a single undoable edit.
   * Call inside the Save undo group. No-op unless the grid was changed and not
   * already committed, so the whole session lands as one undo step.
   */
  commit: () => void
  /**
   * Roll the source grid back to how it opened when a session ends without a Save
   * (Cancel / close). No-op once `commit` has run. Drafts never reach the backend,
   * so this only restores the local view.
   */
  discardIfUncommitted: () => void
  /** Reset per-session grid UI (align mode, edited flag, captured original) for a
   *  freshly opened editor, recapturing the current source tempo as the baseline. */
  reset: () => void
}

const MIN_BPM = 20
const MAX_BPM = 300

function currentAnchorSec(item: LibraryItem): number {
  return item.beatAnchorSec ?? item.beats?.[0] ?? 0
}

export function useClipEditorBeatGrid(deps: ClipEditorBeatGridDeps): ClipEditorBeatGrid {
  const library = useLibraryStore()
  const alignActive = ref(false)
  const manualBpmInput = ref<string | number>('')
  // The tempo the source had when the editor opened. Snapshotted once so the user
  // can always see the value they started from and restore it after an override.
  const originalBpm = ref<number | null>(null)
  // Set once the user pins a BPM or slides the grid; the change stays local to
  // the editor session and is committed to the backend (as one undoable edit) on
  // Save. Also drives the Clip Editor's dirty / Save affordance.
  const gridEdited = ref(false)
  // True after `commit` has persisted the draft, so the close handler doesn't then
  // roll it back as if the session were cancelled.
  let gridCommitted = false
  // The source grid as it looked when the editor opened, so an uncommitted session
  // (Cancel / close without Save) can restore it exactly.
  let gridSnapshot: LibraryItemGridSnapshot | null = null
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
    manualBpmInput.value = cur !== undefined ? cur.toFixed(2) : ''
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
    const rawBpm = String(manualBpmInput.value).trim()
    const bpm = Number(rawBpm)
    if (item && rawBpm !== '' && Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM) {
      if (typeof item.bpm !== 'number' || Math.abs(item.bpm - bpm) > 1e-6) {
        library.setItemManualTempoLocal(item.id, bpm, currentAnchorSec(item))
        gridEdited.value = true
      }
      manualBpmInput.value = bpm.toFixed(2)
    } else if (!tempoEditing || endEditing) {
      // Empty / out-of-range entry: revert the field to the current tempo.
      const cur = currentBpm()
      manualBpmInput.value = cur !== undefined ? cur.toFixed(2) : ''
    }
    if (endEditing) tempoEditing = false
  }

  function restoreOriginalBpm(): void {
    const item = deps.sourceItem()
    const orig = originalBpm.value
    if (!item || orig === null || orig < MIN_BPM || orig > MAX_BPM) return
    library.setItemManualTempoLocal(item.id, orig, currentAnchorSec(item))
    manualBpmInput.value = orig.toFixed(2)
    gridEdited.value = true
  }

  // Re-anchor on the same phase so a halve/double doesn't jump the grid origin.
  function scaleBpm(factor: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    const next = item.bpm * factor
    if (next < MIN_BPM || next > MAX_BPM) return
    library.setItemManualTempoLocal(item.id, next, currentAnchorSec(item))
    manualBpmInput.value = next.toFixed(2)
    gridEdited.value = true
  }

  function halveBpm(): void {
    scaleBpm(0.5)
  }

  function doubleBpm(): void {
    scaleBpm(2)
  }

  function bumpBpm(delta: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0 || !Number.isFinite(delta)) return
    const next = Math.min(MAX_BPM, Math.max(MIN_BPM, item.bpm + delta))
    if (Math.abs(next - item.bpm) < 1e-9) return
    library.setItemManualTempoLocal(item.id, next, currentAnchorSec(item))
    manualBpmInput.value = next.toFixed(2)
    gridEdited.value = true
  }

  function nudgeAnchorMs(deltaMs: number): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0 || !Number.isFinite(deltaMs)) return
    library.setItemManualTempoLocal(item.id, item.bpm, currentAnchorSec(item) + deltaMs / 1000)
    gridEdited.value = true
  }

  function nudgeHalfBeat(direction: -1 | 1): void {
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    const halfBeatSec = 30 / item.bpm
    library.setItemManualTempoLocal(item.id, item.bpm, currentAnchorSec(item) + direction * halfBeatSec)
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
    library.setItemManualTempoLocal(item.id, item.bpm, anchorSec)
    gridEdited.value = true
  }

  function commit(): void {
    if (!gridEdited.value || gridCommitted) return
    const item = deps.sourceItem()
    if (!item || !item.bpm || item.bpm <= 0) return
    // The draft already lives in the item's local (bpm, anchor); persist that final
    // pair as the session's single undoable grid edit.
    library.setItemManualTempo(item.id, item.bpm, currentAnchorSec(item))
    gridCommitted = true
  }

  function discardIfUncommitted(): void {
    if (!gridEdited.value || gridCommitted || !gridSnapshot) return
    const item = deps.sourceItem()
    if (item) library.restoreItemGridLocal(item.id, gridSnapshot)
    gridEdited.value = false
  }

  function reset(): void {
    // Slide-to-align, the session edit flag, and the tempo-edit lock are per-open UI
    // state — without this they persisted into the next clip's editor session.
    alignActive.value = false
    gridEdited.value = false
    gridCommitted = false
    tempoEditing = false
    const item = deps.sourceItem()
    gridSnapshot = item ? library.snapshotItemGrid(item.id) : null
    const bpm = item?.bpm
    originalBpm.value = typeof bpm === 'number' && bpm > 0 ? bpm : null
    syncTempoField()
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
    bumpBpm,
    nudgeAnchorMs,
    nudgeHalfBeat,
    previewAnchorSec,
    commitAnchorSec,
    commit,
    discardIfUncommitted,
    reset
  }
}
