import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioDeviceStore } from './audioDeviceStore'
import { useNotificationsStore } from './notificationsStore'
import type { AudioDevicesListPayload } from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

function makeListPayload(overrides: Partial<AudioDevicesListPayload> = {}): AudioDevicesListPayload {
  return {
    types: [],
    currentTypeName: null,
    currentDeviceName: null,
    ...overrides
  } as AudioDevicesListPayload
}

describe('audioDeviceStore.applyList fallback notice', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('surfaces the saved-device fallback notice only once across repeated lists', () => {
    const store = useAudioDeviceStore()
    const notifications = useNotificationsStore()
    const infoSpy = vi.spyOn(notifications, 'pushInfo')
    const errorSpy = vi.spyOn(notifications, 'pushError')

    store.applyList(makeListPayload({ fellBackToDefault: true, scanInProgress: true }))
    store.applyList(makeListPayload({ fellBackToDefault: true }))
    store.applyList(makeListPayload({ fellBackToDefault: true }))

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(store.startupFellBack).toBe(true)
  })

  it('does not surface a notice when the saved device was available', () => {
    const store = useAudioDeviceStore()
    const notifications = useNotificationsStore()
    const infoSpy = vi.spyOn(notifications, 'pushInfo')
    const errorSpy = vi.spyOn(notifications, 'pushError')

    store.applyList(makeListPayload())

    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(store.startupFellBack).toBe(false)
  })
})
