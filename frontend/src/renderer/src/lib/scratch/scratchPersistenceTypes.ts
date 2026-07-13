import type { Ref } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'

export interface PendingSave {
  patternId: string
  /** Canonical serialization of the pattern that was submitted to the backend. */
  submittedCanonical: string
}

export interface PendingDelete {
  patternId: string
  /** Snapshot of savedPatternId/baseline/selection before the delete was issued. */
  priorSavedPatternId: string | null
  priorBaseline: string | null
  priorSelectedSavedId: string | null
}

export const PENDING_SAVE_TIMEOUT_MS = 10_000
export const PENDING_DELETE_TIMEOUT_MS = 10_000

/** Mutable container for in-flight pending operations (not reactive). */
export interface PendingOpsHolder {
  pendingSave: PendingSave | null
  pendingSaveTimeout: ReturnType<typeof setTimeout> | null
  pendingDelete: PendingDelete | null
  pendingDeleteTimeout: ReturnType<typeof setTimeout> | null
}

/** Reactive state shared between controller and reconciliation modules. */
export interface PersistenceRefs {
  patternName: Ref<string>
  selectedSavedId: Ref<string | null>
  isSavePending: Ref<boolean>
  isDeletePending: Ref<boolean>
  isSaved: Ref<boolean>
  saveError: Ref<string | null>
  isCloseSavePending: Ref<boolean>
  closeSaveAcknowledged: Ref<boolean>
}

export interface ScratchPatternPersistence {
  patternName: Ref<string>
  savedPatterns: Ref<readonly ScratchPattern[]>
  selectedSavedId: Ref<string | null>
  isSavePending: Ref<boolean>
  isDeletePending: Ref<boolean>
  isDirty: Ref<boolean>
  isSaved: Ref<boolean>
  saveError: Ref<string | null>
  isCloseSavePending: Ref<boolean>

  savePattern(): void
  updatePattern(): void
  selectAndLoad(patternId: string): void
  rename(patternId: string, newName: string): void
  deletePattern(patternId: string): void
  reset(): void
  reconcileSnapshot(): void
  saveAndClose(): void
  closeSaveAcknowledged: Ref<boolean>
  dismissCloseSaveError(): void
}
