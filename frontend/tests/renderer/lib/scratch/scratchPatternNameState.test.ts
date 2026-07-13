// Tests for scratch pattern persistence name-state behaviour:
// - Name-only changes enable Update / trigger dirty close
// - Authoritative backend rename merges into dirty content without losing edits
// - Explicit subsequent local rename after authoritative merge
// - Transient new drafts have editable names and save correctly

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
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

vi.mock('@/lib/audio/db', () => ({
  MAX_TRACK_GAIN_LINEAR: 2,
  dbToLinear: vi.fn((db: number) => Math.pow(10, db / 20))
}))

vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => 'uuid-test')
})
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

describe('name-only dirty / close / update', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('editing only the pattern name makes the draft dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    // Save and acknowledge so baseline is established.
    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Change only the name via the text field.
    persistence.patternName.value = 'Renamed Only'

    expect(persistence.isDirty.value).toBe(true)
  })

  it('name-only dirty blocks close (triggers dirty-close guard)', () => {
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

    // Only change the name.
    persistence.patternName.value = 'Different Name'

    // isDirty gate prevents immediate close.
    expect(persistence.isDirty.value).toBe(true)
  })

  it('name-only dirty enables Update and sends the new name', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Before' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Before'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    sendMock.mockClear()

    // Name-only edit.
    persistence.patternName.value = 'After'
    expect(persistence.isDirty.value).toBe(true)

    // Update should fire with new name.
    persistence.updatePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'After' })
      })
    )
  })

  it('name change pushed into completedPattern is reflected in canonicalization', () => {
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Alpha' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Alpha'

    // Change name.
    persistence.patternName.value = 'Beta'

    // completedPattern.name should now be 'Beta'.
    expect(scratch.completedPattern?.name).toBe('Beta')
  })

  it('empty/whitespace-only name does not make draft dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Stable' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Stable'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Set name to whitespace — draft name should NOT change.
    persistence.patternName.value = '   '
    expect(persistence.isDirty.value).toBe(false)
    expect(scratch.completedPattern?.name).toBe('Stable')
  })
})

describe('authoritative rename merged into dirty content', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges authoritative name into dirty draft without losing lane edits', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    // Save and acknowledge.
    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Make a local lane edit (dirty content).
    const dirtyPlatter = [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 500_000, turns: 3, touched: true },
      { timeUs: 1_000_000, turns: 5, touched: false }
    ]
    scratch.replacePattern({ ...pattern, platter: dirtyPlatter })
    expect(persistence.isDirty.value).toBe(true)

    // Backend authoritatively renames (snapshot has only name change from original).
    const renamed = makePattern({ id: 'sp-1', name: 'Authoritative Name' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    // Name merged into draft + UI field.
    expect(scratch.completedPattern?.name).toBe('Authoritative Name')
    expect(persistence.patternName.value).toBe('Authoritative Name')

    // Lane edits preserved.
    expect(scratch.completedPattern?.platter).toEqual(dirtyPlatter)

    // Still dirty because lane data differs from baseline.
    expect(persistence.isDirty.value).toBe(true)
  })

  it('Update after authoritative merge sends authoritative name, not old name', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Old Name' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Old Name'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    // Local crop edit.
    scratch.replacePattern({ ...pattern, cropStartUs: 100_000 })
    expect(persistence.isDirty.value).toBe(true)

    // Authoritative rename arrives.
    const renamed = makePattern({ id: 'sp-1', name: 'New Auth Name' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()
    sendMock.mockClear()

    // User hits Update — should use authoritative name.
    persistence.updatePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'New Auth Name' })
      })
    )
  })

  it('authoritative rename on clean draft keeps draft clean', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'V1' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'V1'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Authoritative rename (no local edits).
    const renamed = makePattern({ id: 'sp-1', name: 'V2' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.name).toBe('V2')
    expect(persistence.patternName.value).toBe('V2')
    expect(persistence.isDirty.value).toBe(false)
  })
})

describe('explicit subsequent local rename after authoritative merge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('local rename after authoritative merge overrides for next Update', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Start' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Start'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    // Local lane edit to make dirty.
    scratch.replacePattern({ ...pattern, cropStartUs: 50_000 })

    // Authoritative rename.
    const renamed = makePattern({ id: 'sp-1', name: 'Auth' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    expect(persistence.patternName.value).toBe('Auth')
    expect(scratch.completedPattern?.name).toBe('Auth')

    // User explicitly renames again.
    persistence.patternName.value = 'User Override'

    expect(scratch.completedPattern?.name).toBe('User Override')
    expect(persistence.isDirty.value).toBe(true)

    sendMock.mockClear()
    persistence.updatePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'User Override' })
      })
    )
  })

  it('user rename back to baseline name clears dirty (name dimension)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Baseline' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Baseline'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    // Change name.
    persistence.patternName.value = 'Something Else'
    expect(persistence.isDirty.value).toBe(true)

    // Change name back to baseline.
    persistence.patternName.value = 'Baseline'
    expect(persistence.isDirty.value).toBe(false)
  })
})

describe('transient new drafts: editable names and save', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('new recording seeds patternName from completedPattern', () => {
    const scratch = setupSessionStore()
    const { persistence } = createPersistence()

    // Simulate pattern recorded event.
    scratch.applyPatternRecorded({
      protocolVersion: 1,
      sessionId: 'session-1',
      pattern: makePattern({ id: 'sp-new', name: 'Recorded' })
    })

    expect(persistence.patternName.value).toBe('Recorded')
  })

  it('new draft with edited name saves using the edited name', () => {
    const scratch = setupSessionStore()
    const { persistence } = createPersistence()

    scratch.applyPatternRecorded({
      protocolVersion: 1,
      sessionId: 'session-1',
      pattern: makePattern({ id: 'sp-new', name: 'Recorded' })
    })

    // User edits the name before first save.
    persistence.patternName.value = 'Custom Name'

    persistence.savePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-new', name: 'Custom Name' })
      })
    )
  })

  it('new transient draft is always dirty (no baseline)', () => {
    const scratch = setupSessionStore()
    const { persistence } = createPersistence()

    scratch.applyPatternRecorded({
      protocolVersion: 1,
      sessionId: 'session-1',
      pattern: makePattern({ id: 'sp-new', name: 'Fresh' })
    })

    expect(persistence.isDirty.value).toBe(true)
  })

  it('name edited on transient draft is reflected in completedPattern', () => {
    const scratch = setupSessionStore()
    const { persistence } = createPersistence()

    scratch.applyPatternRecorded({
      protocolVersion: 1,
      sessionId: 'session-1',
      pattern: makePattern({ id: 'sp-new', name: 'Default' })
    })

    persistence.patternName.value = 'My Scratch'
    expect(scratch.completedPattern?.name).toBe('My Scratch')
  })
})
