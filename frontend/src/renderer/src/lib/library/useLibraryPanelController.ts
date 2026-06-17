import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLibraryStore, libraryItemDisplayName, libraryItemIsSample, libraryItemIsSampleAsset, type LibraryItem } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import { importAudioIntoLibrary, preflightSampleRates } from '@/lib/importAudio'
import { log } from '@/lib/log'
import { keyBadgeClass } from '@/lib/keyBadge'
import { effectiveTempoRatio } from '@/lib/warp'
import { useLibraryDropZone } from '@/lib/library/useLibraryDropZone'
import { useLibraryItemRename } from '@/lib/library/useLibraryItemRename'
import { useLibraryItemActions } from '@/lib/library/useLibraryItemActions'

export type LibraryPanelProps = {
  /** Panel height in CSS pixels, excluding the resize handle. */
  height: number
}

export type LibraryPanelEmit = {
  (e: 'update:height', value: number): void
}

export function useLibraryPanelController(props: Readonly<LibraryPanelProps>, emit: LibraryPanelEmit) {
  const library = useLibraryStore()
  const ui = useUiStore()
  const project = useProjectStore()

  // Tab state bridges persisted FX panel state with the local Library tab.
  const activeTab = computed<'library' | 'trackfx' | 'projectfx'>({
    get: () => {
      if (!project.fxPanelOpen) return 'library'
      // Track FX remains selectable so the panel can show its empty-state hint.
      return project.fxTab === 'project' ? 'projectfx' : 'trackfx'
    },
    set: (tab) => {
      // Tab clicks reveal the minimised panel.
      ui.setLibraryPanelCollapsed(false)
      if (tab === 'library') {
        project.setFxPanelOpen(false)
        return
      }
      project.setFxTab(tab === 'projectfx' ? 'project' : 'track')
      project.setFxPanelOpen(true)
    }
  })

  // Actions, rename, and OS drop-zone behavior live in focused composables.
  const { isDragOver, onPanelDragEnter, onPanelDragOver, onPanelDragLeave, onPanelDrop } =
    useLibraryDropZone()

  const { editingItemId, editingValue, setNameInputEl, startRename, onDocumentKeyDown, onDocumentPointerDown } =
    useLibraryItemRename()

  // Document-level rename commit/cancel survives nested interactive containers.
  watch(editingItemId, (id) => {
    if (id) {
      document.addEventListener('keydown', onDocumentKeyDown, { capture: true })
      document.addEventListener('pointerdown', onDocumentPointerDown, { capture: true })
    } else {
      document.removeEventListener('keydown', onDocumentKeyDown, { capture: true })
      document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true })
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onDocumentKeyDown, { capture: true })
    document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true })
  })

  const {
    contextMenu,
    infoItem,
    editorItem,
    contextMenuItems,
    closeItemInfo,
    openItemEditor,
    closeItemEditor,
    openItemContextMenu,
    closeItemContextMenu,
    onContextMenuCommand
  } = useLibraryItemActions({ startRename })

  const itemCount = computed(() => library.items.length)

  const SAVED_CLIP_PILL_CLASS =
    'shrink-0 whitespace-nowrap rounded border px-1 py-0.5 text-[9px] leading-none shadow-sm'
  const SAVED_CLIP_BPM_PILL_CLASS =
    `${SAVED_CLIP_PILL_CLASS} border-zinc-700 bg-zinc-800 text-zinc-300`
  const SAMPLE_PILL_CLASS =
    `${SAVED_CLIP_PILL_CLASS} border-indigo-800 bg-indigo-900/60 text-indigo-200`
  // Stems are standalone audio files (their own samples / duration), shown as
  // top-level items like imported sources — not nested under the original. The
  // link to the original survives via `derivedFrom` (badge + info-dialog note +
  // inherited cover art), not via tree nesting.
  const sourceItems = computed(() =>
    library.items.filter((item) => item.kind === 'audio-file' || item.kind === 'stem')
  )
  const orphanSavedClipItems = computed(() =>
    library.items.filter(
      (item) =>
        item.kind === 'saved-clip' &&
        !library.items.some((source) => source.id === item.derivedFrom?.sourceItemId)
    )
  )

  async function onImportClick(): Promise<void> {
    log.info('library', 'import-button click')
    const opened = await window.silverdaw.openAudioFiles().catch((err) => {
      log.error('library', `openAudioFiles failed: ${String(err)}`)
      return [] as Awaited<ReturnType<typeof window.silverdaw.openAudioFiles>>
    })
    if (opened.length === 0) {
      log.info('library', 'import-button dialog cancelled')
      return
    }
    // Sample-rate preflight can cancel the whole batch before import starts.
    const decision = await preflightSampleRates(opened.map((f) => f.filePath))
    if (decision === 'cancel') {
      log.info('library', 'import cancelled at sample-rate prompt')
      return
    }
    // Track batch progress as one status-bar operation.
    library.beginImportBatch(opened.length)
    for (const file of opened) {
      await importAudioIntoLibrary(file)
    }
  }

  // ─── Library item → timeline drag ─────────────────────────────────────────

  function onItemDragStart(e: DragEvent, item: LibraryItem): void {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('application/x-silverdaw-library-item', item.id)
    // Plain text helps identify drags that escape the app.
    e.dataTransfer.setData('text/plain', item.fileName)
    // Dragover cannot read dataTransfer, so store the id for drop previews.
    library.setDragItem(item.id)
  }

  function onItemDragEnd(): void {
    library.setDragItem(null)
  }

  function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  /** Saved clips can be sub-second, so avoid rounding them to whole seconds. */
  function formatClipDuration(ms: number): string {
    const safe = Math.max(0, ms)
    if (safe < 60_000) {
      const seconds = safe / 1000
      return seconds.toFixed(seconds < 10 ? 2 : 1)
    }
    const totalSeconds = Math.floor(safe / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  // ─── Metadata display helpers ─────────────────────────────────────

  function displayTitle(item: LibraryItem): string {
    return libraryItemDisplayName(item)
  }

  function displayArtist(item: LibraryItem): string {
    const artist = item.metadata?.artist
    if (artist) return artist
    // Stems carry no tags of their own; show the original source's artist so a
    // stem card reads like the file it came from.
    const originId = item.derivedFrom?.sourceItemId
    return (originId ? library.byId[originId]?.metadata?.artist : undefined) ?? ''
  }

  function childItems(source: LibraryItem): LibraryItem[] {
    // Stems are top-level items, so only saved clips nest under their source.
    return library.items.filter(
      (item) => item.derivedFrom?.sourceItemId === source.id && item.kind !== 'stem'
    )
  }

  /**
   * Cover art shown on a library card. Stems carry no embedded art, so they
   * borrow the original source's image to read as a clear variant of it.
   */
  function groupCoverArtUrl(item: LibraryItem): string | undefined {
    if (item.coverArtUrl) return item.coverArtUrl
    const originId = item.derivedFrom?.sourceItemId
    return originId ? library.byId[originId]?.coverArtUrl : undefined
  }

  function savedClipEffectiveBpm(item: LibraryItem): number | undefined {
    if (item.kind !== 'saved-clip' || item.warpEnabled !== true) return undefined
    const source = item.derivedFrom?.sourceItemId
      ? library.byId[item.derivedFrom?.sourceItemId]
      : undefined
    const sourceBpm = item.bpm ?? source?.bpm
    if (typeof sourceBpm !== 'number' || sourceBpm <= 0) return undefined
    const ratio = effectiveTempoRatio({
      tempoRatio: item.tempoRatio,
      sourceBpm,
      projectBpm: sourceBpm
    })
    return sourceBpm * ratio
  }

  /** Mirrors drop-time warp rules so sample tiles match drop behavior. */
  function tileIsSample(item: LibraryItem): boolean {
    return libraryItemIsSample(item, library.byId)
  }

  /** Saved sample asset (music OR simple) — drives the cover-art type badge and tile
   *  styling. Distinct from `tileIsSample`, which is the narrower non-musical flag. */
  function tileIsSampleAsset(item: LibraryItem): boolean {
    return libraryItemIsSampleAsset(item, library.byId)
  }

  /** Number of timeline placements of a library item (drives the in-use count pill). */
  function tileUseCount(item: LibraryItem): number {
    return library.itemUseCount(item.id)
  }

  // ─── Resize handle (top edge of the panel) ────────────────────────────────

  const MIN_PANEL_HEIGHT = 80
  const MAX_PANEL_HEIGHT_FRACTION = 0.7 // never more than 70% of the window

  // Collapsed height keeps the tab strip fully visible.
  const COLLAPSED_PANEL_HEIGHT = 33

  // Suppress height transition during direct resize.
  const isResizing = ref(false)

  let resizeStartY = 0
  let resizeStartHeight = 0

  function onResizePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    isResizing.value = true
    resizeStartY = e.clientY
    resizeStartHeight = props.height
    window.addEventListener('pointermove', onResizePointerMove)
    window.addEventListener('pointerup', onResizePointerUp)
    window.addEventListener('pointercancel', onResizePointerUp)
    e.preventDefault()
  }

  function onResizePointerMove(e: PointerEvent): void {
    const delta = resizeStartY - e.clientY
    const max = Math.max(MIN_PANEL_HEIGHT, Math.floor(window.innerHeight * MAX_PANEL_HEIGHT_FRACTION))
    const next = Math.min(max, Math.max(MIN_PANEL_HEIGHT, resizeStartHeight + delta))
    if (next !== props.height) emit('update:height', next)
  }

  function onResizePointerUp(): void {
    isResizing.value = false
    window.removeEventListener('pointermove', onResizePointerMove)
    window.removeEventListener('pointerup', onResizePointerUp)
    window.removeEventListener('pointercancel', onResizePointerUp)
  }

  return {
    library,
    ui,
    activeTab,
    isDragOver,
    onPanelDragEnter,
    onPanelDragOver,
    onPanelDragLeave,
    onPanelDrop,
    editingItemId,
    editingValue,
    setNameInputEl,
    startRename,
    contextMenu,
    infoItem,
    editorItem,
    contextMenuItems,
    closeItemInfo,
    openItemEditor,
    closeItemEditor,
    openItemContextMenu,
    closeItemContextMenu,
    onContextMenuCommand,
    itemCount,
    SAVED_CLIP_PILL_CLASS,
    SAVED_CLIP_BPM_PILL_CLASS,
    SAMPLE_PILL_CLASS,
    sourceItems,
    orphanSavedClipItems,
    onImportClick,
    onItemDragStart,
    onItemDragEnd,
    formatDuration,
    formatClipDuration,
    displayTitle,
    displayArtist,
    childItems,
    groupCoverArtUrl,
    savedClipEffectiveBpm,
    keyBadgeClass,
    tileIsSample,
    tileIsSampleAsset,
    tileUseCount,
    COLLAPSED_PANEL_HEIGHT,
    isResizing,
    onResizePointerDown
  }
}
