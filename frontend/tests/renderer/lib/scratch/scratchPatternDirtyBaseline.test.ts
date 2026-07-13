// Tests: dirty baseline behavior — save→edit becomes dirty, never-saved patterns,
// and load-then-edit transitions.

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import type { ScratchPattern } from '@shared/bridge-protocol'
import {
  SCRATCH_PATTERN_VERSION,
  SCRATCH_CROSSFADER_CURVE_VERSION
} from '@shared/bridge-protocol'

const sendMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

vi.mock('@/lib/audio/db', () => ({
  MAX_TRACK_GAIN_LINEAR: 2,
  dbToLinear: vi.fn((db: number) => Math.pow(10, db / 20))
}))

vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-test') })
vi.stubGlobal('window', {
  silverdaw: {
    readAudioMetadata: vi.fn().mockResolvedValue(null),
    readAudioFile: vi.fn().mockResolvedValue(null)
  }
})

function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'sp-1',
    name: 'Test',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ],
    ...overrides
  }
}

function setupSessionStore(sessionId: string = 'session-1') {
  const scratch = useScratchSessionStore()
  scratch.applyState({
    protocolVersion: 1,
    sessionId,
    clipId: 'clip-1',
    status: 'ready',
    positionUs: 0,
    durationUs: 1_000_000,
    platterTurns: 0,
    playbackRate: 1,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false
  })
  return scratch
}

function createPersistence(sessionId: string = 'session-1') {
  const sessionRef = ref<string | null>(sessionId)
  return { persistence: useScratchPatternPersistence(sessionRef), sessionRef }
}

describe('dirty state: save→edit becomes dirty', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is not dirty immediately after save+ack', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Saved' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Saved'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isDirty.value).toBe(false)
  })

  it('becomes dirty after editing name (same ID)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Saved' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Saved'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({ ...pattern, name: 'Edited Name' })
    expect(persistence.isDirty.value).toBe(true)
  })

  it('becomes dirty after editing crop (same ID)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', cropStartUs: 0, cropEndUs: 1_000_000 })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({ ...pattern, cropStartUs: 100_000 })
    expect(persistence.isDirty.value).toBe(true)
  })

  it('becomes dirty after editing platter lanes (same ID)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    const edited = {
      ...pattern,
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 0.5, touched: true },
        { timeUs: 1_000_000, turns: 2, touched: false }
      ]
    }
    scratch.replacePattern(edited)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('becomes dirty after editing provenance (same ID)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({
      id: 'sp-1',
      provenance: { sourceClipId: 'clip-a' }
    })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({
      ...pattern,
      provenance: { sourceClipId: 'clip-b' }
    })
    expect(persistence.isDirty.value).toBe(true)
  })
})

describe('dirty close guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('isDirty blocks close when pattern has unsaved edits', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Saved' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Saved'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({ ...pattern, cropStartUs: 50_000 })
    expect(persistence.isDirty.value).toBe(true)
  })

  it('isDirty is true for never-saved pattern', () => {
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const { persistence } = createPersistence()

    expect(persistence.isDirty.value).toBe(true)
  })

  it('isDirty is false after load (no edits)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern()
    const saved = makePattern({ id: 'sp-saved', name: 'Loaded' })
    project.savedScratchPatterns = [saved]
    const { persistence } = createPersistence()

    persistence.selectAndLoad('sp-saved')
    expect(persistence.isDirty.value).toBe(false)
  })
})

describe('reload behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('selectAndLoad sets baseline so no dirty after load', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-draft' })
    const saved = makePattern({ id: 'sp-saved', name: 'Loaded One' })
    project.savedScratchPatterns = [saved]
    const { persistence } = createPersistence()

    persistence.selectAndLoad('sp-saved')

    expect(persistence.isDirty.value).toBe(false)
    expect(scratch.savedPatternId).toBe('sp-saved')
    expect(scratch.savedCanonicalBaseline).toBe(canonicalizeScratchPattern(saved))
  })

  it('selectAndLoad then edit becomes dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-draft' })
    const saved = makePattern({ id: 'sp-saved', name: 'Loaded' })
    project.savedScratchPatterns = [saved]
    const { persistence } = createPersistence()

    persistence.selectAndLoad('sp-saved')
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({ ...saved, cropStartUs: 50_000 })
    expect(persistence.isDirty.value).toBe(true)
  })

  it('re-saving after reload acknowledges correctly', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    scratch.completedPattern = makePattern({ id: 'sp-draft' })
    const saved = makePattern({ id: 'sp-saved', name: 'Loaded' })
    project.savedScratchPatterns = [saved]
    const { persistence } = createPersistence()

    persistence.selectAndLoad('sp-saved')

    const edited = { ...saved, cropStartUs: 50_000 }
    scratch.replacePattern(edited)
    persistence.patternName.value = 'Loaded'

    persistence.updatePattern()
    expect(persistence.isSavePending.value).toBe(true)

    project.savedScratchPatterns = [edited]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })
})

describe('canonicalizeScratchPattern determinism', () => {
  it('produces identical output for identical patterns', () => {
    const p1 = makePattern({ id: 'sp-1', name: 'Test' })
    const p2 = makePattern({ id: 'sp-1', name: 'Test' })
    expect(canonicalizeScratchPattern(p1)).toBe(canonicalizeScratchPattern(p2))
  })

  it('produces different output for different names', () => {
    const p1 = makePattern({ name: 'Alpha' })
    const p2 = makePattern({ name: 'Beta' })
    expect(canonicalizeScratchPattern(p1)).not.toBe(canonicalizeScratchPattern(p2))
  })

  it('produces different output for different crop', () => {
    const p1 = makePattern({ cropStartUs: 0 })
    const p2 = makePattern({ cropStartUs: 100 })
    expect(canonicalizeScratchPattern(p1)).not.toBe(canonicalizeScratchPattern(p2))
  })

  it('handles provenance correctly', () => {
    const p1 = makePattern({ provenance: { sourceClipId: 'a' } })
    const p2 = makePattern({ provenance: { sourceClipId: 'b' } })
    const p3 = makePattern()
    expect(canonicalizeScratchPattern(p1)).not.toBe(canonicalizeScratchPattern(p2))
    expect(canonicalizeScratchPattern(p1)).not.toBe(canonicalizeScratchPattern(p3))
  })

  it('is stable across property insertion order', () => {
    const p1: ScratchPattern = {
      id: 'sp-1',
      name: 'Test',
      version: SCRATCH_PATTERN_VERSION,
      durationUs: 1_000_000,
      cropStartUs: 0,
      cropEndUs: 1_000_000,
      sourceOffsetTurns: 0,
      ownerDeck: 1,
      crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 1_000_000, turns: 1, touched: false }
      ],
      crossfader: [
        { timeUs: 0, value: 0 },
        { timeUs: 1_000_000, value: 1 }
      ]
    }
    const p2 = {
      crossfader: [
        { value: 0, timeUs: 0 },
        { value: 1, timeUs: 1_000_000 }
      ],
      platter: [
        { touched: true, turns: 0, timeUs: 0 },
        { touched: false, turns: 1, timeUs: 1_000_000 }
      ],
      crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
      ownerDeck: 1 as const,
      sourceOffsetTurns: 0,
      cropEndUs: 1_000_000,
      cropStartUs: 0,
      durationUs: 1_000_000,
      version: SCRATCH_PATTERN_VERSION,
      name: 'Test',
      id: 'sp-1'
    } satisfies ScratchPattern
    expect(canonicalizeScratchPattern(p1)).toBe(canonicalizeScratchPattern(p2))
  })
})
