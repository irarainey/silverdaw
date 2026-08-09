// Coverage for the file-browser IPC handlers: adding a folder is the consent
// step, so the crawl behind it must stay confined to added folders and must only
// surface files the library can actually import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const showOpenDialog = vi.hoisted(() => vi.fn())
const readdirMock = vi.hoisted(() => vi.fn())
const parseFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'silverdaw' },
  dialog: { showOpenDialog },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

vi.mock('node:fs/promises', () => ({
  readdir: readdirMock,
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('music-metadata', () => ({ parseFile: parseFileMock }))

import { registerFileBrowserHandlers, restoreFileBrowserRoots } from '@main/ipc/fileBrowserHandlers'
import { resetFileBrowserIndexes, setFileBrowserIndexCachePath } from '@main/fileBrowserIndex'
import { isAllowedAudioPath } from '@main/audioPaths'
import { buildDefaultPrefs, type Preferences } from '@main/preferences'
import type { FileBrowserFolderIndex, FileBrowserIndexProgress } from '@shared/types'

const ROOT = process.platform === 'win32' ? 'C:\\browsed' : '/browsed'
const sep = process.platform === 'win32' ? '\\' : '/'
const abs = (...parts: string[]): string => ROOT + sep + parts.join(sep)

interface FakeDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

const dir_ = (name: string): FakeDirent => ({
  name,
  isDirectory: () => true,
  isFile: () => false
})
const file = (name: string): FakeDirent => ({
  name,
  isDirectory: () => false,
  isFile: () => true
})
// Neither a file nor a directory, as a symlink reports when not followed.
const link = (name: string): FakeDirent => ({
  name,
  isDirectory: () => false,
  isFile: () => false
})

describe('file browser IPC', () => {
  let store: Preferences
  let flush: ReturnType<typeof vi.fn>
  const sendToRenderer = vi.fn()
  let destroyed = false
  const mainWindow = { isDestroyed: () => destroyed, webContents: { send: sendToRenderer } }

  beforeEach(() => {
    handlers.clear()
    showOpenDialog.mockReset()
    sendToRenderer.mockReset()
    destroyed = false
    readdirMock.mockReset().mockResolvedValue([])
    parseFileMock.mockReset().mockResolvedValue({ common: {}, format: {} })
    resetFileBrowserIndexes()
    setFileBrowserIndexCachePath('/tmp/test-file-browser-index.json')
    store = buildDefaultPrefs()
    flush = vi.fn()
    registerFileBrowserHandlers({
      getMainWindow: () => mainWindow as never,
      prefs: { get: () => store, flushSaveSync: flush, schedulePrefsSave: flush } as never
    })
  })

  const call = async (channel: string, arg?: unknown): Promise<unknown> => {
    const fn = handlers.get(channel)
    expect(fn).toBeTypeOf('function')
    return await fn?.({}, arg)
  }

  const addRoot = async (folder: string): Promise<unknown> => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [folder] })
    return await call('fileBrowser:addFolder')
  }

  it('persists an added folder and grants audio reads inside it', async () => {
    const folder = abs('Added')
    expect(isAllowedAudioPath(abs('Added', 'song.mp3'))).toBe(false)

    const folders = await addRoot(folder)

    expect(folders).toEqual([folder])
    expect(store.ui.fileBrowserFolders).toEqual([folder])
    expect(flush).toHaveBeenCalled()
    expect(isAllowedAudioPath(abs('Added', 'song.mp3'))).toBe(true)
  })

  it('adds nothing when the picker is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await call('fileBrowser:addFolder')).toEqual([])
    expect(store.ui.fileBrowserFolders).toEqual([])
  })

  it('ignores a folder that has already been added', async () => {
    const folder = abs('Twice')
    await addRoot(folder)
    const folders = await addRoot(folder)
    expect(folders).toEqual([folder])
  })

  const getIndex = async (folder: string): Promise<FileBrowserFolderIndex> =>
    (await call('fileBrowser:getIndex', folder)) as FileBrowserFolderIndex

  /** Wait for a condition an in-flight crawl will satisfy, or give up. */
  const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ready(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(ready()).toBe(true)
  }

  it('indexes subfolders and importable audio files only', async () => {
    const folder = abs('Mixed')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder
        ? [
            file('track.mp3'),
            file('notes.txt'),
            file('cover.jpg'),
            file('lossless.flac'),
            dir_('Album'),
            link('shortcut.mp3')
          ]
        : []
    )

    const index = await getIndex(folder)

    expect(index.folders[folder]).toEqual([
      { path: folder + sep + 'Album', name: 'Album', kind: 'directory' },
      { path: folder + sep + 'lossless.flac', name: 'lossless', kind: 'file' },
      { path: folder + sep + 'track.mp3', name: 'track', kind: 'file' }
    ])
  })

  it('walks the whole tree in one pass, so nothing has to be listed again', async () => {
    const folder = abs('Deep')
    await addRoot(folder)
    const album = folder + sep + 'Album'
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === folder) return [dir_('Album'), file('a.mp3')]
      if (dir === album) return [file('b.mp3')]
      return []
    })

    const index = await getIndex(folder)

    expect(Object.keys(index.folders).sort()).toEqual([album, folder].sort())
    expect(index.folders[album]).toEqual([
      { path: album + sep + 'b.mp3', name: 'b', kind: 'file' }
    ])
  })

  it('collects the tags a search matches on, for every file it finds', async () => {
    const folder = abs('Tagged')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3')] : []
    )
    parseFileMock.mockResolvedValue({
      common: { title: 'Night Drive', artist: 'The Band', album: 'Neon Roads' },
      format: { duration: 12.5 }
    })

    const index = await getIndex(folder)

    expect(index.tags[folder + sep + 'a.mp3']).toEqual({
      title: 'Night Drive',
      artist: 'The Band',
      album: 'Neon Roads',
      durationMs: 12500
    })
    // Cover art is deliberately skipped: it is large binary data that only the
    // rows actually on screen ever display.
    expect(parseFileMock).toHaveBeenCalledWith(
      folder + sep + 'a.mp3',
      expect.objectContaining({ skipCovers: true })
    )
  })

  it('keeps a file whose tags cannot be read, since its row falls back to the name', async () => {
    const folder = abs('Broken')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('bad.mp3')] : []
    )
    parseFileMock.mockRejectedValue(new Error('corrupt'))

    const index = await getIndex(folder)

    expect(index.folders[folder]).toHaveLength(1)
    expect(index.tags[folder + sep + 'bad.mp3']).toEqual({})
  })

  it('reuses the index rather than crawling again', async () => {
    const folder = abs('Once')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3')] : []
    )

    await getIndex(folder)
    readdirMock.mockClear()
    parseFileMock.mockClear()
    await getIndex(folder)

    // The whole point of the index: browsing costs nothing after the first read.
    expect(readdirMock).not.toHaveBeenCalled()
    expect(parseFileMock).not.toHaveBeenCalled()
  })

  it('re-crawls on refresh, picking up what changed on disk', async () => {
    const folder = abs('Changing')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3')] : []
    )
    await getIndex(folder)

    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3'), file('b.mp3')] : []
    )
    const refreshed = (await call('fileBrowser:refreshIndex', folder)) as FileBrowserFolderIndex

    expect(refreshed.folders[folder]).toHaveLength(2)
  })

  it('reports the crawl as it goes, so the tree fills in before it finishes', async () => {
    const folder = abs('Streamed')
    await addRoot(folder)
    const album = folder + sep + 'Album'
    // The nested folder is held open, so the crawl is provably unfinished at the
    // point the first progress message is asserted.
    let releaseAlbum = (): void => {}
    const albumListed = new Promise<void>((resolve) => {
      releaseAlbum = resolve
    })
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === folder) return [dir_('Album'), file('a.mp3')]
      if (dir === album) {
        await albumListed
        return [file('b.mp3')]
      }
      return []
    })

    const pending = call('fileBrowser:getIndex', folder)
    // Yield until the first slice arrives, rather than counting microtasks.
    await until(() => sendToRenderer.mock.calls.length > 0)

    const [channel, first] = sendToRenderer.mock.calls[0] as [string, FileBrowserIndexProgress]
    expect(channel).toBe('fileBrowser:indexProgress')
    expect(first.root).toBe(folder)
    expect(first.folders[folder]).toHaveLength(2)
    expect(first.fileCount).toBe(1)
    // Still walking: nothing may claim the listing is complete yet.
    expect(first.listed).toBe(false)

    releaseAlbum()
    await pending

    const last = sendToRenderer.mock.calls.at(-1)?.[1] as FileBrowserIndexProgress
    expect(last.listed).toBe(true)
    expect(last.fileCount).toBe(2)
    expect(last.taggedCount).toBe(2)
  })

  it('reports nothing for an index served from cache, since there is no wait', async () => {
    const folder = abs('Cached')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3')] : []
    )
    await getIndex(folder)

    sendToRenderer.mockClear()
    await getIndex(folder)

    expect(sendToRenderer).not.toHaveBeenCalled()
  })

  it('batches progress rather than sending a message per file', async () => {
    const folder = abs('Many')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? Array.from({ length: 200 }, (_, i) => file(`t${i}.mp3`)) : []
    )

    await getIndex(folder)

    // 200 files, and a message each would flood the bridge for no visible gain.
    expect(sendToRenderer.mock.calls.length).toBeLessThan(20)
  })

  it('does not report progress to a window that has gone away', async () => {
    const folder = abs('Closing')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('a.mp3')] : []
    )
    destroyed = true

    await getIndex(folder)

    expect(sendToRenderer).not.toHaveBeenCalled()
  })

  it('refuses to index a directory outside every added folder', async () => {
    await addRoot(abs('Allowed'))

    expect((await getIndex(abs('Elsewhere'))).folders).toEqual({})
    expect((await getIndex(abs('Allowed', '..', 'Escape'))).folders).toEqual({})
    expect(await call('fileBrowser:getIndex', 42)).toMatchObject({ folders: {} })
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('does not descend out of the added folder through a nested entry', async () => {
    const folder = abs('Guarded')
    await addRoot(folder)
    // A listing claiming a child that resolves outside the root — the walk
    // re-checks every folder it is about to descend into rather than trusting
    // that being reached from inside the root is enough.
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [dir_('..')] : [file('secret.mp3')]
    )

    const index = await getIndex(folder)

    expect(Object.keys(index.folders)).toEqual([folder])
    expect(index.tags).toEqual({})
  })

  it('reports a root it cannot read as unavailable rather than as empty', async () => {
    const folder = abs('Gone')
    await addRoot(folder)
    readdirMock.mockRejectedValue(new Error('ENOENT'))

    const index = await getIndex(folder)

    // An empty listing would be indistinguishable from a folder with no audio
    // in it, and would be cached as though it were the truth.
    expect(index.unavailable).toBe(true)
    expect(index.folders).toEqual({})
  })

  it('retries an unavailable root instead of serving the failure from memory', async () => {
    const folder = abs('Offline')
    await addRoot(folder)
    readdirMock.mockRejectedValue(new Error('ENOENT'))
    expect((await getIndex(folder)).unavailable).toBe(true)

    // The drive comes back: asking again has to crawl, not return the failure
    // a successful crawl would have been allowed to cache.
    readdirMock.mockReset()
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('song.mp3')] : []
    )

    const index = await getIndex(folder)

    expect(index.unavailable).toBeUndefined()
    expect(index.folders[folder]?.map((entry) => entry.name)).toEqual(['song'])
  })

  it('keeps the folders it did read when only a subfolder is unreadable', async () => {
    const folder = abs('Partial')
    await addRoot(folder)
    const broken = abs('Partial', 'Broken')
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === folder) return [dir_('Broken'), file('good.mp3')]
      if (dir === broken) throw new Error('EACCES')
      return []
    })

    const index = await getIndex(folder)

    // One damaged subfolder is local damage, not a missing library.
    expect(index.unavailable).toBeUndefined()
    expect(index.folders[folder]?.map((entry) => entry.name)).toEqual(['Broken', 'good'])
    expect(index.folders[broken]).toEqual([])
  })

  it('withdraws read access and forgets the index when a folder is removed', async () => {
    const folder = abs('Temporary')
    await addRoot(folder)
    readdirMock.mockImplementation(async (dir: string) =>
      dir === folder ? [file('song.mp3')] : []
    )
    await getIndex(folder)
    expect(isAllowedAudioPath(abs('Temporary', 'song.mp3'))).toBe(true)

    const folders = await call('fileBrowser:removeFolder', folder)

    expect(folders).toEqual([])
    expect(store.ui.fileBrowserFolders).toEqual([])
    expect(isAllowedAudioPath(abs('Temporary', 'song.mp3'))).toBe(false)
    // The cached listing must not outlive the consent that allowed it.
    expect((await getIndex(folder)).folders).toEqual({})
  })

  it('reports the folders saved from a previous run', async () => {
    store.ui.fileBrowserFolders = [abs('Restored')]
    expect(await call('fileBrowser:listFolders')).toEqual([abs('Restored')])
  })

  it('re-trusts folders restored from preferences at startup', () => {
    const folder = abs('FromPrefs')
    expect(isAllowedAudioPath(folder + sep + 'song.mp3')).toBe(false)
    restoreFileBrowserRoots([folder])
    expect(isAllowedAudioPath(folder + sep + 'song.mp3')).toBe(true)
  })
})
