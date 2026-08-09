import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import { ensureBackendPlayablePath, isBackendNativeAudioPath } from '@/lib/audioPlaybackPath'
import { importAudioPathsIntoLibrary } from '@/lib/importAudio'
import { usePreviewStore } from '@/stores/previewStore'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { toggleTransportPlayback } from '@/lib/transport/useTransportSkip'

/** Tag data for one browsed file, plus its cover Blob URL. */
export interface FileBrowserFileInfo {
  title?: string
  artist?: string
  album?: string
  /** Track length from the file's tags, used for the duration column. */
  durationMs?: number
  /** Blob URL for embedded artwork; owned by this store and revoked on removal. */
  coverArtUrl?: string
}

/** One rendered row of the flattened tree. */
export interface FileBrowserRow {
  path: string
  name: string
  kind: 'directory' | 'file'
  /** Indent level; added folders sit at 0. */
  depth: number
  /** True for a folder the user added, which is the only kind that can be removed. */
  isRoot: boolean
  expanded: boolean
  /** True for the audition pinned above the tree while a filter is active. */
  pinned?: boolean
}

/** How far a root's crawl has got, for the progress shown against its row. */
export interface FileBrowserIndexStatus {
  /** Audio files found under the root so far. */
  fileCount: number
  /** Files whose tags have been read so far. */
  taggedCount: number
  /** True once every folder has been listed, so only tag reads remain. */
  listed: boolean
}

interface FileBrowserState {
  /** Added folders, in the order the user added them. */
  roots: string[]
  expanded: Record<string, boolean>
  /**
   * Listing for every folder under every added root, taken wholesale from that
   * root's index. Rendering, expanding and filtering all read this, so browsing
   * costs no disk access once a root is indexed.
   */
  children: Record<string, FileBrowserEntry[]>
  /**
   * Roots whose crawl is in flight, with how far it has got. A large library
   * takes seconds to index, so its row reports progress instead of the tree
   * sitting empty with nothing to explain the wait.
   */
  indexing: Record<string, FileBrowserIndexStatus>
  /**
   * Roots whose last crawl could not read them at all — a disconnected drive or
   * a folder since deleted. Tracked so the row can say so and offer a retry,
   * rather than showing an empty folder that looks like a library with nothing
   * in it.
   */
  unavailable: Record<string, boolean>
  /**
   * Tags for every indexed file, plus cover art for the rows that have asked for
   * it. Tags arrive with the index; artwork is fetched per visible row, because
   * it is large binary data and only the handful of rows on screen display one.
   */
  info: Record<string, FileBrowserFileInfo>
  /** Paths whose cover-art read is done or in flight, so rows request it once. */
  coverRequested: Record<string, boolean>
  /**
   * Bumped by a refresh once its subtree's cover state has been dropped. A row
   * is already mounted when the user refreshes, so nothing else would ask it to
   * re-read: artwork changed on disk would keep showing the old image for as
   * long as the row stayed on screen. Rows watch this and fetch again, which
   * keeps covers as lazy as they were — only what is on screen is re-read.
   */
  coverEpoch: number
  /** The file whose name was last clicked, or null when nothing is selected. */
  /** Path of the selected file or folder row, or null. Selecting a folder the
   *  user added arms the Delete key to remove it. */
  selectedPath: string | null
  /**
   * Browsed file currently loaded into the preview voice. Held separately from
   * the preview store's own path because a transcoded file is auditioned from a
   * cached WAV, which is not the path shown in the tree.
   */
  auditionSourcePath: string | null
  /** Browsed file being decoded for audition, or null when nothing is pending. */
  preparingPath: string | null
  /** Source path to engine-playable path, so a transcode happens once per session. */
  playbackPaths: Record<string, string>
  /** Free-text filter applied to files; folders with no match are hidden too. */
  filter: string
  /** Bumped to ask the tree to take keyboard focus back from the filter box. */
  treeFocusRequest: number
  /** Tree scroll offset, kept here so switching tabs and back restores the view. */
  scrollTop: number
  hydrated: boolean
}

/**
 * Shortest query that actually filters. One or two characters match almost
 * every track, so filtering on them narrows nothing while making the whole tree
 * jump about as the user types the first letters of a word.
 */
export const FILE_BROWSER_FILTER_MIN_LENGTH = 3

/**
 * The query actually being applied, which is empty while the box holds too
 * little to search with. Everything that hides rows goes through this rather
 * than the raw text, so a half-typed word leaves the tree exactly as it was.
 */
export function fileBrowserActiveFilter(filter: string): string {
  const query = filter.trim()
  return query.length >= FILE_BROWSER_FILTER_MIN_LENGTH ? query : ''
}

/**
 * Match a browsed file by the track name shown in its row or its artist. The
 * file name is included because an untagged file displays it as the track name,
 * so filtering matches what the user can actually read on screen.
 */
export function fileBrowserFileMatchesFilter(
  query: string,
  name: string,
  info: FileBrowserFileInfo | undefined
): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return true

  const fields = [info?.title ?? '', name, info?.artist ?? '']
  return fields.some((field) => field.toLocaleLowerCase().includes(needle))
}

/**
 * Fold a file's indexed tags into what the store already holds. The index is
 * authoritative for the four tag fields, so they are *replaced* rather than
 * merged: a spread would keep an artist the user has since cleared on disk,
 * because `FileBrowserFileTags` omits an empty field instead of carrying an
 * explicit `undefined`. The cover Blob URL is not part of the index and is
 * carried across, or a row would lose the artwork it has already fetched.
 */
export function fileBrowserInfoWithTags(
  existing: FileBrowserFileInfo | undefined,
  tags: FileBrowserFileTags
): FileBrowserFileInfo {
  const next: FileBrowserFileInfo = { ...tags }
  if (existing?.coverArtUrl !== undefined) next.coverArtUrl = existing.coverArtUrl
  return next
}
/**
 * Unsubscribe for the crawl-progress listener. Module-level rather than store
 * state because it is a live IPC handle, not something the tree renders, and one
 * listener serves the whole app for as long as it runs.
 */
let unsubscribeIndexProgress: (() => void) | null = null

/** Test seam: drop the progress listener so each test starts unsubscribed. */
export function resetFileBrowserIndexProgress(): void {
  unsubscribeIndexProgress?.()
  unsubscribeIndexProgress = null
}

/** A path is inside `dir` when it starts with `dir` plus a separator. */
function isUnder(path: string, dir: string): boolean {
  const prefix = dir.endsWith('\\') || dir.endsWith('/') ? dir : `${dir}\\`
  return path.toLowerCase().startsWith(prefix.toLowerCase())
}

/** Folders containing `path`, from `root` down to its immediate parent. */
function ancestorsOf(path: string, root: string): string[] {
  const out: string[] = [root]
  let current = path
  for (;;) {
    const cut = Math.max(current.lastIndexOf('\\'), current.lastIndexOf('/'))
    if (cut <= 0) break
    current = current.slice(0, cut)
    if (!isUnder(current, root)) break
    out.push(current)
  }
  return out
}

export const useFileBrowserStore = defineStore('fileBrowser', {
  state: (): FileBrowserState => ({
    roots: [],
    expanded: {},
    children: {},
    indexing: {},
    unavailable: {},
    info: {},
    coverRequested: {},
    coverEpoch: 0,
    selectedPath: null,
    auditionSourcePath: null,
    preparingPath: null,
    playbackPaths: {},
    filter: '',
    treeFocusRequest: 0,
    scrollTop: 0,
    hydrated: false
  }),

  getters: {
    /**
     * Depth-first flattening of the expanded tree. Rendering a flat list keeps the
     * row markup non-recursive and makes the disclosure logic directly testable.
     * A filter hides non-matching files, and any folder left with nothing matching
     * anywhere beneath it, so a search narrows to just the folders worth opening.
     *
     * A filter also opens every folder it keeps, so a match buried in a branch the
     * user never opened is still shown. That is done here, by treating folders as
     * open while filtering, rather than by writing to `expanded`: the tree the
     * user arranged is never touched, so clearing the filter restores it exactly
     * with nothing to snapshot and nothing to put back.
     */
    rows(state): FileBrowserRow[] {
      const out: FileBrowserRow[] = []
      const query = fileBrowserActiveFilter(state.filter)
      const filtering = query.length > 0

      /**
       * A folder whose contents are not indexed yet cannot be proven empty of
       * matches, so it stays visible rather than hiding files that are still
       * being crawled.
       */
      const hasMatchBeneath = (dir: string): boolean => {
        const entries = state.children[dir]
        if (entries === undefined) return true
        return entries.some((entry) =>
          entry.kind === 'directory'
            ? hasMatchBeneath(entry.path)
            : fileBrowserFileMatchesFilter(query, entry.name, state.info[entry.path])
        )
      }

      const walk = (dir: string, depth: number, isRoot: boolean, name: string): void => {
        if (filtering && !hasMatchBeneath(dir)) return
        const expanded = filtering || state.expanded[dir] === true
        out.push({ path: dir, name, kind: 'directory', depth, isRoot, expanded })
        if (!expanded) return
        for (const entry of state.children[dir] ?? []) {
          if (entry.kind === 'directory') {
            walk(entry.path, depth + 1, false, entry.name)
          } else {
            if (!fileBrowserFileMatchesFilter(query, entry.name, state.info[entry.path])) {
              continue
            }
            out.push({
              path: entry.path,
              name: entry.name,
              kind: 'file',
              depth: depth + 1,
              isRoot: false,
              expanded: false
            })
          }
        }
      }
      for (const root of state.roots) walk(root, 0, true, folderDisplayName(root))
      return out
    },

    /**
     * The browsed file in the preview voice, or null when nothing is auditioned.
     * A transcoded file plays from a cached WAV, so the preview store's own path
     * cannot be compared against a tree row directly.
     *
     * The comparison is against the path actually handed to the preview voice
     * rather than merely "something is loaded", so the audition releases itself
     * as soon as another consumer of the shared voice — the Clip Editor or
     * Scratch Editor — takes it over, instead of leaving a browsed row showing as
     * playing while a different file is heard.
     */
    auditionedPath(state): string | null {
      const source = state.auditionSourcePath
      if (source === null) return null
      const loaded = state.playbackPaths[source] ?? source
      return usePreviewStore().filePath === loaded ? source : null
    },

    /**
     * The auditioned file, shown in a bar above the tree so what is playing is
     * never lost to scrolling or a filter. Null when nothing is loaded or the
     * file is not in a browsed folder. It stays listed in its folder too: the
     * bar reports playback, it does not move the file out of the tree.
     */
    pinnedAudition(state): FileBrowserRow | null {
      const path = this.auditionedPath
      if (path === null) return null
      const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
      if (cut <= 0) return null
      const entry = state.children[path.slice(0, cut)]?.find((child) => child.path === path)
      if (entry === undefined) return null
      return { path, name: entry.name, kind: 'file', depth: 0, isRoot: false, expanded: false, pinned: true }
    },

    /** True when a filter is hiding every file the tree would otherwise show. */
    filterHidesEverything(state): boolean {
      if (fileBrowserActiveFilter(state.filter).length === 0) return false
      return !this.rows.some((row) => row.kind === 'file')
    },

    /** True only for the row whose file is currently being auditioned. */
    isPlaying() {
      const preview = usePreviewStore()
      return (filePath: string): boolean =>
        this.auditionedPath === filePath && preview.isPlaying
    },

    /**
     * Live playhead for the row loaded into the preview voice, or null for every
     * other row so only the audition shows a running counter.
     */
    positionMs() {
      const preview = usePreviewStore()
      return (filePath: string): number | null =>
        this.auditionedPath === filePath ? preview.positionMs : null
    },

    /**
     * What to show against an added folder while it is being indexed, or null
     * once it is done. Counting files while the tree is still being walked and
     * switching to a ratio once it is means the caption is honest at both
     * stages: there is no total to count against until every folder is listed.
     */
    indexLabel() {
      return (root: string): string | null => {
        const status = this.indexing[root]
        if (status === undefined) return null
        if (!status.listed) {
          return status.fileCount === 0
            ? 'Indexing…'
            : `Indexing… ${status.fileCount.toLocaleString()} files`
        }
        return `Indexing… ${status.taggedCount.toLocaleString()} of ${status.fileCount.toLocaleString()}`
      }
    }
  },

  actions: {
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      this.hydrated = true
      // Subscribed before the first crawl is asked for, so no slice of it is
      // missed, and only once because the store outlives every view that uses it.
      this.subscribeToIndexProgress()
      try {
        this.roots = await window.silverdaw.listFileBrowserFolders()
      } catch (err) {
        log.warn('fileBrowser', `hydrate failed: ${String(err)}`)
        // Allow a later mount to retry rather than stranding an empty browser.
        this.hydrated = false
        return
      }
      // Expanded before the crawl, not after, so a root that has to be indexed
      // shows its progress and fills in as folders arrive.
      for (const root of this.roots) this.expanded[root] = true
      // Each root's whole contents arrive in one call, usually straight from the
      // cache written by a previous run, so the tree is ready without any crawl.
      await Promise.all(this.roots.map((root) => this.loadIndex(root)))
    },

    /**
     * Listen for crawls in progress. Registered once for the life of the app:
     * the store is what holds the tree, so it is what has to receive the slices,
     * and a view mounting or unmounting must not interrupt an indexing folder.
     */
    subscribeToIndexProgress(): void {
      if (unsubscribeIndexProgress !== null) return
      unsubscribeIndexProgress = window.silverdaw.onFileBrowserIndexProgress((progress) => {
        this.applyIndexProgress(progress)
      })
    },

    /**
     * Apply one slice of a crawl. Each message carries only what completed since
     * the last, so this merges rather than replaces — the subtree was already
     * cleared before a refresh started, precisely so these can be applied as
     * they arrive instead of being wiped at the end.
     */
    applyIndexProgress(progress: FileBrowserIndexProgress): void {
      const root = this.roots.find(
        (candidate) => candidate.toLowerCase() === progress.root.toLowerCase()
      )
      // A crawl for a folder the user has since removed has nothing to fill in.
      if (root === undefined || this.indexing[root] === undefined) return

      for (const [dir, entries] of Object.entries(progress.folders)) {
        this.children[dir] = entries
      }
      for (const [filePath, tags] of Object.entries(progress.tags)) {
        this.info[filePath] = fileBrowserInfoWithTags(this.info[filePath], tags)
      }
      this.indexing[root] = {
        fileCount: progress.fileCount,
        taggedCount: progress.taggedCount,
        listed: progress.listed
      }
    },

    /**
     * Pull one root's index into the store: the listing for every folder beneath
     * it and the tags for every file. This is the only thing that reads the
     * filesystem — everything the tree then does is served from what it returns.
     *
     * The crawl reports back as it goes, so the tree fills in while this is
     * still running; the returned index is the same data, applied again as the
     * authoritative copy once the walk is done.
     */
    async loadIndex(root: string, options?: { refresh?: boolean }): Promise<void> {
      if (this.indexing[root] !== undefined) return
      this.indexing[root] = { fileCount: 0, taggedCount: 0, listed: false }
      // A re-crawl replaces the subtree rather than merging into it, or a folder
      // deleted on disk would survive as a listing nothing overwrites. Cleared
      // before the crawl starts, not after it finishes, so the slices arriving
      // meanwhile are kept rather than thrown away by a late wipe.
      if (options?.refresh === true) {
        for (const dir of Object.keys(this.children)) {
          if (dir === root || isUnder(dir, root)) delete this.children[dir]
        }
      }
      try {
        const index =
          options?.refresh === true
            ? await window.silverdaw.refreshFileBrowserIndex(root)
            : await window.silverdaw.getFileBrowserIndex(root)
        for (const [dir, entries] of Object.entries(index.folders)) {
          this.children[dir] = entries
        }
        // A root that could not be read at all is flagged rather than left
        // looking like an empty folder; a crawl that worked clears the flag.
        if (index.unavailable === true) this.unavailable[root] = true
        else delete this.unavailable[root]
        for (const [filePath, tags] of Object.entries(index.tags)) {
          // The index is authoritative for tags, so these replace rather than
          // merge — a tag cleared on disk has to disappear from the row too.
          // Any cover URL already fetched is carried across by the helper, so
          // the Blob is not dropped on the floor and leaked.
          this.info[filePath] = fileBrowserInfoWithTags(this.info[filePath], tags)
        }
      } catch (err) {
        log.warn('fileBrowser', `index failed for ${root}: ${String(err)}`)
      } finally {
        delete this.indexing[root]
      }
    },

    /** Open the native picker and add the chosen folder, already expanded. */
    async addFolder(): Promise<void> {
      let next: string[]
      try {
        next = await window.silverdaw.addFileBrowserFolder()
      } catch (err) {
        log.error('fileBrowser', `addFolder failed: ${String(err)}`)
        return
      }
      const added = next.filter((folder) => !this.roots.includes(folder))
      this.roots = next
      // Crawling here is what makes everything afterwards free: adding the
      // folder is the one moment the user expects the app to go and read it.
      // Expanded first, so the new folder shows its progress and fills in as
      // the crawl reports back rather than appearing only once it has finished.
      for (const folder of added) this.expanded[folder] = true
      await Promise.all(added.map((folder) => this.loadIndex(folder)))
    },

    async removeFolder(folder: string): Promise<void> {
      // Stop any file audition before the tree changes, so nothing keeps
      // playing from a folder the user has just taken out of the browser.
      const preview = usePreviewStore()
      if (preview.filePath !== null) preview.unload()
      this.auditionSourcePath = null
      this.preparingPath = null
      try {
        this.roots = await window.silverdaw.removeFileBrowserFolder(folder)
      } catch (err) {
        log.error('fileBrowser', `removeFolder failed: ${String(err)}`)
        return
      }
      this.forgetSubtree(folder)
    },

    /** Drop cached listings, metadata and cover URLs for a removed folder. */
    forgetSubtree(folder: string): void {
      for (const path of Object.keys(this.info)) {
        if (path !== folder && !isUnder(path, folder)) continue
        const url = this.info[path]?.coverArtUrl
        if (url) URL.revokeObjectURL(url)
        delete this.info[path]
        delete this.coverRequested[path]
      }
      for (const path of Object.keys(this.children)) {
        if (path === folder || isUnder(path, folder)) delete this.children[path]
      }
      for (const path of Object.keys(this.expanded)) {
        if (path === folder || isUnder(path, folder)) delete this.expanded[path]
      }
      for (const path of Object.keys(this.indexing)) {
        if (path === folder || isUnder(path, folder)) delete this.indexing[path]
      }
      for (const path of Object.keys(this.unavailable)) {
        if (path === folder || isUnder(path, folder)) delete this.unavailable[path]
      }
      for (const path of Object.keys(this.playbackPaths)) {
        if (path === folder || isUnder(path, folder)) delete this.playbackPaths[path]
      }
      // A selection inside a removed folder would otherwise outlive its row.
      const selected = this.selectedPath
      if (selected !== null && (selected === folder || isUnder(selected, folder))) {
        this.selectedPath = null
      }
    },

    /** Single-click selection of a file or folder row, so it can be acted on
     *  without playing or collapsing it. */
    select(path: string): void {
      this.selectedPath = path
    },

    /** Move the selection through the visible rows, so the arrow keys walk the
     *  tree exactly as it reads on screen: filtered and collapsed rows are not
     *  in `rows`, so they are skipped. Both ends stop rather than wrap. */
    selectStep(delta: 1 | -1): void {
      const visible = this.rows
      if (visible.length === 0) return
      const current = visible.findIndex((row) => row.path === this.selectedPath)
      if (current === -1) {
        // Entering the list from nowhere starts at the near end.
        this.selectedPath = (delta === 1 ? visible[0] : visible[visible.length - 1])?.path ?? null
        return
      }
      const next = visible[current + delta]
      if (next) this.selectedPath = next.path
    },

    /** Enter on the selection: open or close a folder, play or pause a file. */
    activateSelected(): void {
      const selected = this.selectedPath
      if (selected === null) return
      const row = this.rows.find((candidate) => candidate.path === selected)
      if (!row) return
      if (row.kind === 'directory') void this.toggle(selected)
      else this.togglePlay(selected)
    },

    /** Remove the selected folder via the Delete key. Only a folder the user
     *  added is removable — nested folders leave only with their root. */
    async removeSelectedFolder(): Promise<void> {
      const selected = this.selectedPath
      if (selected === null || !this.roots.includes(selected)) return
      await this.removeFolder(selected)
    },

    /**
     * Apply a filter. Everything it needs is already in the index, so this is a
     * plain state write: no crawl, nothing to await, and no debounce to hide a
     * cost that is no longer there. Matching folders are opened by the `rows`
     * getter rather than here, so the user's own disclosure state is untouched
     * and clearing the filter puts the tree back exactly as it was.
     */
    setFilter(query: string): void {
      this.filter = query
      if (fileBrowserActiveFilter(query).length === 0) this.revealAudition()
    },

    /**
     * Keep the audition on screen once a filter is cleared. The pin that held it
     * above the tree disappears with the filter, and the folders a search had
     * opened to show it fold shut again, so they are reopened and the row
     * reselected — the view scrolls to the selection, and the arrow and Enter
     * keys carry on from there.
     *
     * Uses the browsed path rather than the preview voice's own: a transcoded
     * file plays from a cached WAV that lives outside every browsed root, so
     * asking the voice would never find a row to reveal.
     */
    revealAudition(): void {
      const path = this.auditionedPath
      if (path === null) return
      const root = this.roots.find((candidate) => isUnder(path, candidate))
      if (root === undefined) return
      for (const dir of ancestorsOf(path, root)) this.expanded[dir] = true
      if (this.rows.some((row) => row.path === path)) this.selectedPath = path
    },

    /** Ask the tree to take keyboard focus, so the arrow and Enter keys work
     *  again once the user is finished with the filter box. */
    requestTreeFocus(): void {
      this.treeFocusRequest += 1
    },

    /** Remember where the tree was scrolled to. The view unmounts when the user
     *  switches tabs, so the offset has to outlive the component to be put back. */
    setScrollTop(offset: number): void {
      this.scrollTop = Number.isFinite(offset) && offset > 0 ? offset : 0
    },

    async toggle(dir: string): Promise<void> {
      if (this.expanded[dir] === true) this.expanded[dir] = false
      else await this.expand(dir)
    },

    /**
     * Open a folder. Its contents are already indexed, so this only sets the
     * disclosure flag — no listing, and nothing to wait for. Kept async because
     * the tree and keyboard handlers await it alongside actions that do.
     */
    async expand(dir: string): Promise<void> {
      this.expanded[dir] = true
    },

    /**
     * Re-crawl the added folder containing `dir`, picking up files added, removed
     * or retagged on disk since it was indexed. The whole root is re-read because
     * the index is stored and cached per root, not per folder.
     */
    async refresh(dir: string): Promise<void> {
      const root = this.roots.find((candidate) => candidate === dir || isUnder(dir, candidate))
      if (root === undefined) return
      await this.loadIndex(root, { refresh: true })
      this.pruneMissing(root)
      this.invalidateCovers(root)
    },

    /**
     * Drop the cover art held for a refreshed subtree so it is read again. Tags
     * come back with the crawl, but artwork does not — without this, artwork
     * changed on disk would keep showing the old image for as long as its row
     * stayed mounted. Only the state is dropped here; the re-read is left to the
     * rows, so a refresh still pays for the covers on screen and no more.
     */
    invalidateCovers(root: string): void {
      for (const path of Object.keys(this.coverRequested)) {
        if (path !== root && !isUnder(path, root)) continue
        const url = this.info[path]?.coverArtUrl
        if (url) URL.revokeObjectURL(url)
        if (this.info[path] !== undefined) delete this.info[path].coverArtUrl
        delete this.coverRequested[path]
      }
      this.coverEpoch += 1
    },

    /**
     * Drop state for files and folders a re-crawl no longer lists, so a deleted
     * file cannot linger as a row, a stale selection, or a cover URL that is
     * never revoked.
     */
    pruneMissing(root: string): void {
      const present = new Set<string>([root])
      for (const [dir, entries] of Object.entries(this.children)) {
        if (dir !== root && !isUnder(dir, root)) continue
        for (const entry of entries) present.add(entry.path)
      }
      const gone = (path: string): boolean =>
        (path === root || isUnder(path, root)) && !present.has(path)

      for (const path of Object.keys(this.info)) {
        if (!gone(path)) continue
        const url = this.info[path]?.coverArtUrl
        if (url) URL.revokeObjectURL(url)
        delete this.info[path]
        delete this.coverRequested[path]
      }
      for (const path of Object.keys(this.children)) {
        if (gone(path)) delete this.children[path]
      }
      for (const path of Object.keys(this.expanded)) {
        if (gone(path)) delete this.expanded[path]
      }
      for (const path of Object.keys(this.playbackPaths)) {
        if (gone(path)) delete this.playbackPaths[path]
      }
      if (this.selectedPath !== null && gone(this.selectedPath)) this.selectedPath = null
    },

    /**
     * Fetch a visible row's cover art. Tags already arrived with the index, so
     * this is the one read a row still makes, and only for artwork: a folder of
     * hundreds of files pays for the covers actually on screen and no more.
     */
    async ensureInfo(filePath: string): Promise<void> {
      if (this.coverRequested[filePath] === true) return
      this.coverRequested[filePath] = true
      const metadata = await window.silverdaw.readAudioMetadata(filePath).catch((err) => {
        log.warn('fileBrowser', `readAudioMetadata failed for ${filePath}: ${String(err)}`)
        return null
      })
      if (!metadata) return
      // Cover bytes stay out of reactive state; only the Blob URL is exposed.
      const { coverArt, title, artist, album, durationMs } = metadata
      // Merged field by field rather than spread: a file whose tags this read
      // cannot see would otherwise write `undefined` over the ones the index
      // already found, and the row would lose its title the moment its cover
      // arrived.
      const entry: FileBrowserFileInfo = { ...this.info[filePath] }
      if (title !== undefined) entry.title = title
      if (artist !== undefined) entry.artist = artist
      if (album !== undefined) entry.album = album
      if (durationMs !== undefined) entry.durationMs = durationMs
      if (coverArt) {
        entry.coverArtUrl = URL.createObjectURL(
          new Blob([coverArt.data], { type: coverArt.mimeType })
        )
      }
      this.info[filePath] = entry
    },

    /**
     * Audition a browsed file through the shared preview voice. A format the
     * engine cannot decode is transcoded to a cached WAV first, so the preview
     * voice may hold a different path from the row; `auditionSourcePath` maps it
     * back to the browsed file. A natively playable or already-transcoded file
     * starts immediately; only a first transcode defers.
     */
    play(filePath: string): void {
      const preview = usePreviewStore()
      // Only one thing plays at a time, so an audition stops project playback.
      const transport = useTransportStore()
      if (transport.isPlaying) {
        toggleTransportPlayback('preview', { project: useProjectStore(), transport, ui: useUiStore(), preview })
      }
      if (this.auditionedPath === filePath && preview.isLoaded) {
        preview.play()
        return
      }
      const ready = isBackendNativeAudioPath(filePath) ? filePath : this.playbackPaths[filePath]
      if (ready !== undefined) {
        this.preparingPath = null
        this.startAudition(filePath, ready)
        return
      }
      void this.prepareAndPlay(filePath)
    },

    /**
     * Decode a file the engine cannot read into the cached WAV it will be
     * auditioned from, then start it. A decode takes seconds, so the claim it
     * has to survive is twofold: another row clicked in the browser (tracked by
     * `preparingPath`), and another consumer of the shared preview voice taking
     * it over meanwhile (tracked by the voice's own `loadSeq`). Either abandons
     * this audition rather than letting a finished decode seize playback.
     */
    async prepareAndPlay(filePath: string): Promise<void> {
      const preview = usePreviewStore()
      this.preparingPath = filePath
      const claimedSeq = preview.loadSeq
      const wavPath = await ensureBackendPlayablePath(filePath)
      if (this.preparingPath !== filePath) return
      this.preparingPath = null
      if (preview.loadSeq !== claimedSeq) {
        log.info('fileBrowser', `audition of ${filePath} abandoned: preview voice taken over`)
        return
      }
      if (wavPath === null) {
        log.warn('fileBrowser', `cannot audition ${filePath}: could not decode`)
        return
      }
      this.playbackPaths[filePath] = wavPath
      this.startAudition(filePath, wavPath)
    },

    /** Load an engine-playable path into the preview voice for a browsed row. */
    startAudition(filePath: string, playbackPath: string): void {
      this.auditionSourcePath = filePath
      usePreviewStore().loadFile(playbackPath, true)
    },

    pause(filePath: string): void {
      const preview = usePreviewStore()
      if (this.auditionedPath !== filePath) return
      preview.pause()
    },

    /** One transport button per row: pause the file being auditioned, else play it. */
    togglePlay(filePath: string): void {
      if (this.isPlaying(filePath)) this.pause(filePath)
      else this.play(filePath)
    },

    /** Return the auditioned file to its start, leaving the transport as it is. */
    restart(filePath: string): void {
      const preview = usePreviewStore()
      if (this.auditionedPath !== filePath) return
      preview.seek(0)
    },

    async importFile(filePath: string): Promise<void> {
      await importAudioPathsIntoLibrary([filePath])
    }
  }
})

/** Leaf folder name, falling back to the whole path for a drive root like `D:\`. */
export function folderDisplayName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const leaf = trimmed.split(/[\\/]/).pop()
  return leaf && leaf.length > 0 ? leaf : dir
}

/**
 * File type for the browser's Type column, taken from the extension. Rows carry
 * a display name with the extension already stripped, so this reads the path;
 * only its last segment is considered, so a dot in a folder name is not mistaken
 * for one. Returns an empty string when there is no usable extension.
 */
export function fileBrowserFileTypeLabel(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? ''
  const dot = leaf.lastIndexOf('.')
  // A leading dot makes the whole name the extension, which is not a type.
  if (dot <= 0 || dot === leaf.length - 1) return ''
  return leaf.slice(dot + 1).toLocaleUpperCase()
}

/** Left inset for a tree row. Shared so folder and file rows always line up. */
export function fileBrowserRowIndentPx(depth: number): number {
  const BASE = 8
  const PER_LEVEL = 22
  return BASE + depth * PER_LEVEL
}
