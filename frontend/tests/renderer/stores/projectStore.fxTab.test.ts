// The lower panel's FX tab is view state, not content: it persists with the project
// (non-dirty) so reopening lands the user back on the tab they left, but it must never
// mark the project dirty or be echoed back to the backend when restored.

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function snapshot(viewFxTab?: string) {
  return {
    filePath: null,
    name: 'Tabbed project',
    reset: true,
    bpm: 120,
    library: [],
    tracks: [],
    viewFxPanelOpen: true,
    ...(viewFxTab === undefined ? {} : { viewFxTab })
  }
}

describe('project FX tab view state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockReset()
  })

  it('starts on the track tab', () => {
    expect(useProjectStore().fxTab).toBe('track')
  })

  it('persists a change as non-dirty project view state', () => {
    const project = useProjectStore()

    project.setFxTab('plugins')

    expect(project.fxTab).toBe('plugins')
    expect(sendMock).toHaveBeenCalledWith('PROJECT_SET_VIEW', { fxTab: 'plugins' })
  })

  it('does not echo a no-op change', () => {
    const project = useProjectStore()

    project.setFxTab('track')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('restores the saved tab on load without echoing it back', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot(snapshot('plugins'))

    expect(project.fxTab).toBe('plugins')
    expect(project.fxPanelOpen).toBe(true)
    expect(sendMock).not.toHaveBeenCalledWith(
      'PROJECT_SET_VIEW',
      expect.objectContaining({ fxTab: expect.anything() })
    )
  })

  it('falls back to the track tab for a project saved before the tab was persisted', () => {
    const project = useProjectStore()
    project.setFxTab('plugins')

    project.applyProjectStateSnapshot(snapshot(undefined))

    expect(project.fxTab).toBe('track')
  })

  it('falls back to the track tab for an unrecognised stored value', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot(snapshot('something-a-later-build-added'))

    expect(project.fxTab).toBe('track')
  })
})
