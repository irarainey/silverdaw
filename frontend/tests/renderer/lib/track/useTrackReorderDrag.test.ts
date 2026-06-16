import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTrackReorderDrag } from '@/lib/track/useTrackReorderDrag'
import { useProjectStore } from '@/stores/projectStore'
import { buildTrackRowLayout } from '@/lib/timeline/trackLayout'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

type Listener = (ev: PointerEvent) => void
const listeners = new Map<string, Listener>()

function fakeWindow(): void {
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type)
  })
}

function pointerDown(clientY: number): PointerEvent {
  return {
    button: 0,
    clientY,
    pointerId: 1,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { setPointerCapture: vi.fn() }
  } as unknown as PointerEvent
}

function seedTracks(): void {
  const project = useProjectStore()
  project.tracks = ['t0', 't1', 't2'].map(
    (id) => ({ id, name: id }) as unknown as (typeof project.tracks)[number]
  )
}

function setup() {
  const project = useProjectStore()
  const rowLayout = computed(() => buildTrackRowLayout(project.tracks))
  const drag = useTrackReorderDrag(rowLayout)
  drag.rowsHostEl.value = {
    getBoundingClientRect: () => ({ top: 0 }) as DOMRect
  } as unknown as HTMLDivElement
  return { project, drag }
}

describe('useTrackReorderDrag', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listeners.clear()
    fakeWindow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('commits a post-removal reorder index on pointerup', () => {
    seedTracks()
    const { project, drag } = setup()
    const reorder = vi.spyOn(project, 'reorderTrack').mockImplementation(() => {})

    drag.onGripPointerDown({ id: 't0' }, pointerDown(50))
    listeners.get('pointermove')!({ clientY: 200 } as PointerEvent)
    expect(drag.dropIndicatorIndex.value).toBe(1)
    expect(drag.reorderingTrackId.value).toBe('t0')

    listeners.get('pointerup')!({} as PointerEvent)
    expect(reorder).toHaveBeenCalledWith('t0', 1)
    expect(drag.reorderingTrackId.value).toBeNull()
    expect(drag.dropIndicatorIndex.value).toBeNull()
  })

  it('suppresses a no-op drop onto the source slot', () => {
    seedTracks()
    const { project, drag } = setup()
    const reorder = vi.spyOn(project, 'reorderTrack').mockImplementation(() => {})

    drag.onGripPointerDown({ id: 't0' }, pointerDown(50))
    listeners.get('pointermove')!({ clientY: 60 } as PointerEvent)
    expect(drag.dropIndicatorIndex.value).toBeNull()

    listeners.get('pointerup')!({} as PointerEvent)
    expect(reorder).not.toHaveBeenCalled()
  })

  it('ignores movement below the threshold', () => {
    seedTracks()
    const { project, drag } = setup()
    const reorder = vi.spyOn(project, 'reorderTrack').mockImplementation(() => {})

    drag.onGripPointerDown({ id: 't0' }, pointerDown(50))
    listeners.get('pointermove')!({ clientY: 52 } as PointerEvent)
    expect(drag.dropIndicatorIndex.value).toBeNull()

    listeners.get('pointerup')!({} as PointerEvent)
    expect(reorder).not.toHaveBeenCalled()
  })

  it('exposes the drop-indicator top in content space', () => {
    seedTracks()
    const { drag } = setup()
    drag.dropIndicatorIndex.value = 1
    // row1.top (150) - RULER_HEIGHT (28) - 1
    expect(drag.dropIndicatorTopPx.value).toBe(121)
  })
})
