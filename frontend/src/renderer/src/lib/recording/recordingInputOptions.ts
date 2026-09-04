// Turning the backend's device and channel enumeration into the lists the Record
// Audio dialog shows (ADR 0030). Kept out of the component so the option shapes
// can be tested directly.
//
// Inputs are presented exactly like the output device in Preferences: one row per
// physical device, deduplicated across the drivers that expose it, with the driver
// a separate secondary choice. A performer picks a microphone, not a backend.

import { isPseudoDeviceName, sortByBackendPreference } from '@/lib/audio/audioOutputPicker'
import type {
  RecordingChannelCount,
  RecordingInputSelection,
  RecordingInputsListPayload
} from '@shared/bridge-protocol'

export interface RecordingDeviceOption extends RecordingInputSelection {
  /** Stable select value + list key: the device name, lower-cased. */
  value: string
  /** Every driver exposing this device, most-preferred first. `typeName` is the head. */
  typeNames: string[]
}

export interface RecordingChannelOption {
  value: string
  label: string
  firstChannel: number
  channelCount: RecordingChannelCount
}

export function deviceOptionValue(deviceName: string): string {
  return deviceName.trim().toLowerCase()
}

/**
 * One option per physical input, whichever drivers offer it. Input and output can
 * be different devices on different drivers, so the driver stays chooseable — it
 * is just not what the device list is organised by.
 */
export function buildDeviceOptions(
  payload: RecordingInputsListPayload | null
): RecordingDeviceOption[] {
  if (payload === null) return []
  const byDevice = new Map<string, RecordingDeviceOption>()
  for (const type of payload.types) {
    for (const deviceName of type.devices) {
      if (isPseudoDeviceName(deviceName)) continue
      const value = deviceOptionValue(deviceName)
      const existing = byDevice.get(value)
      if (existing) {
        if (!existing.typeNames.includes(type.name)) existing.typeNames.push(type.name)
      } else {
        byDevice.set(value, { typeName: type.name, deviceName, value, typeNames: [type.name] })
      }
    }
  }
  const options = Array.from(byDevice.values())
  for (const option of options) {
    option.typeNames = sortByBackendPreference(option.typeNames)
    option.typeName = option.typeNames[0] ?? option.typeName
  }
  return options.sort((a, b) => a.deviceName.localeCompare(b.deviceName))
}

export function findDeviceOption(
  options: readonly RecordingDeviceOption[],
  value: string
): RecordingDeviceOption | null {
  return options.find((option) => option.value === value) ?? null
}

/** The option matching an open input, matched on device name only: the session may
 *  have settled on a different driver than the one this list prefers. */
export function findDeviceOptionForInput(
  options: readonly RecordingDeviceOption[],
  input: RecordingInputSelection | null
): RecordingDeviceOption | null {
  if (input === null) return null
  return findDeviceOption(options, deviceOptionValue(input.deviceName))
}

export function channelOptionValue(
  firstChannel: number,
  channelCount: RecordingChannelCount
): string {
  return `${firstChannel}:${channelCount}`
}

/**
 * Mono or stereo, nothing else. A device routinely presents far more inputs than
 * a performer means to record, and "Channel 5" means nothing to someone holding a
 * microphone: the dialog offers the shape of the recording and takes the device's
 * first channels, which is where a single input is on every consumer interface.
 */
export function buildChannelOptions(channelNames: readonly string[]): RecordingChannelOption[] {
  if (channelNames.length === 0) return []
  const options: RecordingChannelOption[] = [
    { value: channelOptionValue(0, 1), label: 'Mono', firstChannel: 0, channelCount: 1 }
  ]
  if (channelNames.length >= 2) {
    options.push({ value: channelOptionValue(0, 2), label: 'Stereo', firstChannel: 0, channelCount: 2 })
  }
  return options
}
