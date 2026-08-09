import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { createTimelineQueries } from '@/lib/timeline/timelineQueries'
import { RULER_HEIGHT } from '@/lib/timeline/constants'
import type { GridGeometry } from '@/lib/timeline/useGridGeometry'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import type { Application } from 'pixi.js'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const HEADER_WIDTH = 100

// One clip filling the first track row, which starts immediately below the ruler.
const REGION: ClipHitRegion = {
  clipId: 'c1',
  x: HEADER_WIDTH,
  y: RULER_HEIGHT,
  w: 400,
  h: 120
} as ClipHitRegion

function makeQueries(scrollY: number) {
  const host = ref({
    getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect
  } as unknown as HTMLElement)
  const app = ref({
    renderer: { screen: { width: 800, height: 400 } }
  }) as unknown as Readonly<Ref<Application | null>>
  const geometry = {
    headerWidth: () => HEADER_WIDTH,
    pxPerSecond: ref(100)
  } as unknown as GridGeometry
  return createTimelineQueries({
    host,
    app,
    scrollX: ref(0),
    scrollY: ref(scrollY),
    maxScrollX: computed(() => 0),
    geometry,
    getClipHitRegions: () => [REGION]
  })
}

// Reported: with the tracks scrolled down, pressing on the ruler to grab the
// playhead started a clip drag instead. The ruler is a fixed overlay that does not
// scroll with the tracks, but clip hit regions are stored in world space, so adding
// `scrollY` to a pointer in the ruler landed it inside whatever row happened to be
// scrolled under that offset. It only behaved while the view sat at the very top.
describe('clip hit tests exclude the ruler band', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const rulerY = RULER_HEIGHT / 2

  it('hits a clip in the track area whatever the vertical scroll', () => {
    // Sanity: the world mapping still works below the ruler.
    expect(makeQueries(0).hitTestClip(200, RULER_HEIGHT + 10)?.clipId).toBe('c1')
    expect(makeQueries(60).hitTestClip(200, RULER_HEIGHT + 10)?.clipId).toBe('c1')  })

  it('never hits a clip through the ruler, scrolled or not', () => {
    expect(makeQueries(0).hitTestClip(200, rulerY)).toBeNull()
    // Unguarded this maps to world y = 14 + 120 = 134, inside the clip row.
    expect(makeQueries(120).hitTestClip(200, rulerY)).toBeNull()
  })

  it('never resolves a trim edge through the ruler, scrolled or not', () => {
    // Aimed at the clip's left edge, where a trim hit would otherwise win.
    expect(makeQueries(0).hitTestTrimEdge(HEADER_WIDTH + 1, rulerY)).toBeNull()
    expect(makeQueries(120).hitTestTrimEdge(HEADER_WIDTH + 1, rulerY)).toBeNull()
    // Still reachable in the track area (scrolled so world y = 38 + 60 = 98, inside).
    expect(makeQueries(60).hitTestTrimEdge(HEADER_WIDTH + 1, RULER_HEIGHT + 10)?.edge).toBe('left')
  })
})
