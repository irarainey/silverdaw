import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  beforeUnmount: null as (() => void) | null
}))

vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    onMounted: (callback: () => void): void => callback(),
    onBeforeUnmount: (callback: () => void): void => {
      lifecycle.beforeUnmount = callback
    }
  }
})

import { useRenderedDialogPresence } from '@/lib/app/useRenderedDialogPresence'

describe('useRenderedDialogPresence', () => {
  let dialog: Element | null
  let mutationCallback: MutationCallback
  const disconnect = vi.fn()

  beforeEach(() => {
    dialog = null
    lifecycle.beforeUnmount = null
    disconnect.mockClear()
    vi.stubGlobal('document', {
      body: {},
      querySelector: vi.fn(() => dialog)
    })
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: MutationCallback) {
          mutationCallback = callback
        }

        observe(): void {}

        disconnect(): void {
          disconnect()
        }
      }
    )
  })

  it('tracks dialogs rendered by child components and disconnects on unmount', () => {
    const dialogOpen = useRenderedDialogPresence()
    expect(dialogOpen.value).toBe(false)

    dialog = {} as Element
    mutationCallback([], {} as MutationObserver)
    expect(dialogOpen.value).toBe(true)

    lifecycle.beforeUnmount?.()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
