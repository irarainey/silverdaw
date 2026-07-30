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

  it('removes an off-grid marker the playhead is parked on', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 1234 }]

    // A marker placed under an earlier tempo: the playhead sits on it, but the
    // caller's snapped position lands on the current grid instead.
    expect(project.toggleMarkerAt(1234.011, 1250)).toBe(true)
    expect(project.markers).toHaveLength(0)
  })

  it('adds at the snapped position when no marker is under the playhead', () => {
    const project = useProjectStore()

    expect(project.toggleMarkerAt(1234.011, 1250)).toBe(true)
    expect(project.markers).toHaveLength(1)
    expect(project.markers[0]!.positionMs).toBe(1250)
  })

  it('removes a marker sitting on the snapped position', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 1250 }]

    expect(project.toggleMarkerAt(1248, 1250)).toBe(true)
    expect(project.markers).toHaveLength(0)
  })

  it('toggles on the given position when no snapped position is supplied', () => {
    const project = useProjectStore()
    project.markers = [{ id: 'm1', positionMs: 700 }]

    expect(project.toggleMarkerAt(700)).toBe(true)
    expect(project.markers).toHaveLength(0)
    expect(project.toggleMarkerAt(700)).toBe(true)
    expect(project.markers[0]!.positionMs).toBe(700)
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
