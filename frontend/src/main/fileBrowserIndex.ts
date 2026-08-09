// The library file browser's index: one crawl of an added root, cached in memory
// and persisted to userData, that everything downstream reads from. Listing a
// folder, rendering a row, expanding a branch and filtering the tree are all
// answered from this index, so the disk is touched only when a folder is added,
// when the user asks for a refresh, or once at startup to reload the cache.
//
// Crawling is confined to the browser's roots: the user picking a folder in the
// native dialog is the consent step, and `isWithinFileBrowserRoot` is re-checked
// for every directory the walk descends into, so a cache file edited by hand
// cannot widen what the app will read.

import { app } from 'electron'
import { readdir, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { parseFile } from 'music-metadata'
import type {
  FileBrowserEntry,
  FileBrowserFileTags,
  FileBrowserFolderIndex,
  FileBrowserIndexProgress
} from '../shared/types'
import { AUDIO_FILE_EXTENSIONS, canonicalisePath, isWithinFileBrowserRoot } from './audioPaths'
import { logMain } from './log'

/**
 * How many files are read for tags at once. Tag reads are IO-bound, so some
 * overlap is a large win over going one at a time, but an unbounded fan-out over
 * a library of tens of thousands of files would open that many handles at once
 * and starve everything else the app is doing.
 */
export const INDEX_READ_CONCURRENCY = 8

/**
 * How often a crawl in progress reports back. Emitting per folder or per file
 * would flood the bridge with thousands of messages for a large library and
 * cost more than the crawl itself; batching at this interval still fills the
 * tree in visibly, several times a second.
 */
export const INDEX_PROGRESS_INTERVAL_MS = 120

/** Called with each slice of a crawl as it completes. */
export type IndexProgressReporter = (progress: FileBrowserIndexProgress) => void

const AUDIO_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

/** Roots indexed this session, keyed by lower-cased path so lookups are stable. */
const indexes = new Map<string, FileBrowserFolderIndex>()

function keyFor(root: string): string {
  return canonicalisePath(root).toLowerCase()
}

function isImportableAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS_SET.has(extname(name).replace(/^\./, '').toLowerCase())
}

// Folders first, then files; both A-Z so the tree reads predictably. Uses locale
// compare so accented titles sort where a user expects them to.
function compareEntries(a: FileBrowserEntry, b: FileBrowserEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/** Read one directory, or an empty listing if it cannot be read. */
async function listOne(dir: string): Promise<FileBrowserEntry[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    const entries: FileBrowserEntry[] = []
    for (const dirent of dirents) {
      // Ignore symlinks: following them would let a link inside a browsed folder
      // reach arbitrary parts of the filesystem.
      if (dirent.isDirectory()) {
        entries.push({ path: join(dir, dirent.name), name: dirent.name, kind: 'directory' })
      } else if (dirent.isFile() && isImportableAudioFile(dirent.name)) {
        entries.push({
          path: join(dir, dirent.name),
          name: basename(dirent.name, extname(dirent.name)),
          kind: 'file'
        })
      }
    }
    return entries.sort(compareEntries)
  } catch (err) {
    logMain('WARN ', 'fileBrowser:index', 'read failed:', dir, String(err))
    return []
  }
}

/** Tags only: cover art is left for the rows that actually display one. */
async function readTags(filePath: string): Promise<FileBrowserFileTags> {
  try {
    const meta = await parseFile(filePath, { duration: true, skipCovers: true })
    const tags: FileBrowserFileTags = {}
    const title = meta.common.title?.trim()
    const artist = meta.common.artist?.trim()
    const album = meta.common.album?.trim()
    if (title) tags.title = title
    if (artist) tags.artist = artist
    if (album) tags.album = album
    if (typeof meta.format.duration === 'number' && Number.isFinite(meta.format.duration)) {
      tags.durationMs = Math.round(meta.format.duration * 1000)
    }
    return tags
  } catch (err) {
    // A file with no readable tags still belongs in the index: it is browsable
    // and importable, and its row falls back to the file name.
    logMain('WARN ', 'fileBrowser:index', 'tag read failed:', filePath, String(err))
    return {}
  }
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * Accumulates what a crawl has completed and reports it at most every
 * `INDEX_PROGRESS_INTERVAL_MS`. Each message carries only the slice gathered
 * since the last, so the renderer can apply them in order without re-sending
 * the growing index every time.
 */
function createProgressBatcher(root: string, report: IndexProgressReporter | undefined) {
  let folders: Record<string, FileBrowserEntry[]> = {}
  let tags: Record<string, FileBrowserFileTags> = {}
  let fileCount = 0
  let taggedCount = 0
  let listed = false
  let lastSentAt = 0

  const send = (): void => {
    lastSentAt = Date.now()
    const slice = { root, folders, tags, fileCount, taggedCount, listed }
    folders = {}
    tags = {}
    report?.(slice)
  }

  return {
    addFolder(dir: string, entries: FileBrowserEntry[], files: number): void {
      if (!report) return
      folders[dir] = entries
      fileCount += files
      if (Date.now() - lastSentAt >= INDEX_PROGRESS_INTERVAL_MS) send()
    },
    addTags(filePath: string, value: FileBrowserFileTags): void {
      if (!report) return
      tags[filePath] = value
      taggedCount += 1
      if (Date.now() - lastSentAt >= INDEX_PROGRESS_INTERVAL_MS) send()
    },
    /** Report everything gathered so far, whatever the interval says. */
    flush(everythingListed: boolean): void {
      if (!report) return
      listed = listed || everythingListed
      send()
    }
  }
}

/**
 * Walk a root once, collecting every folder listing and every file's tags.
 * Rejected outright if the root is not one the user added, and re-checked for
 * each folder descended into.
 *
 * `onProgress` receives the crawl as it happens, so the tree can fill in folder
 * by folder instead of waiting on a large library to finish.
 */
export async function buildFolderIndex(
  root: string,
  onProgress?: IndexProgressReporter
): Promise<FileBrowserFolderIndex> {
  const canonical = canonicalisePath(root)
  const index: FileBrowserFolderIndex = {
    root: canonical,
    folders: {},
    tags: {},
    indexedAt: Date.now()
  }
  if (!isWithinFileBrowserRoot(canonical)) {
    logMain('WARN ', 'fileBrowser:index', 'refused to index path outside browser roots:', root)
    return index
  }

  const progress = createProgressBatcher(canonical, onProgress)
  const files: string[] = []
  const pending: string[] = [canonical]
  // Breadth-first with an explicit queue rather than recursion, so a deeply
  // nested library cannot exhaust the stack. Breadth-first also means the
  // folders nearest the root — the ones the user sees first — arrive first.
  while (pending.length > 0) {
    const dir = pending.shift() as string
    if (index.folders[dir] !== undefined) continue
    const entries = await listOne(dir)
    index.folders[dir] = entries
    let found = 0
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        if (isWithinFileBrowserRoot(entry.path)) pending.push(entry.path)
      } else {
        files.push(entry.path)
        found += 1
      }
    }
    progress.addFolder(dir, entries, found)
  }
  // The tree is complete at this point even though no tags have been read, so
  // say so: rows can render from their file names while the tags catch up.
  progress.flush(true)

  await forEachLimited(files, INDEX_READ_CONCURRENCY, async (filePath) => {
    const tags = await readTags(filePath)
    index.tags[filePath] = tags
    progress.addTags(filePath, tags)
  })
  progress.flush(true)

  logMain(
    'INFO ',
    'fileBrowser:index',
    `indexed ${canonical}: ${Object.keys(index.folders).length} folders, ${files.length} files`
  )
  return index
}

// ── Persistence ─────────────────────────────────────────────────────────────
// The index is a cache, not user data: it can always be rebuilt by crawling
// again, so a missing or unreadable file is not an error worth surfacing.

let cachePathOverride: string | null = null

/**
 * The one cache read, kept so it happens once and so anything asking for an
 * index can wait for it. Startup kicks it off without blocking window creation,
 * which leaves a window where a renderer could ask for a root before the cache
 * has been read — and crawl a library that was already on disk.
 */
let cacheLoad: Promise<void> | null = null

/** Point the cache at a different file. Used by tests to stay off real userData. */
export function setFileBrowserIndexCachePath(path: string | null): void {
  cachePathOverride = path
  cacheLoad = null
}

function cachePath(): string {
  return cachePathOverride ?? join(app.getPath('userData'), 'file-browser-index.json')
}

function isEntry(value: unknown): value is FileBrowserEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<FileBrowserEntry>
  return (
    typeof entry.path === 'string' &&
    typeof entry.name === 'string' &&
    (entry.kind === 'directory' || entry.kind === 'file')
  )
}

/**
 * Rebuild one index from parsed JSON, dropping anything malformed. The cache is
 * an ordinary file on disk that anything could have written, so nothing from it
 * is trusted into the app's state without being checked first.
 */
function reviveIndex(value: unknown): FileBrowserFolderIndex | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<FileBrowserFolderIndex>
  if (typeof raw.root !== 'string' || raw.root === '') return null
  // A cached root the user has since removed is no longer consented to.
  if (!isWithinFileBrowserRoot(raw.root)) return null

  const folders: Record<string, FileBrowserEntry[]> = {}
  for (const [dir, entries] of Object.entries(raw.folders ?? {})) {
    if (!Array.isArray(entries) || !isWithinFileBrowserRoot(dir)) continue
    folders[dir] = entries.filter(isEntry)
  }

  const tags: Record<string, FileBrowserFileTags> = {}
  for (const [filePath, entry] of Object.entries(raw.tags ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    tags[filePath] = entry as FileBrowserFileTags
  }

  return {
    root: raw.root,
    folders,
    tags,
    indexedAt: typeof raw.indexedAt === 'number' ? raw.indexedAt : 0
  }
}

/**
 * Reload the cached indexes written by a previous run, so a restart shows the
 * user's folders without crawling the disk again. Called at startup after the
 * saved roots have been re-trusted, since anything outside them is discarded.
 *
 * Read once and shared: `getFolderIndex` waits on the same promise, so a root
 * asked for while this is still in flight uses the cache rather than starting a
 * crawl of a library that was already indexed last run.
 */
export function loadFileBrowserIndexCache(): Promise<void> {
  cacheLoad ??= readCacheFile()
  return cacheLoad
}

async function readCacheFile(): Promise<void> {
  let raw: string
  try {
    raw = await readFile(cachePath(), 'utf8')
  } catch {
    return
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    let restored = 0
    for (const value of parsed) {
      const index = reviveIndex(value)
      if (!index) continue
      indexes.set(keyFor(index.root), index)
      restored += 1
    }
    logMain('INFO ', 'fileBrowser:index', `reloaded ${restored} cached folder index(es)`)
  } catch (err) {
    logMain('WARN ', 'fileBrowser:index', 'cache unreadable, will rebuild:', String(err))
  }
}

/**
 * Write every index held this session. Written to a sibling and renamed over the
 * target so a crash part-way through leaves the previous cache intact rather
 * than truncated JSON.
 */
export async function saveFileBrowserIndexCache(): Promise<void> {
  const path = cachePath()
  const tempPath = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tempPath, JSON.stringify([...indexes.values()]), 'utf8')
    await rename(tempPath, path)
  } catch (err) {
    logMain('WARN ', 'fileBrowser:index', 'cache write failed:', String(err))
    try {
      await unlink(tempPath)
    } catch {
      // Nothing to clean up.
    }
  }
}

/**
 * The index for a root, crawling it only if this session has none cached. A
 * `refresh` picks up files added or retagged on disk since the last crawl.
 * `onProgress` reports a crawl as it happens; a cached index returns at once
 * and reports nothing, because there is no wait to fill.
 */
export async function getFolderIndex(
  root: string,
  options?: { refresh?: boolean; onProgress?: IndexProgressReporter }
): Promise<FileBrowserFolderIndex> {
  // The startup read may still be in flight; crawling now would redo work the
  // cache is about to hand over.
  await loadFileBrowserIndexCache()
  const key = keyFor(root)
  const cached = indexes.get(key)
  if (cached && options?.refresh !== true) return cached

  const index = await buildFolderIndex(root, options?.onProgress)
  indexes.set(key, index)
  await saveFileBrowserIndexCache()
  return index
}

/** Drop a removed folder's index, so its listing does not outlive the consent. */
export async function forgetFolderIndex(root: string): Promise<void> {
  if (!indexes.delete(keyFor(root))) return
  await saveFileBrowserIndexCache()
}

/** Test seam: clear every index held in memory. */
export function resetFileBrowserIndexes(): void {
  indexes.clear()
  cacheLoad = null
}
