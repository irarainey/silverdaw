// Dirty-close / save-close orchestration for the Scratch Editor dialog. Owns
// only the confirmation-prompt state machine; the actual close side effects
// (stopping replay, resetting persistence/save state, closing the backend
// session, emitting `close`) stay with the caller via `performClose`, which
// this composable treats as an opaque action.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

export interface ScratchDialogCloseOptions {
  isDirty: Ref<boolean>
  isCloseSavePending: Ref<boolean>
  saveError: Ref<string | null>
  closeSaveAcknowledged: Ref<boolean>
  saveAndClose(): void
  dismissCloseSaveError(): void
  /** Runs the actual close: stop replay, reset save/persistence state, close the session, emit. */
  performClose(): void
}

export interface ScratchDialogClose {
  dirtyClosePromptOpen: Ref<boolean>
  /** Whether the ScratchDirtyCloseDialog overlay should be shown. */
  showDirtyCloseDialog: ComputedRef<boolean>
  requestClose(): void
  onDirtyCloseSave(): void
  onDirtyCloseDiscard(): void
  onDirtyCloseCancel(): void
}

export function useScratchDialogClose(options: ScratchDialogCloseOptions): ScratchDialogClose {
  const dirtyClosePromptOpen = ref(false)

  function doPerformClose(): void {
    dirtyClosePromptOpen.value = false
    options.performClose()
  }

  function requestClose(): void {
    if (options.isDirty.value) {
      dirtyClosePromptOpen.value = true
      return
    }
    doPerformClose()
  }

  function onDirtyCloseSave(): void {
    dirtyClosePromptOpen.value = false
    options.saveAndClose()
  }

  // Reconcile authoritative ack: the actual close only happens once the
  // save-on-close round trip acknowledges, never optimistically.
  watch(options.closeSaveAcknowledged, (acked) => {
    if (acked) doPerformClose()
  })

  function onDirtyCloseDiscard(): void {
    doPerformClose()
  }

  function onDirtyCloseCancel(): void {
    dirtyClosePromptOpen.value = false
    options.dismissCloseSaveError()
  }

  const showDirtyCloseDialog = computed(
    () =>
      dirtyClosePromptOpen.value ||
      options.isCloseSavePending.value ||
      Boolean(options.saveError.value)
  )

  return {
    dirtyClosePromptOpen,
    showDirtyCloseDialog,
    requestClose,
    onDirtyCloseSave,
    onDirtyCloseDiscard,
    onDirtyCloseCancel
  }
}
