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

describe('audioDeviceStore per-device keep-awake toggle', () => {
  const setKeepAwakeForDevice = vi.fn()
  const getKeepAwakeByDevice = vi.fn<() => Promise<Record<string, boolean>>>()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
    setKeepAwakeForDevice.mockClear()
    getKeepAwakeByDevice.mockReset()
    vi.stubGlobal('window', { silverdaw: { setKeepAwakeForDevice, getKeepAwakeByDevice } })
  })

  it('defaults an un-toggled / unknown device to off', () => {
    const store = useAudioDeviceStore()
    expect(store.currentDeviceKeepAwakeEnabled).toBe(false)
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    expect(store.currentDeviceKeepAwakeEnabled).toBe(false)
  })

  it('setKeepAwakeForDevice enables a device, persists it, and pushes the effective state', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    vi.mocked(sendBridge).mockClear()

    store.setKeepAwakeForDevice('USB DAC', true)
    expect(store.keepAwakeByDevice['USB DAC']).toBe(true)
    expect(store.currentDeviceKeepAwakeEnabled).toBe(true)
    expect(setKeepAwakeForDevice).toHaveBeenCalledWith('USB DAC', true)
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { enabled: true })
  })

  it('setKeepAwakeForDevice with false clears the entry', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    store.setKeepAwakeForDevice('USB DAC', true)
    store.setKeepAwakeForDevice('USB DAC', false)
    expect(store.keepAwakeByDevice['USB DAC']).toBeUndefined()
    expect(store.currentDeviceKeepAwakeEnabled).toBe(false)
    expect(setKeepAwakeForDevice).toHaveBeenLastCalledWith('USB DAC', false)
  })

  it('setKeepAwakeForDevice can enable a device that is not the current output', () => {
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'Speakers (Realtek)' }))
    store.setKeepAwakeForDevice('USB DAC', true)
    expect(store.keepAwakeByDevice['USB DAC']).toBe(true)
    // The open device is unchanged, so its effective state is still off.
    expect(store.currentDeviceKeepAwakeEnabled).toBe(false)
    expect(setKeepAwakeForDevice).toHaveBeenCalledWith('USB DAC', true)
  })

  it('re-pushes the effective state when the open device changes (e.g. USB unplug → onboard)', () => {
    const store = useAudioDeviceStore()
    store.keepAwakeByDevice = { 'USB DAC': true }
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    expect(sendBridge).toHaveBeenLastCalledWith('AUDIO_KEEP_AWAKE_SET', { enabled: true })

    // USB unplugged; playback falls back to the onboard card (no toggle → off).
    store.applyList(makeListPayload({ currentDeviceName: 'Speakers (Realtek)' }))
    expect(sendBridge).toHaveBeenLastCalledWith('AUDIO_KEEP_AWAKE_SET', { enabled: false })
  })

  it('applyKeepAwakeOnReady reloads the map and re-sends the open device state after reconnect', async () => {
    getKeepAwakeByDevice.mockResolvedValue({ 'USB DAC': true })
    const store = useAudioDeviceStore()
    store.applyList(makeListPayload({ currentDeviceName: 'USB DAC' }))
    vi.mocked(sendBridge).mockClear()

    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeByDevice).toEqual({ 'USB DAC': true })
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { enabled: true })
  })

  it('applyKeepAwakeOnReady falls back to an empty map (off) when the read fails', async () => {
    getKeepAwakeByDevice.mockRejectedValue(new Error('ipc down'))
    const store = useAudioDeviceStore()
    await store.applyKeepAwakeOnReady()
    expect(store.keepAwakeByDevice).toEqual({})
    expect(sendBridge).toHaveBeenCalledWith('AUDIO_KEEP_AWAKE_SET', { enabled: false })
  })
})
