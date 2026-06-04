import { describe, it, expect } from 'vitest'
import {
  ENVELOPE_MAX_GAIN,
  sanitizeEnvelopePoints,
  envelopesEqual,
  envelopeGainAtMs,
  defaultEnvelope,
  insertEnvelopePoint,
  removeEnvelopePoint,
  moveEnvelopePoint,
  isFlatUnityEnvelope
} from '@/lib/envelope'

describe('envelope helpers', () => {
  describe('sanitizeEnvelopePoints', () => {
    it('clamps gain, sorts by time and drops near-duplicate times', () => {
      const out = sanitizeEnvelopePoints([
        { timeMs: 100, gain: 9 },
        { timeMs: 0, gain: -2 },
        { timeMs: 100.0005, gain: 0.5 }
      ])
      expect(out).toEqual([
        { timeMs: 0, gain: 0 },
        { timeMs: 100, gain: ENVELOPE_MAX_GAIN }
      ])
    })

    it('drops non-finite points', () => {
      const out = sanitizeEnvelopePoints([
        { timeMs: 0, gain: 1 },
        { timeMs: Number.NaN, gain: 1 },
        { timeMs: 50, gain: Number.POSITIVE_INFINITY }
      ])
      expect(out).toEqual([{ timeMs: 0, gain: 1 }])
    })
  })

  describe('envelopesEqual', () => {
    it('treats undefined and empty as equal', () => {
      expect(envelopesEqual(undefined, [])).toBe(true)
    })

    it('detects gain and time differences', () => {
      const a = [{ timeMs: 0, gain: 1 }]
      expect(envelopesEqual(a, [{ timeMs: 0, gain: 0.5 }])).toBe(false)
      expect(envelopesEqual(a, [{ timeMs: 5, gain: 1 }])).toBe(false)
    })
  })

  describe('envelopeGainAtMs', () => {
    it('returns unity for fewer than two points', () => {
      expect(envelopeGainAtMs([], 10)).toBe(1)
    })

    it('interpolates linear-in-dB (midpoint of unity→quarter ≈ 0.707·... )', () => {
      // 1.0 (0 dB) to 0.5 (-6 dB): midpoint is -3 dB ≈ 0.70711 (1/√2)
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 100, gain: 0.5 }
      ]
      expect(envelopeGainAtMs(pts, 50)).toBeCloseTo(0.70711, 4)
    })

    it('clamps to endpoint gains outside the range', () => {
      const pts = [
        { timeMs: 100, gain: 0.25 },
        { timeMs: 200, gain: 1 }
      ]
      expect(envelopeGainAtMs(pts, 0)).toBe(0.25)
      expect(envelopeGainAtMs(pts, 999)).toBe(1)
    })
  })

  describe('isFlatUnityEnvelope', () => {
    it('treats <2 points and all-unity shapes as flat', () => {
      expect(isFlatUnityEnvelope([])).toBe(true)
      expect(isFlatUnityEnvelope([{ timeMs: 0, gain: 0.5 }])).toBe(true)
      expect(isFlatUnityEnvelope(defaultEnvelope(1000))).toBe(true)
    })

    it('treats any non-unity breakpoint as a real shape', () => {
      expect(
        isFlatUnityEnvelope([
          { timeMs: 0, gain: 1 },
          { timeMs: 500, gain: 0.5 },
          { timeMs: 1000, gain: 1 }
        ])
      ).toBe(false)
      // A flat but non-unity shape is still a real (constant) attenuation.
      expect(
        isFlatUnityEnvelope([
          { timeMs: 0, gain: 0.5 },
          { timeMs: 1000, gain: 0.5 }
        ])
      ).toBe(false)
    })
  })

  describe('defaultEnvelope', () => {
    it('returns a flat unity two-point shape pinned to clip bounds', () => {
      expect(defaultEnvelope(2000)).toEqual([
        { timeMs: 0, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ])
    })
  })

  describe('insertEnvelopePoint', () => {
    it('inserts an interior point in sorted order', () => {
      const base = defaultEnvelope(1000)
      const { points, index } = insertEnvelopePoint(base, 500, 0.5)
      expect(points).toEqual([
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ])
      expect(index).toBe(1)
    })

    it('replaces gain when inserting at an existing time', () => {
      const base = defaultEnvelope(1000)
      const { points, index } = insertEnvelopePoint(base, 0, 0.2)
      expect(points[0]).toEqual({ timeMs: 0, gain: 0.2 })
      expect(index).toBe(0)
      expect(points).toHaveLength(2)
    })
  })

  describe('removeEnvelopePoint', () => {
    it('removes an interior point', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ]
      expect(removeEnvelopePoint(pts, 1)).toEqual([
        { timeMs: 0, gain: 1 },
        { timeMs: 1000, gain: 1 }
      ])
    })

    it('refuses to remove pinned endpoints', () => {
      const pts = defaultEnvelope(1000)
      expect(removeEnvelopePoint(pts, 0)).toEqual(pts)
      expect(removeEnvelopePoint(pts, 1)).toEqual(pts)
    })
  })

  describe('moveEnvelopePoint', () => {
    it('moves only the gain of a pinned endpoint', () => {
      const pts = defaultEnvelope(1000)
      const out = moveEnvelopePoint(pts, 0, 250, 0.5)
      expect(out[0]).toEqual({ timeMs: 0, gain: 0.5 })
    })

    it('clamps an interior point strictly between its neighbours', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ]
      const out = moveEnvelopePoint(pts, 1, 5000, 0.25)
      expect(out[1]!.timeMs).toBeLessThan(1000)
      expect(out[1]!.timeMs).toBeGreaterThan(0)
      expect(out[1]!.gain).toBe(0.25)
    })
  })
})
