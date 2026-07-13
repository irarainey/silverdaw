import { effectScope, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFocusTrap } from '@/lib/useFocusTrap'

class FakeElement extends EventTarget {
  offsetParent = this

  focus = vi.fn()

  contains(): boolean {
    return false
  }

  querySelectorAll(): FakeElement[] {
    return []
  }
}

const originalDocument = globalThis.document
const originalHTMLElement = globalThis.HTMLElement

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(globalThis, {
    document: originalDocument,
    HTMLElement: originalHTMLElement
  })
})

describe('useFocusTrap', () => {
  it('attaches after a conditionally rendered container becomes available', async () => {
    const invoker = new FakeElement()
    Object.assign(globalThis, {
      document: { activeElement: invoker },
      HTMLElement: FakeElement
    })
    const active = ref(false)
    const container = ref<HTMLElement | null>(null)
    const scope = effectScope()
    scope.run(() => useFocusTrap(container, active))

    active.value = true
    container.value = new FakeElement() as unknown as HTMLElement
    await nextTick()

    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'key', { value: 'Tab' })
    container.value.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    scope.stop()
  })
})
