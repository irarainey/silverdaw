import { describe, it, expect } from 'vitest'
import { useClipEditorSliceDraft } from '@/lib/clipEditor/useClipEditorSliceDraft'

describe('useClipEditorSliceDraft', () => {
  it('starts empty and generates grid markers for the window', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    expect(d.hasMarkers.value).toBe(false)
    d.subdivision.value = '1/4'
    d.generateToGrid(120, 0) // 500 ms grid, interior of 0..4000
    expect(d.markers.value).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500])
    expect(d.hasMarkers.value).toBe(true)
  })

  it('generates over an offset window in source-absolute space', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(1000, 2000) // window 1000..3000
    d.subdivision.value = '1/4'
    d.generateToGrid(120, 0)
    expect(d.markers.value).toEqual([1500, 2000, 2500])
  })

  it('adds a manual marker, keeping the set sorted and guarded', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    d.addMarker(2000)
    const idx = d.addMarker(1000)
    expect(d.markers.value).toEqual([1000, 2000])
    expect(idx).toBe(0)
  })

  it('drops a manual add that collides with a neighbour', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    d.addMarker(1000)
    const idx = d.addMarker(1010) // within 20 ms of 1000
    expect(d.markers.value).toEqual([1000])
    expect(idx).toBe(0) // nearest surviving marker
  })

  it('clamps a dragged marker between its neighbours instead of dropping it', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    d.addMarker(1000)
    d.addMarker(2000)
    d.addMarker(3000)
    // Drag the middle marker far right; it clamps to 3000 - 20 = 2980.
    const newIdx = d.moveMarker(1, 5000)
    expect(newIdx).toBe(1)
    expect(d.markers.value).toEqual([1000, 2980, 3000])
  })

  it('removes and clears markers', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    d.addMarker(1000)
    d.addMarker(2000)
    d.removeMarker(0)
    expect(d.markers.value).toEqual([2000])
    d.clear()
    expect(d.markers.value).toEqual([])
  })

  it('regenerating clears any prior manual markers', () => {
    const d = useClipEditorSliceDraft()
    d.initialise(0, 4000)
    d.addMarker(1234)
    d.subdivision.value = '1/4'
    d.generateToGrid(120, 0)
    expect(d.markers.value).not.toContain(1234)
  })
})
