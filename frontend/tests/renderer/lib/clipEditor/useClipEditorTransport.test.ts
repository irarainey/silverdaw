import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useClipEditorTransport } from '@/lib/clipEditor/useClipEditorTransport'
import { usePreviewStore } from '@/stores/previewStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

interface Bounds {
  hasPlaybackSelection: boolean
  editsExistingClip: boolean
  playbackStartMs: number
  playbackEndMs: number
  viewInMs: number
  visibleDurationMs: number
  maxScrollMs: number
}

function setup(bounds: Partial<Bounds> = {}) {
  const preview = usePreviewStore()
  const loopEnabled = ref(false)
  const scrollMs = ref(0)
  const b: Bounds = {
    hasPlaybackSelection: false,
    editsExistingClip: false,
    playbackStartMs: 0,
    playbackEndMs: 1000,
    viewInMs: 0,
    visibleDurationMs: 500,
    maxScrollMs: 500,
    ...bounds
  }
  const t = useClipEditorTransport({
    preview,
    loopEnabled,
    scrollMs,
    hasPlaybackSelection: () => b.hasPlaybackSelection,
    editsExistingClip: () => b.editsExistingClip,
    playbackStartMs: () => b.playbackStartMs,
    playbackEndMs: () => b.playbackEndMs,
    viewInMs: () => b.viewInMs,
    visibleDurationMs: () => b.visibleDurationMs,
    maxScrollMs: () => b.maxScrollMs
  })
  return { preview, loopEnabled, scrollMs, t }
}

describe('useClipEditorTransport', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('onTogglePlay does nothing until the preview voice is loaded', () => {
    const { preview, t } = setup()
    preview.isLoaded = false
    const play = vi.spyOn(preview, 'play').mockImplementation(() => {})
    t.onTogglePlay()
    expect(play).not.toHaveBeenCalled()
  })

  it('onTogglePlay pauses when already playing', () => {
    const { preview, t } = setup()
    preview.isLoaded = true
    preview.isPlaying = true
    const pause = vi.spyOn(preview, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(preview, 'play').mockImplementation(() => {})
    t.onTogglePlay()
    expect(pause).toHaveBeenCalledOnce()
    expect(play).not.toHaveBeenCalled()
  })

  it('onTogglePlay seeks to the selection start when out of bounds, then plays', () => {
    const { preview, t } = setup({
      hasPlaybackSelection: true,
      playbackStartMs: 200,
      playbackEndMs: 800,
      viewInMs: 0
    })
    preview.isLoaded = true
    preview.isPlaying = false
    preview.positionMs = 50 // before startRel(200) -> should seek
    const seek = vi.spyOn(preview, 'seek').mockImplementation(() => {})
    const play = vi.spyOn(preview, 'play').mockImplementation(() => {})
    t.onTogglePlay()
    expect(seek).toHaveBeenCalledWith(200)
    expect(play).toHaveBeenCalledOnce()
  })

  it('onTogglePlay does not re-seek when already inside the selection', () => {
    const { preview, t } = setup({
      hasPlaybackSelection: true,
      playbackStartMs: 200,
      playbackEndMs: 800
    })
    preview.isLoaded = true
    preview.isPlaying = false
    preview.positionMs = 400
    const seek = vi.spyOn(preview, 'seek').mockImplementation(() => {})
    const play = vi.spyOn(preview, 'play').mockImplementation(() => {})
    t.onTogglePlay()
    expect(seek).not.toHaveBeenCalled()
    expect(play).toHaveBeenCalledOnce()
  })

  it('onSkipToStart seeks to the bounded start and scrolls left if needed', () => {
    const { preview, scrollMs, t } = setup({ playbackStartMs: 300, viewInMs: 100 })
    scrollMs.value = 250
    const seek = vi.spyOn(preview, 'seek').mockImplementation(() => {})
    t.onSkipToStart()
    expect(seek).toHaveBeenCalledWith(200) // 300 - 100
    expect(scrollMs.value).toBe(200) // rel < scrollMs -> scroll back
  })

  it('onSkipToEnd seeks near the end and scrolls it on-screen', () => {
    const { preview, scrollMs, t } = setup({
      playbackEndMs: 1000,
      viewInMs: 0,
      visibleDurationMs: 400,
      maxScrollMs: 600
    })
    scrollMs.value = 0
    const seek = vi.spyOn(preview, 'seek').mockImplementation(() => {})
    t.onSkipToEnd()
    expect(seek).toHaveBeenCalledWith(999) // 1000 - 0 - 1
    // end(999) > scrollMs(0)+visDur(400) -> scroll to clamp(999 - 200)=600
    expect(scrollMs.value).toBe(600)
  })

  it('onToggleLoop flips the loop flag', () => {
    const { loopEnabled, t } = setup()
    expect(loopEnabled.value).toBe(false)
    t.onToggleLoop()
    expect(loopEnabled.value).toBe(true)
    t.onToggleLoop()
    expect(loopEnabled.value).toBe(false)
  })
})
