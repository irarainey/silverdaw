import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTrackResizeDrag } from '@/lib/track/useTrackResizeDrag'
import { useProjectStore } from '@/stores/projectStore'
import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT } from '@/lib/timeline/constants'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

type Listener = (ev: PointerEvent) => void
const listeners = new Map<string, Listener>()

function fakeWindow(): void {
  vi.stubGlobal('window', {
    innerHeight: 1000,
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

function seedTrack(id: string, heightPx: number): void {
  const project = useProjectStore()
  project.tracks = [
    { id, name: id, heightPx } as unknown as (typeof project.tracks)[number]
  ]
}

describe('useTrackResizeDrag', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listeners.clear()
    fakeWindow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('previews height locally during the drag and commits once on pointerup', () => {
    const project = useProjectStore()
    seedTrack('t1', 150)
    const local = vi.spyOn(project, 'setTrackHeightLocal').mockImplementation((_id, h) => {
      project.tracks[0]!.heightPx = h
    })
    const commit = vi.spyOn(project, 'setTrackHeight').mockImplementation(() => {})

    const { onHandlePointerDown } = useTrackResizeDrag()
    onHandlePointerDown({ id: 't1' }, pointerDown(100))
    listeners.get('pointermove')!({ clientY: 150 } as PointerEvent)

    // start 150 + dy (150 - 100) = 200
    expect(local).toHaveBeenCalledWith('t1', 200)

    listeners.get('pointerup')!({} as PointerEvent)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('t1', 200)
    expect(listeners.has('pointermove')).toBe(false)
  })

  it('clamps the previewed height to the track bounds', () => {
    const project = useProjectStore()
    seedTrack('t1', MAX_TRACK_HEIGHT)
    const local = vi.spyOn(project, 'setTrackHeightLocal').mockImplementation(() => {})

    const { onHandlePointerDown } = useTrackResizeDrag()
    onHandlePointerDown({ id: 't1' }, pointerDown(0))
    listeners.get('pointermove')!({ clientY: 5000 } as PointerEvent)
    expect(local).toHaveBeenLastCalledWith('t1', MAX_TRACK_HEIGHT)

    listeners.get('pointermove')!({ clientY: -5000 } as PointerEvent)
    expect(local).toHaveBeenLastCalledWith('t1', MIN_TRACK_HEIGHT)
  })

  it('does not commit when the pointer never moved', () => {
    const project = useProjectStore()
    seedTrack('t1', 150)
    const commit = vi.spyOn(project, 'setTrackHeight').mockImplementation(() => {})

    const { onHandlePointerDown } = useTrackResizeDrag()
    onHandlePointerDown({ id: 't1' }, pointerDown(100))
    listeners.get('pointerup')!({} as PointerEvent)
    expect(commit).not.toHaveBeenCalled()
  })

  it('ignores non-primary buttons and unknown tracks', () => {
    seedTrack('t1', 100)
    const { onHandlePointerDown } = useTrackResizeDrag()

    onHandlePointerDown({ id: 't1' }, { ...pointerDown(100), button: 2 } as PointerEvent)
    expect(listeners.has('pointermove')).toBe(false)

    onHandlePointerDown({ id: 'missing' }, pointerDown(100))
    expect(listeners.has('pointermove')).toBe(false)
  })
})
