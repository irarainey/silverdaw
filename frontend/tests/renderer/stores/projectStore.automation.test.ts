import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import { useProjectStore } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const sendMock = vi.mocked(send)

function seedTrack(project: ReturnType<typeof useProjectStore>): void {
  project.tracks = [
    {
      id: 't1',
      name: 'T',
      colorIndex: 0,
      muted: false,
      soloed: false,
      volume: 1,
      clipIds: [],
      lengthMs: 1000
    } as never
  ]
}

describe('projectStore — setTrackAutomation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('stores a sanitised filter curve and sends TRACK_SET_AUTOMATION', () => {
    const project = useProjectStore()
    seedTrack(project)

    project.setTrackAutomation('t1', 'filter', [
      { timeMs: 1000, value: 5 }, // value clamps to 1, time stays
      { timeMs: 0, value: -3 } // value clamps to -1, sorts first
    ])

    const lane = project.tracks[0]!.automation?.filter
    expect(lane).toEqual([
      { timeMs: 0, value: -1 },
      { timeMs: 1000, value: 1 }
    ])
    expect(sendMock).toHaveBeenCalledWith(
      'TRACK_SET_AUTOMATION',
      expect.objectContaining({ trackId: 't1', paramId: 'filter' })
    )
  })

  it('clears the lane when given fewer than two points', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setTrackAutomation('t1', 'filter', [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 1 }
    ])
    expect(project.tracks[0]!.automation?.filter).toBeDefined()

    project.setTrackAutomation('t1', 'filter', [{ timeMs: 0, value: 0 }])
    expect(project.tracks[0]!.automation).toBeUndefined()
  })

  it('keeps other lanes when one is cleared', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setTrackAutomation('t1', 'filter', [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 1 }
    ])
    project.setTrackAutomation('t1', 'pan', [
      { timeMs: 0, value: -1 },
      { timeMs: 500, value: 1 }
    ])
    expect(Object.keys(project.tracks[0]!.automation ?? {})).toEqual(['filter', 'pan'])

    project.setTrackAutomation('t1', 'filter', [])
    expect(Object.keys(project.tracks[0]!.automation ?? {})).toEqual(['pan'])
  })

  it('localOnly does not echo to the bridge (ack reconciliation)', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setTrackAutomation(
      't1',
      'filter',
      [
        { timeMs: 0, value: 0 },
        { timeMs: 500, value: 1 }
      ],
      { localOnly: true }
    )
    expect(sendMock).not.toHaveBeenCalled()
    expect(project.tracks[0]!.automation?.filter).toHaveLength(2)
  })

  it('setAutomationRamp writes a sorted 2-point ramp', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setAutomationRamp('t1', 'filter', 800, 200, -1, 1)
    expect(project.tracks[0]!.automation?.filter).toEqual([
      { timeMs: 200, value: -1 },
      { timeMs: 800, value: 1 }
    ])
  })

  it('createFilterCrossfade gives two tracks mirrored sweeps', () => {
    const project = useProjectStore()
    project.tracks = [
      { id: 't1', name: 'A', colorIndex: 0, muted: false, soloed: false, volume: 1, clipIds: [], lengthMs: 1000 } as never,
      { id: 't2', name: 'B', colorIndex: 0, muted: false, soloed: false, volume: 1, clipIds: [], lengthMs: 1000 } as never
    ]
    project.createFilterCrossfade('t1', 't2', 0, 1000)
    expect(project.tracks[0]!.automation?.filter?.[1]?.value).toBe(1)
    expect(project.tracks[1]!.automation?.filter?.[1]?.value).toBe(-1)
  })

  it('copyAutomationToTrack inverts a bipolar curve around centre', () => {
    const project = useProjectStore()
    project.tracks = [
      { id: 't1', name: 'A', colorIndex: 0, muted: false, soloed: false, volume: 1, clipIds: [], lengthMs: 1000 } as never,
      { id: 't2', name: 'B', colorIndex: 0, muted: false, soloed: false, volume: 1, clipIds: [], lengthMs: 1000 } as never
    ]
    project.setAutomationRamp('t1', 'filter', 0, 1000, -1, 1)
    project.copyAutomationToTrack('t1', 't2', 'filter', true)
    expect(project.tracks[1]!.automation?.filter).toEqual([
      { timeMs: 0, value: 1 },
      { timeMs: 1000, value: -1 }
    ])
  })

  it('shiftTrackAutomation lays a flat baseline at the static value + delta when no curve', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.tracks[0]!.toneBassDb = 4
    project.shiftTrackAutomation('t1', 'toneBass', 2)
    expect(project.tracks[0]!.automation?.toneBass).toEqual([
      { timeMs: 0, value: 6 },
      { timeMs: 1000, value: 6 }
    ])
  })

  it('shiftTrackAutomation offsets an existing curve by delta', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setAutomationRamp('t1', 'filter', 0, 1000, -0.5, 0.5)
    project.shiftTrackAutomation('t1', 'filter', -0.2)
    expect(project.tracks[0]!.automation?.filter?.[0]?.value).toBeCloseTo(-0.7)
    expect(project.tracks[0]!.automation?.filter?.[1]?.value).toBeCloseTo(0.3)
  })

  it('setAutomationValueAt inserts a point against a flat static baseline', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setAutomationValueAt('t1', 'filter', 500, 0.8)
    const lane = project.tracks[0]!.automation?.filter
    expect(lane).toEqual([
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 0.8 },
      { timeMs: 1000, value: 0 }
    ])
  })

  it('nudgeAutomationPoint shifts an interior point in time and value, clamped', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.setTrackAutomation('t1', 'filter', [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 0.2 },
      { timeMs: 1000, value: 0 }
    ])
    project.nudgeAutomationPoint('t1', 'filter', 1, 50, 5) // value clamps to max 1
    const lane = project.tracks[0]!.automation?.filter
    expect(lane?.[1]?.timeMs).toBe(550)
    expect(lane?.[1]?.value).toBe(1)
  })

  it('clears the lane when a curve settles flat at the static resting value', () => {
    const project = useProjectStore()
    seedTrack(project) // toneFilter unset -> static filter resting value is 0
    project.setTrackAutomation('t1', 'filter', [
      { timeMs: 0, value: 0 },
      { timeMs: 1000, value: 0 }
    ])
    expect(project.tracks[0]!.automation?.filter).toBeUndefined()
  })

  it('keeps a flat curve that differs from the static resting value', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.tracks[0]!.toneBassDb = 0 // static bass resting = 0
    project.setTrackAutomation('t1', 'toneBass', [
      { timeMs: 0, value: 6 },
      { timeMs: 1000, value: 6 }
    ])
    expect(project.tracks[0]!.automation?.toneBass).toHaveLength(2)
  })
})
