import { describe, expect, it } from 'vitest'
import {
  SILENCED_TRACK_PALETTE,
  TRACK_PALETTE,
  isTrackSilenced
} from '@/stores/projectTypes'

describe('isTrackSilenced', () => {
  it('is false for an unmuted track when nothing is soloed', () => {
    expect(isTrackSilenced({ muted: false, soloed: false }, false)).toBe(false)
  })

  it('is true for an explicitly muted track', () => {
    expect(isTrackSilenced({ muted: true, soloed: false }, false)).toBe(true)
  })

  it('is true for an unmuted track while another track is soloed', () => {
    expect(isTrackSilenced({ muted: false, soloed: false }, true)).toBe(true)
  })

  it('is false for the soloed track itself', () => {
    expect(isTrackSilenced({ muted: false, soloed: true }, true)).toBe(false)
  })

  it('keeps an explicit mute on the soloed track', () => {
    expect(isTrackSilenced({ muted: true, soloed: true }, true)).toBe(true)
  })
})

describe('SILENCED_TRACK_PALETTE', () => {
  it('mirrors the palette entry for entry, keeping ids aligned', () => {
    expect(SILENCED_TRACK_PALETTE).toHaveLength(TRACK_PALETTE.length)
    expect(SILENCED_TRACK_PALETTE.map((e) => e.id)).toEqual(TRACK_PALETTE.map((e) => e.id))
  })

  it('moves every painted colour toward the canvas background', () => {
    const channels = (c: number): readonly number[] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
    const bg = channels(0x09090b)
    for (let i = 0; i < TRACK_PALETTE.length; i++) {
      const bright = TRACK_PALETTE[i]!
      const dim = SILENCED_TRACK_PALETTE[i]!
      for (const key of ['fill', 'border', 'wave'] as const) {
        const dimCh = channels(dim[key])
        const brightCh = channels(bright[key])
        // Overall the colour sinks — every palette entry is lighter than the canvas.
        const total = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!
        expect(total(dimCh)).toBeLessThan(total(brightCh))
        for (let ch = 0; ch < 3; ch++) {
          // Each channel lands between where it started and the background,
          // and never overshoots past it.
          expect(dimCh[ch]!).toBeGreaterThanOrEqual(Math.min(bg[ch]!, brightCh[ch]!))
          expect(dimCh[ch]!).toBeLessThanOrEqual(Math.max(bg[ch]!, brightCh[ch]!))
        }
      }
    }
  })
})
