import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { createTimelineQueries } from '@/lib/timeline/timelineQueries'
import { useTransportStore } from '@/stores/transportStore'
import type { GridGeometry } from '@/lib/timeline/useGridGeometry'
import type { Application } from 'pixi.js'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const HEADER_WIDTH = 100
const PX_PER_SECOND = 100

function makeQueries(scrollX = 0) {
  const host = ref({
    getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect
  } as unknown as HTMLElement)
  const app = ref({
    renderer: { screen: { width: 800, height: 400 } }
  }) as unknown as Readonly<Ref<Application | null>>
  const geometry = {
    headerWidth: () => HEADER_WIDTH,
    pxPerSecond: ref(PX_PER_SECOND)
  } as unknown as GridGeometry
  return createTimelineQueries({
    host,
    app,
    scrollX: ref(scrollX),
    scrollY: ref(0),
    maxScrollX: computed(() => 0),
    geometry,
    getClipHitRegions: () => []
  })
}

describe('hitTestPlayhead', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('hits within a few px of the playhead line', () => {
    useTransportStore().positionMs = 1_000 // playhead at x = 100 + 100 = 200
    const q = makeQueries()
    expect(q.hitTestPlayhead(200, 50)).toBe(true)
    expect(q.hitTestPlayhead(203, 50)).toBe(true)
    expect(q.hitTestPlayhead(196, 50)).toBe(true)
  })

  it('misses beyond the hit tolerance', () => {
    useTransportStore().positionMs = 1_000
    const q = makeQueries()
    expect(q.hitTestPlayhead(210, 50)).toBe(false)
    expect(q.hitTestPlayhead(190, 50)).toBe(false)
  })

  it('accounts for horizontal scroll', () => {
    useTransportStore().positionMs = 1_000 // absolute x = 200, viewport = 200 - scroll
    const q = makeQueries(50)
    expect(q.hitTestPlayhead(150, 50)).toBe(true)
    expect(q.hitTestPlayhead(200, 50)).toBe(false)
  })

  it('ignores the header lane', () => {
    useTransportStore().positionMs = 0 // playhead at the header edge (x = 100)
    const q = makeQueries()
    // A point left of the header is never a playhead hit even if numerically near.
    expect(q.hitTestPlayhead(98, 50)).toBe(false)
  })
})
