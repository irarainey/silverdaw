import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRemovedItemFiles,
  removedItemFileInfo,
  type RemovedItemFile
} from '@/lib/library/projectFileCleanup'
import type { LibraryItem } from '@/stores/libraryStore'

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

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

afterEach(() => vi.restoreAllMocks())

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
    expect(fn).not.toHaveBeenCalled()
  })

  it('deletes WAVs and only media GUIDs no longer referenced by a remaining item', () => {
    const fn = stubCleanup()
    const removed: RemovedItemFile[] = [
      { wavPath: 'C:\\proj\\stems\\song-stems\\vocals.wav', mediaId: 'guid-shared' },
      { wavPath: 'C:\\proj\\samples\\song\\hit.wav', mediaId: 'guid-orphan' }
    ]
    // The source keeps guid-shared alive; nothing references guid-orphan anymore.
    const source = item({ id: 'src', mediaId: 'guid-shared' })
    const byId = { src: source }
    cleanupRemovedItemFiles(removed, [source], byId)
    expect(fn).toHaveBeenCalledTimes(1)
    const arg = fn.mock.calls[0]![0] as { wavPaths: string[]; mediaIds: string[] }
    expect(arg.wavPaths).toEqual([
      'C:\\proj\\stems\\song-stems\\vocals.wav',
      'C:\\proj\\samples\\song\\hit.wav'
    ])
    expect(arg.mediaIds).toEqual(['guid-orphan'])
  })

  it('deletes WAVs even when there are no orphan media GUIDs', () => {
    const fn = stubCleanup()
    const source = item({ id: 'src', mediaId: 'guid-1' })
    cleanupRemovedItemFiles(
      [{ wavPath: 'C:\\proj\\stems\\song-stems\\drums.wav', mediaId: 'guid-1' }],
      [source],
      { src: source }
    )
    expect(fn).toHaveBeenCalledTimes(1)
    expect((fn.mock.calls[0]![0] as { mediaIds: string[] }).mediaIds).toEqual([])
  })
})
