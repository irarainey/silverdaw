import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTransportSkip } from '@/lib/transport/useTransportSkip'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'

const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function seedTrackLength(lengthMs: number): void {
  const project = useProjectStore()
  project.tracks = [{ id: 't1', lengthMs } as unknown as (typeof project.tracks)[number]]
}

describe('useTransportSkip', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('skip-back (timeline mode) rewinds to the start and resets the view', () => {
    const transport = useTransportStore()
    const project = useProjectStore()
    const ui = useUiStore()
    ui.skipButtonTarget = 'timelineEnds'
    const setPosition = vi.spyOn(transport, 'setPosition')
    const { onSkipBack } = useTransportSkip()

    onSkipBack()

    expect(project.viewScrollX).toBe(0)
    expect(setPosition).toHaveBeenCalledWith(0)
    expect(sendMock).toHaveBeenCalledWith('PROJECT_SET_VIEW', { scrollX: 0 })
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 0 })
  })

  it('skip-back (marker mode) seeks to the nearest earlier marker', () => {
    const transport = useTransportStore()
    const project = useProjectStore()
    const ui = useUiStore()
    ui.skipButtonTarget = 'markers'
    project.markers = [{ positionMs: 1000 }, { positionMs: 3000 }] as typeof project.markers
    transport.positionMs = 3500
    const scrollTo = vi.spyOn(ui, 'requestTimelineScrollToPosition')
    const { onSkipBack } = useTransportSkip()

    onSkipBack()

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 3000 })
    expect(scrollTo).toHaveBeenCalledWith(3000)
  })

  it('play toggles to pause when already playing', () => {
    const transport = useTransportStore()
    transport.isPlaying = true
    const setState = vi.spyOn(transport, 'setPlaybackState')
    const { onPlay } = useTransportSkip()

    onPlay()

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_PAUSE')
    expect(setState).toHaveBeenCalledWith(false)
  })

  it('play starts playback when stopped before the project end', () => {
    const transport = useTransportStore()
    transport.isPlaying = false
    seedTrackLength(5000)
    transport.positionMs = 0
    const setState = vi.spyOn(transport, 'setPlaybackState')
    const { onPlay } = useTransportSkip()

    onPlay()

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_PLAY')
    expect(setState).toHaveBeenCalledWith(true)
  })

  it('play is a no-op when parked at the project end', () => {
    const transport = useTransportStore()
    transport.isPlaying = false
    seedTrackLength(1000)
    transport.positionMs = 1000
    const { onPlay } = useTransportSkip()

    onPlay()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('skip-forward (timeline mode) seeks to the project end and scrolls the view there', () => {
    const ui = useUiStore()
    ui.skipButtonTarget = 'timelineEnds'
    seedTrackLength(4000)
    const scrollToEdge = vi.spyOn(ui, 'requestTimelineScroll')
    const { onSkipForward } = useTransportSkip()

    onSkipForward()

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 4000 })
    expect(scrollToEdge).toHaveBeenCalledWith('end')
  })

  it('skip-forward (marker mode) seeks to the next marker', () => {
    const transport = useTransportStore()
    const project = useProjectStore()
    const ui = useUiStore()
    ui.skipButtonTarget = 'markers'
    project.markers = [{ positionMs: 2000 }] as typeof project.markers
    transport.positionMs = 500
    const { onSkipForward } = useTransportSkip()

    onSkipForward()

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2000 })
  })

  it('skip-forward (marker mode) is a no-op when there is nowhere to go', () => {
    const transport = useTransportStore()
    const project = useProjectStore()
    const ui = useUiStore()
    ui.skipButtonTarget = 'markers'
    project.markers = [] as typeof project.markers
    transport.positionMs = 10_000
    const { onSkipForward } = useTransportSkip()

    onSkipForward()

    expect(sendMock).not.toHaveBeenCalled()
  })
})
