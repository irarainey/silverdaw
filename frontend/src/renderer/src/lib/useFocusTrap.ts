import { onBeforeUnmount, watch, type Ref } from 'vue'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.offsetParent !== null)
}

/**
 * Traps Tab/Shift-Tab focus inside a container element and restores focus to
 * the previously active element when the container is removed.
 */
export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean>
): void {
  let invoker: HTMLElement | null = null
  let attachedContainer: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return
    const container = containerRef.value
    if (!container) return
    const focusable = getFocusable(container)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey) {
      if (document.activeElement === first || !container.contains(document.activeElement)) {
        event.preventDefault()
        last?.focus()
      }
    } else {
      if (document.activeElement === last || !container.contains(document.activeElement)) {
        event.preventDefault()
        first?.focus()
      }
    }
  }

  watch(active, (isActive) => {
    if (isActive) {
      invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
      attachedContainer = containerRef.value
      attachedContainer?.addEventListener('keydown', onKeydown)
    } else {
      attachedContainer?.removeEventListener('keydown', onKeydown)
      attachedContainer = null
      invoker?.focus()
      invoker = null
    }
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    attachedContainer?.removeEventListener('keydown', onKeydown)
    invoker?.focus()
    invoker = null
  })
}
