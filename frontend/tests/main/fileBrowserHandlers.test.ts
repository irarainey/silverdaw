// Coverage for the file-browser IPC handlers: adding a folder is the consent
// step, so listings must stay confined to added folders and must only surface
// files the library can actually import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const showOpenDialog = vi.hoisted(() => vi.fn())
const readdirMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'silverdaw' },
  dialog: { showOpenDialog },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

vi.mock('node:fs/promises', () => ({ readdir: readdirMock }))

import { registerFileBrowserHandlers, restoreFileBrowserRoots } from '@main/ipc/fileBrowserHandlers'
import { isAllowedAudioPath } from '@main/audioPaths'
import { buildDefaultPrefs, type Preferences } from '@main/preferences'

const ROOT = process.platform === 'win32' ? 'C:\\browsed' : '/browsed'
const sep = process.platform === 'win32' ? '\\' : '/'
const abs = (...parts: string[]): string => ROOT + sep + parts.join(sep)

interface FakeDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

const dir = (name: string): FakeDirent => ({
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

  beforeEach(() => {
    handlers.clear()
    showOpenDialog.mockReset()
    readdirMock.mockReset()
    store = buildDefaultPrefs()
    flush = vi.fn()
    registerFileBrowserHandlers({
      getMainWindow: () => ({}) as never,
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

  it('lists subfolders and importable audio files only', async () => {
    const folder = abs('Mixed')
    await addRoot(folder)
    readdirMock.mockResolvedValue([
      file('track.mp3'),
      file('notes.txt'),
      file('cover.jpg'),
      file('lossless.flac'),
      dir('Album'),
      link('shortcut.mp3')
    ])

    const entries = await call('fileBrowser:listDirectory', folder)

    expect(entries).toEqual([
      { path: folder + sep + 'Album', name: 'Album', kind: 'directory' },
      { path: folder + sep + 'lossless.flac', name: 'lossless', kind: 'file' },
      { path: folder + sep + 'track.mp3', name: 'track', kind: 'file' }
    ])
  })

  it('refuses to list a directory outside every added folder', async () => {
    await addRoot(abs('Allowed'))
    readdirMock.mockResolvedValue([file('secret.mp3')])

    expect(await call('fileBrowser:listDirectory', abs('Elsewhere'))).toEqual([])
    expect(await call('fileBrowser:listDirectory', abs('Allowed', '..', 'Escape'))).toEqual([])
    expect(await call('fileBrowser:listDirectory', 42)).toEqual([])
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('lists a nested folder inside an added folder', async () => {
    const folder = abs('Deep')
    await addRoot(folder)
    readdirMock.mockResolvedValue([file('b.mp3')])

    const entries = await call('fileBrowser:listDirectory', folder + sep + 'Album')

    expect(entries).toEqual([
      { path: folder + sep + 'Album' + sep + 'b.mp3', name: 'b', kind: 'file' }
    ])
  })

  it('returns an empty listing when the folder cannot be read', async () => {
    const folder = abs('Gone')
    await addRoot(folder)
    readdirMock.mockRejectedValue(new Error('ENOENT'))

    expect(await call('fileBrowser:listDirectory', folder)).toEqual([])
  })

  it('withdraws listing and read access when a folder is removed', async () => {
    const folder = abs('Temporary')
    await addRoot(folder)
    expect(isAllowedAudioPath(abs('Temporary', 'song.mp3'))).toBe(true)

    const folders = await call('fileBrowser:removeFolder', folder)

    expect(folders).toEqual([])
    expect(store.ui.fileBrowserFolders).toEqual([])
    expect(isAllowedAudioPath(abs('Temporary', 'song.mp3'))).toBe(false)
    readdirMock.mockResolvedValue([file('song.mp3')])
    expect(await call('fileBrowser:listDirectory', folder)).toEqual([])
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
