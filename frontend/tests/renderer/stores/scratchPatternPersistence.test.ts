import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { applyProjectStateSnapshot } from '@/stores/projectSnapshot'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import { SCRATCH_PROTOCOL_VERSION } from '@shared/bridge-protocol'
import {
  makePattern,
  makeSnapshot
} from '../lib/scratch/scratchPersistenceTestSupport'

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

describe('project snapshot scratch pattern reconciliation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reconciles scratch patterns from snapshot', () => {
    const store = useProjectStore()
    const pattern = makePattern()
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [pattern] }))
    expect(store.savedScratchPatterns).toHaveLength(1)
    expect(store.savedScratchPatterns[0]!.id).toBe('sp-1')
    expect(store.savedScratchPatterns[0]!.name).toBe('Test')
  })

  it('uses empty array when scratchPatterns is absent (older project)', () => {
    const store = useProjectStore()
    applyProjectStateSnapshot(store, makeSnapshot())
    expect(store.savedScratchPatterns).toEqual([])
  })

  it('reconciles multiple patterns preserving order', () => {
    const store = useProjectStore()
    const p1 = makePattern({ id: 'sp-1', name: 'First' })
    const p2 = makePattern({ id: 'sp-2', name: 'Second' })
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [p1, p2] }))
    expect(store.savedScratchPatterns).toHaveLength(2)
    expect(store.savedScratchPatterns[0]!.id).toBe('sp-1')
    expect(store.savedScratchPatterns[1]!.id).toBe('sp-2')
  })

  it('clears savedScratchPatterns on reset snapshot', () => {
    const store = useProjectStore()
    // Seed with patterns.
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [makePattern()] }))
    expect(store.savedScratchPatterns).toHaveLength(1)
    // Reset clears patterns (no scratchPatterns field in the new snapshot).
    applyProjectStateSnapshot(store, makeSnapshot({ reset: true }))
    expect(store.savedScratchPatterns).toEqual([])
  })

  it('clears savedScratchPatterns on softReplace with no patterns', () => {
    const store = useProjectStore()
    applyProjectStateSnapshot(store, makeSnapshot({ scratchPatterns: [makePattern()] }))
    expect(store.savedScratchPatterns).toHaveLength(1)
    applyProjectStateSnapshot(store, makeSnapshot({ softReplace: true }))
    expect(store.savedScratchPatterns).toEqual([])
  })
})

describe('project store scratch pattern actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockReturnValue(true)
    sendMock.mockClear()
  })

  it('saveScratchPattern sends SCRATCH_PATTERN_SAVE', () => {
    const store = useProjectStore()
    const pattern = makePattern()
    store.saveScratchPattern('session-1', pattern)
    expect(sendMock).toHaveBeenCalledWith('SCRATCH_PATTERN_SAVE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId: 'session-1',
      pattern
    })
  })

  it('deleteScratchPattern sends SCRATCH_PATTERN_DELETE', () => {
    const store = useProjectStore()
    store.deleteScratchPattern('sp-1')
    expect(sendMock).toHaveBeenCalledWith('SCRATCH_PATTERN_DELETE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
  })

  it('renameScratchPattern sends SCRATCH_PATTERN_RENAME', () => {
    const store = useProjectStore()
    store.renameScratchPattern('sp-1', 'New Name')
    expect(sendMock).toHaveBeenCalledWith('SCRATCH_PATTERN_RENAME', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1',
      name: 'New Name'
    })
  })
})

describe('scratch session store savedPatternId and dirty detection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('savedPatternId defaults to null', () => {
    const store = useScratchSessionStore()
    expect(store.savedPatternId).toBeNull()
  })

  it('setSavedPatternId stores the id', () => {
    const store = useScratchSessionStore()
    store.setSavedPatternId('sp-1')
    expect(store.savedPatternId).toBe('sp-1')
  })

  it('isSavedPatternDirty is false when no completedPattern', () => {
    const store = useScratchSessionStore()
    expect(store.isSavedPatternDirty).toBe(false)
  })

  it('isSavedPatternDirty is true when completedPattern exists but not saved', () => {
    const store = useScratchSessionStore()
    store.completedPattern = makePattern()
    expect(store.isSavedPatternDirty).toBe(true)
  })

  it('isSavedPatternDirty is false when completedPattern matches saved baseline', () => {
    const store = useScratchSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    store.completedPattern = pattern
    store.setSavedPatternId('sp-1', canonicalizeScratchPattern(pattern))
    expect(store.isSavedPatternDirty).toBe(false)
  })

  it('isSavedPatternDirty is true when completedPattern content differs from baseline', () => {
    const store = useScratchSessionStore()
    const original = makePattern({ id: 'sp-1', name: 'Original' })
    store.completedPattern = makePattern({ id: 'sp-1', name: 'Edited' })
    store.setSavedPatternId('sp-1', canonicalizeScratchPattern(original))
    expect(store.isSavedPatternDirty).toBe(true)
  })

  it('clearRecording resets savedPatternId', () => {
    const store = useScratchSessionStore()
    store.setSavedPatternId('sp-1')
    store.clearRecording()
    expect(store.savedPatternId).toBeNull()
  })

  it('clear resets savedPatternId', () => {
    const store = useScratchSessionStore()
    store.setSavedPatternId('sp-1')
    store.clear()
    expect(store.savedPatternId).toBeNull()
  })
})
