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

vi.mock('@/lib/audioDecode', () => ({
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
      kind: 'source',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 1,
      key: 'A minor'
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ADD', {
      itemId: 'l1',
      filePath: 'C:\\audio\\loop.wav',
      kind: 'source',
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

  it('adds a stem item derived from its source and dedupes by file path', () => {
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

    const stemInput = {
      filePath: 'C:\\stems\\job1\\vocals.wav',
      fileName: 'vocals.wav',
      kind: 'stem' as const,
      name: 'Vocals',
      durationMs: 10_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: 'c1', inMs: 0, durationMs: 0 }
    }
    const stemId = library.addItem(stemInput)
    const duplicateId = library.addItem(stemInput)

    expect(duplicateId).toBe(stemId)
    expect(library.items).toHaveLength(2)
    expect(library.items[1]).toMatchObject({
      id: stemId,
      kind: 'stem',
      name: 'Vocals',
      derivedFrom: { sourceItemId: sourceId, sourceClipId: 'c1' }
    })
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ADD', expect.objectContaining({
      itemId: stemId,
      kind: 'stem',
      sourceItemId: sourceId
    }))
  })

  it('refuses a stem item that lacks a source item', () => {
    const library = useLibraryStore()
    const stemId = library.addItem({
      filePath: 'C:\\stems\\job1\\vocals.wav',
      fileName: 'vocals.wav',
      kind: 'stem',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array()
    })
    expect(stemId).toBe('')
    expect(library.items).toHaveLength(0)
  })

  it('refuses to remove a stem while its timeline clip is still present', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\song.wav',
      fileName: 'song.wav',
      durationMs: 10_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      fromSnapshot: true
    })
    const stemId = library.addItem({
      filePath: 'C:\\stems\\job1\\vocals.wav',
      fileName: 'vocals.wav',
      kind: 'stem',
      name: 'Vocals',
      durationMs: 10_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: 'c1', inMs: 0, durationMs: 0 }
    })
    const trackId = project.addTrack()
    project.addClipToTrack(
      trackId,
      {
        libraryItemId: stemId ?? '',
        filePath: 'C:\\stems\\job1\\vocals.wav',
        fileName: 'vocals.wav',
        durationMs: 10_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )

    expect(library.removeItem(stemId!)).toBe(false)
    expect(library.getItem(stemId!)).not.toBeNull()
  })

  it('saves a cropped stem clip against the stem itself, not the original source', () => {
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
    const stemId = library.addItem({
      filePath: 'C:\\stems\\job1\\vocals.wav',
      playbackFilePath: 'C:\\stems\\job1\\vocals.wav',
      fileName: 'vocals.wav',
      kind: 'stem',
      name: 'Vocals — song',
      durationMs: 10_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: 'c1', inMs: 0, durationMs: 0 }
    })

    const savedId = library.addLibraryClipFromTimelineClip({
      id: 'clip-stem',
      trackId: 't1',
      libraryItemId: stemId,
      filePath: 'C:\\stems\\job1\\vocals.wav',
      playbackFilePath: 'C:\\stems\\job1\\vocals.wav',
      fileName: 'vocals.wav',
      startMs: 0,
      inMs: 2_000,
      durationMs: 1_500,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      unresolved: false
    })

    const saved = library.getItem(savedId!)
    expect(saved?.kind).toBe('clip')
    // The cropped clip must point back to the stem (its real file), not the
    // original track — otherwise the library shows "source not found".
    expect(saved?.derivedFrom?.sourceItemId).toBe(stemId)
    expect(saved?.filePath).toBe('C:\\stems\\job1\\vocals.wav')
    expect(saved?.fileName).toBe('vocals.wav')
    expect(saved?.playbackFilePath).toBe('C:\\stems\\job1\\vocals.wav')
    // A saved clip derived from the stem keeps the stem in use when on-timeline.
    const trackId = useProjectStore().addTrack()
    useProjectStore().addClipToTrack(
      trackId,
      {
        libraryItemId: savedId ?? '',
        filePath: 'C:\\stems\\job1\\vocals.wav',
        fileName: 'vocals.wav',
        durationMs: 1_500,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    expect(library.isItemInUse(stemId!)).toBe(true)
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

    const savedId = library.addLibraryClipFromTimelineClip({
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
    const duplicateId = library.addLibraryClipFromTimelineClip({
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
      kind: 'clip',
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
      kind: 'clip',
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

  it('warns and clears the pending auto-warp when late analysis finds a variable tempo', async () => {
    const { useNotificationsStore } = await import('@/stores/notificationsStore')
    const library = useLibraryStore()
    const project = useProjectStore()
    const notifications = useNotificationsStore()
    const itemId = library.addItem({
      filePath: 'C:\\audio\\funk.wav',
      fileName: 'funk.wav',
      name: 'California Soul',
      durationMs: 8_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    const trackId = project.addTrack()
    const clipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: itemId!,
        filePath: 'C:\\audio\\funk.wav',
        fileName: 'funk.wav',
        durationMs: 8_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    // Drop-time marked the clip pending because the source BPM wasn't known yet.
    project.setClipWarp(clipId!, { pendingAutoWarp: true }, { localOnly: true })
    const importId = library.beginImport('funk.wav')
    library.markImportAnalyzing(importId, itemId!)
    sendMock.mockClear()

    library.setItemAnalysis(itemId!, 94.05, 0.7, [0.7, 1.34], true)

    expect(project.clips[clipId!]?.pendingAutoWarp).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_SET_WARP',
      expect.objectContaining({ clipId, pendingAutoWarp: false })
    )
    expect(notifications.items).toHaveLength(1)
    expect(notifications.items[0]?.message).toContain('"California Soul"')
    expect(notifications.items[0]?.message).toContain('variable tempo')

    vi.advanceTimersByTime(600)
    expect(library.imports[0]?.stage).toBe('done')
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

  it('cascade-removes unused library-clip children when their source is deleted', () => {
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
    const savedId = library.addLibraryClipFromTimelineClip({
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

  it('refuses to remove a source when one of its library-clip children is still on the timeline', () => {
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
    const savedId = library.addLibraryClipFromTimelineClip({
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
    // Now put the library-clip on the timeline — the source becomes
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

  it('removes a source whose only timeline use is a derived stem, baking identity onto the stem', () => {
    const library = useLibraryStore()
    const project = useProjectStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\anthem.wav',
      fileName: 'anthem.wav',
      durationMs: 10_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      key: 'A minor',
      fromSnapshot: true
    })
    library.setItemMetadata(sourceId, {
      title: 'Anthem',
      artist: 'The Band',
      durationMs: 10_000,
      sampleRate: 48_000,
      channelCount: 2,
      coverArt: { data: new ArrayBuffer(4), mimeType: 'image/png' }
    })
    library.setItemAnalysis(sourceId, 124, 0.1, [0, 0.48, 0.96], false)

    const stemId = library.addItem({
      filePath: 'C:\\stems\\job1\\drums.wav',
      fileName: 'drums.wav',
      kind: 'stem',
      name: 'Drums — Anthem',
      durationMs: 10_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId, sourceClipId: 'c1', inMs: 0, durationMs: 0 }
    })
    const trackId = project.addTrack()
    project.addClipToTrack(
      trackId,
      {
        libraryItemId: stemId ?? '',
        filePath: 'C:\\stems\\job1\\drums.wav',
        fileName: 'drums.wav',
        durationMs: 10_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )

    // The stem is on the timeline, but the source itself is not — a derived
    // stem owns its own file, so it must not pin the source as in-use.
    expect(library.isItemInUse(sourceId)).toBe(false)
    sendMock.mockClear()
    expect(library.removeItem(sourceId)).toBe(true)
    expect(library.getItem(sourceId)).toBeNull()

    const stem = library.getItem(stemId!)
    expect(stem).not.toBeNull()
    expect(stem?.metadata).toMatchObject({ title: 'Anthem', artist: 'The Band' })
    expect(stem?.bpm).toBe(124)
    expect(stem?.beats).toEqual([0, 0.48, 0.96])
    expect(stem?.key).toBe('A minor')
    expect(stem?.coverArtUrl).toBe('blob:cover')
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: sourceId })
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: stemId })
  })

  it('sends cleanup:true and no undo group when removing a sample with file cleanup on', async () => {
    const { useUiStore } = await import('@/stores/uiStore')
    const library = useLibraryStore()
    useUiStore().cleanupProjectFiles = true

    const sampleId = library.addItem({
      filePath: 'C:\\proj\\samples\\Song\\Song-sample-001.wav',
      fileName: 'Song-sample-001.wav',
      kind: 'sample',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })

    sendMock.mockClear()
    expect(library.removeItem(sampleId!)).toBe(true)
    // The removal is irreversible, so it carries the cleanup flag and is NOT wrapped in
    // an EDIT_GROUP (no undo step).
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: sampleId, cleanup: true })
    expect(sendMock).not.toHaveBeenCalledWith('EDIT_GROUP_BEGIN', expect.anything())
    expect(sendMock).not.toHaveBeenCalledWith('EDIT_GROUP_END')
  })

  it('keeps a normal undoable removal (no cleanup flag) when file cleanup is off', () => {
    const library = useLibraryStore()
    const sampleId = library.addItem({
      filePath: 'C:\\proj\\samples\\Song\\Song-sample-002.wav',
      fileName: 'Song-sample-002.wav',
      kind: 'sample',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })

    sendMock.mockClear()
    expect(library.removeItem(sampleId!)).toBe(true)
    // No cleanup flag, and wrapped in an undo group — a normal undoable, dirtying edit.
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_REMOVE', { itemId: sampleId })
    expect(sendMock).toHaveBeenCalledWith('EDIT_GROUP_BEGIN', { label: 'Remove from library' })
    expect(sendMock).toHaveBeenCalledWith('EDIT_GROUP_END')
  })

  it('hides and restores a tile cover image via a per-item flag + bridge message', () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\anthem.wav',
      fileName: 'anthem.wav',
      durationMs: 5_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })

    sendMock.mockClear()
    library.setItemCoverArtHidden(sourceId!, true)
    expect(library.getItem(sourceId!)?.coverArtHidden).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_COVER_HIDDEN', {
      itemId: sourceId,
      hidden: true
    })

    // Idempotent: setting the same value again does not re-send.
    sendMock.mockClear()
    library.setItemCoverArtHidden(sourceId!, true)
    expect(sendMock).not.toHaveBeenCalled()

    // Restoring clears the flag (undefined, not false, so it stays absent from save).
    library.setItemCoverArtHidden(sourceId!, false)
    expect(library.getItem(sourceId!)?.coverArtHidden).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_COVER_HIDDEN', {
      itemId: sourceId,
      hidden: false
    })
  })

  it('updateItemCoverArt sets a per-item override, swaps the cover, and clears hide', async () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\track.wav',
      fileName: 'track.wav',
      durationMs: 5_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    // The tile was previously hidden; a freshly-picked image should reveal it.
    library.getItem(sourceId!)!.coverArtHidden = true

    const coverFile = `override-${sourceId}.png`
    globalThis.window = {
      silverdaw: {
        updateItemCover: vi
          .fn()
          .mockResolvedValue({ cancelled: false, coverFile, data: new ArrayBuffer(4), mimeType: 'image/png' })
      }
    } as unknown as Window & typeof globalThis

    sendMock.mockClear()
    await library.updateItemCoverArt(sourceId!)

    const item = library.getItem(sourceId!)
    expect(item?.coverArtOverride).toBe(coverFile)
    expect(item?.coverArtUrl).toBe('blob:cover')
    expect(item?.coverArtHidden).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_COVER_OVERRIDE', { itemId: sourceId, coverFile })
    // Clearing the hide is persisted too.
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_COVER_HIDDEN', { itemId: sourceId, hidden: false })
  })

  it('updateItemCoverArt makes no changes when the picker is cancelled', async () => {
    const library = useLibraryStore()
    const sourceId = library.addItem({
      filePath: 'C:\\audio\\track2.wav',
      fileName: 'track2.wav',
      durationMs: 5_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    globalThis.window = {
      silverdaw: { updateItemCover: vi.fn().mockResolvedValue({ cancelled: true }) }
    } as unknown as Window & typeof globalThis

    sendMock.mockClear()
    await library.updateItemCoverArt(sourceId!)
    expect(library.getItem(sourceId!)?.coverArtOverride).toBeUndefined()
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_ITEM_SET_COVER_OVERRIDE', expect.anything())
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

  it('saves a selection as a new library-clip and deduplicates identical windows', () => {
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

    const id1 = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000, 'My slice')
    const id2 = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000, 'My slice')

    expect(id1).toBeTruthy()
    expect(id2).toBe(id1)
    const saved = library.items.find((i) => i.id === id1)
    expect(saved).toMatchObject({
      kind: 'clip',
      name: 'My slice',
      durationMs: 2_000,
      derivedFrom: { sourceItemId: sourceId, inMs: 1_000, durationMs: 2_000 }
    })
  })

  it('updates a library-clip trim window when no timeline clips reference it', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)
    sendMock.mockClear()

    const result = library.updateLibraryClipTrim(savedId!, 1_500, 3_000)

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

  it('propagates library-clip trim to every linked timeline clip', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'clip',
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

    const result = library.updateLibraryClipTrim(savedId, 1_500, 3_000)

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

  it('propagates a shared volume envelope to every linked timeline clip', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const savedItem = {
      id: savedId,
      kind: 'clip' as const,
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
    }
    const trackA = project.addTrack()
    const trackB = project.addTrack()
    const clipA = project.addClipFromLibrary(trackA, savedItem, 0)!
    const clipB = project.addClipFromLibrary(trackB, savedItem, 0)!
    sendMock.mockClear()

    const points = [
      { timeMs: 0, gain: 1 },
      { timeMs: 1_000, gain: 0.25 }
    ]
    const result = library.updateLibraryClipEnvelope(savedId, points)

    expect(result.ok).toBe(true)
    expect(project.clips[clipA]!.envelopePoints).toEqual(points)
    expect(project.clips[clipB]!.envelopePoints).toEqual(points)
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_SET_ENVELOPE',
      expect.objectContaining({ clipId: clipA, points })
    )
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_SET_ENVELOPE',
      expect.objectContaining({ clipId: clipB, points })
    )
  })

  it('propagates a shared reverse flag to every linked timeline clip', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const savedItem = {
      id: savedId,
      kind: 'clip' as const,
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
    }
    const trackA = project.addTrack()
    const trackB = project.addTrack()
    const clipA = project.addClipFromLibrary(trackA, savedItem, 0)!
    const clipB = project.addClipFromLibrary(trackB, savedItem, 0)!
    sendMock.mockClear()

    const result = library.updateLibraryClipReversed(savedId, true)

    expect(result.ok).toBe(true)
    expect(project.clips[clipA]!.reversed).toBe(true)
    expect(project.clips[clipB]!.reversed).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_REVERSED', { clipId: clipA, reversed: true })
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_REVERSED', { clipId: clipB, reversed: true })
  })

  it('propagates a shared brake / backspin flag to every linked timeline clip', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const savedItem = {
      id: savedId,
      kind: 'clip' as const,
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
    }
    const trackA = project.addTrack()
    const trackB = project.addTrack()
    const clipA = project.addClipFromLibrary(trackA, savedItem, 0)!
    const clipB = project.addClipFromLibrary(trackB, savedItem, 0)!
    sendMock.mockClear()

    const brakeResult = library.updateLibraryClipBrake(savedId, true)
    expect(brakeResult.ok).toBe(true)
    expect(project.clips[clipA]!.brake).toBe(true)
    expect(project.clips[clipB]!.brake).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BRAKE', { clipId: clipA, on: true })
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BRAKE', { clipId: clipB, on: true })

    // Switching to backspin clears brake on every linked instance (mutually exclusive).
    const spinResult = library.updateLibraryClipBackspin(savedId, true)
    expect(spinResult.ok).toBe(true)
    expect(project.clips[clipA]!.backspin).toBe(true)
    expect(project.clips[clipB]!.backspin).toBe(true)
    expect(project.clips[clipA]!.brake).toBeUndefined()
    expect(project.clips[clipB]!.brake).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BACKSPIN', { clipId: clipA, on: true })
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BACKSPIN', { clipId: clipB, on: true })
  })

  it('inherits the shared volume envelope when placing another linked instance', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const savedItem = {
      id: savedId,
      kind: 'clip' as const,
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId!, sourceClipId: '', inMs: 1_000, durationMs: 2_000 }
    }
    const trackA = project.addTrack()
    const trackB = project.addTrack()

    // First placement starts flat (no sibling to inherit from).
    const clipA = project.addClipFromLibrary(trackA, savedItem, 0)!
    expect(project.clips[clipA]!.envelopePoints).toBeUndefined()

    // Shape the first instance, then place a second instance.
    const points = [
      { timeMs: 0, gain: 1 },
      { timeMs: 1_000, gain: 0.5 }
    ]
    project.setClipEnvelope(clipA, points)
    const clipB = project.addClipFromLibrary(trackB, savedItem, 0)!

    expect(project.clips[clipB]!.envelopePoints).toEqual(points)
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000, 'Old loop')!
    const saved = library.items.find((item) => item.id === savedId)!
    const trackId = project.addTrack()
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'clip',
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

  it('refuses library-clip trim when propagation would collide with a neighbour clip', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    // Linked library-clip instance at position 0..2000 ms.
    project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'clip',
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
    // growing the library-clip to 3000 ms would overlap into it.
    project.addClipFromLibrary(
      trackId,
      {
        id: sourceId!,
        kind: 'source',
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

    const result = library.updateLibraryClipTrim(savedId, 1_500, 3_000)

    expect(result.ok).toBe(false)
    expect(result.conflictingTrackNames).toBeDefined()
    expect(result.conflictingTrackNames!.length).toBeGreaterThan(0)
    // Saved-clip library entry unchanged.
    expect(library.items.find((i) => i.id === savedId)).toMatchObject({
      durationMs: 2_000,
      derivedFrom: { inMs: 1_000, durationMs: 2_000 }
    })
  })

  it('commits library-clip trim, warp, and pitch as one editor save', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 2_000)!
    const trackId = project.addTrack()
    const saved = library.items.find((item) => item.id === savedId)!
    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'clip',
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

    const result = library.updateLibraryClipEdit(savedId, {
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

  it('refuses a library-clip editor save when new warp timing would collide', () => {
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
    const savedId = library.addLibraryClipFromSelection(sourceId!, 1_000, 1_000)!
    const trackId = project.addTrack()
    const saved = library.items.find((item) => item.id === savedId)!
    project.addClipFromLibrary(
      trackId,
      {
        id: savedId,
        kind: 'clip',
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
        kind: 'source',
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

    const result = library.updateLibraryClipEdit(savedId, {
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

  it('dedupes LOD builds for freshly-parsed arrays of the same shape (multi-clip load)', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\shared.wav',
      fileName: 'shared.wav',
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    // Each clip of the same source delivers freshly-parsed (non-reference-equal) arrays; a
    // same-shape entry must reuse the existing LOD rather than rebuild it per clip.
    library.setItemChannelPeaks(id, [new Float32Array([0, 1, 0.5, 0.8]), new Float32Array([0, 1, 0.5, 0.8])], 200)
    const firstLod = library.channelPeaksByItemId[id]?.lod
    library.setItemChannelPeaks(id, [new Float32Array([0, 1, 0.5, 0.8]), new Float32Array([0, 1, 0.5, 0.8])], 200)
    expect(library.channelPeaksByItemId[id]?.lod).toBe(firstLod)
    // A different per-channel length is a genuinely different source, so it rebuilds.
    library.setItemChannelPeaks(id, [new Float32Array([0, 1]), new Float32Array([0, 1])], 200)
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

  it('applies a manual tempo override and persists it over the bridge', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\manual.wav',
      fileName: 'manual.wav',
      durationMs: 4_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    library.setItemAudioType(id, 'auto')
    sendMock.mockClear()

    library.setItemManualTempo(id, 128, 0.25)

    const item = library.byId[id]!
    expect(item.bpm).toBe(128)
    expect(item.beatAnchorSec).toBe(0.25)
    expect(item.beats).toEqual([0.25])
    expect(item.lowConfidence).toBeUndefined()
    expect(item.variableTempo).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: id,
      bpm: 128,
      beatAnchorSec: 0.25
    })
  })

  it('ignores an out-of-range manual BPM', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\manual2.wav',
      fileName: 'manual2.wav',
      durationMs: 4_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    sendMock.mockClear()

    library.setItemManualTempo(id, 5, 0)
    library.setItemManualTempo(id, 400, 0)

    expect(library.byId[id]!.bpm).toBeUndefined()
    expect(sendMock).not.toHaveBeenCalledWith(
      'LIBRARY_ITEM_SET_MANUAL_TEMPO',
      expect.anything()
    )
  })

  it('slides the grid anchor locally without a bridge round-trip', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\manual3.wav',
      fileName: 'manual3.wav',
      durationMs: 4_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })
    library.setItemManualTempo(id, 120, 0)
    sendMock.mockClear()

    library.setItemBeatAnchorLocal(id, 0.18)

    expect(library.byId[id]!.beatAnchorSec).toBe(0.18)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not slide the grid anchor when the item has no tempo', () => {
    const library = useLibraryStore()
    const id = library.addItem({
      filePath: 'C:\\audio\\manual4.wav',
      fileName: 'manual4.wav',
      durationMs: 4_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1])
    })

    library.setItemBeatAnchorLocal(id, 0.18)

    expect(library.byId[id]!.beatAnchorSec).toBeUndefined()
  })
})
