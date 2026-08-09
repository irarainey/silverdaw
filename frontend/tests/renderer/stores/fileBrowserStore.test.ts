import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFileBrowserStore,
  fileBrowserActiveFilter,
  fileBrowserFileMatchesFilter,
  fileBrowserFileTypeLabel,
  resetFileBrowserIndexProgress
} from '@/stores/fileBrowserStore'
import { usePreviewStore } from '@/stores/previewStore'
import type {
  FileBrowserFileTags,
  FileBrowserFolderIndex,
  FileBrowserIndexProgress
} from '@shared/types'

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
const TOP_FILE = 'C:\\music\\Top.mp3'
const DEEP_FILE = 'C:\\music\\Album\\Deep.mp3'

// The folder structure a crawl of ROOT would find, keyed by folder path.
const listing: Record<string, FileBrowserEntry[]> = {
  [ROOT]: [
    { path: NESTED, name: 'Album', kind: 'directory' },
    { path: TOP_FILE, name: 'Top', kind: 'file' }
  ],
  [NESTED]: [{ path: DEEP_FILE, name: 'Deep', kind: 'file' }]
}

/** Tags the indexer would have read, keyed by file path; overridden per test. */
let indexTags: Record<string, FileBrowserFileTags> = {}

function buildIndex(root: string): FileBrowserFolderIndex {
  return { root, folders: { ...listing }, tags: { ...indexTags }, indexedAt: 1 }
}

const listFolders = vi.fn<() => Promise<string[]>>()
const addFolder = vi.fn<() => Promise<string[]>>()
const removeFolder = vi.fn<(folder: string) => Promise<string[]>>()
const getIndex = vi.fn<(root: string) => Promise<FileBrowserFolderIndex>>()
const refreshIndex = vi.fn<(root: string) => Promise<FileBrowserFolderIndex>>()
const readAudioMetadata = vi.fn<(path: string) => Promise<AudioMetadata | null>>()

/** Handlers registered for streamed crawl progress, so tests can drive them. */
let progressHandlers: ((progress: FileBrowserIndexProgress) => void)[] = []
const onIndexProgress = vi.fn((handler: (progress: FileBrowserIndexProgress) => void) => {
  progressHandlers.push(handler)
  return () => {
    progressHandlers = progressHandlers.filter((h) => h !== handler)
  }
})

/** Deliver one slice of a crawl, as the main process would mid-index. */
function emitProgress(progress: Partial<FileBrowserIndexProgress> & { root: string }): void {
  const message: FileBrowserIndexProgress = {
    folders: {},
    tags: {},
    fileCount: 0,
    taggedCount: 0,
    listed: false,
    ...progress
  }
  for (const handler of [...progressHandlers]) handler(message)
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetFileBrowserIndexProgress()
  progressHandlers = []
  sendMock.mockClear()
  importPathsMock.mockClear()
  ensurePlayableMock.mockReset().mockResolvedValue(null)
  indexTags = {}
  listFolders.mockReset().mockResolvedValue([ROOT])
  addFolder.mockReset().mockResolvedValue([ROOT])
  removeFolder.mockReset().mockResolvedValue([])
  getIndex.mockReset().mockImplementation(async (root: string) => buildIndex(root))
  refreshIndex.mockReset().mockImplementation(async (root: string) => buildIndex(root))
  readAudioMetadata.mockReset().mockResolvedValue(null)
  onIndexProgress.mockClear()
  vi.stubGlobal('window', {
    silverdaw: {
      listFileBrowserFolders: listFolders,
      addFileBrowserFolder: addFolder,
      removeFileBrowserFolder: removeFolder,
      getFileBrowserIndex: getIndex,
      refreshFileBrowserIndex: refreshIndex,
      onFileBrowserIndexProgress: onIndexProgress,
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
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, TOP_FILE])
    // One index call brings back the whole root; the nested folder is already
    // known but stays shut until the user opens it.
    expect(getIndex).toHaveBeenCalledTimes(1)
    expect(getIndex).toHaveBeenCalledWith(ROOT)
  })

  it('retries hydrating after a failed folder read', async () => {
    const browser = useFileBrowserStore()
    listFolders.mockRejectedValueOnce(new Error('ipc down'))

    await browser.hydrate()
    expect(browser.roots).toEqual([])

    await browser.hydrate()
    expect(browser.roots).toEqual([ROOT])
  })

  it('opens a nested folder without going back to disk for its contents', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    getIndex.mockClear()

    await browser.toggle(NESTED)
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, DEEP_FILE, TOP_FILE])

    await browser.toggle(NESTED)
    await browser.toggle(NESTED)
    // The crawl at hydrate already knew what was inside, so opening and closing
    // a folder is a state change and nothing more.
    expect(getIndex).not.toHaveBeenCalled()
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
    indexTags = {
      [TOP_FILE]: { title: 'Night Drive', artist: 'The Band' },
      [DEEP_FILE]: { title: 'Deep Cut' }
    }
    await browser.hydrate()

    browser.setFilter('night')

    // The nested folder holds no match, so it drops out of the tree.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, TOP_FILE])
  })

  it('keeps a folder whose match is nested deeper inside it', async () => {
    const browser = useFileBrowserStore()
    indexTags = {
      [TOP_FILE]: { title: 'Night Drive' },
      [DEEP_FILE]: { title: 'Deep Cut' }
    }
    await browser.hydrate()

    browser.setFilter('deep')

    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, DEEP_FILE])
  })

  it('hides every folder when nothing matches anywhere', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [TOP_FILE]: { title: 'Night Drive' }, [DEEP_FILE]: { title: 'Night Drive' } }
    await browser.hydrate()

    browser.setFilter('nothing here')

    expect(browser.rows).toEqual([])
    expect(browser.filterHidesEverything).toBe(true)
  })

  it('shows a match inside a folder the user never opened', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [DEEP_FILE]: { title: 'Deep Cut' } }
    await browser.hydrate()

    // Hydrate opens the roots only, leaving the nested folder shut.
    expect(browser.expanded[NESTED]).not.toBe(true)

    browser.setFilter('deep')

    // The row is shown even though its folder is shut, because the index knows
    // what is inside without anything having to open it.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, DEEP_FILE])
  })

  it('leaves the arranged tree untouched, so clearing the filter restores it', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [DEEP_FILE]: { title: 'Deep Cut' } }
    await browser.hydrate()
    const arranged = { ...browser.expanded }

    browser.setFilter('deep')

    // Showing a buried match must not cost the user the layout they arranged:
    // the disclosure state is not written to at all, so there is nothing to
    // snapshot, nothing to put back, and no way for the two to drift apart.
    expect(browser.expanded).toEqual(arranged)
    expect(browser.expanded[NESTED]).not.toBe(true)

    browser.setFilter('')
    expect(browser.expanded).toEqual(arranged)
  })

  it('treats a query shorter than the minimum as no filter at all', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    browser.setFilter('de')

    expect(fileBrowserActiveFilter('de')).toBe('')
    expect(browser.filterHidesEverything).toBe(false)
    // Nothing hidden, and no folder the user had left shut has been opened.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, TOP_FILE])
  })

  it('filters without going back to disk, however much is typed', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [DEEP_FILE]: { title: 'Deep Cut' } }
    await browser.hydrate()
    getIndex.mockClear()
    refreshIndex.mockClear()
    readAudioMetadata.mockClear()

    for (const query of ['dee', 'deep', 'deep ', 'deep c', 'deep cu', 'deep cut']) {
      browser.setFilter(query)
    }

    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, DEEP_FILE])
    // Everything a search needs came from the index, so no keystroke reaches
    // the filesystem however long the query gets.
    expect(getIndex).not.toHaveBeenCalled()
    expect(refreshIndex).not.toHaveBeenCalled()
    expect(readAudioMetadata).not.toHaveBeenCalled()
  })

  it('matches files in folders the user never opened, from the index alone', async () => {
    const browser = useFileBrowserStore()
    indexTags = {
      [TOP_FILE]: { artist: 'The Band' },
      [DEEP_FILE]: { artist: 'The Band' }
    }
    await browser.hydrate()
    readAudioMetadata.mockClear()

    browser.setFilter('band')

    // Both rows match on a tag, including one in a folder that was never opened
    // — and no tag read happens now, because the crawl already did them all.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, DEEP_FILE, TOP_FILE])
    expect(readAudioMetadata).not.toHaveBeenCalled()
  })

  it('does not report an empty result while no filter is set', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    expect(browser.filterHidesEverything).toBe(false)
  })
})

describe('useFileBrowserStore refresh', () => {
  it('re-crawls the added root that contains the folder asked for', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    await browser.refresh(NESTED)

    // The index is stored per added root, so refreshing anything inside one
    // re-reads that root rather than the single folder.
    expect(refreshIndex).toHaveBeenCalledWith(ROOT)
  })

  it('ignores a refresh for a folder outside every added root', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    await browser.refresh('D:\\elsewhere')

    expect(refreshIndex).not.toHaveBeenCalled()
  })

  it('drops rows, selection and cover art for files a re-crawl no longer finds', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [DEEP_FILE]: { title: 'Deep Cut' } }
    await browser.hydrate()
    browser.info[DEEP_FILE] = { title: 'Deep Cut', coverArtUrl: 'blob:deep' }
    browser.select(DEEP_FILE)

    // The nested file has been deleted on disk since the last crawl.
    refreshIndex.mockImplementation(async (root: string) => ({
      root,
      folders: { [ROOT]: [{ path: TOP_FILE, name: 'Top', kind: 'file' }] },
      tags: {},
      indexedAt: 2
    }))
    await browser.refresh(ROOT)

    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, TOP_FILE])
    // Left behind, the deleted file would linger as a stale selection and its
    // cover Blob would never be revoked.
    expect(browser.info[DEEP_FILE]).toBeUndefined()
    expect(browser.selectedPath).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:deep')
  })

  it('drops a tag the file no longer carries on disk', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [TOP_FILE]: { title: 'Old Title', artist: 'Old Artist' } }
    await browser.hydrate()
    expect(browser.info[TOP_FILE]?.artist).toBe('Old Artist')

    // The artist has been cleared in the file's tags since the last crawl. The
    // index omits an empty field rather than sending an explicit undefined, so
    // merging would keep showing the old value forever.
    refreshIndex.mockImplementation(async (root: string) => ({
      root,
      folders: { ...listing },
      tags: { [TOP_FILE]: { title: 'New Title' } },
      indexedAt: 2
    }))
    await browser.refresh(ROOT)

    expect(browser.info[TOP_FILE]?.title).toBe('New Title')
    expect(browser.info[TOP_FILE]?.artist).toBeUndefined()
  })

  it('keeps a cover already fetched when the index replaces the tags', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [TOP_FILE]: { title: 'Track' } }
    await browser.hydrate()
    browser.info[TOP_FILE] = { title: 'Track', coverArtUrl: 'blob:art' }

    // Applying the finished index over the streamed slices must not throw away
    // artwork a visible row has already loaded, or the Blob leaks.
    await browser.loadIndex(ROOT)

    expect(browser.info[TOP_FILE]?.coverArtUrl).toBe('blob:art')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:art')
  })

  it('drops cover art on refresh so changed artwork is read again', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.info[TOP_FILE] = { title: 'Track', coverArtUrl: 'blob:old-art' }
    browser.coverRequested[TOP_FILE] = true
    const epoch = browser.coverEpoch

    await browser.refresh(ROOT)

    // Tags come back with the crawl but artwork does not, so the cover state is
    // cleared and the rows asked to fetch again.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-art')
    expect(browser.info[TOP_FILE]?.coverArtUrl).toBeUndefined()
    expect(browser.coverRequested[TOP_FILE]).toBeUndefined()
    expect(browser.coverEpoch).toBe(epoch + 1)
  })

  it('leaves cover art outside the refreshed root alone', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    const other = 'D:\\other\\Song.mp3'
    browser.info[other] = { coverArtUrl: 'blob:other' }
    browser.coverRequested[other] = true

    await browser.refresh(ROOT)

    expect(browser.info[other]?.coverArtUrl).toBe('blob:other')
    expect(browser.coverRequested[other]).toBe(true)
  })

  it('flags a root that could not be read and clears the flag when it returns', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    expect(browser.unavailable[ROOT]).toBeUndefined()

    // The drive holding the folder has been disconnected.
    refreshIndex.mockImplementation(async (root: string) => ({
      root,
      folders: {},
      tags: {},
      indexedAt: 2,
      unavailable: true
    }))
    await browser.refresh(ROOT)
    expect(browser.unavailable[ROOT]).toBe(true)

    // Plugged back in: a retry has to clear the flag, not leave the row stuck
    // saying the folder is unavailable.
    refreshIndex.mockImplementation(async (root: string) => buildIndex(root))
    await browser.refresh(ROOT)

    expect(browser.unavailable[ROOT]).toBeUndefined()
  })
})

describe('useFileBrowserStore index progress', () => {
  /** A crawl that only finishes when the test says so. */
  function pendingIndex(): { resolve: () => void } {
    let release = (): void => {}
    getIndex.mockImplementation(async (root: string) => {
      await new Promise<void>((r) => {
        release = r
      })
      return buildIndex(root)
    })
    return { resolve: () => release() }
  }

  it('shows folders as the crawl reports them, before it has finished', async () => {
    const browser = useFileBrowserStore()
    const crawl = pendingIndex()
    const hydrating = browser.hydrate()
    await Promise.resolve()

    emitProgress({ root: ROOT, folders: { [ROOT]: listing[ROOT] ?? [] }, fileCount: 1 })

    // The index call has not returned, yet the user can already see the folder.
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, NESTED, TOP_FILE])
    crawl.resolve()
    await hydrating
  })

  it('reports how far an indexing folder has got, and stops once it is done', async () => {
    const browser = useFileBrowserStore()
    const crawl = pendingIndex()
    const hydrating = browser.hydrate()
    await Promise.resolve()

    expect(browser.indexLabel(ROOT)).toBe('Indexing…')

    // Still walking the tree: there is no total to count against yet.
    emitProgress({ root: ROOT, fileCount: 12 })
    expect(browser.indexLabel(ROOT)).toBe('Indexing… 12 files')

    // Every folder listed, so the remaining work is a known number of tag reads.
    emitProgress({ root: ROOT, fileCount: 12, taggedCount: 5, listed: true })
    expect(browser.indexLabel(ROOT)).toBe('Indexing… 5 of 12')

    crawl.resolve()
    await hydrating
    expect(browser.indexLabel(ROOT)).toBeNull()
  })

  it('brings tags in as they are read, so rows fill in during the crawl', async () => {
    const browser = useFileBrowserStore()
    const crawl = pendingIndex()
    const hydrating = browser.hydrate()
    await Promise.resolve()

    emitProgress({ root: ROOT, tags: { [TOP_FILE]: { title: 'Streamed In' } } })

    expect(browser.info[TOP_FILE]?.title).toBe('Streamed In')
    crawl.resolve()
    await hydrating
  })

  it('ignores progress for a folder that is not being indexed', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    const before = browser.rows.length

    // A crawl finishing after its folder was removed must not put rows back.
    emitProgress({
      root: 'D:\\gone',
      folders: { 'D:\\gone': [{ path: 'D:\\gone\\x.mp3', name: 'x', kind: 'file' }] }
    })
    emitProgress({ root: ROOT, folders: { 'C:\\music\\Ghost': [] } })

    expect(browser.rows).toHaveLength(before)
    expect(browser.children['D:\\gone']).toBeUndefined()
    expect(browser.children['C:\\music\\Ghost']).toBeUndefined()
  })

  it('keeps what a re-crawl reports rather than clearing it when the crawl ends', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()

    let release = (): void => {}
    refreshIndex.mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r
      })
      // The re-crawl found only the top-level file; the nested folder is gone.
      return {
        root: ROOT,
        folders: { [ROOT]: [{ path: TOP_FILE, name: 'Top', kind: 'file' }] },
        tags: {},
        indexedAt: 2
      }
    })
    const refreshing = browser.refresh(ROOT)
    await Promise.resolve()

    // The stale subtree is cleared as the re-crawl starts, so it is the streamed
    // slice — not a wipe at the end — that puts the tree back.
    emitProgress({
      root: ROOT,
      folders: { [ROOT]: [{ path: TOP_FILE, name: 'Top', kind: 'file' }] },
      fileCount: 1
    })
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, TOP_FILE])

    release()
    await refreshing
    expect(browser.rows.map((row) => row.path)).toEqual([ROOT, TOP_FILE])
  })

  it('subscribes once however many times the browser is hydrated', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    await browser.hydrate()
    browser.subscribeToIndexProgress()

    expect(onIndexProgress).toHaveBeenCalledTimes(1)
  })

  it('shows a newly added folder filling in while it is still being crawled', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    const NEW_ROOT = 'D:\\added'
    addFolder.mockResolvedValue([ROOT, NEW_ROOT])
    const crawl = pendingIndex()

    const adding = browser.addFolder()
    await Promise.resolve()
    await Promise.resolve()

    emitProgress({
      root: NEW_ROOT,
      folders: { [NEW_ROOT]: [{ path: 'D:\\added\\New.mp3', name: 'New', kind: 'file' }] },
      fileCount: 1
    })

    // Adding a large folder is exactly when the wait is longest, so its contents
    // must appear as they are found rather than only once the crawl returns.
    expect(browser.rows.map((row) => row.path)).toContain('D:\\added\\New.mp3')
    expect(browser.indexLabel(NEW_ROOT)).toBe('Indexing… 1 files')

    crawl.resolve()
    await adding
    expect(browser.indexLabel(NEW_ROOT)).toBeNull()
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

    browser.setFilter('nothing here')

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
    browser.setFilter('deep')
    browser.play(deep)

    browser.setFilter('')

    // Restoring the pre-search tree would otherwise fold the playing file away.
    expect(browser.expanded[NESTED]).toBe(true)
    expect(browser.selectedPath).toBe(deep)
    expect(browser.rows.some((row) => row.path === deep)).toBe(true)
  })

  it('reopens and selects a transcoded audition when the filter is cleared', async () => {
    const browser = useFileBrowserStore()
    const deep = 'C:\\music\\Album\\Deep.m4a'
    getIndex.mockImplementation(
      async (root: string): Promise<FileBrowserFolderIndex> => ({
        root,
        folders: {
          [ROOT]: listing[ROOT] ?? [],
          [NESTED]: [{ path: deep, name: 'Deep', kind: 'file' }]
        },
        tags: { [deep]: { title: 'Deep Cut' } },
        indexedAt: 1
      })
    )
    await browser.hydrate()
    ensurePlayableMock.mockResolvedValue('C:\\cache\\deep.wav')
    browser.setFilter('deep')
    await browser.prepareAndPlay(deep)

    browser.setFilter('')

    // The voice holds the cache WAV, which sits outside every browsed root, so
    // revealing has to work from the browsed path or it finds nothing at all.
    expect(browser.expanded[NESTED]).toBe(true)
    expect(browser.selectedPath).toBe(deep)
  })

  it('leaves the selection alone when nothing is being auditioned', async () => {
    const browser = useFileBrowserStore()
    await browser.hydrate()
    browser.select(ROOT)

    browser.setFilter('')

    expect(browser.selectedPath).toBe(ROOT)
  })
})

describe('useFileBrowserStore metadata', () => {
  it('reads a visible row\'s artwork once however many times it asks', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockResolvedValue({ title: 'Song', artist: 'Band', album: 'Record' })

    await browser.ensureInfo(TOP_FILE)
    await browser.ensureInfo(TOP_FILE)

    expect(readAudioMetadata).toHaveBeenCalledTimes(1)
    expect(browser.info[TOP_FILE]).toEqual({
      title: 'Song',
      artist: 'Band',
      album: 'Record'
    })
  })

  it('stops retrying a file whose artwork cannot be read', async () => {
    const browser = useFileBrowserStore()
    readAudioMetadata.mockRejectedValue(new Error('nope'))

    await browser.ensureInfo('C:\\music\\Bad.mp3')
    await browser.ensureInfo('C:\\music\\Bad.mp3')

    expect(readAudioMetadata).toHaveBeenCalledTimes(1)
  })

  it('keeps the indexed tags when a row reads its artwork', async () => {
    const browser = useFileBrowserStore()
    indexTags = { [TOP_FILE]: { title: 'Night Drive', artist: 'The Band', durationMs: 1000 } }
    await browser.hydrate()
    // A file whose artwork is embedded but whose tags the row already has.
    readAudioMetadata.mockResolvedValue({
      coverArt: { data: new Uint8Array([1]).buffer, mimeType: 'image/jpeg' }
    })

    await browser.ensureInfo(TOP_FILE)

    // The artwork read must add to what the index found rather than replace it,
    // or a row would lose its title the moment its cover arrived.
    expect(browser.info[TOP_FILE]).toMatchObject({
      title: 'Night Drive',
      artist: 'The Band',
      durationMs: 1000,
      coverArtUrl: 'blob:cover'
    })
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

  it('releases the audition when the shared preview voice is pointed elsewhere', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    ensurePlayableMock.mockResolvedValue(CACHED_WAV)
    await browser.prepareAndPlay(M4A)
    preview.isPlaying = true
    expect(browser.auditionedPath).toBe(M4A)

    // The voice is shared: whoever loads into it next owns it, so the browser
    // must stop claiming a row rather than wait to be told.
    preview.loadFile('D:\\elsewhere\\Backing.wav')

    expect(browser.auditionedPath).toBeNull()
    expect(browser.isPlaying(M4A)).toBe(false)
    expect(browser.pinnedAudition).toBeNull()
  })

  it('abandons a transcode if another consumer takes the shared voice meanwhile', async () => {
    const browser = useFileBrowserStore()
    const preview = usePreviewStore()
    const gate: { release?: (path: string | null) => void } = {}
    ensurePlayableMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          gate.release = resolve
        })
    )
    const pending = browser.prepareAndPlay(M4A)

    // The Clip Editor opens and seizes the voice while the decode is running.
    preview.load('item-1', 0, 1_000)
    sendMock.mockClear()
    gate.release?.(CACHED_WAV)
    await pending

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
