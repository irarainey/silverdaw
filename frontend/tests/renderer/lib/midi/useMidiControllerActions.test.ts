import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMidiControllerActions } from '@/lib/midi/useMidiControllerActions'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

const handleMidiControlMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/midi/midiControllerActions', () => ({
  handleMidiControl: handleMidiControlMock
}))
vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))

describe('useMidiControllerActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handleMidiControlMock.mockClear()
  })

  it('forwards each mapped control applied by the bridge', async () => {
    const store = useMidiDeviceStore()
    useMidiControllerActions()
    const control = {
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'playPause',
      deck: 1,
      pressed: true
    } as const

    store.applyControl(control)
    await nextTick()

    expect(handleMidiControlMock).toHaveBeenCalledWith(control)
  })
})
