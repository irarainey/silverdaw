import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useScratchDialogClose } from '@/lib/scratch/useScratchDialogClose'

function setup(overrides: { isDirty?: boolean } = {}) {
  const isDirty = ref(overrides.isDirty ?? false)
  const isCloseSavePending = ref(false)
  const saveError = ref<string | null>(null)
  const closeSaveAcknowledged = ref(false)
  const saveAndClose = vi.fn()
  const dismissCloseSaveError = vi.fn()
  const performClose = vi.fn()

  const close = useScratchDialogClose({
    isDirty,
    isCloseSavePending,
    saveError,
    closeSaveAcknowledged,
    saveAndClose,
    dismissCloseSaveError,
    performClose
  })

  return { close, isDirty, isCloseSavePending, saveError, closeSaveAcknowledged, saveAndClose, dismissCloseSaveError, performClose }
}

describe('useScratchDialogClose', () => {
  it('closes immediately when there are no unsaved changes', () => {
    const { close, performClose } = setup({ isDirty: false })
    close.requestClose()
    expect(performClose).toHaveBeenCalledTimes(1)
    expect(close.dirtyClosePromptOpen.value).toBe(false)
  })

  it('prompts instead of closing when the draft is dirty', () => {
    const { close, performClose } = setup({ isDirty: true })
    close.requestClose()
    expect(performClose).not.toHaveBeenCalled()
    expect(close.dirtyClosePromptOpen.value).toBe(true)
  })

  it('only closes once the save-on-close round trip is authoritatively acknowledged', async () => {
    const { close, saveAndClose, performClose, closeSaveAcknowledged } = setup({ isDirty: true })
    close.requestClose()
    close.onDirtyCloseSave()
    expect(saveAndClose).toHaveBeenCalledTimes(1)
    expect(close.dirtyClosePromptOpen.value).toBe(false)
    expect(performClose).not.toHaveBeenCalled()

    closeSaveAcknowledged.value = true
    await nextTick()
    expect(performClose).toHaveBeenCalledTimes(1)
  })

  it('discard closes immediately without saving', () => {
    const { close, performClose, saveAndClose } = setup({ isDirty: true })
    close.requestClose()
    close.onDirtyCloseDiscard()
    expect(performClose).toHaveBeenCalledTimes(1)
    expect(saveAndClose).not.toHaveBeenCalled()
    expect(close.dirtyClosePromptOpen.value).toBe(false)
  })

  it('cancel dismisses the prompt and any surfaced save error without closing', () => {
    const { close, dismissCloseSaveError, performClose } = setup({ isDirty: true })
    close.requestClose()
    close.onDirtyCloseCancel()
    expect(dismissCloseSaveError).toHaveBeenCalledTimes(1)
    expect(performClose).not.toHaveBeenCalled()
    expect(close.dirtyClosePromptOpen.value).toBe(false)
  })

  it('shows the dirty-close dialog while pending or errored even after the prompt itself closes', () => {
    const { close, isCloseSavePending, saveError } = setup({ isDirty: false })
    expect(close.showDirtyCloseDialog.value).toBe(false)

    isCloseSavePending.value = true
    expect(close.showDirtyCloseDialog.value).toBe(true)
    isCloseSavePending.value = false

    saveError.value = 'Save timed out.'
    expect(close.showDirtyCloseDialog.value).toBe(true)
  })
})
