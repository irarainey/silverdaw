// Coverage for the file browser's persisted index cache. The cache exists so a
// restart can show the user's folders without crawling the disk again, and it is
// an ordinary file on disk, so what it restores must be checked against the
// folders the user actually consented to.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const files = vi.hoisted(() => new Map<string, string>())
const readdirMock = vi.hoisted(() => vi.fn())
const parseFileMock = vi.hoisted(() => vi.fn())
/** Held open to keep the cache read genuinely in flight while a root is asked for. */
const cacheReadGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getName: () => 'silverdaw' } }))

vi.mock('node:fs/promises', () => ({
  readdir: readdirMock,
  readFile: vi.fn(async (path: string) => {
    if (cacheReadGate.wait) await cacheReadGate.wait
    const value = files.get(path)
    if (value === undefined) throw new Error('ENOENT')
    return value
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    files.set(path, data)
  }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn(async (from: string, to: string) => {
    const value = files.get(from)
    if (value === undefined) throw new Error('ENOENT')
    files.set(to, value)
    files.delete(from)
  }),
  unlink: vi.fn(async (path: string) => {
    files.delete(path)
  })
}))

vi.mock('music-metadata', () => ({ parseFile: parseFileMock }))

import {
  INDEX_READ_CONCURRENCY,
  getFolderIndex,
  loadFileBrowserIndexCache,
  resetFileBrowserIndexes,
  setFileBrowserIndexCachePath
} from '@main/fileBrowserIndex'
import { registerFileBrowserRoot, unregisterFileBrowserRoot } from '@main/audioPaths'

const ROOT = process.platform === 'win32' ? 'C:\\indexed' : '/indexed'
const sep = process.platform === 'win32' ? '\\' : '/'
const CACHE = '/tmp/file-browser-index.test.json'

const file = (name: string): { name: string; isDirectory(): boolean; isFile(): boolean } => ({
  name,
  isDirectory: () => false,
  isFile: () => true
})

describe('file browser index cache', () => {
  beforeEach(() => {
    files.clear()
    cacheReadGate.wait = null
    readdirMock.mockReset().mockResolvedValue([])
    parseFileMock.mockReset().mockResolvedValue({ common: {}, format: {} })
    resetFileBrowserIndexes()
    setFileBrowserIndexCachePath(CACHE)
  })

  it('restores a crawled index after a restart without touching the disk again', async () => {
    registerFileBrowserRoot(ROOT)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === ROOT ? [file('a.mp3')] : []
    )
    parseFileMock.mockResolvedValue({ common: { title: 'Kept' }, format: { duration: 1 } })
    await getFolderIndex(ROOT)

    // A fresh run: memory is empty, but the cache file survives.
    resetFileBrowserIndexes()
    readdirMock.mockClear()
    parseFileMock.mockClear()
    await loadFileBrowserIndexCache()
    const index = await getFolderIndex(ROOT)

    expect(index.folders[ROOT]).toEqual([
      { path: ROOT + sep + 'a.mp3', name: 'a', kind: 'file' }
    ])
    expect(index.tags[ROOT + sep + 'a.mp3']).toEqual({ title: 'Kept', durationMs: 1000 })
    expect(readdirMock).not.toHaveBeenCalled()
    expect(parseFileMock).not.toHaveBeenCalled()
  })

  it('discards a cached index for a folder the user has since removed', async () => {
    registerFileBrowserRoot(ROOT)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === ROOT ? [file('a.mp3')] : []
    )
    parseFileMock.mockResolvedValue({ common: { title: 'Private' }, format: {} })
    await getFolderIndex(ROOT)

    resetFileBrowserIndexes()
    unregisterFileBrowserRoot(ROOT)
    await loadFileBrowserIndexCache()

    // Nothing was restored — not the listing and not the tags read from those
    // files — and re-asking refuses rather than crawling.
    readdirMock.mockClear()
    const index = await getFolderIndex(ROOT)
    expect(index.folders).toEqual({})
    expect(index.tags).toEqual({})
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('drops cached listings for folders outside the trusted roots', async () => {
    registerFileBrowserRoot(ROOT)
    const outside = process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere'
    // A hand-edited cache claiming a listing the user never consented to.
    files.set(
      CACHE,
      JSON.stringify([
        {
          root: ROOT,
          folders: {
            [ROOT]: [{ path: ROOT + sep + 'a.mp3', name: 'a', kind: 'file' }],
            [outside]: [{ path: outside + sep + 'secret.mp3', name: 'secret', kind: 'file' }]
          },
          tags: {},
          indexedAt: 1
        }
      ])
    )

    await loadFileBrowserIndexCache()
    const index = await getFolderIndex(ROOT)

    expect(Object.keys(index.folders)).toEqual([ROOT])
  })

  it('waits for the startup cache read rather than crawling a root it is about to restore', async () => {
    registerFileBrowserRoot(ROOT)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === ROOT ? [file('a.mp3')] : []
    )
    await getFolderIndex(ROOT)

    // A fresh launch: the cache read is started but not awaited, exactly as
    // startup does it, and the renderer asks for the root while it is still
    // reading — the window that makes this worth guarding at all.
    resetFileBrowserIndexes()
    readdirMock.mockClear()
    let finishRead = (): void => {}
    cacheReadGate.wait = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    void loadFileBrowserIndexCache()
    const asked = getFolderIndex(ROOT)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Nothing may have been crawled yet: the answer is still on its way.
    expect(readdirMock).not.toHaveBeenCalled()

    finishRead()
    const index = await asked

    expect(index.folders[ROOT]).toHaveLength(1)
    // Crawling here would redo work the cache was already handing over.
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('ignores a malformed cache and crawls instead', async () => {
    registerFileBrowserRoot(ROOT)
    files.set(CACHE, '{ not json')
    readdirMock.mockImplementation(async (dir: string) =>
      dir === ROOT ? [file('a.mp3')] : []
    )

    await loadFileBrowserIndexCache()

    expect((await getFolderIndex(ROOT)).folders[ROOT]).toHaveLength(1)
  })

  it('reads tags with bounded concurrency', async () => {
    registerFileBrowserRoot(ROOT)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === ROOT ? Array.from({ length: 40 }, (_, i) => file(`t${i}.mp3`)) : []
    )
    let inFlight = 0
    let peak = 0
    parseFileMock.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return { common: {}, format: {} }
    })

    await getFolderIndex(ROOT)

    expect(parseFileMock).toHaveBeenCalledTimes(40)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(INDEX_READ_CONCURRENCY)
  })
})
