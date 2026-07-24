import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { useUiStore } from '@/stores/uiStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('uiStore automation lanes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('opens one default lane and supports additional distinct lanes', () => {
    const ui = useUiStore()

    ui.toggleTrackAutomationLanes('track-1')
    ui.addTrackAutomationLane('track-1', 'pan')
    ui.addTrackAutomationLane('track-1', 'pan')

    expect(ui.automationLanes['track-1']?.map((lane) => lane.paramId)).toEqual([
      'filter',
      'pan'
    ])
  })

  it('keeps lane heights independent and rejects duplicate parameter changes', () => {
    const ui = useUiStore()
    ui.addTrackAutomationLane('track-1', 'filter')
    ui.addTrackAutomationLane('track-1', 'pan')

    ui.setTrackAutomationLaneHeight('track-1', 'pan', 160)
    ui.setTrackAutomationLaneParam('track-1', 'pan', 'filter')

    expect(ui.automationLanes['track-1']).toEqual([
      { paramId: 'filter', heightPx: 80 },
      { paramId: 'pan', heightPx: 160 }
    ])
  })

  it('hides a lane without changing the remaining visible lanes', () => {
    const ui = useUiStore()
    ui.addTrackAutomationLane('track-1', 'filter')
    ui.addTrackAutomationLane('track-1', 'pan')
    ui.setSelectedAutomationPoint({ trackId: 'track-1', paramId: 'pan', index: 1 })

    ui.removeTrackAutomationLane('track-1', 'pan')

    expect(ui.automationLanes['track-1']?.map((lane) => lane.paramId)).toEqual(['filter'])
    expect(ui.selectedAutomationPoint).toBeNull()
  })

  it('clamps lane resizing at 80 px', () => {
    const ui = useUiStore()
    ui.addTrackAutomationLane('track-1', 'filter')

    ui.setTrackAutomationLaneHeight('track-1', 'filter', 1)

    expect(ui.automationLanes['track-1']?.[0]?.heightPx).toBe(80)
  })

  it('bumps the lane revision when a visible parameter changes', () => {
    const ui = useUiStore()
    ui.addTrackAutomationLane('track-1', 'filter')
    const revision = ui.automationLaneRevision

    ui.setTrackAutomationLaneParam('track-1', 'filter', 'pan')

    expect(ui.automationLaneRevision).toBe(revision + 1)
    expect(ui.automationLanes['track-1']?.[0]?.paramId).toBe('pan')
  })

  it('persists discrete edits immediately and a resized lane only when committed', () => {
    const ui = useUiStore()

    ui.addTrackAutomationLane('track-1', 'filter')
    expect(sendBridge).toHaveBeenLastCalledWith('TRACK_SET_AUTOMATION_LANE_VIEW', {
      trackId: 'track-1',
      lanes: [{ paramId: 'filter', heightPx: 80 }]
    })

    vi.clearAllMocks()
    ui.setTrackAutomationLaneHeight('track-1', 'filter', 160)
    expect(sendBridge).not.toHaveBeenCalled()

    ui.persistTrackAutomationLaneView('track-1')
    expect(sendBridge).toHaveBeenCalledWith('TRACK_SET_AUTOMATION_LANE_VIEW', {
      trackId: 'track-1',
      lanes: [{ paramId: 'filter', heightPx: 160 }]
    })
  })

  it('restores ordered lane views without sending another bridge mutation', () => {
    const ui = useUiStore()

    ui.applyTrackAutomationLaneViews({
      'track-1': [
        { paramId: 'pan', heightPx: 160 },
        { paramId: 'filter', heightPx: 80 }
      ]
    })

    expect(ui.automationLanes['track-1']).toEqual([
      { paramId: 'pan', heightPx: 160 },
      { paramId: 'filter', heightPx: 80 }
    ])
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('persists and restores timeline selection view state without a snapshot echo', () => {
    const ui = useUiStore()

    ui.setTimelineSelection({ startMs: 1000, endMs: 2500 })
    ui.setLoopTimelineSelection(true)
    ui.persistTimelineSelectionView()

    expect(sendBridge).toHaveBeenCalledWith('PROJECT_SET_VIEW', {
      timelineSelection: { startMs: 1000, endMs: 2500 },
      loopTimelineSelection: true
    })

    vi.clearAllMocks()
    ui.applyTimelineSelectionView({ startMs: 3000, endMs: 4500 }, false)

    expect(ui.timelineSelection).toEqual({ startMs: 3000, endMs: 4500 })
    expect(ui.loopTimelineSelection).toBe(false)
    expect(sendBridge).not.toHaveBeenCalled()
  })
})
