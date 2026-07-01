import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRemovedItemFiles,
  removedItemFileInfo,
  type RemovedItemFile
} from '@/lib/library/projectFileCleanup'
import { send } from '@/lib/bridgeService'
import type { LibraryItem } from '@/stores/libraryStore'

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))

const sendMock = vi.mocked(send)

function item(partial: Partial<LibraryItem> & { id: string }): LibraryItem {
  return {
    kind: 'source',
    filePath: `C:\\src\\${partial.id}.wav`,
    fileName: `${partial.id}.wav`,
    durationMs: 1000,
    sampleRate: 44100,
    channelCount: 2,
    peaks: new Float32Array(),
    playbackFilePath: `C:\\src\\${partial.id}.wav`,
    ...partial
  } as LibraryItem
}

function stubCleanup(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(true)
  globalThis.window = { silverdaw: { cleanupProjectFiles: fn } } as unknown as Window & typeof globalThis
  return fn
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('removedItemFileInfo', () => {
  it('returns the WAV path for a stem', () => {
    const stem = item({ id: 's1', kind: 'stem', playbackFilePath: 'C:\\proj\\stems\\song-stems\\vocals.wav' })
    expect(removedItemFileInfo(stem, false, 'guid-1').wavPath).toBe('C:\\proj\\stems\\song-stems\\vocals.wav')
  })

  it('returns the WAV path for a saved sample (source marked as a sample asset)', () => {
    const sample = item({ id: 'sm1', kind: 'sample', playbackFilePath: 'C:\\proj\\samples\\song\\hit-sample-001.wav' })
    expect(removedItemFileInfo(sample, true, 'guid-1').wavPath).toBe('C:\\proj\\samples\\song\\hit-sample-001.wav')
  })

  it('never returns a WAV path for a plain imported source', () => {
    const source = item({ id: 'a1', kind: 'source', playbackFilePath: 'C:\\music\\original.wav' })
    expect(removedItemFileInfo(source, false, 'guid-1').wavPath).toBeUndefined()
  })

  it('never returns a WAV path for a saved clip', () => {
    const clip = item({ id: 'c1', kind: 'clip' })
    expect(removedItemFileInfo(clip, false, 'guid-1').wavPath).toBeUndefined()
  })
})

describe('cleanupRemovedItemFiles', () => {
  it('does nothing when there are no files and no orphan media', () => {
    const fn = stubCleanup()
    cleanupRemovedItemFiles([{ mediaId: 'guid-1' }], [item({ id: 'src', mediaId: 'guid-1' })], {})
    expect(sendMock).not.toHaveBeenCalled()
    expect(fn).not.toHaveBeenCalled()
  })

  it('deletes WAVs via the backend bridge and orphan media via the main process', () => {
    const fn = stubCleanup()
    const removed: RemovedItemFile[] = [
      { wavPath: 'C:\\proj\\stems\\song-stems\\vocals.wav', mediaId: 'guid-shared' },
      { wavPath: 'C:\\proj\\samples\\song\\hit.wav', mediaId: 'guid-orphan' }
    ]
    // The source keeps guid-shared alive; nothing references guid-orphan anymore.
    const source = item({ id: 'src', mediaId: 'guid-shared' })
    const byId = { src: source }
    cleanupRemovedItemFiles(removed, [source], byId)
    // WAVs go to the audio backend over the bridge.
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_DELETE_ARTIFACTS', {
      paths: ['C:\\proj\\stems\\song-stems\\vocals.wav', 'C:\\proj\\samples\\song\\hit.wav']
    })
    // Only the orphaned media GUID goes to the main process.
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0]![0] as { mediaIds: string[] }).toEqual({ mediaIds: ['guid-orphan'] })
  })

  it('deletes WAVs via the bridge without calling the main process when no media is orphaned', () => {
    const fn = stubCleanup()
    const source = item({ id: 'src', mediaId: 'guid-1' })
    cleanupRemovedItemFiles(
      [{ wavPath: 'C:\\proj\\stems\\song-stems\\drums.wav', mediaId: 'guid-1' }],
      [source],
      { src: source }
    )
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_DELETE_ARTIFACTS', {
      paths: ['C:\\proj\\stems\\song-stems\\drums.wav']
    })
    // No orphan media → the main-process cleanup is not invoked at all.
    expect(fn).not.toHaveBeenCalled()
  })

  it('cleans up orphan media without a bridge send when no WAVs were captured', () => {
    const fn = stubCleanup()
    // A removed item that owns no artifact WAV but whose media GUID is now orphaned.
    cleanupRemovedItemFiles([{ mediaId: 'guid-orphan' }], [], {})
    expect(sendMock).not.toHaveBeenCalled()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0]![0] as { mediaIds: string[] }).toEqual({ mediaIds: ['guid-orphan'] })
  })
})
