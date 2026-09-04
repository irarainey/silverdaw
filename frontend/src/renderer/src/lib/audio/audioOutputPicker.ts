// Shared audio-output picker helpers for the Preferences and Project Properties
// dialogs, keeping their device list and "device first, driver second" order
// consistent. `uniqueDevices` deduplicates per-backend lists to one row per
// physical device, matching device names case-insensitively (so the Windows
// Audio/DirectSound pair collapses while distinctly-named ASIO drivers stay split).

import { computed, type ComputedRef } from 'vue'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'

/** Preference order when auto-picking a backend for a freshly-clicked
 *  device. We default to the most-reliable user-friendly backend
 *  rather than the lowest-latency one; advanced users override via the
 *  driver picker. */
export const BACKEND_PREFERENCE: readonly string[] = [
  'Windows Audio',
  'CoreAudio',
  'ALSA',
  'DirectSound',
  'Windows Audio (Exclusive Mode)',
  'JACK',
  'ASIO'
]

/**
 * Plain-English description for every audio backend JUCE may report.
 * Used by the driver picker's hover label.
 */
export const AUDIO_BACKEND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'Windows Audio':
    'Recommended. Modern Windows audio path; reliable latency and shares the device with other apps.',
  'Windows Audio (Exclusive Mode)':
    'Lower latency, but takes the device exclusively — other apps fall silent while Silverdaw runs.',
  DirectSound:
    'Legacy backend. Use only if a device misbehaves with Windows Audio.',
  ASIO:
    'Lowest latency, but requires a vendor-supplied ASIO driver. Pick this for pro-audio interfaces.',
  CoreAudio: 'macOS standard audio backend.',
  ALSA: 'Linux standard audio backend.',
  JACK: 'Pro-audio routing on Linux / macOS.'
}

export function describeBackend(typeName: string): string {
  return AUDIO_BACKEND_DESCRIPTIONS[typeName] ?? 'Audio backend.'
}

/** Rank for `BACKEND_PREFERENCE` ordering; unknown backends sort last. */
function backendRank(name: string): number {
  const i = BACKEND_PREFERENCE.indexOf(name)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

/** Sorts a copy of `names` by `BACKEND_PREFERENCE`, unknown backends last. */
export function sortByBackendPreference(names: readonly string[]): string[] {
  return [...names].sort((a, b) => backendRank(a) - backendRank(b))
}

// Windows/JUCE report a couple of pseudo "devices" that are not real endpoints — the
// DirectSound default aliases ("Primary Sound Driver" / "Primary Sound Capture Driver")
// and the legacy "Microsoft Sound Mapper". They can't carry a per-device keep-awake
// setting and only confuse the picker, so they are filtered out; the pickers list real
// named devices only. Recording shares this list: the same aliases appear on the input
// side of the very same drivers.
const PSEUDO_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'primary sound driver',
  'primary sound capture driver',
  'microsoft sound mapper',
  'microsoft sound mapper - input',
  'microsoft sound mapper - output'
])

/** Whether `name` is a driver alias rather than a real endpoint. */
export function isPseudoDeviceName(name: string): boolean {
  return PSEUDO_DEVICE_NAMES.has(name.trim().toLowerCase())
}

export interface UniqueDevice {
  /** Canonical (display) name — the first capitalisation we saw. */
  name: string
  /** Backend type names that offer this device, sorted by
   *  `BACKEND_PREFERENCE`. */
  backends: string[]
}

/**
 * Returns a reactive list of every physical output device the backend
 * knows about, deduplicated across backends. Sorted alphabetically.
 */
export function useUniqueAudioDevices(): ComputedRef<UniqueDevice[]> {
  const audioDevices = useAudioDeviceStore()
  return computed(() => {
    const map = new Map<string, UniqueDevice>()
    for (const type of audioDevices.types) {
      for (const dev of type.devices) {
        const key = dev.trim().toLowerCase()
        if (isPseudoDeviceName(dev)) continue
        const existing = map.get(key)
        if (existing) {
          if (!existing.backends.includes(type.name)) existing.backends.push(type.name)
        } else {
          map.set(key, { name: dev, backends: [type.name] })
        }
      }
    }
    // Sort each device's backends list by preference order so the
    // "preferred" backend lands first.
    for (const dev of map.values()) {
      dev.backends = sortByBackendPreference(dev.backends)
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  })
}

/**
 * Most-preferred backend that exposes `device`. Falls back to the
 * device's first reported backend when none of the preferred backends
 * match (e.g. a Linux-only backend on a macOS build).
 */
export function preferredBackendFor(device: UniqueDevice): string {
  for (const b of BACKEND_PREFERENCE) {
    if (device.backends.includes(b)) return b
  }
  return device.backends[0] ?? ''
}

/** One row of the Project Properties audio device / driver pickers. */
export interface AudioListOption {
  /** Empty string represents "Use Application Settings" (no project override). */
  value: string
  label: string
  /** The value itself is no longer exposed by the OS. */
  unavailable: boolean
}

export interface DriverOptionsParams {
  /** Device currently chosen in the picker; `null` inherits the app setting. */
  deviceName: string | null
  /** Devices the OS is exposing right now, deduplicated across drivers. */
  uniqueDevices: readonly UniqueDevice[]
  /** Every driver installed on this machine, device availability aside. */
  installedTypeNames: readonly string[]
  savedTypeName: string | null
  savedDeviceName: string | null
}

/**
 * Builds the driver picker's rows for `deviceName`.
 *
 * Normally the list is scoped to the drivers that actually expose the chosen
 * device. When the device is absent we cannot know that subset, so every
 * installed driver is offered instead — drivers are machine-wide, so each stays
 * a valid choice for when the device returns. Only a driver that is genuinely
 * not installed is marked "(not available)"; a missing *device* says nothing
 * about its driver.
 */
export function buildDriverOptions(params: DriverOptionsParams): AudioListOption[] {
  const { deviceName, uniqueDevices, installedTypeNames, savedTypeName, savedDeviceName } =
    params

  if (!deviceName) {
    return [{ value: '', label: 'Use Application Settings', unavailable: false }]
  }

  const dev = uniqueDevices.find((d) => d.name.toLowerCase() === deviceName.toLowerCase())
  const names = dev ? dev.backends : sortByBackendPreference(installedTypeNames)
  const items: AudioListOption[] = names.map((name) => ({
    value: name,
    label: name,
    unavailable: false
  }))

  if (
    savedTypeName &&
    savedDeviceName &&
    savedDeviceName.toLowerCase() === deviceName.toLowerCase() &&
    !items.some((o) => o.value === savedTypeName)
  ) {
    // A driver can be installed yet not expose the chosen device — the same
    // driver-vs-device distinction the unavailable-device dialog draws. Only a
    // driver that is genuinely not installed is marked missing.
    const installed = installedTypeNames.includes(savedTypeName)
    items.push({
      value: savedTypeName,
      label: installed ? savedTypeName : `${savedTypeName} (not available)`,
      unavailable: !installed
    })
  }
  return items
}
