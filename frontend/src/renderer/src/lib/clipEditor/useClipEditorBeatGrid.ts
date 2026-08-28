// Clip Editor manual-tempo fallback: lets the user pin a BPM for the source
// item and slide its rigid beat grid over the waveform to align the phase.
// Detection failures or wrong-phase results no longer leave the user stuck —
// they can set a known BPM and drag the grid onto the beats by hand.
//
// The grid renders from the source item's (bpm, beatAnchorSec); this composable
// just drives those two values through the library store. Edits are kept local to
// the editor session (a live redraw with no bridge round-trip) and committed to the
// backend as a single undoable edit on Save, or discarded on Cancel.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem, type LibraryItemGridSnapshot } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { libraryItemIsSimple } from '@/stores/libraryItemHelpers'
import { resolveSourceBeatGrid, type SourceBeatGrid } from '@/lib/clip/sourceBeatGrid'
import { MAX_BPM, MIN_BPM } from '@/lib/musicTime'

export interface ClipEditorBeatGridDeps {
  /** The source library item backing the clip, or null when unavailable. */
  sourceItem: () => LibraryItem | null
  /**
   * The unlinked timeline clip that owns the grid PHASE, or null when the session edits a
   * library item or a linked (saved) clip, where the phase is shared by design.
   *
   * A split makes two independent clips, so correcting where beat one falls in one of them
   * must not move the markers on its siblings — which is exactly what writing the shared
   * library-item anchor did. Spacing still comes from the source BPM and stays item-wide;
   * there is only ever one answer for a source tempo (ADR 0024).
   */
  phaseClip?: () => { id: string; beatOffsetMs?: number } | null
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
  /**
   * Whether the source is a one-shot, and so can never have a beat grid however it
   * is retuned. Distinct from `hasGrid`, which is also false for a musical item
   * that simply has no tempo yet — that one may still be given a BPM by hand.
   */
  isOneShot: () => boolean
  /**
   * The resolved source beat grid every editor surface draws and snaps to
   * (waveform lines, envelope beat snap, grid slicing). Resolved through the
   * shared module so an inherited BPM counts.
   */
  resolvedGrid: ComputedRef<SourceBeatGrid | null>
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

export function useClipEditorBeatGrid(deps: ClipEditorBeatGridDeps): ClipEditorBeatGrid {
  const library = useLibraryStore()
  const alignActive = ref(false)
  const manualBpmInput = ref<string | number>('')

  // Draft phase offset (source ms) for the clip that owns it. Local until Save, exactly
  // like the tempo draft, so nothing on the timeline reflows while the user drags.
  const clipPhaseDraftMs = ref(0)

  const itemGrid = computed<SourceBeatGrid | null>(() => {
    const item = deps.sourceItem()
    return item ? resolveSourceBeatGrid(item, library.byId) : null
  })

  const resolvedGrid = computed<SourceBeatGrid | null>(() => {
    const grid = itemGrid.value
    if (!grid) return null
    // Phase belongs to the clip when there is one; spacing is always the source's.
    if (!deps.phaseClip?.()) return grid
    return { ...grid, anchorMs: grid.anchorMs + clipPhaseDraftMs.value }
  })

  const oneShot = computed<boolean>(() => {
    const item = deps.sourceItem()
    return item ? libraryItemIsSimple(item, library.byId) : false
  })

  function isOneShot(): boolean {
    return oneShot.value
  }
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
  // Set when the SOURCE grid was changed (tempo, or a phase edit on a surface that has
  // no owning clip). Only this may write the library item on Save — a clip-local phase
  // session must leave the source, and therefore every sibling clip, untouched.
  let itemGridEdited = false
  // The source grid as it looked when the editor opened, so an uncommitted session
  // (Cancel / close without Save) can restore it exactly.
  let gridSnapshot: LibraryItemGridSnapshot | null = null
  // The item that snapshot came from, held by id rather than re-resolved on close.
  // The dialog drives `open` and `item` from the same ref, so both clear in one flush
  // and the close handler would find no target to restore onto — silently keeping the
  // draft. An id also restores onto the right item if the target switched mid-session.
  let gridSnapshotItemId: string | null = null
  // True while the user is typing in the tempo field, so external tempo changes
  // (octave, restore, backend echo) don't overwrite what they are entering.
  let tempoEditing = false

  function currentBpm(): number | undefined {
    // Always the tempo the grid is actually drawn from, so the controls can never
    // act on something the user cannot see: an item inheriting its source's tempo
    // is editable, while a one-shot (which draws no grid) is inert.
    const bpm = resolvedGrid.value?.bpm
    return typeof bpm === 'number' && bpm > 0 ? bpm : undefined
  }

  /** Grid phase to keep when only the tempo changes; the ITEM's own anchor, never the
   *  clip-shifted one, so a BPM edit can't leak this clip's phase onto the source. */
  function currentAnchorSec(): number {
    const grid = itemGrid.value
    if (grid) return grid.anchorMs / 1000
    const item = deps.sourceItem()
    return item?.beatAnchorSec ?? item?.beats?.[0] ?? 0
  }

  /** Move the grid phase to `anchorSec`, writing whichever of the two owns it. */
  function setAnchorSec(anchorSec: number, local: boolean): void {
    const item = deps.sourceItem()
    if (!item || !Number.isFinite(anchorSec)) return
    if (deps.phaseClip?.()) {
      const base = itemGrid.value?.anchorMs
      if (typeof base !== 'number') return
      clipPhaseDraftMs.value = anchorSec * 1000 - base
      // Markers redraw off `resolvedGrid`; nothing on the item changes.
      useProjectStore().timelineRevision++
      if (!local) gridEdited.value = true
      return
    }
    if (local) {
      library.setItemBeatAnchorLocal(item.id, anchorSec)
      return
    }
    const cur = currentBpm()
    if (cur === undefined) return
    library.setItemManualTempoLocal(item.id, cur, anchorSec)
    gridEdited.value = true
    itemGridEdited = true
  }

  function syncTempoField(): void {
    if (tempoEditing) return
    const cur = currentBpm()
    manualBpmInput.value = cur !== undefined ? cur.toFixed(2) : ''
  }

  watch(
    currentBpm,
    (bpm) => {
      if (originalBpm.value === null && typeof bpm === 'number' && bpm > 0) {
        originalBpm.value = bpm
      }
      syncTempoField()
    },
    { immediate: true }
  )

  function hasGrid(): boolean {
    // Agrees with what is drawn: any resolvable grid, inherited or not.
    return resolvedGrid.value !== null
  }

  function canRestore(): boolean {
    const cur = currentBpm()
    const orig = originalBpm.value
    return cur !== undefined && orig !== null && Math.abs(cur - orig) > 1e-6
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
    // A one-shot can never show a grid, so typing a tempo at it would silently
    // write a value with nothing to display; a musical item with no tempo yet is
    // exactly who this field is for.
    if (item && !oneShot.value && rawBpm !== '' && Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM) {
      const cur = currentBpm()
      if (cur === undefined || Math.abs(cur - bpm) > 1e-6) {
        library.setItemManualTempoLocal(item.id, bpm, currentAnchorSec())
        gridEdited.value = true
        itemGridEdited = true
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
    library.setItemManualTempoLocal(item.id, orig, currentAnchorSec())
    manualBpmInput.value = orig.toFixed(2)
    gridEdited.value = true
    itemGridEdited = true
  }

  // Re-anchor on the same phase so a halve/double doesn't jump the grid origin.
  function scaleBpm(factor: number): void {
    const item = deps.sourceItem()
    const cur = currentBpm()
    if (!item || cur === undefined) return
    const next = cur * factor
    if (next < MIN_BPM || next > MAX_BPM) return
    library.setItemManualTempoLocal(item.id, next, currentAnchorSec())
    manualBpmInput.value = next.toFixed(2)
    gridEdited.value = true
    itemGridEdited = true
  }

  function halveBpm(): void {
    scaleBpm(0.5)
  }

  function doubleBpm(): void {
    scaleBpm(2)
  }

  function bumpBpm(delta: number): void {
    const item = deps.sourceItem()
    const cur = currentBpm()
    if (!item || cur === undefined || !Number.isFinite(delta)) return
    const next = Math.min(MAX_BPM, Math.max(MIN_BPM, cur + delta))
    if (Math.abs(next - cur) < 1e-9) return
    library.setItemManualTempoLocal(item.id, next, currentAnchorSec())
    manualBpmInput.value = next.toFixed(2)
    gridEdited.value = true
    itemGridEdited = true
  }

  function nudgeAnchorMs(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) return
    const grid = resolvedGrid.value
    if (!grid) return
    setAnchorSec(grid.anchorMs / 1000 + deltaMs / 1000, false)
  }

  function nudgeHalfBeat(direction: -1 | 1): void {
    const cur = currentBpm()
    const grid = resolvedGrid.value
    if (cur === undefined || !grid) return
    setAnchorSec(grid.anchorMs / 1000 + (direction * 30) / cur, false)
  }

  function previewAnchorSec(anchorSec: number): void {
    setAnchorSec(anchorSec, true)
  }

  function commitAnchorSec(anchorSec: number): void {
    setAnchorSec(anchorSec, false)
  }

  function commit(): void {
    if (!gridEdited.value || gridCommitted) return
    const item = deps.sourceItem()
    const cur = currentBpm()
    if (!item || cur === undefined) return
    const clip = deps.phaseClip?.()
    if (clip) {
      // Phase is this clip's alone; the source item keeps whatever anchor it had, so no
      // other clip cut from the same file moves.
      useProjectStore().setClipBeatOffset(clip.id, clipPhaseDraftMs.value)
    }
    // The tempo draft already lives in the item's local bpm; persist it (with the item's
    // own unchanged phase) only when it actually moved.
    if (itemGridEdited) library.setItemManualTempo(item.id, cur, currentAnchorSec())
    gridCommitted = true
  }

  function discardIfUncommitted(): void {
    if (!gridEdited.value || gridCommitted) return
    clipPhaseDraftMs.value = deps.phaseClip?.()?.beatOffsetMs ?? 0
    if (gridSnapshot && gridSnapshotItemId) library.restoreItemGridLocal(gridSnapshotItemId, gridSnapshot)
    useProjectStore().timelineRevision++
    gridEdited.value = false
  }

  function reset(): void {
    // Slide-to-align, the session edit flag, and the tempo-edit lock are per-open UI
    // state — without this they persisted into the next clip's editor session.
    alignActive.value = false
    gridEdited.value = false
    gridCommitted = false
    itemGridEdited = false
    tempoEditing = false
    clipPhaseDraftMs.value = deps.phaseClip?.()?.beatOffsetMs ?? 0
    const item = deps.sourceItem()
    gridSnapshot = item ? library.snapshotItemGrid(item.id) : null
    gridSnapshotItemId = item ? item.id : null
    const bpm = currentBpm()
    originalBpm.value = bpm !== undefined ? bpm : null
    syncTempoField()
  }

  return {
    alignActive,
    manualBpmInput,
    originalBpm,
    hasGrid,
    isOneShot,
    resolvedGrid,
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
