import { describe, expect, it } from 'vitest'
import { DEFAULT_PX_PER_SECOND } from './constants'
import {
  ZOOM_PRESET_PX_PER_SECOND,
  isZoomPresetAction,
  parseZoomPresetAction,
  zoomPercentLabel,
  zoomPresetAction
} from './zoomPresets'

describe('zoom presets', () => {
  it('presets are multiples of the zoom step so they survive snapping', () => {
    for (const px of ZOOM_PRESET_PX_PER_SECOND) {
      expect(px % 10).toBe(0)
    }
  })

  it('labels a preset as a percentage of the default zoom', () => {
    expect(zoomPercentLabel(DEFAULT_PX_PER_SECOND)).toBe('100%')
    expect(zoomPercentLabel(DEFAULT_PX_PER_SECOND * 2)).toBe('200%')
    expect(zoomPercentLabel(DEFAULT_PX_PER_SECOND / 2)).toBe('50%')
  })

  it('round-trips action encode → decode for every preset', () => {
    for (const px of ZOOM_PRESET_PX_PER_SECOND) {
      const action = zoomPresetAction(px)
      expect(isZoomPresetAction(action)).toBe(true)
      expect(parseZoomPresetAction(action)).toBe(px)
    }
  })

  it('rejects non-preset and malformed action strings', () => {
    expect(parseZoomPresetAction('view.zoomIn')).toBeNull()
    expect(parseZoomPresetAction('view.zoomPreset:')).toBeNull()
    expect(parseZoomPresetAction('view.zoomPreset:abc')).toBeNull()
    // A value not in the offered preset set must be ignored, not applied.
    expect(parseZoomPresetAction('view.zoomPreset:37')).toBeNull()
    expect(parseZoomPresetAction('view.zoomPreset:9999')).toBeNull()
  })

  it('isZoomPresetAction only matches the preset prefix', () => {
    expect(isZoomPresetAction('view.zoomPreset:200')).toBe(true)
    expect(isZoomPresetAction('view.zoomReset')).toBe(false)
    expect(isZoomPresetAction('file.save')).toBe(false)
  })
})
