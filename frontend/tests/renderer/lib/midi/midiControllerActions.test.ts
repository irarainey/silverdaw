import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleMidiControl,
  resetMidiControllerActionsForTests,
  suspendMidiControllerActions
} from '@/lib/midi/midiControllerActions'
import { useProjectStore } from '@/stores/projectStore'
import type { Clip } from '@/stores/projectTypes'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function seedProject(durationMs = 10_000): void {
  const project = useProjectStore()
  project.tracks = [
    { id: 't1', lengthMs: durationMs, volume: 1 },
    { id: 't2', lengthMs: durationMs, volume: 1 },
    { id: 't3', lengthMs: durationMs, volume: 1 }
  ] as typeof project.tracks
}

function seedTrackClips(): void {
  const project = useProjectStore()
  const clip = (id: string, startMs: number): Clip => ({
    id,
    trackId: 't1',
    libraryItemId: `library-${id}`,
    filePath: `${id}.wav`,
    fileName: `${id}.wav`,
    startMs,
    inMs: 0,
    durationMs: 1000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false
  })
  project.tracks = [
    {
      id: 't1',
      lengthMs: 10_000,
      volume: 1,
      clipIds: ['late', 'early', 'middle']
    }
  ] as typeof project.tracks
  project.clips = {
    late: clip('late', 7000),
    early: clip('early', 1000),
    middle: clip('middle', 4000)
  }
  project.selectedTrackId = 't1'
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

  it('holds playing transport on jog touch and resumes on release', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'jogTouch',
      deck: 2,
      pressed: true
    })

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_PAUSE')
    expect(transport.isPlaying).toBe(true)
    expect(transport.isPlaybackHeld).toBe(true)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'button',
      control: 'jogTouch',
      deck: 2,
      pressed: false
    })

    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_PLAY')
    expect(transport.isPlaybackHeld).toBe(false)
  })

  it('cancels queued movement and releases platter holds when MIDI is suspended', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'jogTouch',
      deck: 1,
      pressed: true
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 10
    })

    suspendMidiControllerActions()
    animationFrame?.(0)

    expect(transport.midiPlaybackHoldActive).toBe(false)
    expect(sendMock).toHaveBeenNthCalledWith(1, 'TRANSPORT_PAUSE')
    expect(sendMock).toHaveBeenNthCalledWith(2, 'TRANSPORT_PLAY')
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(transport.positionMs).toBe(0)
  })

  it('cancels an in-progress physical dial catch-up when MIDI is suspended', () => {
    seedProject()
    const project = useProjectStore()

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'absolute',
      control: 'masterVolume',
      deck: null,
      value: 0.2
    })
    expect(project.masterVolume).toBe(1)

    suspendMidiControllerActions()
    animationFrame?.(globalThis.performance.now() + 200)

    expect(project.masterVolume).toBe(1)
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not resume when a held jog reaches the end of the project', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'jogTouch',
      deck: 2,
      pressed: true
    })
    transport.setPosition(10_000)
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'button',
      control: 'jogTouch',
      deck: 2,
      pressed: false
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_PAUSE')
    expect(transport.isPlaying).toBe(false)
    expect(transport.midiPlaybackHoldActive).toBe(false)
  })

  it('waits for every touched deck before resuming playback', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)

    for (const deck of [1, 2] as const) {
      handleMidiControl({
        deviceIdentifier: 'ddj-rb',
        timestampMs: deck,
        kind: 'button',
        control: 'jogTouch',
        deck,
        pressed: true
      })
    }
    expect(sendMock).toHaveBeenCalledTimes(1)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'button',
      control: 'jogTouch',
      deck: 1,
      pressed: false
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(transport.isPlaybackHeld).toBe(true)

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'button',
      control: 'jogTouch',
      deck: 2,
      pressed: false
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_PLAY')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('does not auto-start paused transport or resume after an explicit pause', () => {
    seedProject()
    const transport = useTransportStore()
    const touch = (pressed: boolean, timestampMs: number): void => {
      handleMidiControl({
        deviceIdentifier: 'ddj-rb',
        timestampMs,
        kind: 'button',
        control: 'jogTouch',
        deck: 2,
        pressed
      })
    }

    touch(true, 1)
    touch(false, 2)
    expect(sendMock).not.toHaveBeenCalled()

    transport.setPlaybackState(true)
    touch(true, 3)
    sendMock.mockClear()
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'button',
      control: 'playPause',
      deck: 2,
      pressed: true
    })
    touch(false, 5)

    expect(transport.isPlaying).toBe(false)
    expect(transport.isPlaybackHeld).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('can re-arm playback while held and resume on release', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)
    const control = (controlName: 'jogTouch' | 'playPause', pressed: boolean, timestampMs: number): void => {
      handleMidiControl({
        deviceIdentifier: 'ddj-rb',
        timestampMs,
        kind: 'button',
        control: controlName,
        deck: 2,
        pressed
      })
    }

    control('jogTouch', true, 1)
    control('playPause', true, 2)
    control('playPause', true, 3)
    control('jogTouch', false, 4)

    expect(transport.isPlaying).toBe(true)
    expect(transport.midiPlaybackHoldActive).toBe(false)
    expect(sendMock).toHaveBeenNthCalledWith(1, 'TRANSPORT_PAUSE')
    expect(sendMock).toHaveBeenNthCalledWith(2, 'TRANSPORT_PLAY')
  })

  it('waits for held platters on other devices before resuming', () => {
    seedProject()
    const transport = useTransportStore()
    transport.setPlaybackState(true)
    const touch = (deviceIdentifier: string, pressed: boolean, timestampMs: number): void => {
      handleMidiControl({
        deviceIdentifier,
        timestampMs,
        kind: 'button',
        control: 'jogTouch',
        deck: 1,
        pressed
      })
    }

    touch('ddj-rb', true, 1)
    touch('second-controller', true, 2)
    touch('ddj-rb', false, 3)
    expect(sendMock).toHaveBeenCalledTimes(1)

    touch('second-controller', false, 4)
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_PLAY')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('uses playback Cue and Shift+Cue for marker navigation', () => {
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
      deck: 2,
      pressed: true
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 3000 })
  })

  it('keeps normal jog movement free', () => {
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
      value: 10
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: -2
    })

    expect(sendMock).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
    animationFrame?.(0)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2112 })
    expect(scrollTo).toHaveBeenCalledWith(2112)
  })

  it('auditions audio when held scrub audio is enabled for the device', () => {
    seedProject()
    const transport = useTransportStore()
    const midiDevices = useMidiDeviceStore()
    transport.positionMs = 2000
    transport.beginMidiPlaybackHold('ddj-rb:1')
    midiDevices.applyDevicePreferences({
      'ddj-rb': {
        scrubAudioEnabled: true,
        crossfaderDirection: 'leftToRight'
      }
    })

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: -2
    })
    animationFrame?.(0)

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SCRUB', {
      positionMs: 1972,
      deltaMs: -28
    })
    expect(sendMock).not.toHaveBeenCalledWith('TRANSPORT_PLAY')
    expect(transport.positionMs).toBe(1972)
  })

  it('moves silently when held scrub audio has no device override', () => {
    seedProject()
    const transport = useTransportStore()
    transport.positionMs = 2000
    transport.beginMidiPlaybackHold('ddj-rb:1')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 2
    })
    animationFrame?.(0)

    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2028 })
    expect(sendMock).not.toHaveBeenCalledWith('TRANSPORT_SCRUB', expect.anything())
  })

  it('snaps jog movement to project ruler subdivisions while Sync is held', () => {
    seedProject()
    const transport = useTransportStore()
    transport.positionMs = 2000
    useMidiDeviceStore().syncPressed[1] = true

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 1
    })

    animationFrame?.(0)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2100 })
  })

  it('snaps backward to the preceding ruler line and stops at the timeline start', () => {
    seedProject()
    const transport = useTransportStore()
    transport.positionMs = 2000
    useMidiDeviceStore().syncPressed[1] = true

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: -8
    })
    animationFrame?.(0)
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 1950 })

    sendMock.mockClear()
    transport.positionMs = 0
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: -8
    })
    animationFrame?.(0)
    expect(sendMock).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })

  it('limits accelerated jog input to one adjacent ruler line per update while Sync is held', () => {
    seedProject()
    const transport = useTransportStore()
    transport.positionMs = 2000
    useMidiDeviceStore().syncPressed[1] = true

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 12
    })

    animationFrame?.(0)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2100 })
  })

  it('gives shifted jog search faster free movement than normal jog', () => {
    seedProject()
    const transport = useTransportStore()
    transport.positionMs = 2000

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'jogSearch',
      deck: 1,
      value: 2
    })
    animationFrame?.(0)
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 2256 })

    sendMock.mockClear()
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'jogScratch',
      deck: 1,
      value: 2
    })
    animationFrame?.(10)
    expect(sendMock).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2284 })
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

  it('browses tracks and reveals each new selection', () => {
    seedProject()
    const project = useProjectStore()
    const ui = useUiStore()
    project.selectedTrackId = 't1'
    const reveal = vi.spyOn(ui, 'requestRevealTrack')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'browseTracks',
      deck: null,
      value: 1
    })

    expect(project.selectedTrackId).toBe('t2')
    expect(reveal).toHaveBeenCalledWith('t2')
  })

  it('moves one track per Browse event and starts at track one', () => {
    seedProject()
    const project = useProjectStore()
    project.selectedTrackId = null

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'browseTracks',
      deck: null,
      value: -1
    })
    expect(project.selectedTrackId).toBe('t1')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'browseTracks',
      deck: null,
      value: -4
    })
    expect(project.selectedTrackId).toBe('t1')
  })

  it('uses the standard zoom step for Shift+Browse in both directions', () => {
    const ui = useUiStore()
    const zoom = vi.spyOn(ui, 'requestTimelineZoom')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'relative',
      control: 'timelineZoom',
      deck: null,
      value: 2
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'timelineZoom',
      deck: null,
      value: -1
    })

    expect(zoom).toHaveBeenNthCalledWith(1, 'in')
    expect(zoom).toHaveBeenNthCalledWith(2, 'out')
  })

  it('enters clip Browse mode, navigates chronologically, and returns to the track', () => {
    seedTrackClips()
    const project = useProjectStore()
    const ui = useUiStore()
    const revealTrack = vi.spyOn(ui, 'requestRevealTrack')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'browsePress',
      deck: null,
      pressed: true
    })
    expect(project.selectedClipId).toBe('early')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'browseTracks',
      deck: null,
      value: 1
    })
    expect(project.selectedClipId).toBe('middle')
    expect(project.selectedClipIds).toEqual(new Set(['middle']))
    expect(ui.timelineScrollRequest).toMatchObject({ positionMs: 4000 })

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'button',
      control: 'browsePress',
      deck: null,
      pressed: true
    })
    expect(project.selectedClipId).toBeNull()
    expect(project.selectedClipIds.size).toBe(0)
    expect(project.selectedTrackId).toBe('t1')
    expect(revealTrack).toHaveBeenCalledWith('t1')
  })

  it('extends clip selection with Shift+Browse without zooming', () => {
    seedTrackClips()
    const project = useProjectStore()
    const ui = useUiStore()
    const zoom = vi.spyOn(ui, 'requestTimelineZoom')

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'browsePress',
      deck: null,
      pressed: true
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'relative',
      control: 'timelineZoom',
      deck: null,
      value: -1
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'relative',
      control: 'timelineZoom',
      deck: null,
      value: -1
    })

    expect(project.selectedClipId).toBe('early')
    expect(project.selectedClipIds).toEqual(new Set(['early', 'middle', 'late']))
    expect(zoom).not.toHaveBeenCalled()
  })

  it('jumps to and deletes chronological marker slots from Hot Cue pads', () => {
    seedProject()
    const project = useProjectStore()
    project.markers = [
      { id: 'early', positionMs: 1000 },
      { id: 'late', positionMs: 3000 }
    ] as typeof project.markers

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'markerJump',
      deck: 1,
      pad: 2,
      pressed: true
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 3000 })

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'button',
      control: 'markerJump',
      deck: 2,
      pad: 2,
      pressed: true
    })
    expect(sendMock).toHaveBeenLastCalledWith('TRANSPORT_SEEK', { positionMs: 3000 })

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'button',
      control: 'markerToggle',
      deck: 2,
      pad: 1,
      pressed: true
    })
    expect(project.markers.map((marker) => marker.id)).toEqual(['late'])
    expect(sendMock).toHaveBeenLastCalledWith('PROJECT_MARKER_REMOVE', { markerId: 'early' })

    useTransportStore().positionMs = 2000
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'button',
      control: 'markerToggle',
      deck: 1,
      pad: 2,
      pressed: true
    })
    expect(project.markers.map((marker) => marker.positionMs)).toEqual([2000, 3000])
  })

  it('anchors mixer controls to current values before applying movement', () => {
    seedProject()
    const project = useProjectStore()
    project.selectedTrackId = 't2'
    const ui = useUiStore()

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'absolute',
      control: 'trackGain',
      deck: 1,
      value: 0.2
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'absolute',
      control: 'toneTreble',
      deck: 2,
      value: 0.75
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'absolute',
      control: 'filter',
      deck: 1,
      value: 0.25
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'absolute',
      control: 'masterVolume',
      deck: null,
      value: 1
    })

    let selected = project.tracks.find((track) => track.id === 't2')
    expect(selected?.volume).toBe(1)
    expect(selected?.toneTrebleDb).toBeUndefined()
    expect(selected?.toneFilter).toBeUndefined()
    expect(project.masterVolume).toBe(1)
    expect(project.fxPanelOpen).toBe(true)
    expect(project.fxTab).toBe('track')
    expect(ui.libraryPanelCollapsed).toBe(false)
    expect(sendMock).not.toHaveBeenCalledWith('TRACK_GAIN', expect.anything())
    expect(sendMock).not.toHaveBeenCalledWith('TRACK_SET_TONE', expect.anything())
    expect(sendMock).not.toHaveBeenCalledWith('PROJECT_SET_MASTER_VOLUME', expect.anything())

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 5,
      kind: 'absolute',
      control: 'trackGain',
      deck: 1,
      value: 0.3
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 6,
      kind: 'absolute',
      control: 'toneTreble',
      deck: 2,
      value: 0.85
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 7,
      kind: 'absolute',
      control: 'filter',
      deck: 1,
      value: 0.15
    })
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 8,
      kind: 'absolute',
      control: 'masterVolume',
      deck: null,
      value: 0.9
    })
    animationFrame?.(globalThis.performance.now() + 200)

    selected = project.tracks.find((track) => track.id === 't2')
    expect(selected?.volume).toBeLessThan(1)
    expect(selected?.toneTrebleDb).toBeGreaterThan(0)
    expect(selected?.toneFilter).toBeLessThan(0)
    expect(project.masterVolume).toBeLessThan(1)
    expect(project.tracks.find((track) => track.id === 't1')?.toneTrebleDb).toBeUndefined()

    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 9,
      kind: 'absolute',
      control: 'toneTreble',
      deck: 2,
      value: 0.9
    })
    expect(selected?.toneTrebleDb).toBeGreaterThan(9)

    if (selected) selected.toneTrebleDb = -5
    handleMidiControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 10,
      kind: 'absolute',
      control: 'toneTreble',
      deck: 2,
      value: 0.8
    })
    expect(selected?.toneTrebleDb).toBe(-5)
    animationFrame?.(globalThis.performance.now() + 200)
    expect(selected?.toneTrebleDb).toBeGreaterThan(0)
  })
})
