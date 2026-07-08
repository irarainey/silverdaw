import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useClipEditorSave, type ClipEditorSaveDeps } from '@/lib/clipEditor/useClipEditorSave'
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
    setClipReversed: ReturnType<typeof vi.fn>
    setClipBrake: ReturnType<typeof vi.fn>
    setClipBackspin: ReturnType<typeof vi.fn>
  }
  library: {
    updateLibraryClipEdit: ReturnType<typeof vi.fn>
    updateLibraryClipEnvelope: ReturnType<typeof vi.fn>
    updateLibraryClipReversed: ReturnType<typeof vi.fn>
    updateLibraryClipBrake: ReturnType<typeof vi.fn>
    updateLibraryClipBackspin: ReturnType<typeof vi.fn>
    addLibraryClipFromSelection: ReturnType<typeof vi.fn>
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
    setClipEnvelope: vi.fn(),
    setClipReversed: vi.fn(),
    setClipBrake: vi.fn(),
    setClipBackspin: vi.fn(),
    alignClipToBarGrid: vi.fn(() => 'skip')
  }
  const library = {
    updateLibraryClipEdit: vi.fn(() => ({ ok: true })),
    updateLibraryClipEnvelope: vi.fn(() => ({ ok: true })),
    updateLibraryClipReversed: vi.fn(() => ({ ok: true })),
    updateLibraryClipBrake: vi.fn(() => ({ ok: true })),
    updateLibraryClipBackspin: vi.fn(() => ({ ok: true })),
    addLibraryClipFromSelection: vi.fn(() => 'new-id')
  }
  const notifications = { pushInfo: vi.fn(), pushError: vi.fn() }
  const close = vi.fn()

  const state: Record<string, unknown> = {
    editorItem: { id: 'item-1', name: 'Test' },
    timelineClip: null,
    sourceItem: { id: 'item-1', name: 'Test' },
    titleText: 'Test',
    editsSingleTimelineClip: false,
    editsLibraryClipLibrary: true,
    editsTimelineClip: false,
    hasWarpPitchChanged: false,
    gridChanged: false,
    alignToGridEnabled: false,
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
    draftTempoMode: 'follow',
    resolveManualRatio: undefined,
    volumeShapeCommittedPoints: [],
    reverseCommitted: false,
    brakeCommitted: false,
    backspinCommitted: false
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
    editsLibraryClipLibrary: () => state.editsLibraryClipLibrary as boolean,
    editsTimelineClip: () => state.editsTimelineClip as boolean,
    hasWarpPitchChanged: () => state.hasWarpPitchChanged as boolean,
    gridChanged: () => state.gridChanged as boolean,
    alignToGridEnabled: () => state.alignToGridEnabled as boolean,
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
    draftTempoMode: () => state.draftTempoMode as ReturnType<ClipEditorSaveDeps['draftTempoMode']>,
    resolveManualRatio: () => state.resolveManualRatio as number | undefined,
    volumeShapeCommittedPoints: () =>
      state.volumeShapeCommittedPoints as ReturnType<ClipEditorSaveDeps['volumeShapeCommittedPoints']>,
    reverseCommitted: () => state.reverseCommitted as boolean,
    brakeCommitted: () => state.brakeCommitted as boolean,
    backspinCommitted: () => state.backspinCommitted as boolean,
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

    expect(h.library.updateLibraryClipEdit).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('library save uses the selection window when a selection exists', () => {
    h.state.selectionInMs = 250
    h.state.selectionDurationMs = 400
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipEdit).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ inMs: 250, durationMs: 400 })
    )
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('library save falls back to the crop view when there is no selection', () => {
    h.state.canApplyCrop = false
    h.state.selectionDurationMs = 0
    h.state.cropViewInMs = 10
    h.state.cropViewDurationMs = 900
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipEdit).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ inMs: 10, durationMs: 900 })
    )
  })

  it('library save surfaces overlap conflicts as an error and stays open', () => {
    h.library.updateLibraryClipEdit.mockReturnValue({
      ok: false,
      conflictingTrackNames: ['Drums', 'Bass']
    })
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.notifications.pushError).toHaveBeenCalledWith(
      'Cannot save changes — they would overlap clips on Drums, Bass.'
    )
    expect(h.close).not.toHaveBeenCalled()
  })

  it('linked-clip save propagates the shared volume envelope to all linked clips', () => {
    h.state.editsLibraryClipLibrary = true
    h.state.editsTimelineClip = true
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.volumeShapeCommittedPoints = [
      { timeMs: 0, gain: 1 },
      { timeMs: 500, gain: 0.5 }
    ]
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipEdit).toHaveBeenCalled()
    expect(h.library.updateLibraryClipEnvelope).toHaveBeenCalledWith('item-1', [
      { timeMs: 0, gain: 1 },
      { timeMs: 500, gain: 0.5 }
    ])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('saved-library save (no placed instance) does not touch the volume envelope', () => {
    h.state.editsLibraryClipLibrary = true
    h.state.editsTimelineClip = false
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipEdit).toHaveBeenCalled()
    expect(h.library.updateLibraryClipEnvelope).not.toHaveBeenCalled()
  })

  it('linked-clip save skips the envelope when the library-clip edit is rejected', () => {
    h.state.editsLibraryClipLibrary = true
    h.state.editsTimelineClip = true
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.library.updateLibraryClipEdit.mockReturnValue({ ok: false, conflictingTrackNames: ['Drums'] })
    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipEnvelope).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('timeline-clip save trims and clears warp/envelope when warp is unchanged', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
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

  it('timeline-clip save commits the reverse flag', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000
    h.state.reverseCommitted = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.setClipReversed).toHaveBeenCalledWith('clip-1', true)
  })

  it('linked-clip save propagates the reverse flag to all linked clips', () => {
    h.state.editsLibraryClipLibrary = true
    h.state.editsTimelineClip = true
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.reverseCommitted = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipReversed).toHaveBeenCalledWith('item-1', true)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('timeline-clip save commits the brake / backspin flags', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000
    h.state.brakeCommitted = true
    h.state.backspinCommitted = false

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.setClipBrake).toHaveBeenCalledWith('clip-1', true)
    expect(h.project.setClipBackspin).toHaveBeenCalledWith('clip-1', false)
  })

  it('timeline-clip save re-aligns the clip to the grid when the beat grid changed', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000
    h.state.gridChanged = true
    h.state.alignToGridEnabled = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.alignClipToBarGrid).toHaveBeenCalledWith('clip-1')
  })

  it('timeline-clip save toasts when the clip cannot be re-aligned (blocked)', () => {
    h.project.alignClipToBarGrid.mockReturnValue('blocked')
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000
    h.state.gridChanged = true
    h.state.alignToGridEnabled = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.notifications.pushInfo).toHaveBeenCalled()
  })

  it('timeline-clip save does not re-align when the beat grid was not changed', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.canApplyCrop = true
    h.state.selectionInMs = 0
    h.state.selectionDurationMs = 1000
    h.state.gridChanged = false
    h.state.alignToGridEnabled = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.project.alignClipToBarGrid).not.toHaveBeenCalled()
  })

  it('linked-clip save propagates brake / backspin to all linked clips', () => {
    h.state.editsLibraryClipLibrary = true
    h.state.editsTimelineClip = true
    h.state.timelineClip = makeClip({ id: 'clip-1' })
    h.state.backspinCommitted = true

    useClipEditorSave(h.deps).onSaveChanges()

    expect(h.library.updateLibraryClipBackspin).toHaveBeenCalledWith('item-1', true)
    expect(h.library.updateLibraryClipBrake).toHaveBeenCalledWith('item-1', false)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('timeline-clip save re-applies warp only when it changed', () => {
    h.state.editsSingleTimelineClip = true
    h.state.editsLibraryClipLibrary = false
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
    h.state.editsLibraryClipLibrary = false
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

    expect(h.library.addLibraryClipFromSelection).toHaveBeenCalledWith('item-1', 100, 500)
    expect(h.notifications.pushInfo).toHaveBeenCalled()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('onSaveAsNew does not close when the library rejects the selection', () => {
    h.library.addLibraryClipFromSelection.mockReturnValue(null)
    useClipEditorSave(h.deps).onSaveAsNew()

    expect(h.close).not.toHaveBeenCalled()
  })
})
