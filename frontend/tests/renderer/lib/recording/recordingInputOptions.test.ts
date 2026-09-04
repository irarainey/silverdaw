import { describe, expect, it } from 'vitest'
import {
  buildChannelOptions,
  buildDeviceOptions,
  deviceOptionValue,
  findDeviceOption,
  findDeviceOptionForInput
} from '@/lib/recording/recordingInputOptions'
import { droppedSamplesMessage, recordingErrorMessage } from '@/lib/recording/recordingMessages'

describe('recordingInputOptions', () => {
  it('lists each physical device once, whichever drivers expose it', () => {
    const options = buildDeviceOptions({
      types: [
        { name: 'DirectSound', devices: ['USB Mic', 'Primary Sound Capture Driver'] },
        { name: 'Windows Audio', devices: ['USB Mic', 'Mic Array'] },
        { name: 'ASIO', devices: [] }
      ]
    })
    expect(options.map((o) => o.deviceName)).toEqual(['Mic Array', 'USB Mic'])
    // The preferred driver leads, so picking a device picks a sensible backend.
    expect(options.find((o) => o.deviceName === 'USB Mic')?.typeName).toBe('Windows Audio')
    expect(options.find((o) => o.deviceName === 'USB Mic')?.typeNames).toEqual([
      'Windows Audio',
      'DirectSound'
    ])
  })

  it('round-trips a device through its select value', () => {
    const options = buildDeviceOptions({
      types: [{ name: 'Windows Audio', devices: ['USB Mic'] }]
    })
    expect(findDeviceOption(options, deviceOptionValue('USB Mic'))?.deviceName).toBe('USB Mic')
    expect(findDeviceOption(options, 'missing')).toBeNull()
  })

  it('matches an open input on the device alone, whatever driver it settled on', () => {
    const options = buildDeviceOptions({
      types: [
        { name: 'Windows Audio', devices: ['USB Mic'] },
        { name: 'DirectSound', devices: ['USB Mic'] }
      ]
    })
    const match = findDeviceOptionForInput(options, {
      typeName: 'DirectSound',
      deviceName: 'USB Mic'
    })
    expect(match?.value).toBe(deviceOptionValue('USB Mic'))
    expect(findDeviceOptionForInput(options, null)).toBeNull()
  })

  it('offers mono and stereo only, never a per-channel list', () => {
    const options = buildChannelOptions(['In 1', 'In 2', 'In 3'])
    expect(options.map((o) => o.value)).toEqual(['0:1', '0:2'])
    expect(options.map((o) => o.label)).toEqual(['Mono', 'Stereo'])
  })

  it('offers no stereo option for a single-channel device', () => {
    expect(buildChannelOptions(['Mono In']).map((o) => o.value)).toEqual(['0:1'])
    expect(buildChannelOptions([])).toEqual([])
  })
})

describe('recordingMessages', () => {
  it('explains silent input as a consent problem rather than a generic failure', () => {
    expect(recordingErrorMessage('silentInput')).toContain('Microphone')
  })

  it('prefers the backend detail when the code is unknown', () => {
    expect(recordingErrorMessage(undefined, 'Disk went away')).toBe('Disk went away')
    expect(recordingErrorMessage(undefined)).toContain('Something went wrong')
  })

  it('reports dropped samples as a duration the user can understand', () => {
    expect(droppedSamplesMessage(4800, 48000)).toContain('100 ms')
  })
})
