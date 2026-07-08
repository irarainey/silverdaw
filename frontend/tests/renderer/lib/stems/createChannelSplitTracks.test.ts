import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTracksFromChannelSplit,
  registerChannelSplitJob,
  type ChannelSplitTarget
} from '@/lib/stems/createChannelSplitTracks'
import type { ChannelSplitReadyPayload } from '@shared/bridge-protocol'

const importAudioIntoLibrary = vi.fn()
vi.mock('@/lib/importAudio', () => ({
  importAudioIntoLibrary: (...args: unknown[]) => importAudioIntoLibrary(...args),
  libraryItemToClipPlacement: (item: { id: string }) => ({ id: item.id })
}))
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/undo/undoGroup', () => ({
  runInUndoGroup: (_label: string, body: () => unknown) => body()
}))
// Analysis inheritance is covered by the stem tests; here it just needs to be inert.
const inheritSourceAnalysis = vi.fn()
vi.mock('@/lib/library/inheritSourceAnalysis', () => ({
  inheritSourceAnalysis: (...args: unknown[]) => inheritSourceAnalysis(...args)
}))

const addTrack = vi.fn(() => 'track-new')
const setTrackName = vi.fn()
const addClipFromLibrary = vi.fn()
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => ({ addTrack, setTrackName, addClipFromLibrary })
}))

const beginImportBatch = vi.fn()
const noteImportFinished = vi.fn()
const getItem = vi.fn((id: string) => ({ id }))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({ beginImportBatch, noteImportFinished, getItem })
}))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))

const readAudioFile = vi.fn()

const target: ChannelSplitTarget = {
  sourceItemId: 'src-item',
  sourceName: 'Song',
  clipId: 'src',
  startMs: 4000,
  sourceInMs: 0
}

function payload(): ChannelSplitReadyPayload {
  return {
    jobId: 'job-1',
    clipId: 'src',
    sourceName: 'Song',
    channels: [
      { channel: 'left', filePath: 'C:\\channels\\left.wav' },
      { channel: 'right', filePath: 'C:\\channels\\right.wav' }
    ]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { silverdaw: { readAudioFile } })
  readAudioFile.mockResolvedValue({ filePath: 'x', fileName: 'x.wav', data: new ArrayBuffer(0) })
  importAudioIntoLibrary.mockResolvedValue('item-1')
})

describe('createTracksFromChannelSplit', () => {
  beforeEach(() => registerChannelSplitJob('job-1', target))

  it('creates one named track per channel aligned to the source start', async () => {
    await createTracksFromChannelSplit(payload())

    expect(beginImportBatch).toHaveBeenCalledWith(2)
    expect(addTrack).toHaveBeenCalledTimes(2)
    expect(setTrackName).toHaveBeenNthCalledWith(1, 'track-new', 'Left — Song')
    expect(setTrackName).toHaveBeenNthCalledWith(2, 'track-new', 'Right — Song')
    expect(addClipFromLibrary).toHaveBeenCalledWith('track-new', { id: 'item-1' }, 4000, {
      suppressWarpSkipNotice: true
    })
    expect(pushInfo).toHaveBeenCalledWith('Added 2 channel tracks from Song')
  })

  it('imports each channel as a stem item derived from the source', async () => {
    await createTracksFromChannelSplit(payload())

    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(1, expect.anything(), {
      kind: 'stem',
      name: 'Left — Song',
      derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 }
    })
    expect(importAudioIntoLibrary).toHaveBeenNthCalledWith(2, expect.anything(), {
      kind: 'stem',
      name: 'Right — Song',
      derivedFrom: { sourceItemId: 'src-item', sourceClipId: 'src', inMs: 0, durationMs: 0 }
    })
    expect(inheritSourceAnalysis).toHaveBeenCalledTimes(2)
  })

  it('splits a single channel when only one is requested', async () => {
    await createTracksFromChannelSplit({ ...payload(), channels: [{ channel: 'right', filePath: 'r.wav' }] })

    expect(addTrack).toHaveBeenCalledTimes(1)
    expect(setTrackName).toHaveBeenCalledWith('track-new', 'Right — Song')
    expect(pushInfo).toHaveBeenCalledWith('Added 1 channel track from Song')
  })

  it('skips a channel whose file cannot be read but still places the others', async () => {
    readAudioFile.mockResolvedValueOnce(null)

    await createTracksFromChannelSplit(payload())

    expect(addTrack).toHaveBeenCalledTimes(1)
    expect(pushInfo).toHaveBeenCalledWith('Added 1 channel track from Song')
  })

  it('reports an error when no channel could be placed', async () => {
    importAudioIntoLibrary.mockResolvedValue(null)

    await createTracksFromChannelSplit(payload())

    expect(addTrack).not.toHaveBeenCalled()
    expect(pushError).toHaveBeenCalledWith('Could not split channels from Song')
  })

  it('ignores results for an unknown job', async () => {
    await createTracksFromChannelSplit({ ...payload(), jobId: 'other' })

    expect(importAudioIntoLibrary).not.toHaveBeenCalled()
    expect(addTrack).not.toHaveBeenCalled()
  })
})
