import { ref } from 'vue'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTimelineZoom, type TimelineZoomDeps } from './useTimelineZoom'

function makeDeps(overrides: Partial<TimelineZoomDeps> = {}): {
  deps: TimelineZoomDeps
  scrollX: ReturnType<typeof ref<number>>
  spies: {
    setPxPerSecond: ReturnType<typeof vi.fn>
    applyScroll: ReturnType<typeof vi.fn>
    redraw: ReturnType<typeof vi.fn>
    updatePlayhead: ReturnType<typeof vi.fn>
  }
  pxPerSecond: { value: number }
} {
  const scrollX = ref(0)
  const pxPerSecond = { value: 100 }
  const spies = {
    setPxPerSecond: vi.fn((v: number) => v),
    applyScroll: vi.fn(),
    redraw: vi.fn(),
    updatePlayhead: vi.fn()
  }
  const deps: TimelineZoomDeps = {
    getScreenWidth: () => 1000,
    getHostRect: () => ({ left: 0, top: 0, width: 1000, height: 400 }) as DOMRect,
    headerWidth: () => 200,
    pxPerSecond: () => pxPerSecond.value,
    scrollX,
    maxScrollX: () => 100_000,
    trackAreaWidth: () => 800,
    setPxPerSecond: spies.setPxPerSecond as TimelineZoomDeps['setPxPerSecond'],
    getPlayheadPositionMs: () => 0,
    getTrackCount: () => 3,
    applyScroll: spies.applyScroll,
    redraw: spies.redraw,
    updatePlayhead: spies.updatePlayhead,
    ...overrides
  }
  return { deps, scrollX, spies, pxPerSecond }
}

function wheel(opts: Partial<WheelEvent> = {}): WheelEvent {
  return {
    deltaX: 0,
    deltaY: 0,
    shiftKey: false,
    clientX: 400,
    preventDefault: vi.fn(),
    ...opts
  } as unknown as WheelEvent
}

describe('useTimelineZoom — onWheel', () => {
  let h: ReturnType<typeof makeDeps>
  beforeEach(() => {
    h = makeDeps()
  })

  it('no-ops when there are no tracks', () => {
    h = makeDeps({ getTrackCount: () => 0 })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100 }))
    expect(h.spies.setPxPerSecond).not.toHaveBeenCalled()
  })

  it('no-ops when the host is not mounted', () => {
    h = makeDeps({ getHostRect: () => null })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100 }))
    expect(h.spies.setPxPerSecond).not.toHaveBeenCalled()
  })

  it('horizontal-dominant wheel pans rather than zooms', () => {
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaX: 50, deltaY: 5 }))
    expect(h.scrollX.value).toBe(50)
    expect(h.spies.applyScroll).toHaveBeenCalledTimes(1)
    expect(h.spies.setPxPerSecond).not.toHaveBeenCalled()
  })

  it('Shift + vertical wheel pans', () => {
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 40, shiftKey: true }))
    expect(h.scrollX.value).toBe(40)
    expect(h.spies.applyScroll).toHaveBeenCalledTimes(1)
  })

  it('vertical wheel zooms in and repaints', () => {
    h = makeDeps({ setPxPerSecond: vi.fn(() => 110) })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100 }))
    expect(h.deps.setPxPerSecond).toHaveBeenCalled()
    expect(h.spies.redraw).toHaveBeenCalledTimes(1)
    expect(h.spies.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('vertical wheel is a no-op when the zoom clamps to the same value', () => {
    h = makeDeps({ setPxPerSecond: vi.fn(() => 100) })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100 }))
    expect(h.spies.redraw).not.toHaveBeenCalled()
  })
})

describe('useTimelineZoom — applyZoomRequest', () => {
  it('absolute request applies the requested px/sec', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'absolute', pxPerSecond: 240, id: 1 } as never)
    expect(setPxPerSecond).toHaveBeenCalledWith(240)
    expect(h.spies.redraw).toHaveBeenCalledTimes(1)
  })

  it('step "in" nudges up by the zoom step', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'in', id: 2 } as never)
    // prev is 100; the step constant is added, so the target exceeds 100.
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeGreaterThan(100)
  })

  it('step "reset" returns to the default zoom', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'reset', id: 3 } as never)
    expect(setPxPerSecond).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the clamped zoom is unchanged', () => {
    const h = makeDeps({ setPxPerSecond: vi.fn(() => 100) })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'absolute', pxPerSecond: 100, id: 4 } as never)
    expect(h.spies.redraw).not.toHaveBeenCalled()
  })
})
