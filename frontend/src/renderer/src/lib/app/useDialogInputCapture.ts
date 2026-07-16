import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * While a modal dialog is open, wheel input must belong to that dialog alone.
 * Without this guard a scroll gesture over the dimmed backdrop (or a background
 * surface such as the library panel) still reaches the content behind the modal,
 * because a `fixed` backdrop does not by itself stop the browser from scrolling
 * another surface. A capture-phase listener lets wheel events proceed only when
 * they originate inside the dialog card; everything else is cancelled so the
 * background stays put.
 */
export function useDialogInputCapture(active: Ref<boolean>): void {
  const onWheel = (event: WheelEvent): void => {
    const target = event.target
    if (target instanceof Element && target.closest('.dialog-card')) return
    event.preventDefault()
  }

  const attach = (): void => {
    document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  }
  const detach = (): void => {
    document.removeEventListener('wheel', onWheel, { capture: true })
  }

  watch(
    active,
    (isOpen) => {
      if (isOpen) attach()
      else detach()
    },
    { immediate: true }
  )

  onBeforeUnmount(detach)
}
