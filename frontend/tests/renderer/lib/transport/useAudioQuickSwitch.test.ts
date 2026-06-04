import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioQuickSwitch } from '@/lib/transport/useAudioQuickSwitch'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

type DeviceTypes = ReturnType<typeof useAudioDeviceStore>['types']

function seedTypes(types: { name: string; devices: string[] }[]): void {
  const audioDevices = useAudioDeviceStore()
  audioDevices.types = types as unknown as DeviceTypes
}

describe('useAudioQuickSwitch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('dedupes the same physical device exposed by multiple backends', () => {
    seedTypes([
      { name: 'Windows Audio', devices: ['Speakers'] },
      { name: 'DirectSound', devices: ['Speakers'] },
      { name: 'ASIO', devices: ['Studio'] }
    ])
    const { quickSwitchDevices } = useAudioQuickSwitch()
    const rows = quickSwitchDevices.value
    expect(rows.map((r) => r.name)).toEqual(['Speakers', 'Studio'])
    const speakers = rows.find((r) => r.name === 'Speakers')!
    expect(speakers.backends).toEqual(['Windows Audio', 'DirectSound'])
  })

  it('toggleAudioMenu flips the popover open state', () => {
    const { audioMenuOpen, toggleAudioMenu } = useAudioQuickSwitch()
    expect(audioMenuOpen.value).toBe(false)
    toggleAudioMenu()
    expect(audioMenuOpen.value).toBe(true)
  })

  it('pickDevice routes through the store, pins to the project, and closes', () => {
    const audioDevices = useAudioDeviceStore()
    const project = useProjectStore()
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})
    const pin = vi.spyOn(project, 'setProjectAudioOutput').mockImplementation(() => {})
    const { audioMenuOpen, toggleAudioMenu, pickDevice } = useAudioQuickSwitch()
    toggleAudioMenu()

    pickDevice('Windows Audio', 'Speakers')

    expect(select).toHaveBeenCalledWith('Windows Audio', 'Speakers')
    expect(pin).toHaveBeenCalledWith('Windows Audio', 'Speakers')
    expect(audioMenuOpen.value).toBe(false)
  })

  it('pickUniqueDevice auto-selects the preferred backend for the device', () => {
    const audioDevices = useAudioDeviceStore()
    const project = useProjectStore()
    const select = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})
    vi.spyOn(project, 'setProjectAudioOutput').mockImplementation(() => {})
    const { pickUniqueDevice } = useAudioQuickSwitch()

    // 'Windows Audio' outranks 'DirectSound' in the preference order.
    pickUniqueDevice({ name: 'Speakers', backends: ['DirectSound', 'Windows Audio'] })

    expect(select).toHaveBeenCalledWith('Windows Audio', 'Speakers')
  })

  it('audioMenuLabel reflects an optimistic pending selection', () => {
    const audioDevices = useAudioDeviceStore()
    audioDevices.pendingSelection = {
      typeName: 'Windows Audio',
      deviceName: 'Headphones'
    } as typeof audioDevices.pendingSelection
    const { audioMenuLabel } = useAudioQuickSwitch()
    expect(audioMenuLabel.value).toBe('Headphones')
  })

  it('isCurrentUniqueDevice matches the active device case-insensitively', () => {
    const audioDevices = useAudioDeviceStore()
    audioDevices.pendingSelection = {
      typeName: 'Windows Audio',
      deviceName: 'Speakers'
    } as typeof audioDevices.pendingSelection
    const { isCurrentUniqueDevice } = useAudioQuickSwitch()
    expect(isCurrentUniqueDevice({ name: 'speakers', backends: ['Windows Audio'] })).toBe(true)
    expect(isCurrentUniqueDevice({ name: 'Studio', backends: ['ASIO'] })).toBe(false)
  })

  it('Escape closes the popover via the document key handler', () => {
    const { audioMenuOpen, toggleAudioMenu, onAudioMenuKey } = useAudioQuickSwitch()
    toggleAudioMenu()
    expect(audioMenuOpen.value).toBe(true)
    onAudioMenuKey({ key: 'Escape' } as KeyboardEvent)
    expect(audioMenuOpen.value).toBe(false)
  })
})
