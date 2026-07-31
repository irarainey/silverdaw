import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useClipEditorPreview, type ClipEditorPreviewDeps } from '@/lib/clipEditor/useClipEditorPreview'
import type { LibraryItem } from '@/stores/libraryStore'
import type { Clip } from '@/stores/projectStore'

function fakePreview() {
  return {
    isLoaded: true,
    isPlaying: false,
    positionMs: 0,
    load: vi.fn(),
    setWarp: vi.fn(),
    setEnvelope: vi.fn(),
    setReversed: vi.fn(),
    seek: vi.fn(),
    setLoop: vi.fn(),
    pause: vi.fn(),
    play: vi.fn()
  }
}

type FakePreview = ReturnType<typeof fakePreview>

function makeDeps(preview: FakePreview, over: Partial<ClipEditorPreviewDeps> = {}): ClipEditorPreviewDeps {
  const entry = { id: 'item-1', tempoRatio: 1, warpEnabled: false } as unknown as LibraryItem
  return {
    preview: preview as unknown as ClipEditorPreviewDeps['preview'],
    isOpen: () => true,
    editorItem: () => entry,
    timelineClip: () => null as Clip | null,
    sourceItem: () => entry,
    editsExistingClip: () => true,
    libraryById: () => ({}),
    projectBpm: () => 120,
    draftProcessorEnabled: () => false,
    draftMode: () => 'rhythmic',
    draftSemitones: () => 0,
    draftCents: () => 0,
    previewTempoRatio: () => undefined,
    committedEnvelopePoints: () => [],
    draftReversed: () => false,
    draftBrake: () => false,
    draftBackspin: () => false,
    viewInMs: () => 0,
    viewDurationMs: () => 1000,
    visibleDurationMs: () => 1000,
    playheadAbsMs: () => 0,
    scrollMs: ref(0),
    hasPlaybackSelection: () => false,
    playbackStartMs: () => 0,
    playbackEndMs: () => 1000,
    loopEnabled: () => false,
    ...over
  }
}

describe('useClipEditorPreview — loadPreviewForView de-dup', () => {
  it('loads once for an unchanged view and re-loads after reset', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview))
    p.loadPreviewForView()
    p.loadPreviewForView()
    expect(preview.load).toHaveBeenCalledTimes(1)
    p.resetPreviewLoadKey()
    p.loadPreviewForView()
    expect(preview.load).toHaveBeenCalledTimes(2)
  })

  it('re-loads when the view window changes', () => {
    const preview = fakePreview()
    let inMs = 0
    const p = useClipEditorPreview(makeDeps(preview, { viewInMs: () => inMs }))
    p.loadPreviewForView()
    inMs = 500
    p.loadPreviewForView()
    expect(preview.load).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a source item', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview, { sourceItem: () => null }))
    p.loadPreviewForView()
    expect(preview.load).not.toHaveBeenCalled()
  })
})

describe('useClipEditorPreview — draft warp debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // The composable calls window.setTimeout; the node test env has no
    // `window`, so point it at globalThis where vi's fake timers live.
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces rapid schedules into a single push after 33ms', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview))
    p.scheduleDraftPreviewWarp()
    p.scheduleDraftPreviewWarp()
    p.scheduleDraftPreviewWarp()
    expect(preview.setWarp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(33)
    expect(preview.setWarp).toHaveBeenCalledTimes(1)
  })

  it('does not schedule when the dialog is closed', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview, { isOpen: () => false }))
    p.scheduleDraftPreviewWarp()
    vi.advanceTimersByTime(33)
    expect(preview.setWarp).not.toHaveBeenCalled()
  })

  it('does not schedule when the preview is not loaded', () => {
    const preview = fakePreview()
    preview.isLoaded = false
    const p = useClipEditorPreview(makeDeps(preview))
    p.scheduleDraftPreviewWarp()
    vi.advanceTimersByTime(33)
    expect(preview.setWarp).not.toHaveBeenCalled()
  })

  it('clearPreviewWarpUpdateTimer cancels a pending push', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview))
    p.scheduleDraftPreviewWarp()
    p.clearPreviewWarpUpdateTimer()
    vi.advanceTimersByTime(33)
    expect(preview.setWarp).not.toHaveBeenCalled()
  })
})

describe('useClipEditorPreview — reverse push', () => {
  it('pushes the current reverse draft to the loaded preview', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(makeDeps(preview, { draftReversed: () => true }))
    p.pushDraftPreviewReversed()
    expect(preview.setReversed).toHaveBeenCalledWith(true)
  })

  it('does not push when the preview is not loaded', () => {
    const preview = fakePreview()
    preview.isLoaded = false
    const p = useClipEditorPreview(makeDeps(preview, { draftReversed: () => true }))
    p.pushDraftPreviewReversed()
    expect(preview.setReversed).not.toHaveBeenCalled()
  })
})

describe('useClipEditorPreview — selection playback bounds', () => {
  it('leaves the wrap to the engine while looping', () => {
    const preview = fakePreview()
    preview.isPlaying = true
    preview.positionMs = 1000
    const p = useClipEditorPreview(
      makeDeps(preview, {
        hasPlaybackSelection: () => true,
        loopEnabled: () => true,
        playbackStartMs: () => 200,
        playbackEndMs: () => 1000
      })
    )
    p.enforceSelectionPlaybackBounds()
    expect(preview.seek).not.toHaveBeenCalled()
    expect(preview.pause).not.toHaveBeenCalled()
  })

  it('pauses and rewinds at the end when not looping', () => {
    const preview = fakePreview()
    preview.isPlaying = true
    preview.positionMs = 1000
    const p = useClipEditorPreview(
      makeDeps(preview, {
        hasPlaybackSelection: () => true,
        loopEnabled: () => false,
        playbackStartMs: () => 200,
        playbackEndMs: () => 1000
      })
    )
    p.enforceSelectionPlaybackBounds()
    expect(preview.pause).toHaveBeenCalledTimes(1)
    expect(preview.seek).toHaveBeenCalledWith(200)
  })

  it('does not bound playback without a selection when not looping', () => {
    const preview = fakePreview()
    preview.isPlaying = true
    preview.positionMs = 1000
    const p = useClipEditorPreview(
      makeDeps(preview, {
        hasPlaybackSelection: () => false,
        loopEnabled: () => false,
        playbackStartMs: () => 0,
        playbackEndMs: () => 1000
      })
    )
    p.enforceSelectionPlaybackBounds()
    expect(preview.pause).not.toHaveBeenCalled()
    expect(preview.seek).not.toHaveBeenCalled()
  })
})

describe('useClipEditorPreview — engine loop window', () => {
  it('arms the selection window in preview-relative ms', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(
      makeDeps(preview, {
        loopEnabled: () => true,
        hasPlaybackSelection: () => true,
        viewInMs: () => 500,
        playbackStartMs: () => 700,
        playbackEndMs: () => 1200
      })
    )
    p.syncPreviewLoop()
    expect(preview.setLoop).toHaveBeenCalledWith({ startMs: 200, endMs: 700 })
  })

  it('arms the whole window when there is no selection', () => {
    const preview = fakePreview()
    const p = useClipEditorPreview(
      makeDeps(preview, {
        loopEnabled: () => true,
        hasPlaybackSelection: () => false,
        playbackStartMs: () => 0,
        playbackEndMs: () => 1000
      })
    )
    p.syncPreviewLoop()
    expect(preview.setLoop).toHaveBeenCalledWith({ startMs: 0, endMs: 1000 })
  })

  it('disarms when loop is off or the dialog is closed', () => {
    const off = fakePreview()
    useClipEditorPreview(makeDeps(off, { loopEnabled: () => false })).syncPreviewLoop()
    expect(off.setLoop).toHaveBeenCalledWith(null)

    const closed = fakePreview()
    useClipEditorPreview(
      makeDeps(closed, { isOpen: () => false, loopEnabled: () => true })
    ).syncPreviewLoop()
    expect(closed.setLoop).toHaveBeenCalledWith(null)
  })

  it('does nothing while the preview is not loaded', () => {
    const preview = fakePreview()
    preview.isLoaded = false
    const p = useClipEditorPreview(makeDeps(preview, { loopEnabled: () => true }))
    p.syncPreviewLoop()
    expect(preview.setLoop).not.toHaveBeenCalled()
  })
})
