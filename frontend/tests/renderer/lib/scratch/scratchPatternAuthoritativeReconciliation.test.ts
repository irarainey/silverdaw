// Tests: authoritative reconciliation — clean draft replacement on undo/redo,
// dirty draft preservation, stale/matching snapshot acknowledgement, and
// name/delete authoritative update behavior.

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('stale same-ID snapshot does not acknowledge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('does not acknowledge when snapshot has same ID but old content', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const original = makePattern({ id: 'sp-1', name: 'Original' })
    const updated = makePattern({ id: 'sp-1', name: 'Updated' })
    scratch.completedPattern = updated
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Updated'

    persistence.savePattern()
    expect(persistence.isSavePending.value).toBe(true)

    project.savedScratchPatterns = [original]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(true)
    expect(persistence.isSaved.value).toBe(false)
  })

  it('does not clear dirty when stale snapshot arrives', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const original = makePattern({ id: 'sp-1', name: 'V1', cropStartUs: 0 })
    const edited = makePattern({ id: 'sp-1', name: 'V2', cropStartUs: 200_000 })
    scratch.completedPattern = edited
    const { persistence } = createPersistence()
    persistence.patternName.value = 'V2'

    persistence.savePattern()

    project.savedScratchPatterns = [original]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(true)
    expect(persistence.isDirty.value).toBe(true)
  })
})

describe('matching snapshot does acknowledge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('acknowledges when snapshot content exactly matches submitted', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Exact Match' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Exact Match'

    persistence.savePattern()
    expect(persistence.isSavePending.value).toBe(true)

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('acknowledges update when snapshot matches updated content', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const original = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = original
    scratch.setSavedPatternId('sp-1', canonicalizeScratchPattern(original))
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Updated'

    const edited = makePattern({ id: 'sp-1', name: 'Updated', cropStartUs: 100_000 })
    scratch.replacePattern(edited)
    persistence.updatePattern()

    project.savedScratchPatterns = [edited]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('eventually acknowledges after initially stale then fresh snapshot', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const submitted = makePattern({ id: 'sp-1', name: 'New Content' })
    scratch.completedPattern = submitted
    const { persistence } = createPersistence()
    persistence.patternName.value = 'New Content'

    persistence.savePattern()

    const stale = makePattern({ id: 'sp-1', name: 'Old Content' })
    project.savedScratchPatterns = [stale]
    persistence.reconcileSnapshot()
    expect(persistence.isSavePending.value).toBe(true)

    project.savedScratchPatterns = [submitted]
    persistence.reconcileSnapshot()
    expect(persistence.isSavePending.value).toBe(false)
    expect(persistence.isSaved.value).toBe(true)
  })
})

describe('authoritative reconciliation: clean draft replaced on undo/redo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('replaces draft wholesale when clean and authoritative lane changes (undo)', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Lane Test' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Lane Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    const undonePattern = makePattern({
      id: 'sp-1',
      name: 'Lane Test',
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 2, touched: true },
        { timeUs: 1_000_000, turns: 4, touched: false }
      ]
    })
    project.savedScratchPatterns = [undonePattern]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.platter).toEqual(undonePattern.platter)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('replaces draft wholesale when clean and authoritative crop changes (redo)', () => {
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

    const redonePattern = makePattern({
      id: 'sp-1',
      cropStartUs: 100_000,
      cropEndUs: 900_000
    })
    project.savedScratchPatterns = [redonePattern]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.cropStartUs).toBe(100_000)
    expect(scratch.completedPattern?.cropEndUs).toBe(900_000)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('replaces draft wholesale when clean and authoritative provenance changes', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', provenance: undefined })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    const withProvenance = makePattern({
      id: 'sp-1',
      provenance: { sourceClipId: 'clip-99', sourceLibraryItemId: 'lib-42' }
    })
    project.savedScratchPatterns = [withProvenance]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.provenance?.sourceClipId).toBe('clip-99')
    expect(scratch.completedPattern?.provenance?.sourceLibraryItemId).toBe('lib-42')
    expect(persistence.isDirty.value).toBe(false)
  })

  it('advances baseline correctly after clean replacement so subsequent edits detect dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Test'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    const undone = makePattern({ id: 'sp-1', cropStartUs: 50_000 })
    project.savedScratchPatterns = [undone]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    scratch.replacePattern({ ...undone, cropEndUs: 800_000 })
    expect(persistence.isDirty.value).toBe(true)
  })
})

describe('authoritative reconciliation: dirty draft preserved on undo/redo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('preserves local lane edits when dirty and authoritative crop changes', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Dirty' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Dirty'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    const localEdit = {
      ...pattern,
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 300_000, turns: 7, touched: true },
        { timeUs: 1_000_000, turns: 10, touched: false }
      ]
    }
    scratch.replacePattern(localEdit)
    expect(persistence.isDirty.value).toBe(true)

    const authoritativeUndo = makePattern({ id: 'sp-1', name: 'Dirty', cropStartUs: 50_000 })
    project.savedScratchPatterns = [authoritativeUndo]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.platter[1]?.turns).toBe(7)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('preserves local crop edits when dirty and authoritative lane changes', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Dirty' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Dirty'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    scratch.replacePattern({ ...pattern, cropStartUs: 200_000 })
    expect(persistence.isDirty.value).toBe(true)

    const authoritativeUndo = makePattern({
      id: 'sp-1',
      name: 'Dirty',
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 3, touched: true },
        { timeUs: 1_000_000, turns: 6, touched: false }
      ]
    })
    project.savedScratchPatterns = [authoritativeUndo]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.cropStartUs).toBe(200_000)
    expect(persistence.isDirty.value).toBe(true)
  })

  it('preserves local provenance edits when dirty and authoritative name/crop changes', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({
      id: 'sp-1',
      name: 'Original',
      provenance: { sourceClipId: 'clip-1' }
    })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    scratch.replacePattern({
      ...pattern,
      provenance: { sourceClipId: 'clip-2', sourceLibraryItemId: 'lib-99' }
    })
    expect(persistence.isDirty.value).toBe(true)

    const authoritativeUndo = makePattern({
      id: 'sp-1',
      name: 'Renamed',
      cropStartUs: 100_000,
      provenance: { sourceClipId: 'clip-1' }
    })
    project.savedScratchPatterns = [authoritativeUndo]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.name).toBe('Renamed')
    expect(persistence.patternName.value).toBe('Renamed')
    expect(scratch.completedPattern?.provenance?.sourceClipId).toBe('clip-2')
    expect(scratch.completedPattern?.provenance?.sourceLibraryItemId).toBe('lib-99')
    expect(persistence.isDirty.value).toBe(true)
  })

  it('updates baseline on dirty reconcile so conflict remains visible', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Base' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Base'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    scratch.replacePattern({ ...pattern, cropStartUs: 100_000 })
    expect(persistence.isDirty.value).toBe(true)

    const authCrop = makePattern({ id: 'sp-1', name: 'Base', cropStartUs: 50_000 })
    project.savedScratchPatterns = [authCrop]
    persistence.reconcileSnapshot()

    expect(scratch.savedCanonicalBaseline).toBe(canonicalizeScratchPattern(authCrop))
    expect(persistence.isDirty.value).toBe(true)

    scratch.replacePattern(authCrop)
    expect(persistence.isDirty.value).toBe(false)
  })

  it('pending save still preserves newer edits after authoritative reconciliation', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Pending' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Pending'

    persistence.savePattern()
    expect(persistence.isSavePending.value).toBe(true)

    scratch.replacePattern({ ...pattern, cropStartUs: 300_000 })

    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    expect(persistence.isSavePending.value).toBe(false)
    expect(scratch.completedPattern?.cropStartUs).toBe(300_000)
    expect(persistence.isDirty.value).toBe(true)
  })
})

describe('rename authoritative update behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('authoritative rename updates baseline without making draft dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Before Rename' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Before Rename'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    const renamed = makePattern({ id: 'sp-1', name: 'After Rename' })
    scratch.replacePattern(renamed)
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    expect(persistence.isDirty.value).toBe(false)
  })

  it('authoritative rename does not lose local lane edits', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    const localEdit = {
      ...pattern,
      platter: [
        { timeUs: 0, turns: 0, touched: true },
        { timeUs: 500_000, turns: 3, touched: true },
        { timeUs: 1_000_000, turns: 5, touched: false }
      ]
    }
    scratch.replacePattern(localEdit)
    expect(persistence.isDirty.value).toBe(true)

    const renamed = makePattern({ id: 'sp-1', name: 'Renamed' })
    project.savedScratchPatterns = [renamed]
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern?.platter[1]?.turns).toBe(3)
    expect(persistence.isDirty.value).toBe(true)
  })
})

describe('delete authoritative update behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('authoritative delete clears baseline and makes draft dirty', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'To Delete' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'To Delete'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    expect(persistence.isDirty.value).toBe(false)

    project.savedScratchPatterns = []
    persistence.reconcileSnapshot()

    expect(persistence.isDirty.value).toBe(true)
    expect(scratch.savedPatternId).toBeNull()
    expect(persistence.selectedSavedId.value).toBeNull()
  })

  it('authoritative delete preserves local completedPattern content', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Preserved' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Preserved'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()

    project.savedScratchPatterns = []
    persistence.reconcileSnapshot()

    expect(scratch.completedPattern).not.toBeNull()
    expect(scratch.completedPattern?.name).toBe('Preserved')
  })
})

describe('Update enabled / controller allows save when dirty', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
  })

  it('updatePattern sends save when dirty after edit', () => {
    const project = useProjectStore()
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-1', name: 'Original' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.patternName.value = 'Original'

    persistence.savePattern()
    project.savedScratchPatterns = [pattern]
    persistence.reconcileSnapshot()
    sendMock.mockClear()

    scratch.replacePattern({ ...pattern, name: 'Edited' })
    persistence.patternName.value = 'Edited'
    expect(persistence.isDirty.value).toBe(true)

    persistence.updatePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-1', name: 'Edited' })
      })
    )
  })

  it('updatePattern uses selectedSavedId when available', () => {
    const scratch = setupSessionStore()
    const pattern = makePattern({ id: 'sp-draft', name: 'Draft' })
    scratch.completedPattern = pattern
    const { persistence } = createPersistence()
    persistence.selectedSavedId.value = 'sp-target'
    persistence.patternName.value = 'Updated'

    persistence.updatePattern()
    expect(sendMock).toHaveBeenCalledWith(
      'SCRATCH_PATTERN_SAVE',
      expect.objectContaining({
        pattern: expect.objectContaining({ id: 'sp-target', name: 'Updated' })
      })
    )
  })
})
