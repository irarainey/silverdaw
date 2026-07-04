import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectAudioOutputReconciliation } from '@/lib/app/useProjectAudioOutputReconciliation'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function seedSavedOutput(typeName: string, deviceName: string): void {
  const project = useProjectStore()
  project.projectId = 'p1'
  project.audioOutputTypeName = typeName
  project.audioOutputDeviceName = deviceName
}

function seedDevices(typeName: string, devices: string[]): void {
  const audioDevices = useAudioDeviceStore()
  audioDevices.hydrated = true
  audioDevices.types = [{ name: typeName, devices }] as unknown as typeof audioDevices.types
}

describe('useProjectAudioOutputReconciliation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Fake timers neutralise the bounded background probe's setTimeout so it never leaks across
    // tests; individual tests advance them explicitly when exercising the probe.
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('switches the live device when the saved output is available', () => {
    seedSavedOutput('WASAPI', 'Speakers')
    seedDevices('WASAPI', ['Speakers', 'Headphones'])
    const audioDevices = useAudioDeviceStore()
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})

    const { audioUnavailableOpen } = useProjectAudioOutputReconciliation()

    expect(select).toHaveBeenCalledWith('WASAPI', 'Speakers', { persistUserPreference: false })
    expect(audioUnavailableOpen.value).toBe(false)
  })

  it('warns when the saved output is unavailable', () => {
    seedSavedOutput('WASAPI', 'Missing DAC')
    seedDevices('WASAPI', ['Speakers'])

    const { audioUnavailableOpen, audioUnavailableSavedTypeName, audioUnavailableSavedDeviceName } =
      useProjectAudioOutputReconciliation()

    expect(audioUnavailableOpen.value).toBe(true)
    expect(audioUnavailableSavedTypeName.value).toBe('WASAPI')
    expect(audioUnavailableSavedDeviceName.value).toBe('Missing DAC')
  })

  it('does nothing until device state has hydrated', () => {
    seedSavedOutput('WASAPI', 'Speakers')
    const audioDevices = useAudioDeviceStore()
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})

    const { audioUnavailableOpen } = useProjectAudioOutputReconciliation()

    expect(select).not.toHaveBeenCalled()
    expect(audioUnavailableOpen.value).toBe(false)
  })

  it('leaves the live device untouched when it already matches', () => {
    seedSavedOutput('WASAPI', 'Speakers')
    seedDevices('WASAPI', ['Speakers'])
    const audioDevices = useAudioDeviceStore()
    audioDevices.currentTypeName = 'WASAPI'
    audioDevices.currentDeviceName = 'Speakers'
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})

    const { audioUnavailableOpen } = useProjectAudioOutputReconciliation()

    expect(select).not.toHaveBeenCalled()
    expect(audioUnavailableOpen.value).toBe(false)
  })

  it('auto-switches (and clears the warning) when a slow device appears in a later scan', async () => {
    seedSavedOutput('WASAPI', 'USB DAC')
    seedDevices('WASAPI', ['Speakers']) // DAC not enumerated yet
    const audioDevices = useAudioDeviceStore()
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})

    const { audioUnavailableOpen } = useProjectAudioOutputReconciliation()
    expect(audioUnavailableOpen.value).toBe(true)
    expect(select).not.toHaveBeenCalled()

    // The USB DAC finishes enumerating and shows up in a later device-list update.
    audioDevices.types = [
      { name: 'WASAPI', devices: ['Speakers', 'USB DAC'] }
    ] as unknown as typeof audioDevices.types
    await nextTick()

    expect(select).toHaveBeenCalledWith('WASAPI', 'USB DAC', { persistUserPreference: false })
    expect(audioUnavailableOpen.value).toBe(false)
  })

  it('probes at most a bounded number of times for a device that never appears', async () => {
    seedSavedOutput('WASAPI', 'USB DAC')
    seedDevices('WASAPI', ['Speakers'])
    const audioDevices = useAudioDeviceStore()
    vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})
    const probe = vi.spyOn(audioDevices, 'probeForDevices').mockImplementation(() => {})

    useProjectAudioOutputReconciliation()

    // Each probe would trigger a device-list broadcast; simulate it (device still missing) so the
    // next probe is scheduled, and confirm the loop stops after the bound rather than polling forever.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      audioDevices.types = [
        { name: 'WASAPI', devices: ['Speakers'] }
      ] as unknown as typeof audioDevices.types
      await nextTick()
    }

    expect(probe.mock.calls.length).toBe(6)
  })
})
