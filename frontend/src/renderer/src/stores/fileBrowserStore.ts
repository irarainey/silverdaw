import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import { ensureBackendPlayablePath, isBackendNativeAudioPath } from '@/lib/audioPlaybackPath'
import { importAudioPathsIntoLibrary } from '@/lib/importAudio'
import { usePreviewStore } from '@/stores/previewStore'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { toggleTransportPlayback } from '@/lib/transport/useTransportSkip'

/** Tag data resolved lazily for one browsed file, plus its cover Blob URL. */
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

interface FileBrowserState {
  /** Added folders, in the order the user added them. */
  roots: string[]
  expanded: Record<string, boolean>
  children: Record<string, FileBrowserEntry[]>
  loading: Record<string, boolean>
  info: Record<string, FileBrowserFileInfo>
  /** Paths whose metadata read is done or in flight, so rows request it once. */
  infoRequested: Record<string, boolean>
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
  /** Disclosure state captured when a search began, restored when it ends. */
  expandedBeforeFilter: Record<string, boolean> | null
  /** Bumped to ask the tree to take keyboard focus back from the filter box. */
  treeFocusRequest: number
  /** Tree scroll offset, kept here so switching tabs and back restores the view. */
  scrollTop: number
  hydrated: boolean
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
    loading: {},
    info: {},
    infoRequested: {},
    selectedPath: null,
    auditionSourcePath: null,
    preparingPath: null,
    playbackPaths: {},
    filter: '',
    expandedBeforeFilter: null,
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
     */
    rows(state): FileBrowserRow[] {
      const out: FileBrowserRow[] = []
      const filtering = state.filter.trim().length > 0

      /**
       * A folder whose contents have never been listed cannot be proven empty of
       * matches, so it stays visible rather than hiding files the user has not
       * opened yet.
       */
      const hasMatchBeneath = (dir: string): boolean => {
        const entries = state.children[dir]
        if (entries === undefined) return true
        return entries.some((entry) =>
          entry.kind === 'directory'
            ? hasMatchBeneath(entry.path)
            : fileBrowserFileMatchesFilter(state.filter, entry.name, state.info[entry.path])
        )
      }

      const walk = (dir: string, depth: number, isRoot: boolean, name: string): void => {
        if (filtering && !hasMatchBeneath(dir)) return
        const expanded = state.expanded[dir] === true
        out.push({ path: dir, name, kind: 'directory', depth, isRoot, expanded })
        if (!expanded) return
        for (const entry of state.children[dir] ?? []) {
          if (entry.kind === 'directory') {
            walk(entry.path, depth + 1, false, entry.name)
          } else {
            if (!fileBrowserFileMatchesFilter(state.filter, entry.name, state.info[entry.path])) {
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
     */
    auditionedPath(state): string | null {
      return usePreviewStore().filePath === null ? null : state.auditionSourcePath
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
      if (state.filter.trim().length === 0) return false
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
    }
  },

  actions: {
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      this.hydrated = true
      try {
        this.roots = await window.silverdaw.listFileBrowserFolders()
      } catch (err) {
        log.warn('fileBrowser', `hydrate failed: ${String(err)}`)
        // Allow a later mount to retry rather than stranding an empty browser.
        this.hydrated = false
        return
      }
      // Show each added folder's contents straight away; nested folders stay shut.
      await Promise.all(this.roots.map((root) => this.expand(root)))
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
      for (const folder of added) await this.expand(folder)
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
        delete this.infoRequested[path]
      }
      for (const path of Object.keys(this.children)) {
        if (path === folder || isUnder(path, folder)) delete this.children[path]
      }
      for (const path of Object.keys(this.expanded)) {
        if (path === folder || isUnder(path, folder)) delete this.expanded[path]
      }
      for (const path of Object.keys(this.loading)) {
        if (path === folder || isUnder(path, folder)) delete this.loading[path]
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
     * Filtering matches on tags, and searches folders the user has never opened,
     * so the whole tree is listed and expanded while a filter is active. The
     * pre-filter disclosure state is put back when the filter is cleared, so
     * searching never costs the user the tree layout they had arranged.
     */
    async setFilter(query: string): Promise<void> {
      const wasFiltering = this.filter.trim().length > 0
      const nowFiltering = query.trim().length > 0
      this.filter = query

      if (!nowFiltering) {
        if (this.expandedBeforeFilter !== null) {
          this.expanded = this.expandedBeforeFilter
          this.expandedBeforeFilter = null
        }
        this.revealAudition()
        return
      }

      // Snapshot only on the first keystroke of a search, so later ones don't
      // capture the fully-expanded tree as the state to restore.
      if (!wasFiltering) this.expandedBeforeFilter = { ...this.expanded }
      await this.expandAllForFilter()
    },

    /**
     * Keep the audition on screen once a filter is cleared. The pin that held it
     * above the tree disappears with the filter, and restoring the pre-filter
     * disclosure state can fold its folders shut, so they are reopened and the
     * row reselected — the view scrolls to the selection, and the arrow and
     * Enter keys carry on from there.
     */
    revealAudition(): void {
      const path = usePreviewStore().filePath
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

    /**
     * List and open every folder, reading each file's tags on the way. `expand`
     * and `ensureInfo` both de-duplicate, so repeated keystrokes cost nothing
     * beyond the first crawl.
     */
    async expandAllForFilter(): Promise<void> {
      const visit = async (dir: string): Promise<void> => {
        await this.expand(dir)
        for (const entry of this.children[dir] ?? []) {
          if (entry.kind === 'directory') await visit(entry.path)
          else void this.ensureInfo(entry.path)
        }
      }
      for (const root of this.roots) await visit(root)
    },

    async toggle(dir: string): Promise<void> {
      if (this.expanded[dir] === true) this.expanded[dir] = false
      else await this.expand(dir)
    },

    /** Expand a folder, listing its contents the first time it is opened. */
    async expand(dir: string): Promise<void> {
      this.expanded[dir] = true
      if (this.children[dir] !== undefined || this.loading[dir] === true) return
      this.loading[dir] = true
      try {
        this.children[dir] = await window.silverdaw.listFileBrowserDirectory(dir)
      } catch (err) {
        log.warn('fileBrowser', `listDirectory failed for ${dir}: ${String(err)}`)
        this.children[dir] = []
      } finally {
        delete this.loading[dir]
      }
    },

    /** Re-read a folder so files added on disk since it was opened appear. */
    async refresh(dir: string): Promise<void> {
      delete this.children[dir]
      await this.expand(dir)
    },

    /**
     * Resolve a file's tags and artwork once. Rows call this when they mount, so
     * a folder of hundreds of files only pays for what is actually on screen.
     */
    async ensureInfo(filePath: string): Promise<void> {
      if (this.infoRequested[filePath] === true) return
      this.infoRequested[filePath] = true
      const metadata = await window.silverdaw.readAudioMetadata(filePath).catch((err) => {
        log.warn('fileBrowser', `readAudioMetadata failed for ${filePath}: ${String(err)}`)
        return null
      })
      if (!metadata) {
        this.info[filePath] = {}
        return
      }
      // Cover bytes stay out of reactive state; only the Blob URL is exposed.
      const { coverArt, title, artist, album, durationMs } = metadata
      const entry: FileBrowserFileInfo = { title, artist, album, durationMs }
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
     * auditioned from, then start it. The pending path doubles as a claim on the
     * preview voice, so clicking another file mid-decode abandons this one rather
     * than stealing playback once its transcode lands.
     */
    async prepareAndPlay(filePath: string): Promise<void> {
      this.preparingPath = filePath
      const wavPath = await ensureBackendPlayablePath(filePath)
      if (this.preparingPath !== filePath) return
      this.preparingPath = null
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
