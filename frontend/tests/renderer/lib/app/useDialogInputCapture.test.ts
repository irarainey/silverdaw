import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const lifecycle = vi.hoisted(() => ({
  beforeUnmount: null as (() => void) | null
}))

vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    onBeforeUnmount: (callback: () => void): void => {
      lifecycle.beforeUnmount = callback
    }
  }
})

import { useDialogInputCapture } from '@/lib/app/useDialogInputCapture'

class FakeElement {
  constructor(private readonly matches: boolean) {}

  closest(selector: string): FakeElement | null {
    return selector === '.dialog-card' && this.matches ? this : null
  }
}

function makeEvent(target: unknown): { target: unknown; preventDefault: () => void } {
  return { target, preventDefault: vi.fn() }
}

describe('useDialogInputCapture', () => {
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()

  afterEach(() => {
    lifecycle.beforeUnmount = null
    addEventListener.mockClear()
    removeEventListener.mockClear()
    vi.unstubAllGlobals()
  })

  function wheelHandler(): (event: unknown) => void {
    const call = addEventListener.mock.calls.find(([type]) => type === 'wheel')
    return call?.[1] as (event: unknown) => void
  }

  it('cancels background wheel input but lets the dialog card scroll', async () => {
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('document', { addEventListener, removeEventListener })
    const active = ref(false)

    useDialogInputCapture(active)
    expect(addEventListener).not.toHaveBeenCalled()

    active.value = true
    await nextTick()
    expect(addEventListener).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function),
      { capture: true, passive: false }
    )

    const handler = wheelHandler()

    const insideEvent = makeEvent(new FakeElement(true))
    handler(insideEvent)
    expect(insideEvent.preventDefault).not.toHaveBeenCalled()

    const outsideEvent = makeEvent(new FakeElement(false))
    handler(outsideEvent)
    expect(outsideEvent.preventDefault).toHaveBeenCalledOnce()

    active.value = false
    await nextTick()
    expect(removeEventListener).toHaveBeenCalledWith('wheel', handler, { capture: true })
  })

  it('detaches the listener on unmount', async () => {
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('document', { addEventListener, removeEventListener })
    const active = ref(true)

    useDialogInputCapture(active)
    await nextTick()
    const handler = wheelHandler()

    lifecycle.beforeUnmount?.()
    expect(removeEventListener).toHaveBeenCalledWith('wheel', handler, { capture: true })
  })
})
