import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMidiControllerActions } from '@/lib/midi/useMidiControllerActions'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

const handleMidiControlMock = vi.hoisted(() => vi.fn())
const suspendMidiControllerActionsMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/midi/midiControllerActions', () => ({
  handleMidiControl: handleMidiControlMock,
  suspendMidiControllerActions: suspendMidiControllerActionsMock,
  isMasterVolumeControl: (payload: { kind: string; control: string }) =>
    payload.kind === 'absolute' && payload.control === 'masterVolume'
}))
vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))

describe('useMidiControllerActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handleMidiControlMock.mockClear()
    suspendMidiControllerActionsMock.mockClear()
  })

  it('forwards each mapped control applied by the bridge', async () => {
    const store = useMidiDeviceStore()
    useMidiControllerActions(() => false)
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

  it('blocks other controls but passes the master volume through while a dialog is open', () => {
    const store = useMidiDeviceStore()
    const blocked = ref(false)
    useMidiControllerActions(() => blocked.value)

    blocked.value = true
    expect(suspendMidiControllerActionsMock).toHaveBeenCalledOnce()

    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'shift',
      deck: 1,
      pressed: true
    })
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 1
    })
    expect(handleMidiControlMock).not.toHaveBeenCalled()
    expect(store.shiftPressed[1]).toBe(true)

    // The master volume is the one control that stays live behind a dialog.
    const masterControl = {
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'absolute',
      control: 'masterVolume',
      deck: null,
      value: 0.5
    } as const
    store.applyControl(masterControl)
    expect(handleMidiControlMock).toHaveBeenCalledOnce()
    expect(handleMidiControlMock).toHaveBeenCalledWith(masterControl)

    blocked.value = false
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'button',
      control: 'playPause',
      deck: 1,
      pressed: true
    })
    expect(handleMidiControlMock).toHaveBeenCalledTimes(2)
  })
})
