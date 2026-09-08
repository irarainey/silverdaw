import { describe, expect, it } from 'vitest'
import { buildRigidBeatGrid } from '@/lib/library/rigidBeatGrid'

describe('buildRigidBeatGrid', () => {
  it('spaces beats by the tempo across the whole duration', () => {
    const beats = buildRigidBeatGrid(120, 0, 2)
    expect(beats).toEqual([0, 0.5, 1, 1.5, 2])
  })

  it('keeps phase with an anchor inside the item', () => {
    const beats = buildRigidBeatGrid(120, 0.2, 1)
    expect(beats[0]).toBeCloseTo(0.2, 6)
    expect(beats[1]).toBeCloseTo(0.7, 6)
    expect(beats.at(-1)).toBeCloseTo(0.7, 6)
  })

  it('starts at or after zero when the anchor sits before the item', () => {
    const beats = buildRigidBeatGrid(120, -1.25, 1)
    expect(beats[0]).toBeCloseTo(0.25, 6)
    expect(beats.every((t) => t >= 0)).toBe(true)
  })

  it('never returns an empty grid for a valid tempo', () => {
    expect(buildRigidBeatGrid(120, 0, 0)).toHaveLength(1)
  })

  it('returns nothing for a tempo that is not a tempo', () => {
    expect(buildRigidBeatGrid(0, 0, 10)).toEqual([])
    expect(buildRigidBeatGrid(Number.NaN, 0, 10)).toEqual([])
  })
})
