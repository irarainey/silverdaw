import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import type { PendingOpsHolder, PersistenceRefs } from './scratchPersistenceTypes'

export interface ReconciliationDeps {
  refs: PersistenceRefs
  ops: PendingOpsHolder
  project: ReturnType<typeof useProjectStore>
  scratch: ReturnType<typeof useScratchSessionStore>
}

/** Top-level reconciliation entry point — call on every PROJECT_STATE snapshot. */
export function reconcileSnapshot(deps: ReconciliationDeps): void {
  reconcilePendingSave(deps)
  reconcileDelete(deps)
  reconcileAuthoritative(deps)
}

function reconcileAuthoritative(deps: ReconciliationDeps): void {
  const { refs, project, scratch } = deps
  if (!scratch.savedPatternId || !scratch.savedCanonicalBaseline) return

  const current = project.savedScratchPatterns.find((p) => p.id === scratch.savedPatternId)
  if (!current) {
    scratch.setSavedPatternId(null, null)
    refs.selectedSavedId.value = null
    refs.isSaved.value = false
    return
  }

  const snapshotCanonical = canonicalizeScratchPattern(current)
  if (snapshotCanonical === scratch.savedCanonicalBaseline) return

  const draftIsClean = !scratch.isSavedPatternDirty

  if (draftIsClean) {
    scratch.replacePattern(current)
    refs.patternName.value = current.name
    scratch.setSavedPatternId(scratch.savedPatternId, snapshotCanonical)
  } else {
    if (scratch.completedPattern) {
      scratch.replacePattern({ ...scratch.completedPattern, name: current.name })
    }
    refs.patternName.value = current.name
    scratch.setSavedPatternId(scratch.savedPatternId, snapshotCanonical)
  }
}

function clearOpsTimeout(ops: PendingOpsHolder, kind: 'save' | 'delete'): void {
  if (kind === 'save') {
    if (ops.pendingSaveTimeout) {
      clearTimeout(ops.pendingSaveTimeout)
      ops.pendingSaveTimeout = null
    }
  } else {
    if (ops.pendingDeleteTimeout) {
      clearTimeout(ops.pendingDeleteTimeout)
      ops.pendingDeleteTimeout = null
    }
  }
}

function reconcileDelete(deps: ReconciliationDeps): void {
  const { refs, ops, project, scratch } = deps
  if (!ops.pendingDelete) return

  const stillExists = project.savedScratchPatterns.some(
    (p) => p.id === ops.pendingDelete!.patternId
  )

  if (!stillExists) {
    if (refs.selectedSavedId.value === ops.pendingDelete.patternId) {
      refs.selectedSavedId.value = null
    }
    if (scratch.savedPatternId === ops.pendingDelete.patternId) {
      scratch.setSavedPatternId(null, null)
      refs.isSaved.value = false
    }
    clearOpsTimeout(ops, 'delete')
    ops.pendingDelete = null
    refs.isDeletePending.value = false
  }
}

function reconcilePendingSave(deps: ReconciliationDeps): void {
  const { refs, ops, project, scratch } = deps
  if (!ops.pendingSave) return

  const found = project.savedScratchPatterns.find((p) => p.id === ops.pendingSave!.patternId)
  if (!found) return

  const snapshotCanonical = canonicalizeScratchPattern(found)
  if (snapshotCanonical !== ops.pendingSave.submittedCanonical) return

  const draftCanonical = scratch.completedPattern
    ? canonicalizeScratchPattern(scratch.completedPattern)
    : null
  const draftMatchesSubmission = draftCanonical === ops.pendingSave.submittedCanonical

  scratch.setSavedPatternId(found.id, snapshotCanonical)
  refs.selectedSavedId.value = found.id

  if (draftMatchesSubmission) {
    refs.isSaved.value = true
    const wasCloseSave = refs.isCloseSavePending.value
    clearOpsTimeout(ops, 'save')
    ops.pendingSave = null
    refs.isSavePending.value = false
    if (wasCloseSave) {
      refs.isCloseSavePending.value = false
      refs.closeSaveAcknowledged.value = true
    }
  } else {
    clearOpsTimeout(ops, 'save')
    ops.pendingSave = null
    refs.isSavePending.value = false
    if (refs.isCloseSavePending.value) {
      refs.isCloseSavePending.value = false
    }
  }
}
