import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleMidiControl,
  resetMidiControllerActionsForTests
} from '@/lib/midi/midiControllerActions'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'

const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function seedProject(durationMs = 10_000): void {
  const project = useProjectStore()
  project.tracks = [{ id: 't1', lengthMs: durationMs }] as typeof project.tracks
}

describe('MIDI controller actions', () => {
  let animationFrame: FrameRequestCallback | null

  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    animationFrame = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    resetMidiControllerActionsForTests()
  })

  it('toggles playback from either deck Play button', () => {
    seedProject()
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'playPause',
      deck: 2,
      pressed: true
    })

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_PLAY')
    expect(useTransportStore().isPlaying).toBe(true)
  })

  it('uses Cue and Shift+Cue for marker navigation', () => {
    seedProject()
    const project = useProjectStore()
    const transport = useTransportStore()
    project.markers = [{ positionMs: 1000 }, { positionMs: 3000 }] as typeof project.markers
    transport.positionMs = 2000

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'previousMarker',
      deck: 1,
      pressed: true
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 1000 })

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'button',
      control: 'nextMarker',
      deck: 1,
      pressed: true
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 3000 })
  })

  it('coalesces jog movement into smooth timeline seeks', () => {
    seedProject()
    const transport = useTransportStore()
    const ui = useUiStore()
    transport.positionMs = 2000
    const scrollTo = vi.spyOn(ui, 'requestTimelineScrollToPosition')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 2
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: -1
    })

    expect(sendMock).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
    animationFrame?.(0)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2009 })
    expect(scrollTo).toHaveBeenCalledWith(2009)
  })

  it('leaves the reserved crossfader without an operational audio command', () => {
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'absolute',
      control: 'crossfader',
      deck: null,
      value: 0.25
    })

    expect(sendMock).not.toHaveBeenCalled()
  })
})
