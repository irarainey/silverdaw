import { describe, it, expect } from 'vitest'
import {
  ENVELOPE_MAX_GAIN,
  sanitizeEnvelopePoints,
  envelopesEqual,
  envelopeGainAtMs,
  scaleEnvelopePoints,
  splitEnvelopeAtMs,
  defaultEnvelope,
  insertEnvelopePoint,
  applyEnvelopeGate,
  removeEnvelopePoint,
  moveEnvelopePoint,
  isFlatUnityEnvelope
} from '@/lib/envelope'

describe('envelope helpers', () => {
  describe('sanitizeEnvelopePoints', () => {
    it('clamps gain, stably sorts ties and preserves close neighbours', () => {
      const out = sanitizeEnvelopePoints([
        { timeMs: 100, gain: 9 },
        { timeMs: 0, gain: -2 },
        { timeMs: 100.0005, gain: 0.5 },
        { timeMs: 100, gain: 0.25 }
      ])
      expect(out).toEqual([
        { timeMs: 0, gain: 0 },
        { timeMs: 100, gain: ENVELOPE_MAX_GAIN },
        { timeMs: 100, gain: 0.25 },
        { timeMs: 100.0005, gain: 0.5 }
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
    it('uses the outgoing gain exactly at a step, including both endpoints', () => {
      const shape = [
        { timeMs: 0, gain: 0.1 }, { timeMs: 0, gain: 0.5 },
        { timeMs: 10, gain: 0.5 }, { timeMs: 10, gain: 0 },
        { timeMs: 20, gain: 0 }, { timeMs: 20, gain: 1 }
      ]
      expect([-1, 0, 9.9999, 10, 19.9999, 20].map(t => envelopeGainAtMs(shape, t)))
        .toEqual([0.1, 0.5, 0.5, 0, 0, 1])
      const { left, right } = splitEnvelopeAtMs(shape, 10, 20)
      expect(left?.at(-1)?.gain).toBe(0.5)
      expect(right?.slice(0, 2)).toEqual([{ timeMs: 0, gain: 0.5 }, { timeMs: 0, gain: 0 }])
      expect(scaleEnvelopePoints(shape, 0.25)).toEqual(shape.map(p => ({ ...p, timeMs: p.timeMs / 4 })))
    })

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
      const { points, index } = insertEnvelopePoint(base, 500, 0.5, 1000)
      expect(points).toEqual([
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ])
      expect(index).toBe(1)
    })

    it('keeps a new handle separate from the pinned endpoint at the same time', () => {
      const base = defaultEnvelope(1000)
      const { points, index } = insertEnvelopePoint(base, 0, 0.2, 1000)
      expect(points[0]).toEqual(base[0])
      expect(points[index]).toEqual({ timeMs: 0, gain: 0.2 })
      expect(index).toBe(1)
      expect(points).toHaveLength(3)
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
      expect(out.points[0]).toEqual({ timeMs: 0, gain: 0.5 })
    })

    it('lets an interior point meet its neighbour', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ]
      const out = moveEnvelopePoint(pts, 1, 5000, 0.25)
      expect(out.points[out.index]).toEqual({ timeMs: 1000, gain: 0.25 })
    })
  })

  describe('applyEnvelopeGate', () => {
    it('gates the held tail of a short envelope without dropping its outgoing gain', () => {
      const pts = [{ timeMs: 0, gain: 1 }, { timeMs: 200, gain: 0.25 }]
      const gated = applyEnvelopeGate(pts, 400, 500, 0, 1000)
      expect([399, 400, 450, 500, 700].map(t => envelopeGainAtMs(gated, t)))
        .toEqual([0.25, 0, 0, 0.25, 0.25])
    })

    it('silences a span from the clip start with a hard trailing edge', () => {
      // Flat unity; silence [0, 1000] → silent block then hard rise to full.
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ]
      const out = applyEnvelopeGate(pts, 0, 1000, 0)
      expect(out).toEqual([
        { timeMs: 0, gain: 0 },
        { timeMs: 1000, gain: 0 },
        { timeMs: 1000, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ])
    })

    it('gates an interior span with hard edges on both sides', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ]
      const out = applyEnvelopeGate(pts, 800, 1200, 0)
      expect(out).toEqual([
        { timeMs: 0, gain: 1 },
        { timeMs: 800, gain: 1 },
        { timeMs: 800, gain: 0 },
        { timeMs: 1200, gain: 0 },
        { timeMs: 1200, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ])
    })

    it('drops interior breakpoints inside the gated span', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 1000, gain: 0.5 },
        { timeMs: 2000, gain: 1 }
      ]
      const out = applyEnvelopeGate(pts, 0, 2000, 0)
      expect(out).toEqual([
        { timeMs: 0, gain: 0 },
        { timeMs: 2000, gain: 0 }
      ])
    })

    it('clamps the gate level and ignores only empty spans', () => {
      const pts = [
        { timeMs: 0, gain: 1 },
        { timeMs: 2000, gain: 1 }
      ]
      expect(applyEnvelopeGate(pts, 1000, 1000, 0)).toEqual(pts)
      const short = applyEnvelopeGate(pts, 1000, 1000.5, 0)
      expect(envelopeGainAtMs(short, 1000.25)).toBe(0)
      expect(envelopeGainAtMs(short, 1000.5)).toBe(1)
      const gated = applyEnvelopeGate(pts, 0, 1000, 9)
      expect(gated[0]).toEqual({ timeMs: 0, gain: ENVELOPE_MAX_GAIN })
    })
  })
})
