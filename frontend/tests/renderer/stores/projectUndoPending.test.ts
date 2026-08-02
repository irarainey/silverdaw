import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

function baseSnapshot(softReplace: boolean) {
  return {
    filePath: null,
    name: 'Undo pending',
    reset: !softReplace,
    softReplace,
    bpm: 120,
    library: [],
    tracks: []
  }
}

describe('undo/redo in-flight tracking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockReset()
    vi.useRealTimers()
    vi.stubGlobal('window', {
      silverdaw: {
        readAudioMetadata: vi.fn().mockResolvedValue(null),
        readAudioFile: vi.fn().mockResolvedValue(null)
      }
    })
  })

  it('marks undo as pending until the resulting snapshot lands', () => {
    const project = useProjectStore()
    project.applyEditUndoState({ canUndo: true, canRedo: false })

    project.requestUndo()
    expect(sendMock).toHaveBeenCalledWith('EDIT_UNDO')
    expect(project.undoRedoPending).toBe(true)

    project.applyProjectStateSnapshot(baseSnapshot(true))
    expect(project.undoRedoPending).toBe(false)
  })

  it('marks redo as pending until the resulting snapshot lands', () => {
    const project = useProjectStore()
    project.applyEditUndoState({ canUndo: false, canRedo: true })

    project.requestRedo()
    expect(sendMock).toHaveBeenCalledWith('EDIT_REDO')
    expect(project.undoRedoPending).toBe(true)

    project.applyProjectStateSnapshot(baseSnapshot(true))
    expect(project.undoRedoPending).toBe(false)
  })

  it('sends nothing and stays idle when there is nothing to undo or redo', () => {
    const project = useProjectStore()
    project.applyEditUndoState({ canUndo: false, canRedo: false })

    project.requestUndo()
    project.requestRedo()

    expect(sendMock).not.toHaveBeenCalled()
    expect(project.undoRedoPending).toBe(false)
  })

  it('clears the pending flag from the watchdog when no snapshot arrives', () => {
    vi.useFakeTimers()
    const project = useProjectStore()
    project.applyEditUndoState({ canUndo: true, canRedo: false })

    project.requestUndo()
    expect(project.undoRedoPending).toBe(true)

    vi.advanceTimersByTime(10_000)
    expect(project.undoRedoPending).toBe(false)
  })
})
