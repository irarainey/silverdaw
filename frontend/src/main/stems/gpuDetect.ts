// Pure GPU-detection heuristics for the stem-separation "use GPU" preference.
//
// Electron's `app.getGPUInfo('complete')` is impure (touches the GPU process),
// so the side-effecting call lives in the IPC handler while the classification
// logic lives here, where it can be unit-tested against captured shapes. The
// goal is only to answer "is there a real hardware GPU?" so the preference
// checkbox can be enabled or disabled — not to enumerate every adapter.

import type { StemGpuStatus } from '../../shared/types'

interface GpuDevice {
  readonly active?: boolean
  readonly vendorId?: number
  readonly deviceId?: number
}

interface RawGpuInfo {
  readonly gpuDevice?: readonly GpuDevice[]
  readonly auxAttributes?: Record<string, unknown>
}

// Renderer strings that indicate a software / fallback rasteriser rather than a
// real GPU. Matched case-insensitively against the GL renderer/vendor strings.
const SOFTWARE_RENDERER_MARKERS = [
  'swiftshader',
  'llvmpipe',
  'softpipe',
  'software',
  'microsoft basic render',
  'basic render driver'
]

// Adapters Windows exposes for software rendering. 0x1414 is the Microsoft
// Basic Render Driver; vendor 0 is an unknown/placeholder device.
const SOFTWARE_VENDOR_IDS: ReadonlySet<number> = new Set([0x1414, 0])

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isSoftwareRenderer(text: string): boolean {
  const lower = text.toLowerCase()
  return SOFTWARE_RENDERER_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Classify a GPU-info object (the shape returned by `app.getGPUInfo`) into a
 * stem-preference availability status. Defensive against unknown / partial
 * shapes so a future Electron change cannot throw on the main thread.
 */
export function detectGpuFromInfo(info: unknown): StemGpuStatus {
  if (!info || typeof info !== 'object') return { available: false, name: null }
  const raw = info as RawGpuInfo

  const glRenderer = readString(raw.auxAttributes, 'glRenderer')
  const glVendor = readString(raw.auxAttributes, 'glVendor')

  // A named, non-software GL renderer is the strongest positive signal.
  if (glRenderer && !isSoftwareRenderer(glRenderer) && !(glVendor && isSoftwareRenderer(glVendor))) {
    return { available: true, name: glRenderer }
  }

  // Fall back to the device list: a real GPU has an active device whose vendor
  // is not a known software adapter.
  const devices = Array.isArray(raw.gpuDevice) ? raw.gpuDevice : []
  const hardware = devices.some(
    (d) =>
      typeof d.vendorId === 'number' &&
      !SOFTWARE_VENDOR_IDS.has(d.vendorId) &&
      // Treat an unspecified `active` flag as active to avoid false negatives.
      d.active !== false
  )
  if (hardware) {
    return { available: true, name: glRenderer && !isSoftwareRenderer(glRenderer) ? glRenderer : null }
  }

  return { available: false, name: null }
}
