import { describe, it, expect } from 'vitest'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'
import type { Clip } from '@/stores/projectStore'

function clipWith(envelopePoints?: Clip['envelopePoints']): Clip {
  return { id: 'c1', durationMs: 1000, envelopePoints } as Clip
}

describe('useClipEditorVolumeShapeDraft', () => {
  it('seeds a flat unity shape when the clip has no envelope', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 2000)
    expect(d.draftPoints.value).toEqual([
      { timeMs: 0, gain: 1 },
      { timeMs: 2000, gain: 1 }
    ])
    // A flat unity draft is "no shape" → not dirty, commits empty.
    expect(d.hasChanged.value).toBe(false)
    expect(d.committedPoints()).toEqual([])
  })

  it('seeds from the clip envelope when present', () => {
    const pts = [
      { timeMs: 0, gain: 1 },
      { timeMs: 500, gain: 0.5 },
      { timeMs: 1000, gain: 1 }
    ]
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(pts), 1000)
    expect(d.draftPoints.value).toEqual(pts)
    expect(d.hasChanged.value).toBe(false)
    expect(d.committedPoints()).toEqual(pts)
  })

  it('becomes dirty after bending a handle', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 1000)
    const idx = d.addPoint(500, 0.5)
    expect(idx).toBe(1)
    expect(d.hasChanged.value).toBe(true)
    expect(d.committedPoints()).toEqual([
      { timeMs: 0, gain: 1 },
      { timeMs: 500, gain: 0.5 },
      { timeMs: 1000, gain: 1 }
    ])
  })

  it('keeps endpoints pinned in time when moved', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 1000)
    d.movePoint(0, 400, 0.25)
    expect(d.draftPoints.value[0]).toEqual({ timeMs: 0, gain: 0.25 })
  })

  it('does not remove pinned endpoints', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 1000)
    d.removePoint(0)
    d.removePoint(1)
    expect(d.draftPoints.value).toHaveLength(2)
  })

  it('reset returns to flat unity and clears dirtiness', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 1000)
    d.addPoint(500, 0.5)
    expect(d.hasChanged.value).toBe(true)
    d.reset(1000)
    expect(d.hasChanged.value).toBe(false)
    expect(d.committedPoints()).toEqual([])
  })

  it('is dirty when resetting a clip that had a persisted shape', () => {
    const pts = [
      { timeMs: 0, gain: 1 },
      { timeMs: 500, gain: 0.5 },
      { timeMs: 1000, gain: 1 }
    ]
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(pts), 1000)
    d.reset(1000)
    // Flattening a clip that had a shape IS a change (clears it).
    expect(d.hasChanged.value).toBe(true)
    expect(d.committedPoints()).toEqual([])
  })

  it('tracks isFlat as the draft is shaped and reset', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(clipWith(undefined), 1000)
    expect(d.isFlat.value).toBe(true)
    d.addPoint(500, 0.5)
    expect(d.isFlat.value).toBe(false)
    d.reset(1000)
    expect(d.isFlat.value).toBe(true)
  })

  it('reports isFlat false when seeded from a persisted shape', () => {
    const d = useClipEditorVolumeShapeDraft()
    d.initialise(
      clipWith([
        { timeMs: 0, gain: 1 },
        { timeMs: 500, gain: 0.5 },
        { timeMs: 1000, gain: 1 }
      ]),
      1000
    )
    expect(d.isFlat.value).toBe(false)
  })
})
