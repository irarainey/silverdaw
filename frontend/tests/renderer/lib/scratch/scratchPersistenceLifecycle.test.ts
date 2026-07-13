// Regression tests for Scratch persistence lifecycle blockers:
// 1. Authoritative rename: clean/dirty draft handling.
// 2. Delete rejection/ack (pending delete, timeout recovery).
// 3. Dirty-close save: matching ack closes, timeout/failure preserves state.

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import {
  createPersistence,
  makePattern,
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

// ── 1. Authoritative rename: clean vs dirty ──────────────────────────────────

describe('authoritative rename – clean draft', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('updates draft name and baseline when draft is clean', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    // Save + acknowledge.
    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Backend renames.
    const renamed = makePattern({ id: 'sp-1', name: 'Renamed' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    // Draft stays clean; name is synced everywhere.
    expect(persistence.isDirty.value).toBe(false)
    expect(scratch.completedPattern?.name).toBe('Renamed')
    expect(persistence.patternName.value).toBe('Renamed')
    expect(scratch.savedCanonicalBaseline).toBe(canonicalizeScratchPattern(renamed))
  })

  it('remains clean when rename is the only snapshot change', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'A' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'A'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    // Rename twice in sequence.
    project.savedScratchPatterns = [makePattern({ id: 'sp-1', name: 'B' })]
    persistence.reconcileSnapshot()
    project.savedScratchPatterns = [makePattern({ id: 'sp-1', name: 'C' })]
    persistence.reconcileSnapshot()

    expect(persistence.isDirty.value).toBe(false)
    expect(scratch.completedPattern?.name).toBe('C')
  })
})

describe('authoritative rename – dirty draft', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('updates baseline only, preserves local edits (stays dirty)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    // Save + acknowledge.
    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    // Make local edit (dirty).
    const localEdit = { ...pattern, cropStartUs: 50_000 }
    scratch.replacePattern(localEdit)
    expect(persistence.isDirty.value).toBe(true)

    // Backend renames.
    const renamed = makePattern({ id: 'sp-1', name: 'Renamed' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    // Still dirty — local crop edit preserved, authoritative name merged.
    expect(persistence.isDirty.value).toBe(true)
    expect(scratch.completedPattern?.cropStartUs).toBe(50_000)
    expect(scratch.completedPattern?.name).toBe('Renamed')
  })

  it('dirty draft name is overwritten by authoritative rename', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Base' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Base'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    // Locally edit the name.
    scratch.replacePattern({ ...pattern, name: 'My Local Name' })
    persistence.patternName.value = 'My Local Name'
    expect(persistence.isDirty.value).toBe(true)

    // Backend renames authoritatively.
    project.savedScratchPatterns = [makePattern({ id: 'sp-1', name: 'Backend Name' })]
    persistence.reconcileSnapshot()

    // Authoritative name takes precedence; name-only dirty is resolved.
    expect(scratch.completedPattern?.name).toBe('Backend Name')
    expect(persistence.isDirty.value).toBe(false)
  })
})

// ── 2. Delete: rejection/ack ─────────────────────────────────────────────────

describe('delete – pending until backend ack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('enters pending state on delete', () => {
    setupSessionStore()
    const { persistence } = createPersistence()

    persistence.deletePattern('sp-1')

    expect(persistence.isDeletePending.value).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_DELETE',
      expect.objectContaining({ patternId: 'sp-1' })
    )
  })

  it('does not clear state until snapshot confirms absence', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Saved' })
    scratch.completedPattern = pattern
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(pattern))
    const { persistence } = createPersistence()
    persistence.selectedSavedId.value = 'sp-1'

    persistence.deletePattern('sp-1')

    // Still present — snapshot hasn't confirmed yet.
    expect(scratch.savedPatternId).toBe('sp-1')
    expect(persistence.selectedSavedId.value).toBe('sp-1')

    // Snapshot still has it (rejected or delayed).
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isDeletePending.value).toBe(true)
    expect(scratch.savedPatternId).toBe('sp-1')
  })

  it('clears state when snapshot confirms deletion', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    scratch.completedPattern = pattern
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(pattern))
    const { persistence } = createPersistence()
    persistence.selectedSavedId.value = 'sp-1'

    persistence.deletePattern('sp-1')

    // Backend confirms — pattern absent.
    project.savedScratchPatterns = []
    persistence.reconcileSnapshot()

    expect(persistence.isDeletePending.value).toBe(false)
    expect(scratch.savedPatternId).toBeNull()
    expect(persistence.selectedSavedId.value).toBeNull()
    expect(persistence.isSaved.value).toBe(false)
  })

  it('rejected delete keeps prior state and allows retry', () => {
    vi.useFakeTimers()
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Keep Me' })
    scratch.completedPattern = pattern
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(pattern))
    const { persistence } = createPersistence()
    persistence.selectedSavedId.value = 'sp-1'

    persistence.deletePattern('sp-1')
    expect(persistence.isDeletePending.value).toBe(true)

    // Snapshot still has the pattern (rejection).
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDeletePending.value).toBe(true)

    // Simulate timeout.
    vi.advanceTimersByTime(11_000)

    expect(persistence.isDeletePending.value).toBe(false)
    // Prior state preserved — can retry.
    expect(scratch.savedPatternId).toBe('sp-1')
    expect(persistence.selectedSavedId.value).toBe('sp-1')

    // Retry: send delete again.
    sendMock.mockClear()
    persistence.deletePattern('sp-1')
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_DELETE',
      expect.objectContaining({ patternId: 'sp-1' })
    )
    expect(persistence.isDeletePending.value).toBe(true)
    vi.useRealTimers()
  })

  it('timed-out delete preserves baseline and selection', () => {
    vi.useFakeTimers()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    scratch.completedPattern = pattern
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(pattern))
    const { persistence } = createPersistence()
    persistence.selectedSavedId.value = 'sp-1'

    persistence.deletePattern('sp-1')
    vi.advanceTimersByTime(11_000)

    expect(persistence.isDeletePending.value).toBe(false)
    expect(scratch.savedPatternId).toBe('sp-1')
    expect(persistence.selectedSavedId.value).toBe('sp-1')
    vi.useRealTimers()
  })
})

// ── 3. Dirty-close save: ack and timeout/failure ─────────────────────────────

describe('dirty-close save – matching ack closes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('saveAndClose sets pending state and sends save', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-1' })
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Close Me'

    persistence.saveAndClose()

    expect(persistence.isCloseSavePending.value).toBe(true)
    expect(persistence.isSavePending.value).toBe(true)
    expect(persistence.closeSaveAcknowledged.value).toBe(false)
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ name: 'Close Me' })
      })
    )
  })

  it('sets closeSaveAcknowledged when matching snapshot arrives', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Save Me' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Save Me'

    persistence.saveAndClose()
    expect(persistence.closeSaveAcknowledged.value).toBe(false)

    // Matching snapshot arrives.
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.closeSaveAcknowledged.value).toBe(true)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.isSavePending.value).toBe(false)
  })

  it('does not acknowledge on stale snapshot', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'New' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'New'

    persistence.saveAndClose()

    // Stale snapshot (old content).
    const stale = makePattern({ id: 'sp-1', name: 'Old' })
    project.savedScratchPatterns = [stale]
    persistence.reconcileSnapshot()

    expect(persistence.closeSaveAcknowledged.value).toBe(false)
    expect(persistence.isCloseSavePending.value).toBe(true)
  })

  it('uses updatePattern when savedPatternId exists', () => {
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Update' })
    scratch.completedPattern = pattern
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(makePattern({ id: 'sp-1', name: 'Old' })))
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Update'

    persistence.saveAndClose()

    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'Update' })
      })
    )
  })
})

describe('dirty-close save – timeout/failure preserves state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('on timeout: remains open, preserves draft, shows error', () => {
    vi.useFakeTimers()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-1', name: 'Pending' })
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Pending'

    persistence.saveAndClose()
    expect(persistence.isCloseSavePending.value).toBe(true)

    vi.advanceTimersByTime(11_000)

    // Not acknowledged — dialog stays open.
    expect(persistence.closeSaveAcknowledged.value).toBe(false)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.saveError.value).toBeTruthy()
    // Draft preserved.
    expect(scratch.completedPattern?.name).toBe('Pending')
    expect(persistence.patternName.value).toBe('Pending')
    vi.useRealTimers()
  })

  it('dismissCloseSaveError clears the error', () => {
    vi.useFakeTimers()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-1' })
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Err'

    persistence.saveAndClose()
    vi.advanceTimersByTime(11_000)
    expect(persistence.saveError.value).toBeTruthy()

    persistence.dismissCloseSaveError()
    expect(persistence.saveError.value).toBeNull()
    vi.useRealTimers()
  })

  it('cancel/discard semantics are unchanged during close-save', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-1', name: 'Draft' })
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Draft'

    // Simulate cancel — just don't call saveAndClose, state preserved.
    expect(persistence.isDirty.value).toBe(true)
    expect(scratch.completedPattern).not.toBeNull()

    // Simulate discard — reset clears.
    persistence.reset()
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.closeSaveAcknowledged.value).toBe(false)
  })

  it('retry after timeout triggers a new save', () => {
    vi.useFakeTimers()
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Retry' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Retry'

    persistence.saveAndClose()
    vi.advanceTimersByTime(11_000)
    expect(persistence.saveError.value).toBeTruthy()
    vi.useRealTimers()

    // User clicks retry.
    sendMock.mockClear()
    persistence.saveAndClose()

    expect(persistence.isCloseSavePending.value).toBe(true)
    expect(persistence.isSavePending.value).toBe(true)
    expect(persistence.saveError.value).toBeNull()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ name: 'Retry' })
      })
    )

    // Ack arrives this time.
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.closeSaveAcknowledged.value).toBe(true)
  })
})
