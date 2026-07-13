// Tests: pending save race conditions — save→rename/edit→ack sequences that
// must preserve newer draft content and correctly resolve or block close-save.

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
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

describe('race: save→rename/edit→old matching ack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ack after rename preserves newer draft name and keeps dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    persistence.savePattern()
    expect(persistence.isSavePending.value).toBe(true)

    scratch.replacePattern({ ...pattern, name: 'Renamed After Save' })

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(scratch.completedPattern?.name).toBe('Renamed After Save')
    expect(persistence.isDirty.value).toBe(true)
  })

  it('ack after lane edit preserves newer platter data and keeps dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()

    const edited = {
      ...pattern,
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 2, touched: true },
        { timeUs: 1_000_000, turns: 4, touched: false }
      ]
    }
    scratch.replacePattern(edited)

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(scratch.completedPattern?.platter).toHaveLength(3)
    expect(scratch.completedPattern?.platter[1]?.turns).toBe(2)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('ack after crop edit keeps dirty and does not overwrite crop', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', cropStartUs: 0, cropEndUs: 1_000_000 })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()

    scratch.replacePattern({ ...pattern, cropStartUs: 200_000 })

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(scratch.completedPattern?.cropStartUs).toBe(200_000)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('close-save is not acknowledged when user edits after saveAndClose', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Close Me' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Close Me'

    persistence.saveAndClose()
    expect(persistence.isCloseSavePending.value).toBe(true)

    scratch.replacePattern({ ...pattern, cropStartUs: 100_000 })

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.closeSaveAcknowledged.value).toBe(false)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('subsequent update after stale ack saves and acknowledges correctly', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const original = makePattern({ id: 'sp-1', name: 'V1' })
    scratch.completedPattern = original
    const { persistence } = createPersistence()
    persistence.patternName.value = 'V1'

    persistence.savePattern()

    const v2 = makePattern({ id: 'sp-1', name: 'V2', cropStartUs: 300_000 })
    scratch.replacePattern(v2)
    persistence.patternName.value = 'V2'

    project.savedScratchPatterns = [original]
    persistence.reconcileSnapshot()
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
    sendMock.mockClear()

    persistence.updatePattern()
    expect(persistence.isSavePending.value).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'V2', cropStartUs: 300_000 })
      })
    )

    project.savedScratchPatterns = [v2]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('ack still fully acknowledges when draft has not changed since save', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Stable' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Stable'

    persistence.savePattern()

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })
})

describe('race: update B → local name/content C → authoritative B ack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves local name C when authoritative B ack arrives after update', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'A' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'A'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')
    expect(persistence.isDirty.value).toBe(false)

    const patternB = makePattern({ id: 'sp-1', name: 'B', cropStartUs: 100_000 })
    scratch.replacePattern(patternB)
    persistence.patternName.value = 'B'
    persistence.updatePattern()
    expect(persistence.isSavePending.value).toBe(true)

    scratch.replacePattern({ ...patternB, name: 'C' })
    persistence.patternName.value = 'C'

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.name).toBe('C')
    expect(persistence.patternName.value).toBe('C')
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('preserves local content C when authoritative B ack arrives after update', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'Test' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')

    const patternB = makePattern({ id: 'sp-1', name: 'Test', cropStartUs: 200_000 })
    scratch.replacePattern(patternB)
    persistence.updatePattern()
    expect(persistence.isSavePending.value).toBe(true)

    const patternC = makePattern({ id: 'sp-1', name: 'Test', cropStartUs: 400_000 })
    scratch.replacePattern(patternC)

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.cropStartUs).toBe(400_000)
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('preserves local lane edits C when authoritative B ack arrives after update', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'Lanes' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Lanes'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')

    const patternB = makePattern({
      id: 'sp-1',
      name: 'Lanes',
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 2, touched: true },
        { timeUs: 1_000_000, turns: 3, touched: false }
      ]
    })
    scratch.replacePattern(patternB)
    persistence.updatePattern()

    const patternC = makePattern({
      id: 'sp-1',
      name: 'Lanes',
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 250_000, turns: 5, touched: true },
        { timeUs: 750_000, turns: 8, touched: true },
        { timeUs: 1_000_000, turns: 10, touched: false }
      ]
    })
    scratch.replacePattern(patternC)

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.platter).toHaveLength(4)
    expect(scratch.completedPattern?.platter[1]?.turns).toBe(5)
    expect(scratch.completedPattern?.platter[2]?.turns).toBe(8)
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('close-save does not close when local edit C diverges from submitted B', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'Close' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Close'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')

    const patternB = makePattern({ id: 'sp-1', name: 'Close', cropStartUs: 150_000 })
    scratch.replacePattern(patternB)
    persistence.saveAndClose()
    expect(persistence.isCloseSavePending.value).toBe(true)

    scratch.replacePattern({ ...patternB, cropStartUs: 350_000 })

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()

    expect(persistence.closeSaveAcknowledged.value).toBe(false)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.isDirty.value).toBe(true)
    expect(scratch.completedPattern?.cropStartUs).toBe(350_000)
  })

  it('close-save closes when draft still equals submitted B at ack time', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'Close' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Close'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')

    const patternB = makePattern({ id: 'sp-1', name: 'Close', cropStartUs: 150_000 })
    scratch.replacePattern(patternB)
    persistence.patternName.value = 'Close'
    persistence.saveAndClose()
    expect(persistence.isCloseSavePending.value).toBe(true)

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()

    expect(persistence.closeSaveAcknowledged.value).toBe(true)
    expect(persistence.isCloseSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('subsequent update after ack round-trips correctly', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const patternA = makePattern({ id: 'sp-1', name: 'V1' })
    scratch.completedPattern = patternA
    const { persistence } = createPersistence()
    persistence.patternName.value = 'V1'

    project.savedScratchPatterns = [patternA]
    persistence.selectAndLoad('sp-1')

    const patternB = makePattern({ id: 'sp-1', name: 'V2', cropStartUs: 100_000 })
    scratch.replacePattern(patternB)
    persistence.patternName.value = 'V2'
    persistence.updatePattern()

    const patternC = makePattern({ id: 'sp-1', name: 'V3', cropStartUs: 250_000 })
    scratch.replacePattern(patternC)
    persistence.patternName.value = 'V3'

    project.savedScratchPatterns = [patternB]
    persistence.reconcileSnapshot()
    expect(scratch.completedPattern?.name).toBe('V3')
    expect(scratch.completedPattern?.cropStartUs).toBe(250_000)
    expect(persistence.isDirty.value).toBe(true)
    sendMock.mockClear()

    persistence.updatePattern()
    expect(persistence.isSavePending.value).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'V3', cropStartUs: 250_000 })
      })
    )

    project.savedScratchPatterns = [patternC]
    persistence.reconcileSnapshot()
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })
})
