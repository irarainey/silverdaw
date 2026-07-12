import { onBeforeUnmount, onMounted, readonly, ref, type DeepReadonly, type Ref } from 'vue'

const DIALOG_SELECTOR = '.dialog-backdrop, [role="dialog"], [role="alertdialog"]'

/** Tracks dialogs rendered anywhere below the application shell. */
export function useRenderedDialogPresence(): DeepReadonly<Ref<boolean>> {
  const dialogOpen = ref(false)
  let observer: MutationObserver | null = null

  const refresh = (): void => {
    dialogOpen.value = document.querySelector(DIALOG_SELECTOR) !== null
  }

  onMounted(() => {
    observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    refresh()
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return readonly(dialogOpen)
}
