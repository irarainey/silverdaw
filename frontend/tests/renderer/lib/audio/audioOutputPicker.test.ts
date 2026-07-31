import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildDriverOptions, useUniqueAudioDevices } from '@/lib/audio/audioOutputPicker'
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

describe('buildDriverOptions', () => {
  const INSTALLED = ['Windows Audio', 'DirectSound', 'ASIO']
  const PRESENT = [
    { name: 'Speakers (Realtek)', backends: ['Windows Audio', 'DirectSound'] }
  ]

  it('offers only the drivers that expose an available device', () => {
    const opts = buildDriverOptions({
      deviceName: 'Speakers (Realtek)',
      uniqueDevices: PRESENT,
      installedTypeNames: INSTALLED,
      savedTypeName: 'Windows Audio',
      savedDeviceName: 'Speakers (Realtek)'
    })
    expect(opts.map((o) => o.label)).toEqual(['Windows Audio', 'DirectSound'])
    expect(opts.some((o) => o.unavailable)).toBe(false)
  })

  it('does not mark an installed driver unavailable when only the device is missing', () => {
    // The reported bug: an unplugged USB DAC made its perfectly-present driver
    // read as "Windows Audio (not available)".
    const opts = buildDriverOptions({
      deviceName: 'Speakers (iFi USB Audio SE UAC1)',
      uniqueDevices: PRESENT,
      installedTypeNames: INSTALLED,
      savedTypeName: 'Windows Audio',
      savedDeviceName: 'Speakers (iFi USB Audio SE UAC1)'
    })
    const saved = opts.find((o) => o.value === 'Windows Audio')
    expect(saved).toEqual({ value: 'Windows Audio', label: 'Windows Audio', unavailable: false })
    expect(opts.some((o) => o.unavailable)).toBe(false)
  })

  it('offers every installed driver, preferred first, when the device is missing', () => {
    const opts = buildDriverOptions({
      deviceName: 'Gone DAC',
      uniqueDevices: PRESENT,
      installedTypeNames: ['ASIO', 'DirectSound', 'Windows Audio'],
      savedTypeName: 'Windows Audio',
      savedDeviceName: 'Gone DAC'
    })
    expect(opts.map((o) => o.value)).toEqual(['Windows Audio', 'DirectSound', 'ASIO'])
  })

  it('marks the saved driver unavailable only when it is not installed', () => {
    const opts = buildDriverOptions({
      deviceName: 'Interface ASIO',
      uniqueDevices: PRESENT,
      installedTypeNames: ['Windows Audio', 'DirectSound'],
      savedTypeName: 'ASIO',
      savedDeviceName: 'Interface ASIO'
    })
    const saved = opts.find((o) => o.value === 'ASIO')
    expect(saved).toEqual({ value: 'ASIO', label: 'ASIO (not available)', unavailable: true })
  })

  it('matches the saved device name case-insensitively', () => {
    const opts = buildDriverOptions({
      deviceName: 'gone dac',
      uniqueDevices: PRESENT,
      installedTypeNames: ['Windows Audio'],
      savedTypeName: 'ASIO',
      savedDeviceName: 'Gone DAC'
    })
    expect(opts.map((o) => o.label)).toEqual(['Windows Audio', 'ASIO (not available)'])
  })

  it('returns only the inherit row when no device is chosen', () => {
    const opts = buildDriverOptions({
      deviceName: null,
      uniqueDevices: PRESENT,
      installedTypeNames: INSTALLED,
      savedTypeName: 'Windows Audio',
      savedDeviceName: 'Speakers (Realtek)'
    })
    expect(opts).toEqual([{ value: '', label: 'Use Application Settings', unavailable: false }])
  })
})