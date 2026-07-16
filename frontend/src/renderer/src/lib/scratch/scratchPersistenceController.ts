import type { Ref } from 'vue'
import { ScratchPatternSchema } from '@shared/bridge-protocol'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import { log } from '@/lib/log'
import {
  PENDING_SAVE_TIMEOUT_MS,
  PENDING_DELETE_TIMEOUT_MS,
  type PendingOpsHolder,
  type PersistenceRefs
} from './scratchPersistenceTypes'

export interface ControllerDeps {
  sessionId: Ref<string | null>
  refs: PersistenceRefs
  ops: PendingOpsHolder
  project: ReturnType<typeof useProjectStore>
  scratch: ReturnType<typeof useScratchSessionStore>
}

function clearPendingSave(deps: ControllerDeps): void {
  const { ops, refs } = deps
  if (ops.pendingSaveTimeout) {
    clearTimeout(ops.pendingSaveTimeout)
    ops.pendingSaveTimeout = null
  }
  ops.pendingSave = null
  refs.isSavePending.value = false
}

function startPendingSave(deps: ControllerDeps, patternId: string, submittedCanonical: string): void {
  clearPendingSave(deps)
  const { ops, refs } = deps
  refs.saveError.value = null
  ops.pendingSave = { patternId, submittedCanonical }
  refs.isSavePending.value = true
  refs.isSaved.value = false
  ops.pendingSaveTimeout = setTimeout(() => {
    log.warn('scratch', `save timed out for pattern ${patternId}`)
    const wasCloseSave = refs.isCloseSavePending.value
    clearPendingSave(deps)
    if (wasCloseSave) {
      refs.saveError.value = 'Save timed out. Your changes are preserved — try again.'
      refs.isCloseSavePending.value = false
    }
  }, PENDING_SAVE_TIMEOUT_MS)
}

function clearPendingDelete(deps: ControllerDeps): void {
  const { ops, refs } = deps
  if (ops.pendingDeleteTimeout) {
    clearTimeout(ops.pendingDeleteTimeout)
    ops.pendingDeleteTimeout = null
  }
  ops.pendingDelete = null
  refs.isDeletePending.value = false
}

function startPendingDelete(deps: ControllerDeps, patternId: string): void {
  clearPendingDelete(deps)
  const { ops, refs, scratch } = deps
  ops.pendingDelete = {
    patternId,
    priorSavedPatternId: scratch.savedPatternId,
    priorBaseline: scratch.savedCanonicalBaseline,
    priorSelectedSavedId: refs.selectedSavedId.value
  }
  refs.isDeletePending.value = true
  ops.pendingDeleteTimeout = setTimeout(() => {
    log.warn('scratch', `delete timed out for pattern ${patternId}`)
    clearPendingDelete(deps)
  }, PENDING_DELETE_TIMEOUT_MS)
}

export function savePattern(deps: ControllerDeps): void {
  const { sessionId, refs, scratch, project } = deps
  const sid = sessionId.value
  const pattern = scratch.completedPattern
  if (!sid || !pattern) return

  const name = refs.patternName.value.trim() || 'Untitled Scratch'
  const saved: ScratchPattern = { ...pattern, name }

  const result = ScratchPatternSchema.safeParse(saved)
  if (!result.success) {
    log.warn('scratch', 'savePattern: pattern failed validation')
    return
  }

  project.saveScratchPattern(sid, result.data)
  startPendingSave(deps, result.data.id, canonicalizeScratchPattern(result.data))
}

export function updatePattern(deps: ControllerDeps): void {
  const { sessionId, refs, scratch, project } = deps
  const sid = sessionId.value
  const pattern = scratch.completedPattern
  const targetId = refs.selectedSavedId.value ?? scratch.savedPatternId
  if (!sid || !pattern || !targetId) return

  const name = refs.patternName.value.trim() || pattern.name
  const updated: ScratchPattern = { ...pattern, id: targetId, name }

  const result = ScratchPatternSchema.safeParse(updated)
  if (!result.success) {
    log.warn('scratch', 'updatePattern: pattern failed validation')
    return
  }

  project.saveScratchPattern(sid, result.data)
  startPendingSave(deps, targetId, canonicalizeScratchPattern(result.data))
}

export function selectAndLoad(deps: ControllerDeps, patternId: string): void {
  const { refs, scratch, project } = deps
  const saved = project.savedScratchPatterns.find((p) => p.id === patternId)
  if (!saved) return

  refs.selectedSavedId.value = patternId
  refs.patternName.value = saved.name
  scratch.loadSavedPattern(saved)
  scratch.setSavedPatternId(patternId, canonicalizeScratchPattern(saved))
  refs.isSaved.value = true
}

export function rename(deps: ControllerDeps, patternId: string, newName: string): void {
  const trimmed = newName.trim()
  if (!trimmed) return
  deps.project.renameScratchPattern(patternId, trimmed)
}

export function deletePattern(deps: ControllerDeps, patternId: string): void {
  deps.project.deleteScratchPattern(patternId)
  startPendingDelete(deps, patternId)
}

export function saveAndClose(deps: ControllerDeps): void {
  const { refs, scratch } = deps
  refs.saveError.value = null
  refs.isCloseSavePending.value = true
  refs.closeSaveAcknowledged.value = false
  if (scratch.savedPatternId) {
    updatePattern(deps)
  } else {
    savePattern(deps)
  }
}

export function dismissCloseSaveError(deps: ControllerDeps): void {
  deps.refs.saveError.value = null
}

export function reset(deps: ControllerDeps): void {
  clearPendingSave(deps)
  clearPendingDelete(deps)
  const { refs } = deps
  refs.patternName.value = ''
  refs.selectedSavedId.value = null
  refs.isSaved.value = false
  refs.saveError.value = null
  refs.isCloseSavePending.value = false
  refs.closeSaveAcknowledged.value = false
}
