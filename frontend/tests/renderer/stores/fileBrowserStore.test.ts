import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFileBrowserStore,
  fileBrowserFileMatchesFilter,
  fileBrowserFileTypeLabel
} from '@/stores/fileBrowserStore'
import { usePreviewStore } from '@/stores/previewStore'

const sendMock = vi.hoisted(() => vi.fn())
const importPathsMock = vi.hoisted(() => vi.fn())
const ensurePlayableMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string | null>>())

vi.mock('@/lib/bridgeService', () => ({ send: sendMock }))
vi.mock('@/lib/importAudio', () => ({ importAudioPathsIntoLibrary: importPathsMock }))
vi.mock('@/lib/audioPlaybackPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audioPlaybackPath')>()),
  ensureBackendPlayablePath: ensurePlayableMock
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const ROOT = 'C:\\music'
const NESTED = 'C:\\music\\Album'

// One shallow listing per directory, mirroring the lazy main-process handler.
const listing: Record<string, FileBrowserEntry[]> = {
  [ROOT]: [
    { path: NESTED, name: 'Album', kind: 'directory' },
    { path: 'C:\\music\\Top.mp3', name: 'Top', kind: 'file' }
  ],
  [NESTED]: [{ path: 'C:\\music\\Album\\Deep.mp3', name: 'Deep', kind: 'file' }]
}

const listFolders = vi.fn<() => Promise<string[]>>()
const addFolder = vi.fn<() => Promise<string[]>>()
const removeFolder = vi.fn<(folder: string) => Promise<string[]>>()
const listDirectory = vi.fn<(dir: string) => Promise<FileBrowserEntry[]>>()
const readAudioMetadata = vi.fn<(path: string) => Promise<AudioMetadata | null>>()

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
  importPathsMock.mockClear()
  ensurePlayableMock.mockReset().mockResolvedValue(null)
  listFolders.mockReset().mockResolvedValue([ROOT])
  addFolder.mockReset().mockResolvedValue([ROOT])
  removeFolder.mockReset().mockResolvedValue([])
  listDirectory.mockReset().mockImplementation(async (dir: string) => listing[dir] ?? [])
  readAudioMetadata.mockReset().mockResolvedValue(null)
  vi.stubGlobal('window', {
    silverdaw: {
      listFileBrowserFolders: listFolders,
      addFileBrowserFolder: addFolder,
      removeFileBrowserFolder: removeFolder,
      listFileBrowserDirectory: listDirectory,
      readAudioMetadata
    }
  })
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:cover'),
    revokeObjectURL: vi.fn()
  })
})

describe('useFileBrowserStore tree', () => {
  it('expands added folders on hydrate so their files are immediately visible', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    expect(browser.roots).toEqual([ROOT])
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, 'C:\\music\\Top.mp3'])
    // The nested folder is listed but stays shut until the user opens it.
    expect(listDirectory).toHaveBeenCalledTimes(1)
  })

  it('retries hydrating after a failed folder read', async () => {
    const browser = useFileBrowserStore()
    listFolders.mockRejectedValueOnce(new Error('ipc down'))

    await browser.hydrate()
    expect(browser.roots).toEqual([])

    await browser.hydrate()
    expect(browser.roots).toEqual([ROOT])
  })

  it('lists a nested folder only when it is first expanded, then reuses the cache', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    await browser.toggle(NESTED)
    expect(browser.rows.map((row) => row.path)).toEqual([
      ROOT,
      NESTED,
      'C:\\music\\Album\\Deep.mp3',
      'C:\\music\\Top.mp3'
    ])

    await browser.toggle(NESTED)
    await browser.toggle(NESTED)
    // Two directories listed in total; re-expanding does not re-read the disk.
    expect(listDirectory).toHaveBeenCalledTimes(2)
  })

  it('marks only added folders as removable', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    await browser.toggle(NESTED)

    const byPath = Object.fromEntries(browser.rows.map((row) => [row.path, row]))
    expect(byPath[ROOT]?.isRoot).toBe(true)
    expect(byPath[NESTED]?.isRoot).toBe(false)
  })

  it('indents nested rows one level deeper than their folder', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    await browser.toggle(NESTED)

    const byPath = Object.fromEntries(browser.rows.map((row) => [row.path, row]))
    expect(byPath[ROOT]?.depth).toBe(0)
    expect(byPath[NESTED]?.depth).toBe(1)
    expect(byPath['C:\\music\\Album\\Deep.mp3']?.depth).toBe(2)
  })

  it('refresh re-reads a folder so newly added files appear', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    listing[ROOT] = [{ path: 'C:\\music\\New.mp3', name: 'New', kind: 'file' }]
    await browser.refresh(ROOT)

    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, 'C:\\music\\New.mp3'])
    listing[ROOT] = [
      { path: NESTED, name: 'Album', kind: 'directory' },
      { path: 'C:\\music\\Top.mp3', name: 'Top', kind: 'file' }
    ]
  })
})

describe('useFileBrowserStore removal', () => {
  it('drops cached rows and revokes cover art for a removed folder', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    readAudioMetadata.mockResolvedValue({
      title: 'Top Song',
      coverArt: { data: new ArrayBuffer(4), mimeType: 'image/jpeg' }
    })
    await browser.ensureInfo('C:\\music\\Top.mp3')
    expect(browser.info['C:\\music\\Top.mp3']?.coverArtUrl).toBe('blob:cover')

    await browser.removeFolder(ROOT)

    expect(browser.roots).toEqual([])
    expect(browser.rows).toEqual([])
    expect(browser.info['C:\\music\\Top.mp3']).toBeUndefined()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover')
  })

  it('stops auditioning a file that lived inside the removed folder', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    await browser.hydrate()
    browser.play('C:\\music\\Top.mp3')
    sendMock.mockClear()

    await browser.removeFolder(ROOT)

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_UNLOAD')
    expect(preview.filePath).toBeNull()
  })

  it('stops any file audition when a folder is removed, wherever it came from', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    await browser.hydrate()
    browser.play('D:\\other\\Song.mp3')
    sendMock.mockClear()

    await browser.removeFolder(ROOT)

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_UNLOAD')
    expect(preview.filePath).toBeNull()
  })

  it('leaves the preview alone when no file is being auditioned', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    sendMock.mockClear()

    await browser.removeFolder(ROOT)

    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_UNLOAD')
  })

  it('selects one file at a time', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    expect(browser.selectedPath).toBeNull()

    browser.select('C:\\music\\Top.mp3')
    expect(browser.selectedPath).toBe('C:\\music\\Top.mp3')

    browser.select('D:\\other\\Song.mp3')
    expect(browser.selectedPath).toBe('D:\\other\\Song.mp3')
  })

  it('clears a selection that lived inside a removed folder', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select('C:\\music\\Top.mp3')

    await browser.removeFolder(ROOT)

    expect(browser.selectedPath).toBeNull()
  })

  it('keeps a selection from another folder when a folder is removed', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select('D:\\other\\Song.mp3')

    await browser.removeFolder(ROOT)

    expect(browser.selectedPath).toBe('D:\\other\\Song.mp3')
  })

  it('removes the selected folder on request', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select(ROOT)

    await browser.removeSelectedFolder()

    expect(removeFolder).toHaveBeenCalledWith(ROOT)
    expect(browser.roots).not.toContain(ROOT)
    expect(browser.selectedPath).toBeNull()
  })

  it('refuses to remove a selected nested folder, which leaves only with its root', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select(NESTED)

    await browser.removeSelectedFolder()

    expect(removeFolder).not.toHaveBeenCalled()
    expect(browser.roots).toContain(ROOT)
  })

  it('does nothing when a file, or nothing at all, is selected', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    await browser.removeSelectedFolder()
    browser.select('C:\\music\\Top.mp3')
    await browser.removeSelectedFolder()

    expect(removeFolder).not.toHaveBeenCalled()
  })
})

describe('fileBrowserFileTypeLabel', () => {
  it('reports the extension in upper case', () => {
    expect(fileBrowserFileTypeLabel('Top.mp3')).toBe('MP3')
    expect(fileBrowserFileTypeLabel('Take 1.FLAC')).toBe('FLAC')
    expect(fileBrowserFileTypeLabel('mix.final.wav')).toBe('WAV')
  })

  // Rows carry a display name with the extension stripped, so the column reads
  // the path; a dot in a folder name must not be read as an extension.
  it('reads the extension from the last segment of a path', () => {
    expect(fileBrowserFileTypeLabel('C:\\music\\Album\\Deep.m4a')).toBe('M4A')
    expect(fileBrowserFileTypeLabel('C:\\my.music\\Deep')).toBe('')
  })

  it('returns nothing when the name carries no usable extension', () => {
    expect(fileBrowserFileTypeLabel('README')).toBe('')
    expect(fileBrowserFileTypeLabel('trailing.')).toBe('')
    // A leading dot is a hidden file, not a type.
    expect(fileBrowserFileTypeLabel('.gitignore')).toBe('')
  })
})

describe('useFileBrowserStore keyboard navigation', () => {  it('walks the visible rows with the arrow keys and stops at both ends', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    // Roots open on hydrate, the nested folder stays shut, so the visible rows
    // are: C:\music, C:\music\Album, C:\music\Top.mp3, D:\other, ...Song.mp3.
    const visible = browser.rows.map((row) => row.path)

    browser.selectStep(1)
    expect(browser.selectedPath).toBe(visible[0])

    browser.selectStep(1)
    expect(browser.selectedPath).toBe(visible[1])

    browser.selectStep(-1)
    expect(browser.selectedPath).toBe(visible[0])

    // Already at the top: the selection holds rather than wrapping round.
    browser.selectStep(-1)
    expect(browser.selectedPath).toBe(visible[0])
  })

  it('enters the list at the bottom when arrowing up from no selection', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    browser.selectStep(-1)

    expect(browser.selectedPath).toBe(browser.rows[browser.rows.length - 1]?.path)
  })

  it('skips rows hidden inside a collapsed folder', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    // The nested folder is closed, so its file is not a row to step onto.
    browser.select(NESTED)

    browser.selectStep(1)

    expect(browser.selectedPath).not.toBe('C:\\music\\Album\\Deep.mp3')
    expect(browser.selectedPath).toBe('C:\\music\\Top.mp3')
  })

  it('activating a folder toggles it open and closed', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select(NESTED)

    browser.activateSelected()
    await Promise.resolve()
    expect(browser.expanded[NESTED]).toBe(true)

    browser.activateSelected()
    expect(browser.expanded[NESTED]).toBe(false)
  })

  it('activating a file toggles its playback', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    await browser.hydrate()
    browser.select('C:\\music\\Top.mp3')

    browser.activateSelected()
    expect(preview.filePath).toBe('C:\\music\\Top.mp3')

    preview.isLoaded = true
    preview.isPlaying = true
    sendMock.mockClear()
    browser.activateSelected()
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_PAUSE')
  })

  it('does nothing when the selection is not a visible row', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select('C:\\music\\Album\\Deep.mp3')

    browser.activateSelected()

    expect(browser.selectedPath).toBe('C:\\music\\Album\\Deep.mp3')
  })

  // The view unmounts on a tab switch, so the offset has to survive in the
  // store for the tree to come back where the user left it.
  it('remembers the tree scroll offset, ignoring values a scroller cannot hold', () => {
    const browser = useFileBrowserStore()

    browser.setScrollTop(240)
    expect(browser.scrollTop).toBe(240)

    browser.setScrollTop(-10)
    expect(browser.scrollTop).toBe(0)

    browser.setScrollTop(Number.NaN)
    expect(browser.scrollTop).toBe(0)
  })
})

describe('useFileBrowserStore filter', () => {
  it('matches on track name and artist, ignoring case, but never the album', () => {
    const info = { title: 'Night Drive', artist: 'The Band', album: 'Neon Roads' }

    expect(fileBrowserFileMatchesFilter('drive', 'Top.mp3', info)).toBe(true)
    expect(fileBrowserFileMatchesFilter('BAND', 'Top.mp3', info)).toBe(true)
    expect(fileBrowserFileMatchesFilter('neon', 'Top.mp3', info)).toBe(false)
    expect(fileBrowserFileMatchesFilter('nothing', 'Top.mp3', info)).toBe(false)
  })

  it('falls back to the file name, which is what an untagged row displays', () => {
    expect(fileBrowserFileMatchesFilter('top', 'Top.mp3', undefined)).toBe(true)
    expect(fileBrowserFileMatchesFilter('other', 'Top.mp3', undefined)).toBe(false)
  })

  it('treats an empty or whitespace-only query as no filter', () => {
    expect(fileBrowserFileMatchesFilter('', 'Top.mp3', undefined)).toBe(true)
    expect(fileBrowserFileMatchesFilter('   ', 'Top.mp3', undefined)).toBe(true)
  })

  it('hides non-matching files and folders left with nothing beneath them', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockImplementation(async (path: string) =>
      path === 'C:\\music\\Top.mp3' ? { title: 'Night Drive', artist: 'The Band' } : { title: 'Deep Cut' }
    )
    await browser.hydrate()

    await browser.setFilter('night')

    // The nested folder holds no match, so it drops out of the tree.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, 'C:\\music\\Top.mp3'])
  })

  it('keeps a folder whose match is nested deeper inside it', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockImplementation(async (path: string) =>
      path === 'C:\\music\\Album\\Deep.mp3' ? { title: 'Deep Cut' } : { title: 'Night Drive' }
    )
    await browser.hydrate()

    await browser.setFilter('deep')

    expect(browser.rows.map((row) => row.path)).toEqual([
      ROOT,
      NESTED,
      'C:\\music\\Album\\Deep.mp3'
    ])
  })

  it('hides every folder when nothing matches anywhere', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Night Drive' })
    await browser.hydrate()

    await browser.setFilter('nothing here')

    expect(browser.rows).toEqual([])
    expect(browser.filterHidesEverything).toBe(true)
  })

  it('opens every folder while filtering and restores the tree when cleared', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Deep Cut' })
    await browser.hydrate()

    // Hydrate opens the roots only, leaving the nested folder shut.
    expect(browser.expanded[NESTED]).not.toBe(true)

    await browser.setFilter('deep')
    expect(browser.expanded[NESTED]).toBe(true)

    await browser.setFilter('')
    expect(browser.expanded[NESTED]).not.toBe(true)
    expect(browser.expanded[ROOT]).toBe(true)
  })

  it('restores the disclosure state from before the search, not mid-search', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Deep Cut' })
    await browser.hydrate()

    await browser.setFilter('d')
    await browser.setFilter('de')
    await browser.setFilter('dee')
    await browser.setFilter('')

    expect(browser.expanded[NESTED]).not.toBe(true)
  })

  it('reads tags for files that have never been rendered so they can match', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    readAudioMetadata.mockClear()

    await browser.setFilter('band')

    expect(readAudioMetadata).toHaveBeenCalledWith('C:\\music\\Top.mp3')
    // Reached only by listing a folder the user never opened.
    expect(readAudioMetadata).toHaveBeenCalledWith('C:\\music\\Album\\Deep.mp3')
  })

  it('does not report an empty result while no filter is set', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    expect(browser.filterHidesEverything).toBe(false)
  })
})

describe('useFileBrowserStore audition bar', () => {
  const TOP = 'C:\\music\\Top.mp3'

  it('reports the audition for the bar above the tree, whatever the filter', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Deep Cut' })
    await browser.hydrate()
    browser.play(TOP)

    expect(browser.pinnedAudition).toMatchObject({ path: TOP, kind: 'file', pinned: true })

    await browser.setFilter('nothing here')

    // The bar is the handle on playback a filter can no longer take away.
    expect(browser.pinnedAudition).toMatchObject({ path: TOP, pinned: true })
    expect(browser.filterHidesEverything).toBe(true)
  })

  it('reports nothing while no file is being auditioned', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    expect(browser.pinnedAudition).toBeNull()
  })

  it('leaves the audition listed in its own folder', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.play(TOP)

    // The bar reports playback; it does not move the file out of the tree.
    expect(browser.rows.filter((row) => row.path === TOP)).toHaveLength(1)
    expect(browser.rows.some((row) => row.pinned === true)).toBe(false)
  })

  it('reopens and selects the audition when the filter is cleared', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Deep Cut' })
    await browser.hydrate()
    const deep = 'C:\\music\\Album\\Deep.mp3'
    await browser.setFilter('deep')
    browser.play(deep)

    await browser.setFilter('')

    // Restoring the pre-search tree would otherwise fold the playing file away.
    expect(browser.expanded[NESTED]).toBe(true)
    expect(browser.selectedPath).toBe(deep)
    expect(browser.rows.some((row) => row.path === deep)).toBe(true)
  })

  it('leaves the selection alone when nothing is being auditioned', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select(ROOT)

    await browser.setFilter('')

    expect(browser.selectedPath).toBe(ROOT)
  })
})

describe('useFileBrowserStore metadata', () => {
  it('reads a file\'s tags once however many times a row asks', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Song', artist: 'Band', album: 'Record' })

    await browser.ensureInfo('C:\\music\\Top.mp3')
    await browser.ensureInfo('C:\\music\\Top.mp3')

    expect(readAudioMetadata).toHaveBeenCalledTimes(1)
    expect(browser.info['C:\\music\\Top.mp3']).toEqual({
      title: 'Song',
      artist: 'Band',
      album: 'Record'
    })
  })

  it('records an empty entry for an unreadable file so the row stops retrying', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockRejectedValue(new Error('nope'))

    await browser.ensureInfo('C:\\music\\Bad.mp3')

    expect(browser.info['C:\\music\\Bad.mp3']).toEqual({})
  })
})

describe('useFileBrowserStore playback and import', () => {
  const M4A = 'C:\\music\\Hooked.m4a'
  const CACHED_WAV = 'C:\\cache\\abc123.wav'

  it('auditions a format the engine cannot decode from a transcoded WAV', async () => {
    const browser = useFileBrowserStore()
    ensurePlayableMock.mockResolvedValue(CACHED_WAV)

    await browser.prepareAndPlay(M4A)

    // The engine is handed the WAV, never the undecodable source path.
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: CACHED_WAV,
      inMs: 0,
      durationMs: 0
    })
    expect(ensurePlayableMock).toHaveBeenCalledWith(M4A)
  })

  it('keeps row identity on the browsed file while auditioning its transcode', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    ensurePlayableMock.mockResolvedValue(CACHED_WAV)

    await browser.prepareAndPlay(M4A)
    preview.isPlaying = true

    expect(browser.auditionedPath).toBe(M4A)
    expect(browser.isPlaying(M4A)).toBe(true)
    expect(browser.isPlaying(CACHED_WAV)).toBe(false)
  })

  it('reuses a transcode so a second audition starts without decoding again', async () => {
    const browser = useFileBrowserStore()
    ensurePlayableMock.mockResolvedValue(CACHED_WAV)
    await browser.prepareAndPlay(M4A)
    browser.play('C:\\music\\Top.mp3')
    sendMock.mockClear()

    browser.play(M4A)

    expect(ensurePlayableMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: CACHED_WAV,
      inMs: 0,
      durationMs: 0
    })
  })

  it('abandons a transcode superseded by a newer audition', async () => {
    const browser = useFileBrowserStore()
    ensurePlayableMock.mockResolvedValue(CACHED_WAV)
    const pending = browser.prepareAndPlay(M4A)

    // The user clicks a directly playable row before the decode lands.
    browser.play('C:\\music\\Top.mp3')
    sendMock.mockClear()
    await pending

    expect(sendMock).not.toHaveBeenCalled()
    expect(browser.auditionedPath).toBe('C:\\music\\Top.mp3')
  })

  it('does not load anything when a file cannot be decoded', async () => {
    const browser = useFileBrowserStore()
    ensurePlayableMock.mockResolvedValue(null)

    await browser.prepareAndPlay(M4A)

    expect(sendMock).not.toHaveBeenCalled()
    expect(browser.auditionedPath).toBeNull()
  })

  it('play loads the file through the preview voice', () => {
    const browser = useFileBrowserStore()
    browser.play('C:\\music\\Top.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: 'C:\\music\\Top.mp3',
      inMs: 0,
      durationMs: 0
    })
  })

  it('play resumes rather than reloads the file already loaded', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    sendMock.mockClear()

    browser.play('C:\\music\\Top.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_PLAY')
    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_LOAD', expect.anything())
  })

  it('togglePlay starts the file when nothing is auditioned', () => {
    const browser = useFileBrowserStore()
    browser.togglePlay('C:\\music\\Top.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: 'C:\\music\\Top.mp3',
      inMs: 0,
      durationMs: 0
    })
  })

  it('togglePlay pauses the file it is already playing', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    preview.play()
    sendMock.mockClear()

    browser.togglePlay('C:\\music\\Top.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_PAUSE')
    expect(browser.isPlaying('C:\\music\\Top.mp3')).toBe(false)
  })

  it('togglePlay on another row switches the audition to that file', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    preview.play()
    sendMock.mockClear()

    browser.togglePlay('C:\\music\\Other.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_LOAD', {
      libraryItemId: '',
      filePath: 'C:\\music\\Other.mp3',
      inMs: 0,
      durationMs: 0
    })
  })

  it('isPlaying is true only for the row being auditioned', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    expect(browser.isPlaying('C:\\music\\Top.mp3')).toBe(false)

    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    preview.play()

    expect(browser.isPlaying('C:\\music\\Top.mp3')).toBe(true)
    expect(browser.isPlaying('C:\\music\\Other.mp3')).toBe(false)
  })

  it('restart returns the auditioned file to its start', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    preview.durationMs = 10_000
    preview.positionMs = 4_000
    sendMock.mockClear()

    browser.restart('C:\\music\\Top.mp3')

    expect(sendMock).toHaveBeenCalledWith('PREVIEW_SEEK', { positionMs: 0 })
    expect(preview.positionMs).toBe(0)
  })

  it('restart ignores a row that is not the one auditioned', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.positionMs = 4_000
    sendMock.mockClear()

    browser.restart('C:\\music\\Other.mp3')

    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_SEEK', expect.anything())
    expect(preview.positionMs).toBe(4_000)
  })

  it('pause only acts on the file currently auditioned', () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    browser.play('C:\\music\\Top.mp3')
    preview.isLoaded = true
    preview.play()
    sendMock.mockClear()

    browser.pause('C:\\music\\Other.mp3')
    expect(sendMock).not.toHaveBeenCalledWith('PREVIEW_PAUSE')

    browser.pause('C:\\music\\Top.mp3')
    expect(sendMock).toHaveBeenCalledWith('PREVIEW_PAUSE')
  })

  it('importFile routes through the shared library import path', async () => {
    const browser = useFileBrowserStore()
    await browser.importFile('C:\\music\\Top.mp3')

    expect(importPathsMock).toHaveBeenCalledWith(['C:\\music\\Top.mp3'])
  })
})
