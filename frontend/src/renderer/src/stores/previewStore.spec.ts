import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore } from './previewStore'

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
