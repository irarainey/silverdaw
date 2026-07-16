// Scratch pattern persistence — public composable facade. Delegates to focused
// sub-modules for controller actions and authoritative reconciliation.

import { computed, ref, watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type { ScratchPatternPersistence, PendingOpsHolder } from './scratchPersistenceTypes'
import {
  savePattern as ctrlSave,
  updatePattern as ctrlUpdate,
  selectAndLoad as ctrlSelectAndLoad,
  rename as ctrlRename,
  deletePattern as ctrlDelete,
  saveAndClose as ctrlSaveAndClose,
  dismissCloseSaveError as ctrlDismissError,
  reset as ctrlReset,
  type ControllerDeps
} from './scratchPersistenceController'
import { reconcileSnapshot as reconcile, type ReconciliationDeps } from './scratchPersistenceReconciliation'

export type { ScratchPatternPersistence } from './scratchPersistenceTypes'

export function useScratchPatternPersistence(
  sessionId: Ref<string | null>
): ScratchPatternPersistence {
  const project = useProjectStore()
  const scratch = useScratchSessionStore()

  const patternName = ref('')
  const selectedSavedId = ref<string | null>(null)
  const isSavePending = ref(false)
  const isDeletePending = ref(false)
  const isSaved = ref(false)
  const saveError = ref<string | null>(null)
  const isCloseSavePending = ref(false)
  const closeSaveAcknowledged = ref(false)

  const refs = { patternName, selectedSavedId, isSavePending, isDeletePending, isSaved, saveError, isCloseSavePending, closeSaveAcknowledged }
  const ops: PendingOpsHolder = { pendingSave: null, pendingSaveTimeout: null, pendingDelete: null, pendingDeleteTimeout: null }

  const ctrlDeps: ControllerDeps = { sessionId, refs, ops, project, scratch }
  const reconDeps: ReconciliationDeps = { refs, ops, project, scratch }

  const savedPatterns = computed(() => project.savedScratchPatterns)

  const isDirty = computed(() => {
    if (!scratch.completedPattern) return false
    if (!scratch.savedCanonicalBaseline) return true
    return scratch.isSavedPatternDirty
  })

  // Seed name from draft when it first appears.
  watch(
    () => scratch.completedPattern,
    (pattern) => {
      if (pattern && !patternName.value) {
        patternName.value = pattern.name
      }
    },
    { immediate: true, flush: 'sync' }
  )

  // Push name edits into the working draft for dirty detection.
  watch(
    patternName,
    (newName) => {
      const pattern = scratch.completedPattern
      if (!pattern) return
      const effective = newName.trim()
      if (!effective || pattern.name === effective) return
      scratch.replacePattern({ ...pattern, name: effective })
    },
    { flush: 'sync' }
  )

  return {
    patternName,
    savedPatterns,
    selectedSavedId,
    isSavePending,
    isDeletePending,
    isDirty,
    isSaved,
    saveError,
    isCloseSavePending,
    closeSaveAcknowledged,
    savePattern: () => ctrlSave(ctrlDeps),
    updatePattern: () => ctrlUpdate(ctrlDeps),
    selectAndLoad: (id: string) => ctrlSelectAndLoad(ctrlDeps, id),
    rename: (id: string, name: string) => ctrlRename(ctrlDeps, id, name),
    deletePattern: (id: string) => ctrlDelete(ctrlDeps, id),
    reset: () => ctrlReset(ctrlDeps),
    reconcileSnapshot: () => reconcile(reconDeps),
    saveAndClose: () => ctrlSaveAndClose(ctrlDeps),
    dismissCloseSaveError: () => ctrlDismissError(ctrlDeps)
  }
}
