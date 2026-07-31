import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send as sendBridge } from '@/lib/bridgeService'
import { useProjectStore } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

describe('projectStore — marker toggling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
  })

  it('removes a marker the playhead is parked on, wherever it sits', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 1234 }]

    // A marker placed under an earlier tempo sits off the current beat grid, and
    // must still toggle off from the spot it occupies.
    expect(project.toggleMarkerAt(1234.011)).toBe(true)
    expect(project.markers).toHaveLength(0)
  })

  it('adds at the exact playhead position rather than the nearest beat', () => {
    const project = useProjectStore()

    expect(project.toggleMarkerAt(1234.011)).toBe(true)
    expect(project.markers).toHaveLength(1)
    expect(project.markers[0]!.positionMs).toBe(1234)
  })

  it('adds a second marker rather than snapping onto a nearby one', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 1250 }]

    // 1248 is a distinct position the user chose; it must not be pulled onto the
    // marker two milliseconds away.
    expect(project.toggleMarkerAt(1248)).toBe(true)
    expect(project.markers.map((marker) => marker.positionMs)).toEqual([1248, 1250])
  })

  it('toggles the same position off and back on', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 700 }]

    expect(project.toggleMarkerAt(700)).toBe(true)
    expect(project.markers).toHaveLength(0)
    expect(project.toggleMarkerAt(700)).toBe(true)
    expect(project.markers[0]!.positionMs).toBe(700)
  })

  it('rounds a fractional add so it stays toggleable', () => {
    const project = useProjectStore()

    // The MIDI path calls addMarkerAt with the raw playhead float. Flooring here
    // would store 1233 and put the marker outside the 1 ms match tolerance.
    expect(project.addMarkerAt(1233.6)).toBe(true)
    expect(project.markers[0]!.positionMs).toBe(1234)
    expect(project.toggleMarkerAt(1233.6)).toBe(true)
    expect(project.markers).toHaveLength(0)
  })
})

describe('projectStore — clearAllMarkers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
  })

  it('removes every marker as a single undo step', () => {
    const project = useProjectStore()
    project.markers = [
      { id: 'm1', positionMs: 0 },
      { id: 'm2', positionMs: 500 },
      { id: 'm3', positionMs: 1500 }
    ]

    expect(project.clearAllMarkers()).toBe(3)
    expect(project.markers).toHaveLength(0)

    const types = vi.mocked(sendBridge).mock.calls.map((call) => call[0])
    expect(types).toEqual([
      'EDIT_GROUP_BEGIN',
      'PROJECT_MARKER_REMOVE',
      'PROJECT_MARKER_REMOVE',
      'PROJECT_MARKER_REMOVE',
      'EDIT_GROUP_END'
    ])
  })

  it('is a no-op with no markers', () => {
    const project = useProjectStore()

    expect(project.clearAllMarkers()).toBe(0)
    expect(sendBridge).not.toHaveBeenCalled()
  })
})
