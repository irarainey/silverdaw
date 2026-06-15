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
const getItem = vi.fn((id: string) =>
  id === 'src-item' ? { id, kind: 'audio-file', filePath: 'C:\\music\\Song.mp3' } : { id }
)
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({ beginImportBatch, noteImportFinished, getItem, setItemAnalysis, setItemKey })
}))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))

const readAudioFile = vi.fn()
const writeStemSidecar = vi.fn()

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
      { stem: 'vocals', filePath: 'C:\\stems\\vocals.wav' },
      { stem: 'drums', filePath: 'C:\\stems\\drums.wav' }
    ]
  }
}

function partial(stem: 'vocals' | 'drums'): StemPartialPayload {
  return {
    jobId: 'job-1',
    clipId: 'src',
    sourceName: 'Song',
    stem,
    filePath: `C:\\stems\\${stem}.wav`
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { silverdaw: { readAudioFile, writeStemSidecar } })
  readAudioFile.mockResolvedValue({ filePath: 'x', fileName: 'x.wav', data: new ArrayBuffer(0) })
  writeStemSidecar.mockResolvedValue(true)
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
      {
        kind: 'stem',
        name: 'Vocals — Song',
        derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 }
      }
    )
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        kind: 'stem',
        name: 'Drums — Song',
        derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 }
      }
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

  it('writes a metadata sidecar from the source into the stem folder once per job', async () => {
    await createTracksFromStems(payload())

    expect(writeStemSidecar).toHaveBeenCalledTimes(1)
    expect(writeStemSidecar).toHaveBeenCalledWith('C:\\stems', 'C:\\music\\Song.mp3')
  })

  it('inherits the source beat grid and key onto each stem instead of re-analysing', async () => {
    getItem.mockImplementation((id: string) =>
      id === 'src-item'
        ? {
            id,
            kind: 'audio-file',
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
            kind: 'audio-file',
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
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(1, expect.anything(), {
      kind: 'stem',
      name: 'Vocals \u2014 Song',
      derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 200, durationMs: 0 }
    })
  })

  it('never copies a low-confidence source flag onto the stem (defers to the source)', async () => {
    getItem.mockImplementation((id: string) =>
      id === 'src-item'
        ? {
            id,
            kind: 'audio-file',
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
      {
        kind: 'stem',
        name: 'Vocals — Song',
        derivedFrom: {
          sourceItemId: 'src-item',
          sourceClipId: undefined,
          inMs: 0,
          durationMs: 0
        }
      }
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
