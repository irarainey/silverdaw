import { describe, it, expect } from 'vitest'
import {
  useClipEditorDirtyState,
  type ClipEditorDirtyStateDeps
} from '@/lib/clipEditor/useClipEditorDirtyState'
import type { Clip } from '@/stores/projectStore'
import type { LibraryItem } from '@/stores/libraryStore'

// A mutable state bag whose getters feed the composable. Defaults describe a
// pristine existing single-timeline clip (in 0, duration 1000, no warp/pitch)
// so each test perturbs exactly the field under examination.
interface HarnessState {
  editsExistingClip: boolean
  editsTimelineClip: boolean
  timelineClip: Clip | null
  editorItem: LibraryItem | null
  sourceItem: LibraryItem | null
  selectionInMs: number
  selectionDurationMs: number
  selectionEndMs: number
  cropViewInMs: number
  cropViewDurationMs: number
  draftTempoEnabled: boolean
  draftMode: ClipEditorDirtyStateDeps['draftMode'] extends () => infer R ? R : never
  draftTempoMode: ClipEditorDirtyStateDeps['draftTempoMode'] extends () => infer R ? R : never
  draftPinnedBpm: number
  draftStretchPercent: number
  draftSemitones: number
  draftCents: number
  hasVolumeShapeChanged: boolean
  hasReverseChanged: boolean
  hasDjEffectChanged: boolean
  hasGridChanged: boolean
  sourceBpm: number | undefined
  projectBpm: number
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    inMs: 0,
    durationMs: 1000,
    warpMode: 'rhythmic',
    semitones: 0,
    cents: 0,
    ...overrides
  } as Clip
}

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    durationMs: 1000,
    ...overrides
  } as LibraryItem
}

function makeHarness(initial: Partial<HarnessState> = {}) {
  const clip = makeClip()
  const item = makeItem()
  const state: HarnessState = {
    editsExistingClip: true,
    editsTimelineClip: true,
    timelineClip: clip,
    editorItem: item,
    sourceItem: item,
    selectionInMs: 0,
    selectionDurationMs: 1000,
    selectionEndMs: 1000,
    cropViewInMs: 0,
    cropViewDurationMs: 1000,
    draftTempoEnabled: false,
    draftMode: 'rhythmic',
    draftTempoMode: 'follow',
    draftPinnedBpm: 120,
    draftStretchPercent: 100,
    draftSemitones: 0,
    draftCents: 0,
    hasVolumeShapeChanged: false,
    hasReverseChanged: false,
    hasDjEffectChanged: false,
    hasGridChanged: false,
    sourceBpm: 120,
    projectBpm: 120,
    ...initial
  }

  const deps: ClipEditorDirtyStateDeps = {
    editsExistingClip: () => state.editsExistingClip,
    editsTimelineClip: () => state.editsTimelineClip,
    timelineClip: () => state.timelineClip,
    editorItem: () => state.editorItem,
    sourceItem: () => state.sourceItem,
    selectionInMs: () => state.selectionInMs,
    selectionDurationMs: () => state.selectionDurationMs,
    selectionEndMs: () => state.selectionEndMs,
    cropViewInMs: () => state.cropViewInMs,
    cropViewDurationMs: () => state.cropViewDurationMs,
    draftTempoEnabled: () => state.draftTempoEnabled,
    draftMode: () => state.draftMode,
    draftTempoMode: () => state.draftTempoMode,
    draftPinnedBpm: () => state.draftPinnedBpm,
    draftStretchPercent: () => state.draftStretchPercent,
    draftSemitones: () => state.draftSemitones,
    draftCents: () => state.draftCents,
    hasVolumeShapeChanged: () => state.hasVolumeShapeChanged,
    hasReverseChanged: () => state.hasReverseChanged,
    hasDjEffectChanged: () => state.hasDjEffectChanged,
    hasGridChanged: () => state.hasGridChanged,
    sourceBpm: () => state.sourceBpm,
    projectBpm: () => state.projectBpm
  }

  return { state, dirty: useClipEditorDirtyState(deps) }
}

describe('useClipEditorDirtyState', () => {
  describe('hasSelectionChanged', () => {
    it('is false for a pristine selection matching the persisted window', () => {
      const { dirty } = makeHarness()
      expect(dirty.hasSelectionChanged.value).toBe(false)
    })

    it('is false when not editing an existing clip', () => {
      const { dirty } = makeHarness({ editsExistingClip: false, selectionInMs: 500 })
      expect(dirty.hasSelectionChanged.value).toBe(false)
    })

    it('is true when the selection start moves off the persisted in point', () => {
      const { dirty } = makeHarness({ selectionInMs: 250 })
      expect(dirty.hasSelectionChanged.value).toBe(true)
    })

    it('is true when the cropped view differs from the persisted window', () => {
      const { dirty } = makeHarness({ cropViewDurationMs: 800 })
      expect(dirty.hasSelectionChanged.value).toBe(true)
    })
  })

  describe('hasWarpPitchChanged', () => {
    it('is false when drafts match the persisted clip', () => {
      const { dirty } = makeHarness()
      expect(dirty.hasWarpPitchChanged.value).toBe(false)
    })

    it('is true when the pitch draft differs from the clip', () => {
      const { dirty } = makeHarness({ draftSemitones: 3 })
      expect(dirty.hasWarpPitchChanged.value).toBe(true)
    })

    it('is true when the tempo-warp draft is enabled but the clip has none', () => {
      const { dirty } = makeHarness({ draftTempoEnabled: true })
      expect(dirty.hasWarpPitchChanged.value).toBe(true)
    })
  })

  describe('canSaveChanges volume-shape gating', () => {
    it('enables Save when a single timeline clip has only a dirty volume shape', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: true,
        hasVolumeShapeChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(true)
    })

    it('does NOT enable Save for a multi/saved-library clip with only a dirty volume shape', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: false,
        hasVolumeShapeChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(false)
    })

    it('does NOT enable Save for a new clip with only a dirty volume shape', () => {
      const { dirty } = makeHarness({
        editsExistingClip: false,
        editsTimelineClip: true,
        hasVolumeShapeChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(false)
    })

    it('still enables Save on a selection change even when not a single timeline clip', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: false,
        selectionInMs: 250
      })
      expect(dirty.canSaveChanges.value).toBe(true)
    })
  })

  describe('canSaveChanges reverse gating', () => {
    it('enables Save when a timeline clip has only a dirty reverse flag', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: true,
        hasReverseChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(true)
    })

    it('does NOT enable Save for a saved-library clip with only a dirty reverse flag', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: false,
        hasReverseChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(false)
    })
  })

  describe('canSaveChanges beat-grid gating', () => {
    it('enables Save when the source beat grid was changed', () => {
      const { dirty } = makeHarness({ hasGridChanged: true })
      expect(dirty.canSaveChanges.value).toBe(true)
    })

    it('still enables Save for a saved-library clip when only the grid changed', () => {
      const { dirty } = makeHarness({
        editsTimelineClip: false,
        hasGridChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(true)
    })

    it('does NOT enable Save for a grid change when not editing an existing clip', () => {
      const { dirty } = makeHarness({
        editsExistingClip: false,
        hasGridChanged: true
      })
      expect(dirty.canSaveChanges.value).toBe(false)
    })
  })

  describe('canApplyCrop', () => {
    it('is false with no editor item', () => {
      const { dirty } = makeHarness({ editorItem: null })
      expect(dirty.canApplyCrop.value).toBe(false)
    })

    it('is false for a full-width selection (nothing to narrow)', () => {
      const { dirty } = makeHarness()
      expect(dirty.canApplyCrop.value).toBe(false)
    })

    it('is true for a narrowing selection inside the view', () => {
      const { dirty } = makeHarness({
        selectionInMs: 200,
        selectionEndMs: 800,
        selectionDurationMs: 600
      })
      expect(dirty.canApplyCrop.value).toBe(true)
    })
  })

  describe('canSaveAsNew', () => {
    it('is true for a new clip with a source item and a selection', () => {
      const { dirty } = makeHarness({ editsExistingClip: false })
      expect(dirty.canSaveAsNew.value).toBe(true)
    })

    it('is false while editing an existing clip', () => {
      const { dirty } = makeHarness()
      expect(dirty.canSaveAsNew.value).toBe(false)
    })

    it('is false with an empty selection', () => {
      const { dirty } = makeHarness({ editsExistingClip: false, selectionDurationMs: 0 })
      expect(dirty.canSaveAsNew.value).toBe(false)
    })
  })
})
