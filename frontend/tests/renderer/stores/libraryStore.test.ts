import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'

const sendMock = vi.hoisted(() => vi.fn())

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

vi.mock('@/lib/audio', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

let uuidCounter = 0
const createObjectURLMock = vi.fn(() => 'blob:cover')
const revokeObjectURLMock = vi.fn()

function stubGlobals(): void {
  uuidCounter = 0
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`)
  })
  vi.stubGlobal('URL', {
    createObjectURL: createObjectURLMock,
    revokeObjectURL: revokeObjectURLMock
  })
}

describe('libraryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sendMock.mockClear()
    createObjectURLMock.mockClear()
    revokeObjectURLMock.mockClear()
    stubGlobals()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('adds user-driven library items and de-duplicates by source path', () => {
    const library = useLibraryStore()

    const id = library.addItem({
      filePath: 'C:\\audio\\loop.wav',
      fileName: 'loop.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      key: 'A minor'
    })
    const duplicateId = library.addItem({
      filePath: 'C:\\audio\\loop.wav',
      fileName: 'loop-renamed.wav',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 1,
      peaks: new Float32Array(),
      key: 'C major'
    })

    expect(id).toBe('l1')
    expect(duplicateId).toBe(id)
    expect(library.items).toHaveLength(1)
    expect(library.items[0]).toMatchObject({
      id,
      kind: 'audio-file',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 1,
      key: 'A minor'
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ADD', {
      itemId: 'l1',
      filePath: 'C:\\audio\\loop.wav',
      kind: 'audio-file',
      name: undefined,
      fileName: 'loop.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      playbackFilePath: undefined,
      key: 'A minor',
      sourceItemId: undefined,
      sourceClipId: undefined,
      sourceInMs: undefined,
      sourceDurationMs: undefined
    })
  })

  it('saves reusable clips as derived library children of their source', () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\song.wav',
      fileName: 'song.wav',
      durationMs: 10_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    sendMock.mockClear()

    const savedId = library.addSavedClipFromTimelineClip({
      id: 'c1',
      trackId: 't1',
      libraryItemId: sourceId,
      filePath: 'C:\\audio\\song.wav',
      playbackFilePath: 'C:\\audio\\song.wav',
      fileName: 'song.wav',
      startMs: 4_000,
      inMs: 2_000,
      durationMs: 1_500,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      unresolved: false
    })
    const duplicateId = library.addSavedClipFromTimelineClip({
      id: 'c2',
      trackId: 't1',
      libraryItemId: sourceId,
      filePath: 'C:\\audio\\song.wav',
      fileName: 'song.wav',
      startMs: 6_000,
      inMs: 2_000,
      durationMs: 1_500,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      unresolved: false
    })

    expect(savedId).toBe('l2')
    expect(duplicateId).toBe(savedId)
    expect(library.items).toHaveLength(2)
    expect(library.items[1]).toMatchObject({
      id: savedId,
      kind: 'saved-clip',
      filePath: 'C:\\audio\\song.wav',
      durationMs: 1_500,
      derivedFrom: {
        sourceItemId: sourceId,
        sourceClipId: 'c1',
        inMs: 2_000,
        durationMs: 1_500
      }
    })
    expect(library.isItemInUse(sourceId)).toBe(false)
    expect(library.isItemInUse(savedId ?? '')).toBe(false)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ADD', expect.objectContaining({
      itemId: savedId,
      kind: 'saved-clip',
      sourceItemId: sourceId,
      sourceClipId: 'c1',
      sourceInMs: 2_000,
      sourceDurationMs: 1_500
    }))
  })

  it('hydrates snapshot items without echoing them to the backend', () => {
    const library = useLibraryStore()

    const snapshotId = library.addItem({
      id: 'l7',
      filePath: 'C:\\audio\\saved.wav',
      fileName: 'saved.wav',
      durationMs: 4_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const nextId = library.addItem({
      filePath: 'C:\\audio\\new.wav',
      fileName: 'new.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array()
    })

    expect(snapshotId).toBe('l7')
    expect(nextId).toBe('l8')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ADD', expect.objectContaining({ itemId: 'l8' }))
  })

  it('stores analysis results, bumps redraw state, and completes progress entries', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const itemId = library.addItem({
      filePath: 'C:\\audio\\analysis.wav',
      fileName: 'analysis.wav',
      durationMs: 4_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const importId = library.beginImport('analysis.wav')
    library.markImportAnalyzing(importId, itemId)

    library.setItemAnalysis(itemId, 124.5678, 0.25, [0.25, 0.75], true, 'C:\\cache\\analysis.wav')

    expect(library.items[0]).toMatchObject({
      bpm: 124.5678,
      beatAnchorSec: 0.25,
      beats: [0.25, 0.75],
      variableTempo: true,
      decodedCacheFilePath: 'C:\\cache\\analysis.wav'
    })
    expect(project.peaksRevision).toBe(1)
    expect(library.imports[0]?.stage).toBe('detectingBeats')

    vi.advanceTimersByTime(600)
    expect(library.imports[0]?.stage).toBe('done')
    vi.advanceTimersByTime(1200)
    expect(library.imports).toHaveLength(0)
  })

  it('refuses to remove in-use items and removes unused items with cleanup', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const usedItemId = library.addItem({
      filePath: 'C:\\audio\\used.wav',
      fileName: 'used.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const unusedItemId = library.addItem({
      filePath: 'C:\\audio\\unused.wav',
      fileName: 'unused.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const trackId = project.addTrack()
    project.addClipToTrack(
      trackId,
      {
        libraryItemId: usedItemId,
        filePath: 'C:\\audio\\used.wav',
        fileName: 'used.wav',
        durationMs: 1_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    library.items[1]!.coverArtUrl = 'blob:cover'
    sendMock.mockClear()

    expect(library.removeItem(usedItemId)).toBe(false)
    expect(library.items.map((item) => item.id)).toContain(usedItemId)
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_REMOVE', expect.anything())

    expect(library.removeItem(unusedItemId)).toBe(true)
    expect(library.items.map((item) => item.id)).not.toContain(unusedItemId)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:cover')
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: unusedItemId })
  })

  it('cascade-removes unused saved-clip children when their audio-file source is deleted', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\loop.wav',
      fileName: 'loop.wav',
      durationMs: 8_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    // Create a saved clip from a (transient) timeline clip, then
    // immediately drop the timeline clip so the source has only an
    // unused library child — the exact scenario the bug report
    // describes.
    const savedId = library.addSavedClipFromTimelineClip({
      id: 'c1',
      trackId: 't1',
      libraryItemId: sourceId,
      filePath: 'C:\\audio\\loop.wav',
      playbackFilePath: 'C:\\audio\\loop.wav',
      fileName: 'loop.wav',
      startMs: 0,
      inMs: 1_000,
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      unresolved: false
    })

    // No timeline clip references either row — both should be
    // freely removable, and removing the source should take the
    // child with it.
    expect(library.isItemInUse(sourceId)).toBe(false)
    expect(library.isItemInUse(savedId ?? '')).toBe(false)
    expect(project.tracks).toHaveLength(0)

    sendMock.mockClear()
    expect(library.removeItem(sourceId)).toBe(true)
    expect(library.items).toHaveLength(0)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: savedId })
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: sourceId })
  })

  it('refuses to remove a source when one of its saved-clip children is still on the timeline', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\hook.wav',
      fileName: 'hook.wav',
      durationMs: 10_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const savedId = library.addSavedClipFromTimelineClip({
      id: 'c-transient',
      trackId: 't0',
      libraryItemId: sourceId,
      filePath: 'C:\\audio\\hook.wav',
      playbackFilePath: 'C:\\audio\\hook.wav',
      fileName: 'hook.wav',
      startMs: 0,
      inMs: 500,
      durationMs: 1_500,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array(),
      unresolved: false
    })
    // Now put the saved-clip on the timeline — the source becomes
    // in-use via its child, even though no clip references the
    // source directly.
    const trackId = project.addTrack()
    project.addClipToTrack(
      trackId,
      {
        libraryItemId: savedId ?? '',
        filePath: 'C:\\audio\\hook.wav',
        fileName: 'hook.wav',
        durationMs: 1_500,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )

    expect(library.isItemInUse(sourceId)).toBe(true)
    expect(library.isItemInUse(savedId ?? '')).toBe(true)
    sendMock.mockClear()
    expect(library.removeItem(sourceId)).toBe(false)
    expect(library.items.map((item) => item.id)).toEqual([sourceId, savedId])
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_REMOVE', expect.anything())
  })

  it('normalises metadata and display names', () => {
    const library = useLibraryStore()
    const itemId = library.addItem({
      filePath: 'C:\\audio\\tagged.wav',
      fileName: 'tagged.wav',
      durationMs: 0,
      sampleRate: 0,
      channelCount: 0,
      peaks: new Float32Array(),
      key: 'D minor',
      fromSnapshot: true
    })

    library.setItemMetadata(itemId, {
      title: 'Tagged Title',
      artist: 'Artist',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      coverArt: {
        data: new ArrayBuffer(4),
        mimeType: 'image/png'
      }
    })

    expect(library.items[0]).toMatchObject({
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      coverArtUrl: 'blob:cover',
      metadata: {
        title: 'Tagged Title',
        artist: 'Artist',
        key: 'D minor'
      }
    })
    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(libraryItemDisplayName(library.items[0]!)).toBe('Tagged Title')
    expect(libraryItemDisplayName({ fileName: 'fallback.wav', metadata: { title: '   ' } })).toBe(
      'fallback.wav'
    )
  })

  it('saves a selection as a new saved-clip and deduplicates identical windows', () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    sendMock.mockClear()

    const id1 = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000, 'My slice')
    const id2 = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000, 'My slice')

    expect(id1).toBeTruthy()
    expect(id2).toBe(id1)
    const saved = library.items.find((i) => i.id === id1)
    expect(saved).toMatchObject({
      kind: 'saved-clip',
      name: 'My slice',
      durationMs: 2_000,
      derivedFrom: { sourceItemId: sourceId, inMs: 1_000, durationMs: 2_000 }
    })
  })

  it('updates a saved-clip trim window when no timeline clips reference it', () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000)
    sendMock.mockClear()

    const result = library.updateSavedClipTrim(savedId!, 1_500, 3_000)

    expect(result.ok).toBe(true)
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 3_000,
      derivedFrom: { inMs: 1_500, durationMs: 3_000 }
    })
    expect(sendMock).toHaveBeenCalledWith(
      'LIBRARY_ADD',
      expect.objectContaining({
        itemId: savedId,
        sourceInMs: 1_500,
        sourceDurationMs: 3_000,
        durationMs: 3_000
      })
    )
  })

  it('propagates saved-clip trim to every linked timeline clip', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'saved-clip',
        filePath: 'C:\\audio\\source.wav',
        fileName: 'source.wav',
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1]),
        derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
      },
      0
    )!
    sendMock.mockClear()

    const result = library.updateSavedClipTrim(savedId, 1_500, 3_000)

    expect(result.ok).toBe(true)
    // Saved-clip library entry updated.
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 3_000,
      derivedFrom: { inMs: 1_500, durationMs: 3_000 }
    })
    // Linked timeline clip's window mirrors the new trim.
    expect(project.clips[clipId]).toMatchObject({ inMs: 1_500, durationMs: 3_000 })
    // CLIP_TRIM envelope broadcast for the linked sibling.
    expect(sendMock).toHaveBeenCalledWith('CLIP_TRIM', {
      clipId,
      startMs: 0,
      inMs: 1_500,
      durationMs: 3_000
    })
  })

  it('redraws linked timeline clips when a saved clip is renamed', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000, 'Old loop')!
    const saved = library.items.find((item) => item.id === savedId)!
    const trackId = project.addTrack()
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'saved-clip',
        name: saved.name,
        filePath: saved.filePath,
        fileName: saved.fileName,
        durationMs: saved.durationMs,
        sampleRate: saved.sampleRate,
        channelCount: saved.channelCount,
        peaks: saved.peaks,
        derivedFrom: saved.derivedFrom
      },
      0
    )!
    const revisionBefore = project.peaksRevision
    sendMock.mockClear()

    const renamed = library.renameItem(savedId, 'New loop')

    expect(renamed).toBe(true)
    expect(project.clips[clipId]?.name).toBe('New loop')
    expect(project.peaksRevision).toBe(revisionBefore + 1)
    expect(sendMock).toHaveBeenCalledWith('CLIP_RENAME', { clipId, name: 'New loop' })
  })

  it('refuses saved-clip trim when propagation would collide with a neighbour clip', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    // Linked saved-clip instance at position 0..2000 ms.
    project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'saved-clip',
        filePath: 'C:\\audio\\source.wav',
        fileName: 'source.wav',
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1]),
        derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
      },
      0
    )
    // Independent neighbour clip at 2500..4500 ms — close enough that
    // growing the saved-clip to 3000 ms would overlap into it.
    project.addClipFromLibrary(
      trackId,
      {
        id: sourceId!,
        kind: 'audio-file',
        filePath: 'C:\\audio\\source.wav',
        fileName: 'source.wav',
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1])
      },
      2_500
    )
    sendMock.mockClear()

    const result = library.updateSavedClipTrim(savedId, 1_500, 3_000)

    expect(result.ok).toBe(false)
    expect(result.conflictingTrackNames).toBeDefined()
    expect(result.conflictingTrackNames!.length).toBeGreaterThan(0)
    // Saved-clip library entry unchanged.
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 2_000,
      derivedFrom: { inMs: 1_000, durationMs: 2_000 }
    })
  })

  it('commits saved-clip trim, warp, and pitch as one editor save', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      key: 'C major',
      fromSnapshot: true
    })
    library.items.find((item) => item.id === sourceId)!.bpm = 100
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    const saved = library.items.find((item) => item.id === savedId)!
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'saved-clip',
        filePath: saved.filePath,
        fileName: saved.fileName,
        durationMs: saved.durationMs,
        sampleRate: saved.sampleRate,
        channelCount: saved.channelCount,
        peaks: saved.peaks,
        derivedFrom: saved.derivedFrom
      },
      0
    )!
    sendMock.mockClear()

    const result = library.updateSavedClipEdit(savedId, {
      inMs: 1_500,
      durationMs: 3_000,
      warpEnabled: true,
      warpMode: 'tonal',
      tempoRatio: 2,
      semitones: 2,
      cents: 10
    })

    expect(result.ok).toBe(true)
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 3_000,
      derivedFrom: { inMs: 1_500, durationMs: 3_000 },
      warpEnabled: true,
      warpMode: 'tonal',
      tempoRatio: 2,
      semitones: 2,
      cents: 10,
      key: 'D major +10c'
    })
    expect(project.clips[clipId]).toMatchObject({
      inMs: 1_500,
      durationMs: 3_000,
      warpEnabled: true,
      warpMode: 'tonal',
      tempoRatio: 2,
      semitones: 2,
      cents: 10
    })
    expect(sendMock).toHaveBeenCalledWith(
      'LIBRARY_ADD',
      expect.objectContaining({
        itemId: savedId,
        sourceInMs: 1_500,
        sourceDurationMs: 3_000,
        warpEnabled: true,
        warpMode: 'tonal',
        tempoRatio: 2,
        semitones: 2,
        cents: 10
      })
    )
    expect(sendMock).toHaveBeenCalledWith('CLIP_TRIM', {
      clipId,
      startMs: 0,
      inMs: 1_500,
      durationMs: 3_000
    })
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_SET_WARP',
      expect.objectContaining({
        clipId,
        warpEnabled: true,
        warpMode: 'tonal',
        tempoRatio: 2,
        semitones: 2,
        cents: 10
      })
    )
  })

  it('refuses a saved-clip editor save when new warp timing would collide', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 20_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    library.items.find((item) => item.id === sourceId)!.bpm = 100
    const savedId = library.addSavedClipFromSelection(sourceId!, 1_000, 1_000)!
    const trackId = project.addTrack()
    const saved = library.items.find((item) => item.id === savedId)!
    project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'saved-clip',
        filePath: saved.filePath,
        fileName: saved.fileName,
        durationMs: saved.durationMs,
        sampleRate: saved.sampleRate,
        channelCount: saved.channelCount,
        peaks: saved.peaks,
        derivedFrom: saved.derivedFrom
      },
      0
    )
    project.addClipFromLibrary(
      trackId,
      {
        id: sourceId!,
        kind: 'audio-file',
        filePath: 'C:\\audio\\source.wav',
        fileName: 'source.wav',
        durationMs: 1_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1])
      },
      1_500
    )
    sendMock.mockClear()

    const result = library.updateSavedClipEdit(savedId, {
      inMs: 1_000,
      durationMs: 1_000,
      warpEnabled: true,
      warpMode: 'rhythmic',
      tempoRatio: 0.5,
      semitones: 0,
      cents: 0
    })

    expect(result.ok).toBe(false)
    expect(result.conflictingTrackNames).toBeDefined()
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 1_000,
      derivedFrom: { inMs: 1_000, durationMs: 1_000 },
      warpEnabled: undefined,
      tempoRatio: undefined
    })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('stores and clears per-channel stereo peaks keyed by item id', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\stereo.wav',
      fileName: 'stereo.wav',
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })

    const left = new Float32Array([-0.5, 0.5, -0.4, 0.4])
    const right = new Float32Array([-0.3, 0.3, -0.2, 0.2])
    library.setItemChannelPeaks(id, [left, right], 200)

    const entry = library.channelPeaksByItemId[id]
    expect(entry).toBeDefined()
    expect(entry?.channels).toHaveLength(2)
    expect(entry?.channels[0]).toBe(left)
    expect(entry?.lod).toHaveLength(2)
    expect(entry?.lod[0]?.[0]?.peaks).toBe(left)
    expect(entry?.peaksPerSecond).toBe(200)

    // A non-stereo (or empty) update clears the entry.
    library.setItemChannelPeaks(id, [left], 200)
    expect(library.channelPeaksByItemId[id]).toBeUndefined()
  })

  it('drops per-channel stereo peaks when the item is removed', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\stereo2.wav',
      fileName: 'stereo2.wav',
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    library.setItemChannelPeaks(id, [new Float32Array([0, 1]), new Float32Array([0, 1])], 200)
    expect(library.channelPeaksByItemId[id]).toBeDefined()

    library.removeItem(id)
    expect(library.channelPeaksByItemId[id]).toBeUndefined()
  })

  it('reuses an identical channel entry instead of rebuilding its LOD', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\stereo3.wav',
      fileName: 'stereo3.wav',
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    const left = new Float32Array([0, 1])
    const right = new Float32Array([0, 1])
    library.setItemChannelPeaks(id, [left, right], 200)
    const firstLod = library.channelPeaksByItemId[id]?.lod
    // Same references + rate must short-circuit and keep the existing LOD.
    library.setItemChannelPeaks(id, [left, right], 200)
    expect(library.channelPeaksByItemId[id]?.lod).toBe(firstLod)
    // A different rate forces a rebuild.
    library.setItemChannelPeaks(id, [left, right], 400)
    expect(library.channelPeaksByItemId[id]?.lod).not.toBe(firstLod)
  })

  it('clears per-channel and hi-res peaks when the library is cleared', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\stereo4.wav',
      fileName: 'stereo4.wav',
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    library.setItemChannelPeaks(id, [new Float32Array([0, 1]), new Float32Array([0, 1])], 200)
    library.setEditorHiResPeaks({
      libraryItemId: id,
      peaksPerSecond: 200,
      sampleRate: 48_000,
      peaks: new Float32Array([0, 1]),
      channels: []
    })

    library.clear()
    expect(library.channelPeaksByItemId).toEqual({})
    expect(library.editorHiResPeaks).toBeNull()
  })
})
