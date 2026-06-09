import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { createTimelineQueries } from '@/lib/timeline/timelineQueries'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import type { GridGeometry } from '@/lib/timeline/useGridGeometry'
import type { Application } from 'pixi.js'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip',
    trackId: 'track-1',
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

function makeQueries(regions: ClipHitRegion[]) {
  const host = ref({
    getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect
  } as unknown as HTMLElement)
  return createTimelineQueries({
    host,
    app: ref(null) as unknown as Readonly<Ref<Application | null>>,
    scrollX: ref(0),
    scrollY: ref(0),
    maxScrollX: computed(() => 0),
    geometry: {} as unknown as GridGeometry,
    getClipHitRegions: () => regions
  })
}

describe('hitTestTrimEdge boundary resolution', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("offers the later clip's left edge just inside its start at a butt-join", () => {
    const project = useProjectStore()
    // Clip A occupies [0,100]px, clip B [100,200]px, sharing the seam at x=100.
    project.clips['a'] = makeClip({ id: 'a', startMs: 0, durationMs: 1_000 })
    project.clips['b'] = makeClip({ id: 'b', startMs: 1_000, inMs: 500, durationMs: 1_000 })
    // B is listed before A so draw-order "last wins" would otherwise pick A.
    const regions: ClipHitRegion[] = [
      { clipId: 'b', x: 100, y: 0, w: 100, h: 50 },
      { clipId: 'a', x: 0, y: 0, w: 100, h: 50 }
    ]
    const q = makeQueries(regions)

    const hit = q.hitTestTrimEdge(103, 25)
    expect(hit?.region.clipId).toBe('b')
    expect(hit?.edge).toBe('left')
  })

  it("prefers the later clip's left edge right at the shared seam", () => {
    const project = useProjectStore()
    project.clips['a'] = makeClip({ id: 'a', startMs: 0, durationMs: 1_000 })
    project.clips['b'] = makeClip({ id: 'b', startMs: 1_000, inMs: 500, durationMs: 1_000 })
    const regions: ClipHitRegion[] = [
      { clipId: 'a', x: 0, y: 0, w: 100, h: 50 },
      { clipId: 'b', x: 100, y: 0, w: 100, h: 50 }
    ]
    const q = makeQueries(regions)

    // Aiming a pixel or two left of the seam still grabs the later clip's start.
    const seamHit = q.hitTestTrimEdge(98, 25)
    expect(seamHit?.region.clipId).toBe('b')
    expect(seamHit?.edge).toBe('left')
  })

  it("offers the previous clip's right edge a few pixels inside its end", () => {
    const project = useProjectStore()
    project.clips['a'] = makeClip({ id: 'a', startMs: 0, durationMs: 1_000 })
    project.clips['b'] = makeClip({ id: 'b', startMs: 1_000, inMs: 500, durationMs: 1_000 })
    const regions: ClipHitRegion[] = [
      { clipId: 'a', x: 0, y: 0, w: 100, h: 50 },
      { clipId: 'b', x: 100, y: 0, w: 100, h: 50 }
    ]
    const q = makeQueries(regions)

    // Deeper inside the previous clip (past the left-bias band) still trims its end.
    const hit = q.hitTestTrimEdge(95, 25)
    expect(hit?.region.clipId).toBe('a')
    expect(hit?.edge).toBe('right')
  })

  it('returns null in the clip body away from any edge', () => {
    const project = useProjectStore()
    project.clips['a'] = makeClip({ id: 'a', startMs: 0, durationMs: 1_000 })
    const regions: ClipHitRegion[] = [{ clipId: 'a', x: 0, y: 0, w: 100, h: 50 }]
    const q = makeQueries(regions)

    expect(q.hitTestTrimEdge(50, 25)).toBeNull()
  })

  it('does not offer a locked clip edge', () => {
    const project = useProjectStore()
    project.clips['a'] = makeClip({ id: 'a', startMs: 0, durationMs: 1_000, locked: true })
    const regions: ClipHitRegion[] = [{ clipId: 'a', x: 0, y: 0, w: 100, h: 50 }]
    const q = makeQueries(regions)

    expect(q.hitTestTrimEdge(2, 25)).toBeNull()
  })
})
