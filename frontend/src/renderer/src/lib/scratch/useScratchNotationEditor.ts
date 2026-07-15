// Composable for the Scratch Notation Editor. Manages selection, editing
// (move/add/delete/touch toggle), and schema-validated commits to the store.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import {
  addCrossfaderKeyframe,
  addPlatterKeyframe,
  applyCrossfaderEdit,
  applyPlatterEdit,
  deleteCrossfaderKeyframe,
  deletePlatterKeyframe,
  interpolateCrossfaderAt,
  interpolatePlatterAt,
  moveCrossfaderKeyframe,
  movePlatterKeyframe
} from './scratchPatternEditing'

export type NotationLane = 'platter' | 'crossfader'

export interface NotationSelection {
  lane: NotationLane
  index: number
}

export interface ScratchNotationEditor {
  pattern: ComputedRef<ScratchPattern | null>
  selection: Ref<NotationSelection | null>

  selectKeyframe(lane: NotationLane, index: number): void
  clearSelection(): void

  movePlatter(index: number, timeUs: number, turns: number): boolean
  moveCrossfader(index: number, timeUs: number, value: number): boolean
  addPlatter(timeUs: number): boolean
  addCrossfaderPoint(timeUs: number): boolean
  deleteSelected(): boolean
  togglePlatterTouch(index: number): boolean
}

export function useScratchNotationEditor(
  sessionId: Ref<string | null>
): ScratchNotationEditor {
  const store = useScratchSessionStore()
  const selection = ref<NotationSelection | null>(null)

  const pattern = computed<ScratchPattern | null>(() => store.completedPattern)

  // Track whether the next draftRevision change is from our own commit.
  // We use a Set to handle rapid sequential edits whose watchers may batch.
  const expectedRevisions = new Set<number>()

  // Distinguish our own revision advances from external pattern replacements.
  watch(
    () => store.draftRevision,
    (rev) => {
      if (expectedRevisions.has(rev)) {
        // This revision was caused by our own commit — keep selection intact.
        expectedRevisions.delete(rev)
      } else {
        // External replacement (session state, recording, or other source).
        selection.value = null
      }
    }
  )

  watch(sessionId, () => {
    selection.value = null
    expectedRevisions.clear()
  })

  function commitEdit(newPattern: ScratchPattern): boolean {
    const sid = sessionId.value
    if (!sid || !store.isActiveSession(sid)) return false
    const current = store.completedPattern
    if (!current) return false
    // Mark the upcoming revision as ours so the watcher doesn't clear selection.
    expectedRevisions.add(store.draftRevision + 1)
    return store.editPattern(sid, newPattern)
  }

  function selectKeyframe(lane: NotationLane, index: number): void {
    selection.value = { lane, index }
  }

  function clearSelection(): void {
    selection.value = null
  }

  function movePlatter(index: number, timeUs: number, turns: number): boolean {
    const p = pattern.value
    if (!p) return false
    const newPlatter = movePlatterKeyframe(p.platter, index, timeUs, turns)
    const result = applyPlatterEdit(p, newPlatter)
    if (!result) return false
    return commitEdit(result)
  }

  function moveCrossfader(index: number, timeUs: number, value: number): boolean {
    const p = pattern.value
    if (!p) return false
    const newCf = moveCrossfaderKeyframe(p.crossfader, index, timeUs, value)
    const result = applyCrossfaderEdit(p, newCf)
    if (!result) return false
    return commitEdit(result)
  }

  function addPlatter(timeUs: number): boolean {
    const p = pattern.value
    if (!p) return false
    const interp = interpolatePlatterAt(p.platter, timeUs)
    const added = addPlatterKeyframe(p.platter, timeUs, interp.turns, interp.touched)
    if (!added) return false
    const result = applyPlatterEdit(p, added.platter)
    if (!result) return false
    const ok = commitEdit(result)
    if (ok) selection.value = { lane: 'platter', index: added.index }
    return ok
  }

  function addCrossfaderPoint(timeUs: number): boolean {
    const p = pattern.value
    if (!p) return false
    const interp = interpolateCrossfaderAt(p.crossfader, timeUs)
    const added = addCrossfaderKeyframe(p.crossfader, timeUs, interp)
    if (!added) return false
    const result = applyCrossfaderEdit(p, added.crossfader)
    if (!result) return false
    const ok = commitEdit(result)
    if (ok) selection.value = { lane: 'crossfader', index: added.index }
    return ok
  }

  function deleteSelected(): boolean {
    const sel = selection.value
    const p = pattern.value
    if (!sel || !p) return false

    if (sel.lane === 'platter') {
      const result = deletePlatterKeyframe(p.platter, sel.index)
      if (!result) return false
      const validated = applyPlatterEdit(p, result)
      if (!validated) return false
      selection.value = null
      return commitEdit(validated)
    } else {
      const result = deleteCrossfaderKeyframe(p.crossfader, sel.index)
      if (!result) return false
      const validated = applyCrossfaderEdit(p, result)
      if (!validated) return false
      selection.value = null
      return commitEdit(validated)
    }
  }

  function togglePlatterTouch(index: number): boolean {
    const p = pattern.value
    if (!p) return false
    const kf = p.platter[index]
    if (!kf) return false
    const newPlatter = p.platter.map((k, i) =>
      i === index ? { ...k, touched: !k.touched } : { ...k }
    )
    const result = applyPlatterEdit(p, newPlatter)
    if (!result) return false
    return commitEdit(result)
  }

  return {
    pattern,
    selection,
    selectKeyframe,
    clearSelection,
    movePlatter,
    moveCrossfader,
    addPlatter,
    addCrossfaderPoint,
    deleteSelected,
    togglePlatterTouch
  }
}
