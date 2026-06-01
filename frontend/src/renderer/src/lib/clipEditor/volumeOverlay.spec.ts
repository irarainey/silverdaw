import { describe, expect, it } from 'vitest'
import {
  OVERLAY_DB_MAX,
  OVERLAY_DB_MIN,
  hitTestHandle,
  overlayGainToDb,
  overlayGainToY,
  overlayYToGain,
  sourceMsToVolumeTime,
  volumeTimeToSourceMs
} from './volumeOverlay'

describe('volumeOverlay gain/dB mapping', () => {
  it('maps unity gain to 0 dB and silence to the floor', () => {
    expect(overlayGainToDb(1)).toBeCloseTo(0, 6)
    expect(overlayGainToDb(0)).toBe(OVERLAY_DB_MIN)
  })

  it('clamps boost above the ceiling and attenuation below the floor', () => {
    expect(overlayGainToDb(100)).toBe(OVERLAY_DB_MAX)
    expect(overlayGainToDb(1e-9)).toBe(OVERLAY_DB_MIN)
  })

  it('places loudest at the band top and silence at the band bottom', () => {
    const top = 18
    const height = 200
    const yMax = overlayGainToY(ENVELOPE_MAX_AS_GAIN(), top, height)
    const ySilence = overlayGainToY(0, top, height)
    expect(yMax).toBeCloseTo(top, 1)
    expect(ySilence).toBeCloseTo(top + height, 6)
  })

  it('round-trips a y back through to a gain near the original', () => {
    const top = 18
    const height = 200
    const y = overlayGainToY(1, top, height)
    expect(overlayYToGain(y, top, height)).toBeCloseTo(1, 3)
  })

  it('snaps to true zero near the silence floor', () => {
    const top = 0
    const height = 100
    expect(overlayYToGain(top + height + 5, top, height)).toBe(0)
  })
})

describe('volumeOverlay time mapping', () => {
  it('maps clip-local ms into the source window and back (warp ratio 1)', () => {
    const base = 5000
    expect(volumeTimeToSourceMs(0, base, 1)).toBe(base)
    expect(volumeTimeToSourceMs(2000, base, 1)).toBe(7000)
    expect(sourceMsToVolumeTime(7000, base, 1)).toBe(2000)
  })

  it('applies the warp ratio in both directions', () => {
    const base = 1000
    const ratio = 2
    const src = volumeTimeToSourceMs(500, base, ratio)
    expect(src).toBe(2000)
    expect(sourceMsToVolumeTime(src, base, ratio)).toBe(500)
  })

  it('treats a non-positive ratio as 1 to avoid divide-by-zero', () => {
    expect(volumeTimeToSourceMs(100, 0, 0)).toBe(100)
    expect(sourceMsToVolumeTime(100, 0, 0)).toBe(100)
  })
})

describe('volumeOverlay hit-testing', () => {
  const handles = [
    { x: 0, y: 0 },
    { x: 50, y: 20 },
    { x: 100, y: 40 }
  ]

  it('returns the nearest handle within the radius', () => {
    expect(hitTestHandle(handles, 52, 21, 12)).toBe(1)
  })

  it('returns null when nothing is close enough', () => {
    expect(hitTestHandle(handles, 200, 200, 12)).toBeNull()
  })

  it('resolves ties to the closest handle', () => {
    expect(hitTestHandle(handles, 1, 1, 12)).toBe(0)
  })
})

// Local helper so the spec does not need to import ENVELOPE_MAX_GAIN; the
// loudest reachable gain maps to the band top.
function ENVELOPE_MAX_AS_GAIN(): number {
  return Math.pow(10, OVERLAY_DB_MAX / 20)
}
