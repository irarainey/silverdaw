import { describe, expect, it } from 'vitest'
import {
  WAVEFORM_FILL_HEADROOM,
  WAVEFORM_MAX_BOOST,
  waveformFillScale
} from '@/lib/waveform/fillScale'

describe('waveformFillScale', () => {
  it('leaves the loudest peak just short of the edge', () => {
    expect(waveformFillScale(1) * 1).toBeCloseTo(WAVEFORM_FILL_HEADROOM)
    expect(waveformFillScale(0.5) * 0.5).toBeCloseTo(WAVEFORM_FILL_HEADROOM)
  })

  it('draws a quiet take up so its shape is readable', () => {
    // A mic take peaking around -18 dBFS is normal and correct, and drawn
    // literally it is a thin line in a tall box.
    const scale = waveformFillScale(0.125)
    expect(scale).toBeGreaterThan(1)
    expect(0.125 * scale).toBeCloseTo(WAVEFORM_FILL_HEADROOM)
  })

  it('stops boosting before a near-silent take is drawn as a performance', () => {
    expect(waveformFillScale(0.0001)).toBe(WAVEFORM_MAX_BOOST)
  })

  it('leaves silence flat rather than amplifying the noise bed', () => {
    expect(waveformFillScale(0)).toBe(1)
    expect(waveformFillScale(-1)).toBe(1)
    expect(waveformFillScale(Number.NaN)).toBe(1)
  })
})
