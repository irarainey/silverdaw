import { describe, expect, it } from 'vitest'

import { detectGpuFromInfo } from '@main/stems/gpuDetect'

describe('detectGpuFromInfo', () => {
  it('returns unavailable for non-object input', () => {
    expect(detectGpuFromInfo(undefined)).toEqual({ available: false, name: null })
    expect(detectGpuFromInfo(null)).toEqual({ available: false, name: null })
    expect(detectGpuFromInfo('gpu')).toEqual({ available: false, name: null })
  })

  it('detects a real GPU from a named GL renderer', () => {
    const info = {
      auxAttributes: { glRenderer: 'ANGLE (NVIDIA GeForce RTX 4070)', glVendor: 'Google Inc.' }
    }
    expect(detectGpuFromInfo(info)).toEqual({
      available: true,
      name: 'ANGLE (NVIDIA GeForce RTX 4070)'
    })
  })

  it('rejects a software renderer string', () => {
    const info = { auxAttributes: { glRenderer: 'Google SwiftShader' } }
    expect(detectGpuFromInfo(info)).toEqual({ available: false, name: null })
  })

  it('rejects the Microsoft Basic Render Driver', () => {
    const info = { auxAttributes: { glRenderer: 'Microsoft Basic Render Driver' } }
    expect(detectGpuFromInfo(info)).toEqual({ available: false, name: null })
  })

  it('falls back to an active hardware device when no GL renderer string', () => {
    const info = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2786 }] }
    expect(detectGpuFromInfo(info)).toEqual({ available: true, name: null })
  })

  it('treats a software-vendor-only device list as unavailable', () => {
    const info = { gpuDevice: [{ active: true, vendorId: 0x1414 }] }
    expect(detectGpuFromInfo(info)).toEqual({ available: false, name: null })
  })

  it('ignores an inactive hardware device', () => {
    const info = { gpuDevice: [{ active: false, vendorId: 0x10de }] }
    expect(detectGpuFromInfo(info)).toEqual({ available: false, name: null })
  })
})
