import { describe, expect, it } from 'vitest'
import { nextSmoothProgress } from '@/lib/stems/useSmoothProgress'

describe('nextSmoothProgress', () => {
  it('snaps up toward a freshly-delivered real milestone without overshooting it', () => {
    const next = nextSmoothProgress(10, 26, false, 0.5)
    expect(next).toBeGreaterThan(10)
    expect(next).toBeLessThanOrEqual(26)
  })

  it('reaches the milestone quickly when catching up from below', () => {
    let v = 10
    for (let i = 0; i < 5; i++) v = nextSmoothProgress(v, 26, false, 0.1)
    expect(v).toBeGreaterThanOrEqual(26)
  })

  it('keeps creeping forward between milestones so the bar never freezes', () => {
    const next = nextSmoothProgress(26, 26, false, 1)
    expect(next).toBeGreaterThan(26)
  })

  it('caps the cold-start creep so it cannot run far ahead of the last real value', () => {
    let v = 26
    for (let i = 0; i < 1000; i++) v = nextSmoothProgress(v, 26, false, 0.1)
    // Before any pace is known, capped at target + the small cold-start headroom (4).
    expect(v).toBeLessThanOrEqual(30)
    expect(v).toBeGreaterThan(29)
  })

  it('never trickles past the ceiling even for a high target', () => {
    let v = 90
    for (let i = 0; i < 1000; i++) v = nextSmoothProgress(v, 90, false, 0.1)
    expect(v).toBeLessThanOrEqual(98)
  })

  it('drives to 100 once the job is done', () => {
    let v = 40
    for (let i = 0; i < 200; i++) v = nextSmoothProgress(v, 94, true, 0.1)
    expect(v).toBe(100)
  })

  it('creeps at the supplied observed pace toward the projected cap', () => {
    // With a measured pace of 4%/s and a projected cap of 40, one 0.5 s step advances ~2%.
    const next = nextSmoothProgress(30, 30, false, 0.5, { tricklePerSec: 4, cap: 40 })
    expect(next).toBeCloseTo(32, 5)
  })

  it('never creeps past the supplied projected cap', () => {
    let v = 30
    for (let i = 0; i < 1000; i++) {
      v = nextSmoothProgress(v, 30, false, 0.1, { tricklePerSec: 4, cap: 40 })
    }
    expect(v).toBeLessThanOrEqual(40)
    expect(v).toBeGreaterThan(39)
  })

  it('is monotonic across a realistic bursty milestone sequence', () => {
    // Real targets arrive in bursts: 2 (prepare), long wait at 26, then a jump to 94.
    const targets = [2, 2, 2, 26, 26, 26, 94, 94]
    let v = 0
    for (const target of targets) {
      for (let i = 0; i < 30; i++) {
        const nextV = nextSmoothProgress(v, target, false, 0.1)
        expect(nextV).toBeGreaterThanOrEqual(v)
        v = nextV
      }
    }
    expect(v).toBeGreaterThanOrEqual(94)
  })
})
