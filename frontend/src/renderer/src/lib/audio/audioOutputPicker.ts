// Shared audio-output picker helpers used by both the Preferences
// dialog and the Project Properties dialog so the two surfaces stay
// consistent: same device list, same backend preference order, same
// "device first, driver second" picker order.
//
// `uniqueDevices` deduplicates the per-backend device lists from
// `audioDeviceStore.types` into one row per physical device. Two
// backends are considered the same device when their device names
// match case-insensitively — true for the Windows Audio /
// DirectSound pair (both describe the same MMDevice) and gives ASIO
// devices their own row because vendor ASIO drivers usually report
// distinct names.

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
        const key = dev.toLowerCase()
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
      dev.backends.sort((a, b) => {
        const ai = BACKEND_PREFERENCE.indexOf(a)
        const bi = BACKEND_PREFERENCE.indexOf(b)
        return (
          (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
        )
      })
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
