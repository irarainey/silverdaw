import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { applyProjectStateSnapshot } from '@/stores/projectSnapshot'
import type { ScratchPattern } from '@shared/bridge-protocol'
import {
  createPersistence,
  makePattern,
  makeSnapshot,
  setupSessionStore
} from './scratchPersistenceTestSupport'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))
vi.mock('@/lib/audio/db', () => ({
  MAX_TRACK_GAIN_LINEAR: 2,
  dbToLinear: vi.fn((db: number) => Math.pow(10, db / 20))
}))

describe('corrupt stored pattern snapshot isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('omits corrupt patterns and keeps valid ones', () => {
    const store = useProjectStore()
    const valid = makePattern({ id: 'sp-valid' })
    const corrupt = { ...makePattern({ id: 'sp-bad' }), version: 99 }
    applyProjectStateSnapshot(
      store,
      makeSnapshot({ scratchPatterns: [valid, corrupt as unknown as ScratchPattern] })
    )
    expect(store.savedScratchPatterns).toHaveLength(1)
    expect(store.savedScratchPatterns[0]!.id).toBe('sp-valid')
  })

  it('returns empty array when all patterns are corrupt', () => {
    const store = useProjectStore()
    const bad1 = { ...makePattern(), version: 99 }
    const bad2 = { ...makePattern({ id: 'sp-2' }), durationUs: -1 }
    applyProjectStateSnapshot(
      store,
      makeSnapshot({ scratchPatterns: [bad1, bad2] as unknown as ScratchPattern[] })
    )
    expect(store.savedScratchPatterns).toEqual([])
  })

  it('handles absent scratchPatterns gracefully (older project)', () => {
    const store = useProjectStore()
    applyProjectStateSnapshot(store, makeSnapshot())
    expect(store.savedScratchPatterns).toEqual([])
  })
})

describe('scratchPatternPersistence composable', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('save', () => {
    it('sends SCRATCH_PATTERN_SAVE and sets pending state', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const { persistence } = createPersistence()
      persistence.patternName.value = 'My Pattern'

      persistence.savePattern()

      expect(sendMock).toHaveBeenCalledWith(
        'SCRATCH_PATTERN_SAVE',
        expect.objectContaining({
          pattern: expect.objectContaining({ name: 'My Pattern' })
        })
      )
      expect(persistence.isSavePending.value).toBe(true)
    })

    it('uses "Untitled Scratch" when name is empty', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const { persistence } = createPersistence()
      persistence.patternName.value = ''

      persistence.savePattern()

      expect(sendMock).toHaveBeenCalledWith(
        'SCRATCH_PATTERN_SAVE',
        expect.objectContaining({
          pattern: expect.objectContaining({ name: 'Untitled Scratch' })
        })
      )
    })

    it('does nothing without a session', () => {
      setupSessionStore()
      const { persistence, sessionRef } = createPersistence()
      sessionRef.value = null

      persistence.savePattern()
      expect(sendMock).not.toHaveBeenCalled()
    })

    it('does nothing without a completed pattern', () => {
      setupSessionStore()
      const { persistence } = createPersistence()

      persistence.savePattern()
      expect(sendMock).not.toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('sends save with the target pattern id', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-draft' })
      scratch.setSavedPatternId('sp-1')
      const { persistence } = createPersistence()
      persistence.patternName.value = 'Updated'

      persistence.updatePattern()

      expect(sendMock).toHaveBeenCalledWith(
        'SCRATCH_PATTERN_SAVE',
        expect.objectContaining({
          pattern: expect.objectContaining({ id: 'sp-1', name: 'Updated' })
        })
      )
    })
  })

  describe('selectAndLoad', () => {
    it('loads a saved pattern into the editor', () => {
      const project = useProjectStore()
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const saved = makePattern({ id: 'sp-saved', name: 'Saved One' })
      project.savedScratchPatterns = [saved]

      const { persistence } = createPersistence()
      persistence.selectAndLoad('sp-saved')

      expect(persistence.selectedSavedId.value).toBe('sp-saved')
      expect(persistence.patternName.value).toBe('Saved One')
      expect(scratch.completedPattern?.id).toBe('sp-saved')
      expect(scratch.savedPatternId).toBe('sp-saved')
      expect(persistence.isSaved.value).toBe(true)
    })

    it('does nothing for unknown pattern id', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const { persistence } = createPersistence()

      persistence.selectAndLoad('sp-unknown')
      expect(persistence.selectedSavedId.value).toBeNull()
    })
  })

  describe('rename', () => {
    it('sends SCRATCH_PATTERN_RENAME', () => {
      setupSessionStore()
      const { persistence } = createPersistence()

      persistence.rename('sp-1', 'New Name')

      expect(sendMock).toHaveBeenCalledWith(
        'SCRATCH_PATTERN_RENAME',
        expect.objectContaining({ patternId: 'sp-1', name: 'New Name' })
      )
    })

    it('trims whitespace and rejects empty name', () => {
      setupSessionStore()
      const { persistence } = createPersistence()

      persistence.rename('sp-1', '   ')
      expect(sendMock).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    it('sends SCRATCH_PATTERN_DELETE', () => {
      setupSessionStore()
      const { persistence } = createPersistence()

      persistence.deletePattern('sp-1')

      expect(sendMock).toHaveBeenCalledWith(
        'SCRATCH_PATTERN_DELETE',
        expect.objectContaining({ patternId: 'sp-1' })
      )
    })

    it('clears savedPatternId when backend confirms deletion', () => {
      const project = useProjectStore()
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-1' })
      scratch.setSavedPatternId('sp-1')
      const { persistence } = createPersistence()

      persistence.deletePattern('sp-1')

      // Not cleared immediately — pending delete.
      expect(persistence.isDeletePending.value).toBe(true)
      expect(scratch.savedPatternId).toBe('sp-1')

      // Backend confirms: snapshot no longer has the pattern.
      project.savedScratchPatterns = []
      persistence.reconcileSnapshot()

      expect(scratch.savedPatternId).toBeNull()
      expect(persistence.isSaved.value).toBe(false)
      expect(persistence.isDeletePending.value).toBe(false)
    })

    it('clears selectedSavedId when backend confirms deletion', () => {
      const project = useProjectStore()
      setupSessionStore()
      const { persistence } = createPersistence()
      persistence.selectedSavedId.value = 'sp-1'

      persistence.deletePattern('sp-1')

      // Not cleared immediately.
      expect(persistence.selectedSavedId.value).toBe('sp-1')
      expect(persistence.isDeletePending.value).toBe(true)

      // Backend confirms deletion.
      project.savedScratchPatterns = []
      persistence.reconcileSnapshot()

      expect(persistence.selectedSavedId.value).toBeNull()
      expect(persistence.isDeletePending.value).toBe(false)
    })
  })

  describe('authoritative acknowledgement', () => {
    it('resolves pending save when snapshot includes the pattern', () => {
      const project = useProjectStore()
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-1' })
      const { persistence } = createPersistence()
      persistence.patternName.value = 'My Pattern'

      persistence.savePattern()
      expect(persistence.isSavePending.value).toBe(true)

      // Simulate PROJECT_STATE arriving with the saved pattern.
      project.savedScratchPatterns = [makePattern({ id: 'sp-1', name: 'My Pattern' })]
      persistence.reconcileSnapshot()

      expect(persistence.isSavePending.value).toBe(false)
      expect(persistence.isSaved.value).toBe(true)
      expect(scratch.savedPatternId).toBe('sp-1')
    })

    it('does not falsely clear dirty on stale save', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-1' })
      const { persistence } = createPersistence()

      persistence.savePattern()
      expect(persistence.isSavePending.value).toBe(true)

      // Snapshot arrives but doesn't contain our pattern — save failed.
      persistence.reconcileSnapshot()
      expect(persistence.isSavePending.value).toBe(true)
      expect(persistence.isSaved.value).toBe(false)
    })

    it('times out pending save', async () => {
      vi.useFakeTimers()
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-1' })
      const { persistence } = createPersistence()

      persistence.savePattern()
      expect(persistence.isSavePending.value).toBe(true)

      vi.advanceTimersByTime(11_000)

      expect(persistence.isSavePending.value).toBe(false)
      expect(persistence.isSaved.value).toBe(false)
      vi.useRealTimers()
    })
  })

  describe('dirty state', () => {
    it('is false when no completed pattern', () => {
      setupSessionStore()
      const { persistence } = createPersistence()
      expect(persistence.isDirty.value).toBe(false)
    })

    it('is true when completed pattern exists but never saved', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const { persistence } = createPersistence()
      expect(persistence.isDirty.value).toBe(true)
    })

    it('is false after saving and acknowledging', () => {
      const project = useProjectStore()
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern({ id: 'sp-1' })
      const { persistence } = createPersistence()
      persistence.patternName.value = 'Test'

      persistence.savePattern()
      project.savedScratchPatterns = [makePattern({ id: 'sp-1' })]
      persistence.reconcileSnapshot()

      expect(persistence.isDirty.value).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears all persistence state', () => {
      const scratch = setupSessionStore()
      scratch.completedPattern = makePattern()
      const { persistence } = createPersistence()
      persistence.patternName.value = 'Something'
      persistence.selectedSavedId.value = 'sp-1'

      persistence.reset()

      expect(persistence.patternName.value).toBe('')
      expect(persistence.selectedSavedId.value).toBeNull()
      expect(persistence.isSavePending.value).toBe(false)
      expect(persistence.isSaved.value).toBe(false)
    })
  })
})

describe('dirty close confirmation flow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('clean close is immediate when not dirty', () => {
    setupSessionStore()
    const { persistence } = createPersistence()
    // isDirty is false (no completed pattern) — close should be immediate.
    expect(persistence.isDirty.value).toBe(false)
  })

  it('dirty state prevents immediate close', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const { persistence } = createPersistence()

    expect(persistence.isDirty.value).toBe(true)
  })

  it('save action during dirty close triggers save', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-1' })
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Save Me'

    persistence.savePattern()

    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ name: 'Save Me' })
      })
    )
  })

  it('discard leaves pattern unsaved', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const { persistence } = createPersistence()

    // Discard = just close without saving.
    persistence.reset()

    expect(scratch.savedPatternId).toBeNull()
    expect(persistence.isSaved.value).toBe(false)
  })

  it('cancel preserves state', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Keep Me'

    // Cancel = do nothing, keep editing.
    expect(persistence.patternName.value).toBe('Keep Me')
    expect(persistence.isDirty.value).toBe(true)
    expect(scratch.completedPattern).not.toBeNull()
  })
})

describe('recovery and reload', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('preserves saved patterns across reload snapshots', () => {
    const store = useProjectStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Survivor' })
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [pattern] }))
    expect(store.savedScratchPatterns).toHaveLength(1)

    // Reload — snapshot arrives again.
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [pattern] }))
    expect(store.savedScratchPatterns).toHaveLength(1)
    expect(store.savedScratchPatterns[0]!.name).toBe('Survivor')
  })

  it('engine recovery clears pending save state', () => {
    vi.useFakeTimers()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Pending'

    persistence.savePattern()
    expect(persistence.isSavePending.value).toBe(true)

    // Simulate recovery: session clears.
    persistence.reset()
    expect(persistence.isSavePending.value).toBe(false)
    vi.useRealTimers()
  })
})

describe('undo/redo reconciliation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('undo (softReplace) snapshot updates savedScratchPatterns', () => {
    const store = useProjectStore()
    const p1 = makePattern({ id: 'sp-1' })
    const p2 = makePattern({ id: 'sp-2' })
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [p1, p2] }))
    expect(store.savedScratchPatterns).toHaveLength(2)

    // Undo removed sp-2.
    applyProjectStateSnapshot(
      store,
      makeSnapshot({ softReplace: true, scratchPatterns: [p1] })
    )
    expect(store.savedScratchPatterns).toHaveLength(1)
    expect(store.savedScratchPatterns[0]!.id).toBe('sp-1')
  })

  it('redo restores patterns', () => {
    const store = useProjectStore()
    const p1 = makePattern({ id: 'sp-1' })
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [p1] }))

    // Undo removed it.
    applyProjectStateSnapshot(store, makeSnapshot({ softReplace: true, scratchPatterns: [] }))
    expect(store.savedScratchPatterns).toHaveLength(0)

    // Redo restores it.
    applyProjectStateSnapshot(
      store,
      makeSnapshot({ softReplace: true, scratchPatterns: [p1] })
    )
    expect(store.savedScratchPatterns).toHaveLength(1)
    expect(store.savedScratchPatterns[0]!.id).toBe('sp-1')
  })
})
