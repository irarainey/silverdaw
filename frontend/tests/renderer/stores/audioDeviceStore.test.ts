import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
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

describe('audioDeviceStore keep-awake override', () => {
  const setKeepAwakeMode = vi.fn()
  const getKeepAwakeMode = vi.fn<() => Promise<'auto' | 'on' | 'off'>>()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
    setKeepAwakeMode.mockClear()
    getKeepAwakeMode.mockReset()
    vi.stubGlobal('window', { silverdaw: { setKeepAwakeMode, getKeepAwakeMode } })
  })

  it('defaults to auto', () => {
    expect(useAudioDeviceStore().keepAwakeMode).toBe('auto')
  })

  it('setKeepAwakeMode persists, updates state, and pushes the override to the backend', () => {
    const store = useAudioDeviceStore()
    store.setKeepAwakeMode('off')
    expect(store.keepAwakeMode).toBe('off')
    expect(setKeepAwakeMode).toHaveBeenCalledWith('off')
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'off' })
  })

  it('applyKeepAwakeOnReady re-sends the persisted override after a reconnect', async () => {
    getKeepAwakeMode.mockResolvedValue('on')
    const store = useAudioDeviceStore()
    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeMode).toBe('on')
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'on' })
  })

  it('applyKeepAwakeOnReady falls back to auto when the preference read fails', async () => {
    getKeepAwakeMode.mockRejectedValue(new Error('ipc down'))
    const store = useAudioDeviceStore()
    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeMode).toBe('auto')
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'auto' })
  })
})
