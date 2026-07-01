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

describe('audioDeviceStore per-device keep-awake override', () => {
  const setKeepAwakeForDevice = vi.fn()
  const getKeepAwakeByDevice = vi.fn<() => Promise<Record<string, 'auto' | 'on' | 'off'>>>()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
    setKeepAwakeForDevice.mockClear()
    getKeepAwakeByDevice.mockReset()
    vi.stubGlobal('window', { silverdaw: { setKeepAwakeForDevice, getKeepAwakeByDevice } })
  })

  it('defaults an un-pinned / unknown device to auto', () => {
    const store = useAudioDeviceStore()
    expect(store.currentDeviceKeepAwakeMode).toBe('auto')
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    expect(store.currentDeviceKeepAwakeMode).toBe('auto')
  })

  it('setKeepAwakeForDevice pins a device, persists it, and pushes the effective mode', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    vi.mocked(sendBridge).mockClear()

    store.setKeepAwakeForDevice('USB DAC', 'on')
    expect(store.keepAwakeByDevice['USB DAC']).toBe('on')
    expect(store.currentDeviceKeepAwakeMode).toBe('on')
    expect(setKeepAwakeForDevice).toHaveBeenCalledWith('USB DAC', 'on')
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'on' })
  })

  it('setKeepAwakeForDevice with auto clears the override', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    store.setKeepAwakeForDevice('USB DAC', 'on')
    store.setKeepAwakeForDevice('USB DAC', 'auto')
    expect(store.keepAwakeByDevice['USB DAC']).toBeUndefined()
    expect(store.currentDeviceKeepAwakeMode).toBe('auto')
    expect(setKeepAwakeForDevice).toHaveBeenLastCalledWith('USB DAC', 'auto')
  })

  it('setKeepAwakeForDevice can pin a device that is not the current output', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'Speakers (Realtek)' }))
    store.setKeepAwakeForDevice('USB DAC', 'on')
    expect(store.keepAwakeByDevice['USB DAC']).toBe('on')
    // The open device is unchanged, so its effective mode is still auto.
    expect(store.currentDeviceKeepAwakeMode).toBe('auto')
    expect(setKeepAwakeForDevice).toHaveBeenCalledWith('USB DAC', 'on')
  })

  it('re-pushes the effective mode when the open device changes (e.g. USB unplug → onboard)', () => {
    const store = useAudioDeviceStore()
    store.keepAwakeByDevice = { 'USB DAC': 'on' }
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    expect(sendBridge).toHaveBeenLastCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'on' })

    // USB unplugged; playback falls back to the onboard card (no override → auto).
    store.applyList(makeListPayload({ currentDeviceName: 'Speakers (Realtek)' }))
    expect(sendBridge).toHaveBeenLastCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'auto' })
  })

  it('applyKeepAwakeOnReady reloads the map and re-sends the open device override after reconnect', async () => {
    getKeepAwakeByDevice.mockResolvedValue({ 'USB DAC': 'on' })
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    vi.mocked(sendBridge).mockClear()

    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeByDevice).toEqual({ 'USB DAC': 'on' })
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'on' })
  })

  it('applyKeepAwakeOnReady falls back to an empty map (auto) when the read fails', async () => {
    getKeepAwakeByDevice.mockRejectedValue(new Error('ipc down'))
    const store = useAudioDeviceStore()
    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeByDevice).toEqual({})
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { mode: 'auto' })
  })
})
