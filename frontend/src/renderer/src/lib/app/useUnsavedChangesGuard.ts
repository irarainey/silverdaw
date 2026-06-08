// Unsaved-changes guard for the app shell. Gates destructive navigation on a
// save/discard/cancel prompt; clean projects still flush their view state
// before proceeding. Extracted from App.vue so the shell stays thin.

import { ref, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { clearAutosaveBucket } from '@/lib/autosave'
import { log } from '@/lib/log'

export interface UnsavedChangesGuard {
  unsavedPromptOpen: Ref<boolean>
  guardAgainstUnsavedChanges: (proceed: () => void | Promise<void>) => void
  onUnsavedPromptSave: () => Promise<void>
  onUnsavedPromptDiscard: () => Promise<void>
  onUnsavedPromptCancel: () => void
}

export function useUnsavedChangesGuard(): UnsavedChangesGuard {
  const project = useProjectStore()
  const transport = useTransportStore()
  const notifications = useNotificationsStore()

  // Action deferred until the unsaved-changes prompt resolves.
  const unsavedPromptOpen = ref(false)
  // Deferred actions may be async; run them fire-and-forget but never let a
  // sync throw or async rejection escape into the prompt's event handlers.
  let pendingAfterDiscard: (() => void | Promise<void>) | null = null
  let cleanViewStateSave: Promise<void> | null = null

  function runDeferred(action: () => void | Promise<void>): void {
    void (async () => {
      await action()
    })().catch((err) => log.warn('app', `deferred navigation action failed: ${String(err)}`))
  }

  /** Gate destructive navigation on unsaved changes; clean projects still flush view state. */
  function guardAgainstUnsavedChanges(proceed: () => void | Promise<void>): void {
    if (!project.isDirty) {
      void persistCleanViewState()
        .then(proceed)
        .catch((err) => log.warn('app', `deferred navigation action failed: ${String(err)}`))
      return
    }
    pendingAfterDiscard = proceed
    unsavedPromptOpen.value = true
  }

  async function persistCleanViewState(): Promise<void> {
    if (!transport.bridgeReady || !project.currentFilePath || cleanViewStateSave) {
      return cleanViewStateSave ?? Promise.resolve()
    }
    cleanViewStateSave = project
      .saveViewStateAndWait()
      .then((result) => {
        if (!result.ok) {
          log.warn('project', `view-state save failed: ${result.error ?? 'unknown error'}`)
        }
      })
      .finally(() => {
        cleanViewStateSave = null
      })
    return cleanViewStateSave
  }

  /** Save from the unsaved-changes prompt, then run the pending action on ack. */
  async function onUnsavedPromptSave(): Promise<void> {
    unsavedPromptOpen.value = false
    const next = pendingAfterDiscard
    pendingAfterDiscard = null
    if (!next) return

    let filePath = project.currentFilePath
    let isSaveAs = false
    if (!filePath) {
      isSaveAs = true
      filePath = await window.silverdaw.chooseProjectSaveAs(project.projectName || 'Untitled')
      if (!filePath) return // Save As cancelled.
    }

    const result = await project.saveAndWait(filePath, isSaveAs)
    if (!result.ok) {
      if (
        result.error?.startsWith('Timed out') ||
        result.error === 'The audio engine isn\'t connected'
      ) {
        notifications.pushError(`Save failed: ${result.error}.`)
      }
      return // Bridge-reported save failures are shown elsewhere.
    }
    runDeferred(next)
  }

  async function onUnsavedPromptDiscard(): Promise<void> {
    unsavedPromptOpen.value = false
    const next = pendingAfterDiscard
    pendingAfterDiscard = null
    // Await autosave cleanup before close/exit can terminate IPC.
    const projectId = project.projectId
    if (projectId) {
      await clearAutosaveBucket(projectId)
    }
    if (next) runDeferred(next)
  }

  function onUnsavedPromptCancel(): void {
    unsavedPromptOpen.value = false
    pendingAfterDiscard = null
  }

  return {
    unsavedPromptOpen,
    guardAgainstUnsavedChanges,
    onUnsavedPromptSave,
    onUnsavedPromptDiscard,
    onUnsavedPromptCancel
  }
}
