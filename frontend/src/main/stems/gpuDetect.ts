// Pure GPU-detection heuristics for the stem-separation "use GPU" preference.
//
// Electron's `app.getGPUInfo` is impure (touches the GPU process), so the
// side-effecting call lives in the IPC handler while the classification logic
// lives here, where it can be unit-tested against captured shapes. The handler
// uses the 'basic' query (the 'complete' query can crash the GPU process in
// packaged builds), so the GL renderer/vendor strings may be absent — the goal
// is only to answer "is there a real hardware GPU?" so the preference checkbox
// can be enabled or disabled, which the device-list fallback below handles.

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
 *
 * The backend's GPU path is DirectML, which runs on ANY Direct3D-12 adapter —
 * including integrated GPUs that Chromium's lightweight `'basic'` probe reports
 * as inactive or without a vendorId. So the policy is deliberately permissive:
 * enable the (opt-in, off-by-default, CPU-fallback) option UNLESS we positively
 * detect software-only rendering. A false "available" merely lets the backend
 * try and fall back to CPU; a false "unavailable" wrongly hides GPU on a capable
 * machine (the failure mode this replaces).
 */
export function detectGpuFromInfo(info: unknown): StemGpuStatus {
  if (!info || typeof info !== 'object') return { available: false, name: null }
  const raw = info as RawGpuInfo

  const glRenderer = readString(raw.auxAttributes, 'glRenderer')
  const glVendor = readString(raw.auxAttributes, 'glVendor')

  // Positive software-renderer signal (SwiftShader, Basic Render Driver, …) —
  // there is no real GPU to accelerate on, so keep the option disabled.
  if (glRenderer && isSoftwareRenderer(glRenderer)) return { available: false, name: null }
  if (glVendor && isSoftwareRenderer(glVendor)) return { available: false, name: null }

  // Software-adapter-only device list (e.g. only the Microsoft Basic Render
  // Driver) is the other positive "no GPU" signal. A device with an unknown /
  // absent vendorId is treated as inconclusive, not software.
  const devices = Array.isArray(raw.gpuDevice) ? raw.gpuDevice : []
  const anyKnownSoftware = devices.some(
    (d) => typeof d.vendorId === 'number' && SOFTWARE_VENDOR_IDS.has(d.vendorId)
  )
  const anyRealHardware = devices.some(
    (d) => typeof d.vendorId === 'number' && !SOFTWARE_VENDOR_IDS.has(d.vendorId)
  )
  if (devices.length > 0 && anyKnownSoftware && !anyRealHardware) {
    return { available: false, name: null }
  }

  // A real hardware GPU is present, or detection is inconclusive (an iGPU
  // reported inactive / without a vendorId, or no device list at all). DirectML
  // can use it; enable the option and surface a friendly name when we have one.
  const name = glRenderer && !isSoftwareRenderer(glRenderer) ? glRenderer : null
  return { available: true, name }
}
