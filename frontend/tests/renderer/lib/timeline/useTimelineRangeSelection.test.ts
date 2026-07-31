import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useTimelineRangeSelection } from '@/lib/timeline/useTimelineRangeSelection'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import type { GridGeometry } from '@/lib/timeline/useGridGeometry'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const HEADER_WIDTH = 100
const PX_PER_SECOND = 100
const SCREEN_WIDTH = 800
// 800 wide minus the 12 px scrollbar: x beyond this is inside the right edge zone.
const RIGHT_EDGE_X = 788

let rafCallbacks: FrameRequestCallback[] = []
let listeners: Record<string, ((e: unknown) => void)[]> = {}

// The suite runs in the node environment (no jsdom), so the composable's few
// `window` touchpoints are stubbed with a minimal event registry.
function stubWindow(): void {
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (listeners[type] ??= []).push(fn)
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn)
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    },
    cancelAnimationFrame: () => {}
  })
}

function setup(maxScrollXPx = 5_000) {
  const project = useProjectStore()
  project.tracks = [
    { id: 't1', lengthMs: 600_000 } as unknown as (typeof project.tracks)[number]
  ]
  const host = ref({
    getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect
  } as unknown as HTMLElement)
  const app = ref({
    renderer: { screen: { width: SCREEN_WIDTH, height: 400 } }
  }) as unknown as Readonly<Ref<Application | null>>
  const scrollX = ref(0)
  const geometry = {
    headerWidth: () => HEADER_WIDTH,
    pxPerSecond: ref(PX_PER_SECOND),
    // Quarter-beat grid at 120 BPM.
    snapTimelineMs: (ms: number, fineMode: boolean) =>
      fineMode ? Math.max(0, Math.round(ms)) : Math.max(0, Math.round(ms / 125) * 125)
  } as unknown as GridGeometry
  const onSeek = vi.fn()
  const { tryBegin } = useTimelineRangeSelection({
    host,
    app,
    scrollX,
    maxScrollX: computed(() => maxScrollXPx),
    geometry,
    onSeek
  })
  return { onSeek, scrollX, tryBegin }
}

function pointerDown(clientX: number): PointerEvent {
  return {
    button: 0,
    shiftKey: false,
    altKey: false,
    clientX,
    clientY: 5,
    preventDefault: vi.fn()
  } as unknown as PointerEvent
}

function dispatchPointer(type: string, clientX: number): void {
  for (const fn of [...(listeners[type] ?? [])]) fn({ clientX, clientY: 5, altKey: false })
}

function runFrame(): void {
  const pending = rafCallbacks
  rafCallbacks = []
  for (const cb of pending) cb(0)
}

describe('useTimelineRangeSelection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    rafCallbacks = []
    listeners = {}
    stubWindow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects the dragged range between the anchor and the pointer', () => {
    const { tryBegin } = setup()
    expect(tryBegin(pointerDown(200))).toBe(true)
    dispatchPointer('pointermove', 400)

    // x=200 -> 1000 ms, x=400 -> 3000 ms (100 px header, 100 px per second).
    expect(useUiStore().timelineSelection).toEqual({ startMs: 1000, endMs: 3000 })
  })

  it('scrolls the view and keeps extending the selection at the right edge', () => {
    const { scrollX, tryBegin } = setup()
    tryBegin(pointerDown(200))
    dispatchPointer('pointermove', RIGHT_EDGE_X)
    const endBeforeScroll = useUiStore().timelineSelection?.endMs ?? 0

    runFrame()

    expect(scrollX.value).toBeGreaterThan(0)
    expect(useUiStore().timelineSelection?.endMs).toBeGreaterThan(endBeforeScroll)
    expect(useUiStore().timelineSelection?.startMs).toBe(1000)
  })

  it('keeps auto-scrolling while the pointer stays at the edge', () => {
    const { scrollX, tryBegin } = setup()
    tryBegin(pointerDown(200))
    dispatchPointer('pointermove', RIGHT_EDGE_X)

    runFrame()
    const afterOneFrame = scrollX.value
    runFrame()

    expect(scrollX.value).toBeGreaterThan(afterOneFrame)
  })

  it('does not auto-scroll while the pointer is clear of the edges', () => {
    const { scrollX, tryBegin } = setup()
    tryBegin(pointerDown(200))
    dispatchPointer('pointermove', 400)

    runFrame()

    expect(scrollX.value).toBe(0)
  })

  it('does not auto-scroll when there is no room to scroll', () => {
    const { scrollX, tryBegin } = setup(0)
    tryBegin(pointerDown(200))
    dispatchPointer('pointermove', RIGHT_EDGE_X)

    runFrame()

    expect(scrollX.value).toBe(0)
  })

  it('stops auto-scrolling once the drag ends', () => {
    const { scrollX, tryBegin } = setup()
    tryBegin(pointerDown(200))
    dispatchPointer('pointermove', RIGHT_EDGE_X)
    runFrame()
    const atRelease = scrollX.value
    dispatchPointer('pointerup', RIGHT_EDGE_X)

    runFrame()

    expect(scrollX.value).toBe(atRelease)
  })
})
