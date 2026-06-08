import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})
