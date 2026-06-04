import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineRulerInteraction, type TimelineRulerInteractionDeps } from '@/lib/timeline/useTimelineRulerInteraction'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audio', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'src',
    kind: 'audio-file',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 5_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    ...overrides
  } as LibraryItem
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId: 'src',
    filePath: 'C:\\src.wav',
    fileName: 'src.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 1_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

function makeDeps(
  hitRegions: ClipHitRegion[],
  overrides: Partial<TimelineRulerInteractionDeps> = {}
): {
  deps: TimelineRulerInteractionDeps
  startClipRename: ReturnType<typeof vi.fn>
  openClipEditor: ReturnType<typeof vi.fn>
} {
  const startClipRename = vi.fn()
  const openClipEditor = vi.fn()
  const deps: TimelineRulerInteractionDeps = {
    getHostRect: () => ({ left: 0, top: 0, width: 1000, height: 400 }) as DOMRect,
    getScreenWidth: () => 1000,
    headerWidth: () => 200,
    pxPerSecond: () => 100,
    scrollX: () => 0,
    scrollY: () => 0,
    msPerSubBeat: () => 125,
    getClipHitRegions: () => hitRegions,
    startClipRename,
    openClipEditor,
    ...overrides
  }
  return { deps, startClipRename, openClipEditor }
}

function mouse(opts: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    ...opts
  } as unknown as MouseEvent
}

describe('useTimelineRulerInteraction — onDoubleClick', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('ignores non-primary buttons', () => {
    const { deps, startClipRename } = makeDeps([])
    const r = useTimelineRulerInteraction(deps)
    r.onDoubleClick(mouse({ button: 2 }))
    expect(startClipRename).not.toHaveBeenCalled()
  })

  it('double-click on a clip header strip starts a rename', () => {
    useLibraryStore().items = [makeItem()]
    useProjectStore().clips = { 'clip-1': makeClip() }
    const region: ClipHitRegion = { clipId: 'clip-1', x: 200, y: 30, w: 100, h: 60 }
    const { deps, startClipRename } = makeDeps([region])
    const r = useTimelineRulerInteraction(deps)
    // y within the 18px header band at the top of the region.
    r.onDoubleClick(mouse({ clientX: 250, clientY: 35 }))
    expect(startClipRename).toHaveBeenCalledWith('clip-1')
  })

  it('double-click on a clip body opens the editor', () => {
    useLibraryStore().items = [makeItem()]
    useProjectStore().clips = { 'clip-1': makeClip() }
    const region: ClipHitRegion = { clipId: 'clip-1', x: 200, y: 30, w: 100, h: 60 }
    const { deps, openClipEditor } = makeDeps([region])
    const r = useTimelineRulerInteraction(deps)
    // y below the header band but inside the region body.
    r.onDoubleClick(mouse({ clientX: 250, clientY: 70 }))
    expect(openClipEditor).toHaveBeenCalledWith('clip-1')
  })

  it('double-click on an unresolved clip body does not open the editor', () => {
    useLibraryStore().items = [makeItem()]
    useProjectStore().clips = { 'clip-1': makeClip({ unresolved: true }) }
    const region: ClipHitRegion = { clipId: 'clip-1', x: 200, y: 30, w: 100, h: 60 }
    const { deps, openClipEditor } = makeDeps([region])
    const r = useTimelineRulerInteraction(deps)
    r.onDoubleClick(mouse({ clientX: 250, clientY: 70 }))
    expect(openClipEditor).not.toHaveBeenCalled()
  })

  it('double-click on an empty ruler position toggles a marker', () => {
    const project = useProjectStore()
    const spy = vi.spyOn(project, 'toggleMarkerAt')
    const { deps } = makeDeps([])
    const r = useTimelineRulerInteraction(deps)
    // y inside the ruler band (RULER_HEIGHT), x past the header column.
    // worldMs = ((0 + 300 - 200) / 100) * 1000 = 1000 -> snapped to 1000.
    r.onDoubleClick(mouse({ clientX: 300, clientY: 5 }))
    expect(spy).toHaveBeenCalledWith(1000)
  })

  it('double-click on an existing ruler marker removes it', () => {
    const project = useProjectStore()
    // Marker at 1000 ms -> screen x = 200 + (1000/1000)*100 = 300.
    project.toggleMarkerAt(1000)
    const markerId = project.markers[0]?.id
    const spy = vi.spyOn(project, 'removeMarker')
    const { deps } = makeDeps([])
    const r = useTimelineRulerInteraction(deps)
    r.onDoubleClick(mouse({ clientX: 300, clientY: 5 }))
    expect(spy).toHaveBeenCalledWith(markerId)
  })
})
