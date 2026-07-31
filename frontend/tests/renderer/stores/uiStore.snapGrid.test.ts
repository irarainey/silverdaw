import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { useUiStore } from '@/stores/uiStore'
import { DEFAULT_SNAP_GRID } from '@shared/snapGrid'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('uiStore snap grid', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('starts on the default grid', () => {
    expect(useUiStore().snapGrid).toBe(DEFAULT_SNAP_GRID)
  })

  it('persists a change as non-dirty project view state', () => {
    const ui = useUiStore()

    ui.setSnapGrid('bar')

    expect(ui.snapGrid).toBe('bar')
    expect(sendBridge).toHaveBeenCalledWith('PROJECT_SET_VIEW', { snapGrid: 'bar' })
  })

  it('does not echo a no-op change', () => {
    const ui = useUiStore()

    ui.setSnapGrid(DEFAULT_SNAP_GRID)

    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('applies a snapshot value without echoing it back to the backend', () => {
    const ui = useUiStore()

    ui.applySnapGridView('half')

    expect(ui.snapGrid).toBe('half')
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('falls back to the default for a project saved before the grid existed', () => {
    const ui = useUiStore()
    ui.applySnapGridView('bar')

    ui.applySnapGridView(undefined)

    expect(ui.snapGrid).toBe(DEFAULT_SNAP_GRID)
  })

  it('falls back to the default for an unrecognised stored value', () => {
    const ui = useUiStore()

    ui.applySnapGridView('sixteenth')

    expect(ui.snapGrid).toBe(DEFAULT_SNAP_GRID)
  })
})
