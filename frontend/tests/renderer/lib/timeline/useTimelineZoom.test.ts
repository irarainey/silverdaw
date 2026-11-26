import { ref } from 'vue'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, ZOOM_STEP_FACTOR } from '@/lib/timeline/constants'
import { useTimelineZoom, type TimelineZoomDeps } from '@/lib/timeline/useTimelineZoom'

function makeDeps(overrides: Partial<TimelineZoomDeps> = {}): {
  deps: TimelineZoomDeps
  scrollX: ReturnType<typeof ref<number>>
  scrollY: ReturnType<typeof ref<number>>
  spies: {
    setPxPerSecond: ReturnType<typeof vi.fn>
    applyScroll: ReturnType<typeof vi.fn>
    redraw: ReturnType<typeof vi.fn>
    updatePlayhead: ReturnType<typeof vi.fn>
  }
  pxPerSecond: { value: number }
} {
  const scrollX = ref(0)
  const scrollY = ref(0)
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
    getProjectDurationMs: () => 240_000,
    scrollX,
    maxScrollX: () => 100_000,
    scrollY,
    maxScrollY: () => 100_000,
    trackAreaWidth: () => 800,
    setPxPerSecond: spies.setPxPerSecond as TimelineZoomDeps['setPxPerSecond'],
    getPlayheadPositionMs: () => 0,
    getTrackCount: () => 3,
    applyScroll: spies.applyScroll,
    redraw: spies.redraw,
    updatePlayhead: spies.updatePlayhead,
    ...overrides
  }
  return { deps, scrollX, scrollY, spies, pxPerSecond }
}

function wheel(opts: Partial<WheelEvent> = {}): WheelEvent {
  return {
    deltaX: 0,
    deltaY: 0,
    shiftKey: false,
    ctrlKey: false,
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
    onWheel(wheel({ deltaY: -100, ctrlKey: true }))
    expect(h.spies.setPxPerSecond).not.toHaveBeenCalled()
  })

  it('no-ops when the host is not mounted', () => {
    h = makeDeps({ getHostRect: () => null })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100, ctrlKey: true }))
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

  it('plain vertical wheel scrolls the tracks vertically', () => {
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 60 }))
    expect(h.scrollY.value).toBe(60)
    expect(h.spies.applyScroll).toHaveBeenCalledTimes(1)
    expect(h.spies.setPxPerSecond).not.toHaveBeenCalled()
  })

  it('plain vertical wheel clamps to maxScrollY', () => {
    h = makeDeps({ maxScrollY: () => 30 })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 100 }))
    expect(h.scrollY.value).toBe(30)
  })

  it('plain vertical wheel is a no-op when already at the scroll limit', () => {
    h = makeDeps({ maxScrollY: () => 0 })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 100 }))
    expect(h.spies.applyScroll).not.toHaveBeenCalled()
  })

  it('Ctrl + vertical wheel zooms in and repaints', () => {
    h = makeDeps({ setPxPerSecond: vi.fn(() => 110) })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100, ctrlKey: true }))
    expect(h.deps.setPxPerSecond).toHaveBeenCalled()
    expect(h.spies.redraw).toHaveBeenCalledTimes(1)
    expect(h.spies.updatePlayhead).toHaveBeenCalledTimes(1)
  })

  it('Ctrl + vertical wheel does not scroll vertically', () => {
    h = makeDeps({ setPxPerSecond: vi.fn(() => 110) })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 100, ctrlKey: true }))
    expect(h.scrollY.value).toBe(0)
  })

  it('Ctrl + vertical wheel is a no-op when the zoom clamps to the same value', () => {
    h = makeDeps({ setPxPerSecond: vi.fn(() => 100) })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -100, ctrlKey: true }))
    expect(h.spies.redraw).not.toHaveBeenCalled()
  })

  it('Ctrl + wheel zoom-out at a full notch scales proportionally at low zoom', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond, pxPerSecond: () => 10 })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 100, ctrlKey: true }))
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeCloseTo(10 / ZOOM_STEP_FACTOR, 8)
  })

  it('a small pinch delta moves the zoom a matching fraction of a step', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond, pxPerSecond: () => 100 })
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: -5, ctrlKey: true }))
    const next = setPxPerSecond.mock.calls[0]?.[0] as number
    // One twentieth of a notch, so one twentieth of the step factor's change.
    expect(next).toBeGreaterThan(100)
    expect(next).toBeLessThan(100 * 1.02)
  })

  it('pinch deltas compose like wheel notches (two half-notches = one step)', () => {
    const h = makeDeps()
    h.deps.setPxPerSecond = (v: number) => {
      h.pxPerSecond.value = v
      return v
    }
    const { onWheel } = useTimelineZoom(h.deps)
    onWheel(wheel({ deltaY: 50, ctrlKey: true }))
    onWheel(wheel({ deltaY: 50, ctrlKey: true }))
    expect(h.pxPerSecond.value).toBeCloseTo(100 / ZOOM_STEP_FACTOR, 8)
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

  it('step "in" scales the zoom up', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'in', id: 2 } as never)
    // prev is 100; the multiplicative step factor scales it up.
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeCloseTo(100 * ZOOM_STEP_FACTOR, 10)
  })

  it('step "out" scales the zoom down proportionally', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'out', id: 7 } as never)
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeCloseTo(100 / ZOOM_STEP_FACTOR, 10)
  })

  it('step "in" scales the zoom up proportionally at low zoom', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond, pxPerSecond: () => 5 })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'in', id: 8 } as never)
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeCloseTo(5 * ZOOM_STEP_FACTOR, 10)
  })

  it('one step feels proportionate at every zoom level', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    let id = 20
    for (const level of [500, 100, 20, 3, 0.5]) {
      h.deps.pxPerSecond = () => level
      applyZoomRequest({ kind: 'step', action: 'out', id: id++ } as never)
      expect(setPxPerSecond.mock.calls.at(-1)?.[0]).toBeCloseTo(level / ZOOM_STEP_FACTOR, 10)
    }
  })

  it('step "out" at the floor is a no-op', () => {
    const setPxPerSecond = vi.fn((v: number) => Math.max(MIN_PX_PER_SECOND, v))
    const h = makeDeps({ setPxPerSecond, pxPerSecond: () => MIN_PX_PER_SECOND })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'out', id: 9 } as never)
    expect(h.spies.redraw).not.toHaveBeenCalled()
  })

  it('step "in" at the ceiling is a no-op', () => {
    const setPxPerSecond = vi.fn((v: number) => Math.min(MAX_PX_PER_SECOND, v))
    const h = makeDeps({ setPxPerSecond, pxPerSecond: () => MAX_PX_PER_SECOND })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'in', id: 10 } as never)
    expect(h.spies.redraw).not.toHaveBeenCalled()
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

  it('step "fit" sizes the project to the track area and jumps to the start', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond })
    h.scrollX.value = 5000
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'fit', id: 5 } as never)
    // (trackAreaWidth 800 * 0.98) / (240000 ms / 1000) = 3.2667 px/sec.
    expect(setPxPerSecond.mock.calls[0]?.[0]).toBeCloseTo(3.2667, 3)
    expect(h.scrollX.value).toBe(0)
    expect(h.spies.redraw).toHaveBeenCalled()
  })

  it('step "fit" is a no-op when the project has no duration', () => {
    const setPxPerSecond = vi.fn((v: number) => v)
    const h = makeDeps({ setPxPerSecond, getProjectDurationMs: () => 0 })
    const { applyZoomRequest } = useTimelineZoom(h.deps)
    applyZoomRequest({ kind: 'step', action: 'fit', id: 6 } as never)
    expect(setPxPerSecond).not.toHaveBeenCalled()
  })
})
