import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore } from '@/stores/previewStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

describe('previewStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('load sends PREVIEW_LOAD and seeds local state immediately', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 500, 2_000)

    expect(preview.itemId).toBe('lib1')
    expect(preview.inMs).toBe(500)
    expect(preview.durationMs).toBe(2_000)
    expect(preview.positionMs).toBe(0)
    expect(preview.isPlaying).toBe(false)
    expect(preview.isLoaded).toBe(false)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: 'lib1',
      inMs: 500,
      durationMs: 2_000
    })
  })

  it('loadFile auditions an un-imported path and clears any loaded item', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 500, 2_000)
    sendMock.mockClear()

    preview.loadFile('C:\\music\\Track.mp3')

    expect(preview.itemId).toBeNull()
    expect(preview.filePath).toBe('C:\\music\\Track.mp3')
    expect(preview.inMs).toBe(0)
    expect(preview.durationMs).toBe(0)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: 'C:\\music\\Track.mp3',
      inMs: 0,
      durationMs: 0
    })
  })

  it('loadFile with autoPlay starts playback once the backend acks the load', () => {
    const preview = usePreviewStore()
    preview.loadFile('C:\\music\\Track.mp3', true)
    sendMock.mockClear()

    // Loading alone must not play — the engine has nothing ready yet.
    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_PLAY')

    preview.applyState({
      isPlaying: false,
      isLoaded: true,
      durationMs: 3_000,
      generation: 1
    })

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_PLAY')
    expect(preview.pendingPlay).toBe(false)
  })

  it('loadFile without autoPlay stays paused when the load is acked', () => {
    const preview = usePreviewStore()
    preview.loadFile('C:\\music\\Track.mp3')
    sendMock.mockClear()

    preview.applyState({
      isPlaying: false,
      isLoaded: true,
      durationMs: 3_000,
      generation: 1
    })

    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_PLAY')
  })

  it('a failed load does not leave a pending play armed for the next source', () => {
    const preview = usePreviewStore()
    preview.loadFile('C:\\music\\Missing.mp3', true)

    preview.applyState({
      isPlaying: false,
      isLoaded: false,
      durationMs: 0,
      generation: 1
    })
    sendMock.mockClear()

    expect(preview.pendingPlay).toBe(false)

    // A later library preview must not inherit the stale auto-play.
    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: false,
      isLoaded: true,
      durationMs: 1_000,
      generation: 2
    })
    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_PLAY')
  })

  it('load clears a file audition so the two preview sources cannot both look active', () => {    const preview = usePreviewStore()
    preview.loadFile('C:\\music\\Track.mp3')
    preview.load('lib1', 0, 0)

    expect(preview.filePath).toBeNull()
    expect(preview.itemId).toBe('lib1')
  })

  it('unload releases a file audition even with no library item loaded', () => {
    const preview = usePreviewStore()
    preview.loadFile('C:\\music\\Track.mp3')
    sendMock.mockClear()

    preview.unload()

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_UNLOAD')
    expect(preview.filePath).toBeNull()
  })

  it('includes initial warp settings in PREVIEW_LOAD so first play is warped', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 500, 2_000, {
      warpEnabled: true,
      warpMode: 'rhythmic',
      tempoRatio: 0.85,
      semitones: 1,
      cents: 25
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: 'lib1',
      inMs: 500,
      durationMs: 2_000,
      warpEnabled: true,
      warpMode: 'rhythmic',
      tempoRatio: 0.85,
      semitones: 1,
      cents: 25
    })
  })

  it('applyState updates state and gates stale generations', () => {
    const preview = usePreviewStore()
    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: false,
      isLoaded: true,
      durationMs: 2_000,
      generation: 5
    })
    expect(preview.isLoaded).toBe(true)
    expect(preview.durationMs).toBe(2_000)
    expect(preview.generation).toBe(5)

    // Stale generation should be ignored.
    preview.applyState({
      isPlaying: true,
      isLoaded: false,
      durationMs: 999,
      generation: 4
    })
    expect(preview.isLoaded).toBe(true)
    expect(preview.durationMs).toBe(2_000)
  })

  it('seek clamps to selection length and sends PREVIEW_SEEK', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    sendMock.mockClear()

    preview.seek(2_000)

    expect(preview.positionMs).toBe(1_000)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_SEEK', { positionMs: 1_000 })
  })

  it('does not send live warp updates until the preview is loaded', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    sendMock.mockClear()

    preview.setWarp({ warpEnabled: false, tempoRatio: null, semitones: 0, cents: 0 })

    expect(sendMock).not.toHaveBeenCalled()

    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: false,
      isLoaded: true,
      durationMs: 1_000,
      generation: 1
    })
    preview.setWarp({ warpEnabled: true, warpMode: 'rhythmic', tempoRatio: 1.2 })

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_SET_WARP', {
      warpEnabled: true,
      warpMode: 'rhythmic',
      tempoRatio: 1.2,
      semitones: undefined,
      cents: undefined
    })
  })

  it('unload sends PREVIEW_UNLOAD and clears local state', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: true,
      isLoaded: true,
      durationMs: 1_000,
      generation: 1
    })
    sendMock.mockClear()

    preview.unload()

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_UNLOAD')
    expect(preview.itemId).toBeNull()
    expect(preview.isLoaded).toBe(false)
    expect(preview.isPlaying).toBe(false)
  })

  it('does not send envelope updates until the preview is loaded, then sends PREVIEW_SET_ENVELOPE', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    sendMock.mockClear()

    const points = [
      { timeMs: 0, gain: 1 },
      { timeMs: 1_000, gain: 0.5 }
    ]
    preview.setEnvelope(points)
    expect(sendMock).not.toHaveBeenCalled()

    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: false,
      isLoaded: true,
      durationMs: 1_000,
      generation: 1
    })
    preview.setEnvelope(points)

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_SET_ENVELOPE', { points })
  })

  it('setLoop sends PREVIEW_SET_LOOP once per distinct window and disarms with null', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: false,
      isLoaded: true,
      durationMs: 1_000,
      generation: 1
    })
    sendMock.mockClear()

    preview.setLoop({ startMs: 100, endMs: 400 })
    preview.setLoop({ startMs: 100, endMs: 400 })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_SET_LOOP', {
      enabled: true,
      startMs: 100,
      endMs: 400
    })
    expect(preview.loopEnabled).toBe(true)

    preview.setLoop(null)
    expect(sendMock).toHaveBeenLastCalledWith('PREVIEW_SET_LOOP', {
      enabled: false,
      startMs: 0,
      endMs: 0
    })
    expect(preview.loopEnabled).toBe(false)
  })

  it('setLoop does nothing while the preview is not loaded', () => {
    const preview = usePreviewStore()
    preview.load('lib1', 0, 1_000)
    sendMock.mockClear()

    preview.setLoop({ startMs: 0, endMs: 500 })

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('applyEnded resets isPlaying without bumping older state', () => {
    const preview = usePreviewStore()
    preview.applyState({
      libraryItemId: 'lib1',
      isPlaying: true,
      isLoaded: true,
      durationMs: 1_000,
      generation: 3
    })

    preview.applyEnded({ generation: 2 })
    expect(preview.isPlaying).toBe(true)

    preview.applyEnded({ generation: 3 })
    expect(preview.isPlaying).toBe(false)
    expect(preview.positionMs).toBe(0)
  })
})
