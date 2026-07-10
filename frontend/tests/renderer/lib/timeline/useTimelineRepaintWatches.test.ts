import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useTimelineRepaintWatches,
  type TimelineRepaintWatchesDeps
} from '@/lib/timeline/useTimelineRepaintWatches'
import { useProjectStore } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

describe('useTimelineRepaintWatches', () => {
  let scope: EffectScope
  let deps: TimelineRepaintWatchesDeps
  let uuidCounter: number

  async function addTestClip(): Promise<{ clipId: string; trackId: string }> {
    const project = useProjectStore()
    const trackId = project.addTrack()
    const clipId = project.addClipToTrack(trackId, {
      libraryItemId: 'library-1',
      filePath: 'C:\\audio\\test.wav',
      fileName: 'test.wav',
      durationMs: 4_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0.25, 0.5])
    })
    if (!clipId) throw new Error('Failed to create test clip')
    await nextTick()
    vi.mocked(deps.redraw).mockClear()
    vi.mocked(deps.updatePlayhead).mockClear()
    return { clipId, trackId }
  }

  beforeEach(() => {
    uuidCounter = 0
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `uuid-${++uuidCounter}`)
    })
    setActivePinia(createPinia())
    scope = effectScope()
    deps = {
      redraw: vi.fn(),
      updatePlayhead: vi.fn(),
      clampScroll: vi.fn(() => false),
      applyScroll: vi.fn(),
      horizontalRebuildNeeded: vi.fn(() => false),
      scrollX: ref(0),
      scrollY: ref(0),
      headerWidthRef: ref(0)
    }
    scope.run(() => useTimelineRepaintWatches(deps))
  })

  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('rebuilds the timeline and playhead from the scalar timeline revision', async () => {
    const project = useProjectStore()

    project.timelineRevision++
    await nextTick()

    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple mutations made in the same reactive flush', async () => {
    const project = useProjectStore()

    project.timelineRevision++
    project.timelineRevision++
    await nextTick()

    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('repaints after trimming a clip', async () => {
    const project = useProjectStore()
    const { clipId } = await addTestClip()

    project.trimClip(clipId, 250, 100, 3_000)
    await nextTick()

    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('repaints after duplicating or splitting a clip', async () => {
    const project = useProjectStore()
    const { clipId } = await addTestClip()

    expect(project.duplicateClip(clipId)).not.toBeNull()
    await nextTick()
    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)

    vi.mocked(deps.redraw).mockClear()
    vi.mocked(deps.updatePlayhead).mockClear()
    expect(project.splitClipAt(clipId, 2_000)).not.toBeNull()
    await nextTick()
    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('repaints after reordering rows with equal heights', async () => {
    const project = useProjectStore()
    const firstTrackId = project.addTrack()
    const secondTrackId = project.addTrack()
    await nextTick()
    vi.mocked(deps.redraw).mockClear()
    vi.mocked(deps.updatePlayhead).mockClear()

    project.reorderTrack(firstTrackId, 1)
    await nextTick()

    expect(project.tracks.map((track) => track.id)).toEqual([secondTrackId, firstTrackId])
    expect(deps.redraw).toHaveBeenCalledTimes(1)
    expect(deps.updatePlayhead).toHaveBeenCalledTimes(1)
  })
})
