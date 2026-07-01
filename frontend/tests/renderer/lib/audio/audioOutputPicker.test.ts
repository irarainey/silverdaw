import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useUniqueAudioDevices } from '@/lib/audio/audioOutputPicker'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import type { AudioDeviceTypeListing } from '@shared/bridge-protocol'

function setTypes(types: AudioDeviceTypeListing[]): void {
  useAudioDeviceStore().types = types
}

describe('useUniqueAudioDevices', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('lists real named devices, deduplicated across backends', () => {
    setTypes([
      { name: 'Windows Audio', devices: ['Speakers (Realtek)', 'USB DAC'] },
      { name: 'DirectSound', devices: ['Speakers (Realtek)'] }
    ])
    const devices = useUniqueAudioDevices().value
    expect(devices.map((d) => d.name)).toEqual(['Speakers (Realtek)', 'USB DAC'])
    const realtek = devices.find((d) => d.name === 'Speakers (Realtek)')
    expect(realtek?.backends).toEqual(['Windows Audio', 'DirectSound'])
  })

  it('filters out pseudo-devices (Primary Sound Driver, Microsoft Sound Mapper)', () => {
    setTypes([
      { name: 'DirectSound', devices: ['Primary Sound Driver', 'Speakers (Realtek)'] },
      { name: 'Windows Audio', devices: ['  microsoft sound mapper  ', 'USB DAC'] }
    ])
    const names = useUniqueAudioDevices().value.map((d) => d.name)
    expect(names).toEqual(['Speakers (Realtek)', 'USB DAC'])
  })
})
