import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useClipEditorSave, type ClipEditorSaveDeps } from './useClipEditorSave'
import type { Clip } from '@/stores/projectStore'

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId: 'item-1',
    startMs: 0,
    offsetMs: 0,
    durationMs: 1000,
    ...(overrides as Record<string, unknown>)
  } as unknown as Clip
}

interface Harness {
  deps: ClipEditorSaveDeps
  project: {
    tracks: Array<{ id: string; name: string; clipIds: string[] }>
    clips: Record<string, Clip>
    trimClip: ReturnType<typeof vi.fn>
    setClipWarp: ReturnType<typeof vi.fn>
    setClipEnvelope: ReturnType<typeof vi.fn>
  }
  library: {
    updateSavedClipEdit: ReturnType<typeof vi.fn>
    addSavedClipFromSelection: ReturnType<typeof vi.fn>
  }
  notifications: {
    pushInfo: ReturnType<typeof vi.fn>
    pushError: ReturnType<typeof vi.fn>
  }
  close: ReturnType<typeof vi.fn>
  state: Record<string, unknown>
}

function makeHarness(overrides: Partial<ClipEditorSaveDeps> = {}): Harness {
  const project = {
    tracks: [] as Array<{ id: string; name: string; clipIds: string[] }>,
    clips: {} as Record<string, Clip>,
    trimClip: vi.fn(),
    setClipWarp: vi.fn(),
    setClipEnvelope: vi.fn()
  }
  const library = {
    updateSavedClipEdit: vi.fn(() => ({ ok: true })),
    addSavedClipFromSelection: vi.fn(() => 'new-id')
  }
  const notifications = { pushInfo: vi.fn(), pushError: vi.fn() }
  const close = vi.fn()

  const state: Record<string, unknown> = {
    editorItem: { id: 'item-1', name: 'Test' },
    timelineClip: null,
    sourceItem: { id: 'item-1', name: 'Test' },
    titleText: 'Test',
    editsSingleTimelineClip: false,
    editsSavedClipLibrary: true,
    hasWarpPitchChanged: false,
    sourceBpm: 120,
    projectBpm: 120,
    canApplyCrop: false,
    selectionInMs: 100,
    selectionDurationMs: 500,
    cropViewInMs: 0,
    cropViewDurationMs: 1000,
    draftSemitones: 0,
    draftCents: 0,
    draftTempoEnabled: false,
    draftMode: 'rhythmic',
    draftTempoPinned: false,
    tempoRatioFromPinnedBpm: undefined,
    volumeShapeCommittedPoints: []
  }

  const deps: ClipEditorSaveDeps = {
    project: project as unknown as ClipEditorSaveDeps['project'],
    library: library as unknown as ClipEditorSaveDeps['library'],
    notifications: notifications as unknown as ClipEditorSaveDeps['notifications'],
    close,
    editorItem: () => state.editorItem as ReturnType<ClipEditorSaveDeps['editorItem']>,
    timelineClip: () => state.timelineClip as Clip | null,
    sourceItem: () => state.sourceItem as ReturnType<ClipEditorSaveDeps['sourceItem']>,
    titleText: () => state.titleText as string,
    editsSingleTimelineClip: () => state.editsSingleTimelineClip as boolean,
    editsSavedClipLibrary: () => state.editsSavedClipLibrary as boolean,
    hasWarpPitchChanged: () => state.hasWarpPitchChanged as boolean,
    sourceBpm: () => state.sourceBpm as number | undefined,
    projectBpm: () => state.projectBpm as number,
    canApplyCrop: () => state.canApplyCrop as boolean,
    selectionInMs: () => state.selectionInMs as number,
    selectionDurationMs: () => state.selectionDurationMs as number,
    cropViewInMs: () => state.cropViewInMs as number,
    cropViewDurationMs: () => state.cropViewDurationMs as number,
    draftSemitones: () => state.draftSemitones as number,
    draftCents: () => state.draftCents as number,
    draftTempoEnabled: () => state.draftTempoEnabled as boolean,
    draftMode: () => state.draftMode as ReturnType<ClipEditorSaveDeps['draftMode']>,
    draftTempoPinned: () => state.draftTempoPinned as boolean,
    tempoRatioFromPinnedBpm: () => state.tempoRatioFromPinnedBpm as number | undefined,
    volumeShapeCommittedPoints: () =>
      state.volumeShapeCommittedPoints as ReturnType<ClipEditorSaveDeps['volumeShapeCommittedPoints']>,
    ...overrides
  }

  return { deps, project, library, notifications, close, state }
}

describe('useClipEditorSave', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('onSaveChanges no-ops when there is no editor item', () => {
    h.state.editorItem = null
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateSavedClipEdit).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('library save uses the selection window when a selection exists', () => {
    h.state.selectionInMs = 250
    h.state.selectionDurationMs = 400
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateSavedClipEdit).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ inMs: 250, durationMs: 400 })
    )
    expect(h.notifications.pushInfo).toHaveBeenCalled()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('library save falls back to the crop view when there is no selection', () => {
    h.state.canApplyCrop = false
    h.state.selectionDurationMs = 0
    h.state.cropViewInMs = 10
    h.state.cropViewDurationMs = 900
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateSavedClipEdit).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ inMs: 10, durationMs: 900 })
    )
  })

  it('library save surfaces overlap conflicts as an error and stays open', () => {
    h.library.updateSavedClipEdit.mockReturnValue({
      ok: false,
      conflictingTrackNames: ['Drums', 'Bass']
    })
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.notifications.pushError).toHaveBeenCalledWith(
      'Cannot save changes — they would overlap clips on Drums, Bass.'
    )
    expect(h.close).not.toHaveBeenCalled()
  })

  it('timeline-clip save trims and clears warp/envelope when warp is unchanged', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsSavedClipLibrary = false
    h.state.hasWarpPitchChanged = false
    const clip = makeClip({ id: 'clip-1', trackId: 'track-1', startMs: 0 })
    h.state.timelineClip = clip
    h.state.selectionInMs = 50
    h.state.selectionDurationMs = 300
    h.state.canApplyCrop = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.trimClip).toHaveBeenCalledWith('clip-1', 0, 50, 300)
    expect(h.project.setClipWarp).not.toHaveBeenCalled()
    expect(h.project.setClipEnvelope).toHaveBeenCalledWith('clip-1', [])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('timeline-clip save re-applies warp only when it changed', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsSavedClipLibrary = false
    h.state.hasWarpPitchChanged = true
    h.state.draftSemitones = 3
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.setClipWarp).toHaveBeenCalledWith(
      'clip-1',
      expect.objectContaining({ semitones: 3 })
    )
  })

  it('timeline-clip save blocks on an overlapping neighbour', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsSavedClipLibrary = false
    const clip = makeClip({ id: 'clip-1', trackId: 'track-1', startMs: 0, durationMs: 1000 })
    const neighbour = makeClip({ id: 'clip-2', trackId: 'track-1', startMs: 200, durationMs: 1000 })
    h.state.timelineClip = clip
    h.project.tracks = [{ id: 'track-1', name: 'Drums', clipIds: ['clip-1', 'clip-2'] }]
    h.project.clips = { 'clip-2': neighbour }
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.notifications.pushError).toHaveBeenCalledWith(
      'Cannot save changes — they would overlap clips on Drums.'
    )
    expect(h.project.trimClip).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('onSaveAsNew adds a clip from the current selection', () => {
    useClipEditorSave(h.deps).onSaveAsNew()

    expect(h.library.addSavedClipFromSelection).toHaveBeenCalledWith('item-1', 100, 500)
    expect(h.notifications.pushInfo).toHaveBeenCalled()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('onSaveAsNew does not close when the library rejects the selection', () => {
    h.library.addSavedClipFromSelection.mockReturnValue(null)
    useClipEditorSave(h.deps).onSaveAsNew()

    expect(h.close).not.toHaveBeenCalled()
  })
})
