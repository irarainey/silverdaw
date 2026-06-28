import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTrackPan } from '@/lib/track/useTrackPan'
import { useProjectStore } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('useTrackPan', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    let n = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++n}`) })
  })

  it('formats pan as C / L<n> / R<n>', () => {
    const { panDisplay } = useTrackPan()
    expect(panDisplay(0)).toBe('C')
    expect(panDisplay(undefined)).toBe('C')
    expect(panDisplay(-0.5)).toBe('L50')
    expect(panDisplay(1)).toBe('R100')
    expect(panDisplay(0.25)).toBe('R25')
  })

  it('onPanInput pushes pan with an open per-track gesture', () => {
    const project = useProjectStore()
    const setPan = vi.spyOn(project, 'setTrackPan').mockImplementation(() => {})
    const { onPanInput } = useTrackPan()

    onPanInput('t1', -0.3)
    expect(setPan).toHaveBeenCalledWith('t1', -0.3, {
      gestureId: expect.stringContaining('pan-'),
      gestureEnd: false
    })
  })

  it('coalesces a drag on one track but mints a fresh gesture per track', () => {
    const project = useProjectStore()
    const setPan = vi.spyOn(project, 'setTrackPan').mockImplementation(() => {})
    const { onPanInput } = useTrackPan()

    onPanInput('t1', 0.1)
    onPanInput('t1', 0.2)
    const firstId = setPan.mock.calls[0]![2]!.gestureId
    const secondId = setPan.mock.calls[1]![2]!.gestureId
    expect(secondId).toBe(firstId) // same track → one undo step

    onPanInput('t2', 0.4)
    const thirdId = setPan.mock.calls[2]![2]!.gestureId
    expect(thirdId).not.toBe(firstId) // different track → fresh gesture
  })

  it('onPanChange commits with gestureEnd then closes the gesture', () => {
    const project = useProjectStore()
    const setPan = vi.spyOn(project, 'setTrackPan').mockImplementation(() => {})
    const { onPanInput, onPanChange } = useTrackPan()

    onPanInput('t1', 0.5)
    const dragId = setPan.mock.calls[0]![2]!.gestureId
    onPanChange('t1', 0.6)
    expect(setPan).toHaveBeenLastCalledWith('t1', 0.6, {
      gestureId: dragId,
      gestureEnd: true
    })

    // After the gesture closes, a new drag mints a fresh id.
    onPanInput('t1', 0.7)
    expect(setPan.mock.calls.at(-1)![2]!.gestureId).not.toBe(dragId)
  })

  it('onPanReset recentres in a single committed step', () => {
    const project = useProjectStore()
    const setPan = vi.spyOn(project, 'setTrackPan').mockImplementation(() => {})
    const { onPanReset } = useTrackPan()

    onPanReset('t1')
    expect(setPan).toHaveBeenCalledWith('t1', 0, { gestureEnd: true })
  })

  it('ignores non-finite input values', () => {
    const project = useProjectStore()
    const setPan = vi.spyOn(project, 'setTrackPan').mockImplementation(() => {})
    const { onPanInput, onPanChange } = useTrackPan()

    onPanInput('t1', Number.NaN)
    onPanChange('t1', Number.POSITIVE_INFINITY)
    expect(setPan).not.toHaveBeenCalled()
  })
})
