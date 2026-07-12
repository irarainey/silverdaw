import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTracksFromStems,
  createTrackFromStem,
  registerStemJob
} from '@/lib/stems/createStemTracks'
import type { StemSeparationTarget } from '@/lib/stemSeparationState'
import type { StemPartialPayload, StemReadyPayload } from '@shared/bridge-protocol'

const importAudioIntoLibrary = vi.fn()
vi.mock('@/lib/importAudio', () => ({
  importAudioIntoLibrary: (...args: unknown[]) => importAudioIntoLibrary(...args),
  libraryItemToClipPlacement: (item: { id: string }) => ({ id: item.id })
}))
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
// Undo grouping is exercised in undoGroup.test.ts; here it must just run the body so the
// placement store calls are observable without a live bridge.
vi.mock('@/lib/undo/undoGroup', () => ({
  runInUndoGroup: (_label: string, body: () => unknown) => body()
}))

const addTrack = vi.fn(() => 'track-new')
const setTrackName = vi.fn()
const addClipFromLibrary = vi.fn()
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => ({
    clips: { src: { startMs: 4000, libraryItemId: 'src-item' } },
    addTrack,
    setTrackName,
    addClipFromLibrary
  })
}))

const beginImportBatch = vi.fn()
const noteImportFinished = vi.fn()
const setItemAnalysis = vi.fn()
const setItemKey = vi.fn()
const sourceLibraryItem = {
  id: 'src-item',
  kind: 'source',
  filePath: 'C:\\music\\Song.mp3',
  mediaId: 'media-1'
}
const byId: Record<string, typeof sourceLibraryItem> = {
  'src-item': sourceLibraryItem
}
const getItem = vi.fn((id: string) =>
  id === 'src-item' ? byId['src-item'] : { id }
)
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({
    beginImportBatch,
    noteImportFinished,
    getItem,
    setItemAnalysis,
    setItemKey,
    byId
  }),
  resolveLibraryItemMediaId: (item: { mediaId?: string } | undefined) => item?.mediaId
}))

const { getProjectMedia } = vi.hoisted(() => ({
  getProjectMedia: vi.fn(async () => ({ artist: 'Artist' }))
}))
vi.mock('@/lib/library/projectMedia', () => ({ getProjectMedia }))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))

const readAudioFile = vi.fn()

const timelineTarget: StemSeparationTarget = {
  sourceItemId: 'src-item',
  sourceName: 'Song',
  clipId: 'src',
  startMs: 4000
}

const libraryTarget: StemSeparationTarget = {
  sourceItemId: 'src-item',
  sourceName: 'Song'
}

function payload(): StemReadyPayload {
  return {
    jobId: 'job-1',
    clipId: 'src',
    sourceName: 'Song',
    stems: [
      {
        stem: 'vocals',
        filePath: 'C:\\stems\\vocals.wav',
        sampleRate: 44100,
        durationMs: 50000,
        channelCount: 2
      },
      {
        stem: 'drums',
        filePath: 'C:\\stems\\drums.wav',
        sampleRate: 44100,
        durationMs: 50000,
        channelCount: 2
      }
    ]
  }
}

function partial(stem: 'vocals' | 'drums'): StemPartialPayload {
  return {
    jobId: 'job-1',
    clipId: 'src',
    sourceName: 'Song',
    stem,
    filePath: `C:\\stems\\${stem}.wav`,
    sampleRate: 44100,
    durationMs: 50000,
    channelCount: 2
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  byId['src-item'] = sourceLibraryItem
  vi.stubGlobal('window', { silverdaw: { readAudioFile } })
  readAudioFile.mockResolvedValue({ filePath: 'x', fileName: 'x.wav', data: new ArrayBuffer(0) })
  importAudioIntoLibrary.mockResolvedValue('item-1')
})

describe('createTracksFromStems (timeline target)', () => {
  beforeEach(() => registerStemJob('job-1', timelineTarget))

  it('creates one named track per stem aligned to the source start', async () => {
    await createTracksFromStems(payload())

    expect(beginImportBatch).toHaveBeenCalledWith(2)
    expect(addTrack).toHaveBeenCalledTimes(2)
    expect(setTrackName).toHaveBeenNthCalledWith(1, 'track-new', 'Vocals — Song')
    expect(setTrackName).toHaveBeenNthCalledWith(2, 'track-new', 'Drums — Song')
    expect(addClipFromLibrary).toHaveBeenCalledWith('track-new', { id: 'item-1' }, 4000)
    expect(pushInfo).toHaveBeenCalledWith('Added 2 stem tracks from Song')
  })

  it('imports each stem as a nested stem item derived from the source', async () => {
    await createTracksFromStems(payload())

    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        kind: 'stem',
        name: 'Vocals — Song',
        derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 },
        generatedAudio: { sampleRate: 44100, durationMs: 50000, channelCount: 2 },
        inheritedMetadata: { artist: 'Artist' }
      })
    )
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        kind: 'stem',
        name: 'Drums — Song',
        derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 },
        generatedAudio: { sampleRate: 44100, durationMs: 50000, channelCount: 2 },
        inheritedMetadata: { artist: 'Artist' }
      })
    )
    expect(getProjectMedia).toHaveBeenCalledTimes(1)
  })

  it('keeps the source media identity if the source is removed before later stems arrive', async () => {
    delete byId['src-item']

    await createTracksFromStems(payload())

    expect(importAudioIntoLibrary).toHaveBeenCalledTimes(2)
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ inheritedMediaId: 'media-1' })
    )
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ inheritedMediaId: 'media-1' })
    )
  })

  it('skips a stem whose file cannot be read but still places the others', async () => {
    readAudioFile.mockResolvedValueOnce(null)

    await createTracksFromStems(payload())

    expect(addTrack).toHaveBeenCalledTimes(1)
    expect(pushInfo).toHaveBeenCalledWith('Added 1 stem track from Song')
  })

  it('reports an error when no stem could be placed', async () => {
    importAudioIntoLibrary.mockResolvedValue(null)

    await createTracksFromStems(payload())

    expect(addTrack).not.toHaveBeenCalled()
    expect(pushError).toHaveBeenCalledWith('Could not create stems from Song')
  })

  it('places a stem incrementally and does not duplicate it on STEM_READY', async () => {
    await createTrackFromStem(partial('vocals'))

    expect(addTrack).toHaveBeenCalledTimes(1)
    expect(setTrackName).toHaveBeenNthCalledWith(1, 'track-new', 'Vocals — Song')

    await createTracksFromStems(payload())

    // Vocals is not re-created; only the remaining drums stem is added.
    expect(addTrack).toHaveBeenCalledTimes(2)
    expect(setTrackName).toHaveBeenNthCalledWith(2, 'track-new', 'Drums — Song')
    expect(pushInfo).toHaveBeenCalledWith('Added 2 stem tracks from Song')
  })

  it('awaits an in-flight partial import before reporting completion', async () => {
    let resolveImport: ((itemId: string) => void) | undefined
    importAudioIntoLibrary.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveImport = resolve
      })
    )
    const vocalsOnly = { ...payload(), stems: [payload().stems[0]!] }

    const partialImport = createTrackFromStem(partial('vocals'))
    await vi.waitFor(() => expect(importAudioIntoLibrary).toHaveBeenCalledTimes(1))
    const readyImport = createTracksFromStems(vocalsOnly)
    await Promise.resolve()

    expect(pushInfo).not.toHaveBeenCalled()
    resolveImport?.('item-1')
    await partialImport
    await readyImport

    expect(importAudioIntoLibrary).toHaveBeenCalledTimes(1)
    expect(pushInfo).toHaveBeenCalledWith('Added 1 stem track from Song')
  })

  it('awaits partial imports before starting missing ready imports', async () => {
    let resolveVocals: ((itemId: string) => void) | undefined
    importAudioIntoLibrary
      .mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveVocals = resolve
        })
      )
      .mockResolvedValueOnce('item-2')

    const partialImport = createTrackFromStem(partial('vocals'))
    await vi.waitFor(() => expect(importAudioIntoLibrary).toHaveBeenCalledTimes(1))
    const readyImport = createTracksFromStems(payload())
    await Promise.resolve()

    expect(readAudioFile).toHaveBeenCalledTimes(1)
    resolveVocals?.('item-1')
    await partialImport
    await readyImport

    expect(readAudioFile).toHaveBeenCalledTimes(2)
    expect(importAudioIntoLibrary).toHaveBeenCalledTimes(2)
    expect(pushInfo).toHaveBeenCalledWith('Added 2 stem tracks from Song')
  })

  it('inherits the source beat grid and key onto each stem instead of re-analysing', async () => {
    getItem.mockImplementation((id: string) =>
      id === 'src-item'
        ? {
            id,
            kind: 'source',
            filePath: 'C:\\music\\Song.mp3',
            bpm: 120,
            beats: [0.5, 1.0, 1.5],
            beatAnchorSec: 0.5,
            variableTempo: false,
            lowConfidence: false,
            key: 'A min'
          }
        : { id }
    )

    await createTracksFromStems(payload())

    expect(setItemAnalysis).toHaveBeenNthCalledWith(
      1,
      'item-1',
      120,
      0.5,
      [0.5, 1.0, 1.5],
      false,
      undefined,
      false
    )
    expect(setItemKey).toHaveBeenCalledWith('item-1', 'A min')
    expect(setItemAnalysis).toHaveBeenCalledTimes(2)
  })

  it('shifts the inherited grid by the source clip trim and records the offset', async () => {
    registerStemJob('job-1', { ...timelineTarget, sourceInMs: 200 })
    getItem.mockImplementation((id: string) =>
      id === 'src-item'
        ? {
            id,
            kind: 'source',
            filePath: 'C:\\music\\Song.mp3',
            bpm: 120,
            beats: [0.1, 0.5, 1.0, 1.5],
            beatAnchorSec: 0.5,
            variableTempo: false,
            key: 'A min'
          }
        : { id }
    )

    await createTracksFromStems(payload())

    // The stem WAV starts 200 ms into the source, so the grid shifts back by 0.2 s
    // and any beat that lands before the stem's start is dropped (0.1 → -0.1).
    expect(setItemAnalysis).toHaveBeenNthCalledWith(
      1,
      'item-1',
      120,
      0.3,
      [0.3, 0.8, 1.3],
      false,
      undefined,
      false
    )
    // The window start is recorded on the stem's provenance so the backend can
    // apply the same shift authoritatively.
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        kind: 'stem',
        name: 'Vocals \u2014 Song',
        derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 200, durationMs: 0 }
      })
    )
  })

  it('never copies a low-confidence source flag onto the stem (defers to the source)', async () => {
    getItem.mockImplementation((id: string) =>
      id === 'src-item'
        ? {
            id,
            kind: 'source',
            filePath: 'C:\\music\\Song.mp3',
            bpm: 120,
            beats: [0.5, 1.0, 1.5],
            beatAnchorSec: 0.5,
            variableTempo: false,
            lowConfidence: true,
            key: 'A min'
          }
        : { id }
    )

    await createTracksFromStems(payload())

    // A stem has no independent confidence measurement; its lowConfidence stays
    // unset (false) so `libraryItemIsSample` defers to the source via derivedFrom.
    expect(setItemAnalysis).toHaveBeenNthCalledWith(
      1,
      'item-1',
      120,
      0.5,
      [0.5, 1.0, 1.5],
      false,
      undefined,
      false
    )
  })
})

describe('createTracksFromStems (library target)', () => {
  beforeEach(() => registerStemJob('job-1', libraryTarget))

  it('imports stems to the library without creating timeline tracks', async () => {
    await createTracksFromStems(payload())

    expect(importAudioIntoLibrary).toHaveBeenCalledTimes(2)
    expect(addTrack).not.toHaveBeenCalled()
    expect(addClipFromLibrary).not.toHaveBeenCalled()
    expect(pushInfo).toHaveBeenCalledWith('Extracted 2 stems from Song to the library')
  })

  it('imports each stem without a source clip id', async () => {
    await createTracksFromStems(payload())

    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        kind: 'stem',
        name: 'Vocals — Song',
        derivedFrom: {
          sourceItemId: 'src-item',
          sourceClipId: undefined,
          inMs: 0,
          durationMs: 0
        }
      })
    )
  })
})

describe('unregistered jobs', () => {
  it('ignores results for an unknown job', async () => {
    await createTracksFromStems(payload())
    await createTrackFromStem(partial('vocals'))

    expect(importAudioIntoLibrary).not.toHaveBeenCalled()
    expect(addTrack).not.toHaveBeenCalled()
  })
})
