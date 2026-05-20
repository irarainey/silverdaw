<script setup lang="ts">
// LibraryPanel — bottom-of-window panel hosting imported audio files as
// draggable items. Files can be added via the Import button or by dragging
// them in from the OS file manager. Each item can then be dragged out onto
// a track in the timeline; placement is handled by TimelineView's drop
// listener which calls `projectStore.addClipFromLibrary`.
//
// Drag payload for "library item → timeline":
//   dataTransfer.setData('application/x-silverdaw-library-item', itemId)
//   dataTransfer.effectAllowed = 'copy'
//
// Resize: the user can drag the top edge to grow / shrink the panel. The
// height is held by App.vue so the timeline can size itself off whatever
// height is left over.

import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { useLibraryStore, libraryItemDisplayName, type LibraryItem } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { importAudioIntoLibrary, reanalyseLibraryItem } from '@/lib/importAudio'
import { log } from '@/lib/log'
import { keyBadgeClass } from '@/lib/keyBadge'
import ClipContextMenu, { type ClipContextMenuItem } from '@/components/ClipContextMenu.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'

const props = defineProps<{
    /** Current panel height in CSS pixels (excluding the resize handle). */
    height: number
}>()

const emit = defineEmits<{
    (e: 'update:height', value: number): void
}>()

const library = useLibraryStore()
const ui = useUiStore()

// True while an OS drag is hovering over the panel — used to highlight the
// drop zone. We track depth to handle nested dragenter/dragleave correctly.
const isDragOver = ref(false)
const infoItemId = ref<string | null>(null)
const contextMenu = ref<{ itemId: string; x: number; y: number } | null>(null)
let dragDepth = 0

// ─── Inline rename ────────────────────────────────────────────────────────
const editingItemId = ref<string | null>(null)
const editingValue = ref('')
let nameInputEl: HTMLInputElement | null = null

function setNameInputEl(el: Element | ComponentPublicInstance | null): void {
    nameInputEl = (el as HTMLInputElement | null) ?? null
}

async function startRename(item: LibraryItem): Promise<void> {
    log.info('library', `startRename id=${item.id}`)
    editingItemId.value = item.id
    editingValue.value = libraryItemDisplayName(item)
    await nextTick()
    if (nameInputEl) {
        nameInputEl.focus()
        nameInputEl.select()
    }
}

function commitRename(): void {
    const id = editingItemId.value
    if (!id) return
    log.info('library', `commitRename ${id} -> "${editingValue.value}"`)
    library.renameItem(id, editingValue.value)
    editingItemId.value = null
}

function cancelRename(): void {
    log.info('library', 'cancelRename')
    editingItemId.value = null
}

// While a rename is in progress, listen at the document level for the
// commit / cancel gestures. This is more robust than relying on the
// input's own `keydown` / `blur` handlers, which can be blocked when the
// input lives inside other interactive containers (draggable rows etc.).
function onDocumentKeyDown(e: KeyboardEvent): void {
    if (!editingItemId.value) return
    if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        commitRename()
    } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelRename()
    }
}

function onDocumentPointerDown(e: PointerEvent): void {
    if (!editingItemId.value) return
    if (!nameInputEl) return
    if (e.target instanceof Node && nameInputEl.contains(e.target)) return
    commitRename()
}

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

const itemCount = computed(() => library.items.length)
const infoItem = computed(() => library.items.find((item) => item.id === infoItemId.value) ?? null)
const contextMenuItem = computed(() =>
    contextMenu.value ? library.items.find((item) => item.id === contextMenu.value?.itemId) ?? null : null
)
const sourceItems = computed(() => library.items.filter((item) => item.kind === 'audio-file'))
const orphanSavedClipItems = computed(() =>
    library.items.filter(
        (item) =>
            item.kind === 'saved-clip' &&
            !library.items.some((source) => source.id === item.derivedFrom?.sourceItemId)
    )
)
const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
    const item = contextMenuItem.value
    if (!item) return []
    const inUse = library.isItemInUse(item.id)
    const items: ClipContextMenuItem[] = [
        { command: 'library.info', label: 'Show information' },
        { command: 'library.rename', label: 'Rename…', separatorAbove: true }
    ]
    if (item.kind === 'audio-file') {
        items.push({ command: 'library.reanalyse', label: 'Reanalyse file' })
    }
    items.push(
        {
            command: 'library.delete',
            label: inUse ? 'Delete (in use)' : 'Delete',
            disabled: inUse,
            separatorAbove: true
        }
    )
    return items
})

async function onImportClick(): Promise<void> {
    log.info('library', 'import-button click')
    const opened = await window.silverdaw.openAudioFiles().catch((err) => {
        console.error('[LibraryPanel] openAudioFiles failed:', err)
        log.error('library', `openAudioFiles failed: ${String(err)}`)
        return [] as Awaited<ReturnType<typeof window.silverdaw.openAudioFiles>>
    })
    if (opened.length === 0) {
        log.info('library', 'import-button dialog cancelled')
        return
    }
    // Register the batch with the library store so the status-bar progress
    // bar reflects the whole import, not per-file flashes.
    library.beginImportBatch(opened.length)
    for (const file of opened) {
        await importAudioIntoLibrary(file)
    }
}

// ─── OS drag-and-drop into the library ─────────────────────────────────────

function onPanelDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return
    dragDepth++
    isDragOver.value = true
    e.preventDefault()
}

function onPanelDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return
    // Required to allow `drop` to fire.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onPanelDragLeave(e: DragEvent): void {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) isDragOver.value = false
}

async function onPanelDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    isDragOver.value = false

    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    // Count every dropped file towards the progress total, even ones that
    // turn out to lack a path or fail to read — we call
    // `noteImportFinished()` for those too so the bar still completes.
    library.beginImportBatch(files.length)
    for (const file of files) {
        // The preload exposes Electron's `webUtils.getPathForFile`, the only
        // way to recover an absolute path from a drag-dropped File since
        // Electron dropped `file.path` in v32.
        const path = window.silverdaw.getPathForFile(file)
        if (!path) {
            console.warn('[LibraryPanel] dropped file has no path:', file.name)
            library.noteImportFinished()
            continue
        }
        const opened = await window.silverdaw.readAudioFile(path)
        if (!opened) {
            library.noteImportFinished()
            continue
        }
        await importAudioIntoLibrary(opened)
    }
}

/** True if the dragged payload includes filesystem files (vs an inner drag). */
function hasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types
    if (!types) return false
    for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true
    }
    return false
}

// ─── Library item → timeline drag ─────────────────────────────────────────

function onItemDragStart(e: DragEvent, item: LibraryItem): void {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('application/x-silverdaw-library-item', item.id)
    // A plain-text fallback helps debugging and lets external surfaces
    // identify the drag if it escapes the app.
    e.dataTransfer.setData('text/plain', item.fileName)
    // `dataTransfer.getData(...)` returns '' during `dragover` events for
    // security, so we stash the dragged item id on the store too. The
    // timeline reads it from there to drive the drop-preview ghost.
    library.setDragItem(item.id)
}

function onItemDragEnd(): void {
    library.setDragItem(null)
}

function openItemInfo(item: LibraryItem): void {
    closeItemContextMenu()
    infoItemId.value = item.id
}

function closeItemInfo(): void {
    infoItemId.value = null
}

function openItemContextMenu(e: MouseEvent, item: LibraryItem): void {
    contextMenu.value = {
        itemId: item.id,
        x: e.clientX,
        y: e.clientY
    }
}

function closeItemContextMenu(): void {
    contextMenu.value = null
}

function onContextMenuCommand(command: string): void {
    const item = contextMenuItem.value
    if (!item) return
    if (command === 'library.info') {
        openItemInfo(item)
        return
    }
    if (command === 'library.rename') {
        closeItemContextMenu()
        void startRename(item)
        return
    }
    if (command === 'library.reanalyse') {
        closeItemContextMenu()
        void reanalyseLibraryItem(item.id)
        return
    }
    if (command === 'library.delete') {
        const removed = library.removeItem(item.id)
        if (removed && infoItemId.value === item.id) closeItemInfo()
    }
}

function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, '0')}`
}

/** Saved clips can be sub-second; show one decimal so a 1.5 s clip
 *  doesn't display as "0:01" alongside its source range. */
function formatClipDuration(ms: number): string {
    const safe = Math.max(0, ms)
    if (safe < 60_000) {
        const seconds = safe / 1000
        return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`
    }
    const totalSeconds = Math.floor(safe / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// ─── Metadata display helpers ─────────────────────────────────────
// Cards show the track title on the top line (falling back to the file
// name) and the artist on a second muted line when tags are present. The
// full metadata payload is shown in LibraryItemInfoDialog.

function displayTitle(item: LibraryItem): string {
    return libraryItemDisplayName(item)
}

function displayArtist(item: LibraryItem): string {
    return item.metadata?.artist ?? ''
}

function childItems(source: LibraryItem): LibraryItem[] {
    return library.items.filter((item) => item.derivedFrom?.sourceItemId === source.id)
}

function sourceWindowLabel(item: LibraryItem): string {
    if (!item.derivedFrom) return ''
    const start = item.derivedFrom.inMs
    const end = start + item.derivedFrom.durationMs
    return `${formatDuration(start)} – ${formatDuration(end)}`
}

// ─── Resize handle (top edge of the panel) ────────────────────────────────

const MIN_PANEL_HEIGHT = 80
const MAX_PANEL_HEIGHT_FRACTION = 0.7 // never more than 70% of the window

let resizeStartY = 0
let resizeStartHeight = 0

function onResizePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    resizeStartY = e.clientY
    resizeStartHeight = props.height
    window.addEventListener('pointermove', onResizePointerMove)
    window.addEventListener('pointerup', onResizePointerUp)
    window.addEventListener('pointercancel', onResizePointerUp)
    e.preventDefault()
}

function onResizePointerMove(e: PointerEvent): void {
    // Dragging the handle UP grows the panel; DOWN shrinks it.
    const delta = resizeStartY - e.clientY
    const max = Math.max(MIN_PANEL_HEIGHT, Math.floor(window.innerHeight * MAX_PANEL_HEIGHT_FRACTION))
    const next = Math.min(max, Math.max(MIN_PANEL_HEIGHT, resizeStartHeight + delta))
    if (next !== props.height) emit('update:height', next)
}

function onResizePointerUp(): void {
    window.removeEventListener('pointermove', onResizePointerMove)
    window.removeEventListener('pointerup', onResizePointerUp)
    window.removeEventListener('pointercancel', onResizePointerUp)
}
</script>

<template>
  <section
    class="relative flex shrink-0 flex-col border-t border-zinc-800 bg-zinc-900 text-zinc-100"
    :style="{ height: height + 'px' }"
    @dragenter="onPanelDragEnter"
    @dragover="onPanelDragOver"
    @dragleave="onPanelDragLeave"
    @drop="onPanelDrop"
  >
    <!-- Top resize handle. The visible line is 1px; the hit area is 6px tall
             so it's easy to grab. The cursor changes to row-resize on hover. -->
    <div
      class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      title="Drag to resize"
      @pointerdown="onResizePointerDown"
    />

    <!-- Header. -->
    <header
      class="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 text-xs uppercase tracking-wide text-zinc-400"
    >
      <div class="flex items-center gap-2">
        <span class="font-semibold text-zinc-200">Library</span>
        <span class="text-zinc-500">{{ itemCount }} {{ itemCount === 1 ? 'item' : 'items' }}</span>
      </div>
      <button
        type="button"
        class="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
        title="Import audio files into the library"
        @click="onImportClick"
      >
        Import
      </button>
    </header>

    <!-- Body. Tiles wrap to the available width; only vertical overflow scrolls. -->
    <div class="library-panel-body relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
      <div
        v-if="library.items.length === 0"
        class="flex h-full w-full items-center justify-center text-xs text-zinc-500"
      >
        Drop audio files here, or click <span class="mx-1 font-medium text-zinc-300">Import</span> to add them.
      </div>
      <div
        v-else
        class="flex w-full min-w-0 flex-wrap items-start content-start gap-3"
      >
        <!-- Source group: source tile on top, derived saved clips below in a sub-list.
                       When the source has no saved clips, drop the group framing so the tile
                       reads as a standalone item rather than an empty container. -->
        <div
          v-for="source in sourceItems"
          :key="source.id"
          class="library-group flex w-72 max-w-full shrink-0 flex-col overflow-hidden rounded-md border"
          :class="
            childItems(source).length > 0
              ? 'border-zinc-800 bg-zinc-950/50'
              : 'border-zinc-800 bg-zinc-950/30'
          "
        >
          <div
            draggable="true"
            class="library-item group relative flex h-22 cursor-grab select-none items-stretch overflow-hidden bg-zinc-950/60 text-left transition-colors hover:bg-zinc-900 active:cursor-grabbing"
            @dragstart="(e) => onItemDragStart(e, source)"
            @dragend="onItemDragEnd"
            @dblclick="openItemInfo(source)"
            @contextmenu.prevent="(e) => openItemContextMenu(e, source)"
          >
            <!-- Cover art thumbnail (or fallback) on the left edge. -->
            <div
              v-if="ui.showLibraryTileImages"
              class="flex h-full w-15 shrink-0 items-center justify-center border-r border-zinc-800 bg-zinc-900"
            >
              <img
                v-if="source.coverArtUrl"
                :src="source.coverArtUrl"
                alt=""
                class="h-full w-full object-cover"
                draggable="false"
              >
              <svg
                v-else
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-6 w-6 text-zinc-700"
                aria-hidden="true"
              >
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm0 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
              </svg>
            </div>
            <!-- Text body. -->
            <div class="flex min-w-0 flex-1 flex-col px-2 py-1.5">
              <input
                v-if="editingItemId === source.id"
                :ref="setNameInputEl"
                v-model="editingValue"
                type="text"
                spellcheck="false"
                draggable="false"
                data-borderless-button="true"
                class="w-full min-w-0 rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-xs font-medium text-zinc-100 outline-none focus:border-cyan-500"
                @click.stop
                @dblclick.stop
                @mousedown.stop
                @dragstart.stop.prevent
              >
              <div
                v-else
                class="min-w-0 truncate text-xs font-medium text-zinc-100"
                title="Double-click to rename"
                @dblclick.stop="startRename(source)"
              >
                {{ displayTitle(source) }}
              </div>
              <div
                v-if="displayArtist(source)"
                class="min-w-0 truncate text-[11px] text-zinc-400"
              >
                {{ displayArtist(source) }}
              </div>
              <div class="mt-auto flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span class="flex items-center gap-2 font-mono tabular-nums">
                  <span>{{ formatDuration(source.durationMs) }}</span>
                  <span
                    v-if="source.key"
                    :class="keyBadgeClass(source.key)"
                    title="Detected key"
                  >
                    {{ source.key }}
                  </span>
                  <span
                    v-if="source.bpm"
                    class="whitespace-nowrap rounded px-1 py-0.5 text-[9px] uppercase tracking-wide"
                    :class="
                      source.variableTempo
                        ? 'bg-amber-900/60 text-amber-200'
                        : 'bg-zinc-800 text-zinc-300'
                    "
                    :title="
                      source.variableTempo
                        ? 'Tempo varies across the file - the BPM shown is a rough average'
                        : 'Detected tempo'
                    "
                  >
                    <span
                      v-if="source.variableTempo"
                      class="mr-0.5"
                    >~</span>{{ source.bpm.toFixed(2) }} BPM
                  </span>
                </span>
                <button
                  type="button"
                  tabindex="-1"
                  :disabled="library.isItemInUse(source.id)"
                  class="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent disabled:hover:text-zinc-700"
                  :title="library.isItemInUse(source.id) ? 'In use - remove track clips and saved clips first' : 'Remove from library'"
                  @click="library.removeItem(source.id)"
                  @mousedown.stop
                  @contextmenu.stop.prevent
                  @dragstart.stop.prevent
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    class="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path
                      d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.29 10.59 10.6l6.3-6.3z"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Saved clip sub-list derived from this source. Compact rows so
                       a source with many saved clips stays readable. The user
                       can collapse the sub-list with the disclosure chevron;
                       collapse state persists with the project. -->
          <div
            v-if="childItems(source).length > 0"
            class="flex flex-col bg-zinc-900/60"
          >
            <button
              type="button"
              data-borderless-button="true"
              class="flex w-full items-center gap-1.5 border-t border-zinc-800/80 px-2 py-1 text-left text-[10px] uppercase tracking-wide text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-300"
              :title="source.collapsed ? 'Show saved clips' : 'Hide saved clips'"
              @click="library.setItemCollapsed(source.id, !source.collapsed)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-3 w-3 transition-transform"
                :class="source.collapsed ? '-rotate-90' : ''"
                aria-hidden="true"
              >
                <path d="M7 10l5 5 5-5H7z" />
              </svg>
              <span>{{ childItems(source).length }} saved {{ childItems(source).length === 1 ? 'clip' : 'clips' }}</span>
            </button>
            <template v-if="!source.collapsed">
              <div
                v-for="item in childItems(source)"
                :key="item.id"
                draggable="true"
                class="saved-clip group flex h-10 cursor-grab select-none items-center gap-2 border-t border-zinc-800/60 px-2 text-left transition-colors hover:bg-zinc-800/70 active:cursor-grabbing"
                @dragstart="(e) => onItemDragStart(e, item)"
                @dragend="onItemDragEnd"
                @dblclick="openItemInfo(item)"
                @contextmenu.prevent="(e) => openItemContextMenu(e, item)"
              >
                <span
                  class="h-6 w-1 shrink-0 rounded-sm bg-cyan-500/60"
                  aria-hidden="true"
                />
                <div class="flex min-w-0 flex-1 flex-col">
                  <input
                    v-if="editingItemId === item.id"
                    :ref="setNameInputEl"
                    v-model="editingValue"
                    type="text"
                    spellcheck="false"
                    draggable="false"
                    data-borderless-button="true"
                    class="w-full min-w-0 rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-[11px] font-medium text-zinc-100 outline-none focus:border-cyan-500"
                    @click.stop
                    @dblclick.stop
                    @mousedown.stop
                    @dragstart.stop.prevent
                  >
                  <div
                    v-else
                    class="min-w-0 truncate text-[11px] font-medium text-zinc-100"
                    title="Double-click to rename"
                    @dblclick.stop="startRename(item)"
                  >
                    {{ displayTitle(item) }}
                  </div>
                  <div class="min-w-0 truncate font-mono text-[10px] tabular-nums text-zinc-500">
                    {{ sourceWindowLabel(item) }}
                  </div>
                </div>
                <span class="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400">
                  {{ formatClipDuration(item.durationMs) }}
                </span>
                <button
                  type="button"
                  tabindex="-1"
                  class="shrink-0 rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100"
                  title="Remove saved clip from library"
                  @click="library.removeItem(item.id)"
                  @mousedown.stop
                  @contextmenu.stop.prevent
                  @dragstart.stop.prevent
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    class="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path
                      d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.29 10.59 10.6l6.3-6.3z"
                    />
                  </svg>
                </button>
              </div>
            </template>
          </div>
        </div>

        <!-- Orphan saved clips: source file was removed from the library. -->
        <div
          v-if="orphanSavedClipItems.length > 0"
          class="library-group flex w-72 max-w-full shrink-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/50"
        >
          <div class="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
            Saved clips (source missing)
          </div>
          <div
            v-for="item in orphanSavedClipItems"
            :key="item.id"
            draggable="true"
            class="saved-clip group flex h-10 cursor-grab select-none items-center gap-2 border-t border-zinc-800/60 px-2 text-left transition-colors hover:bg-zinc-800/70 active:cursor-grabbing"
            @dragstart="(e) => onItemDragStart(e, item)"
            @dragend="onItemDragEnd"
            @dblclick="openItemInfo(item)"
            @contextmenu.prevent="(e) => openItemContextMenu(e, item)"
          >
            <span
              class="h-6 w-1 shrink-0 rounded-sm bg-amber-500/60"
              aria-hidden="true"
            />
            <div class="flex min-w-0 flex-1 flex-col">
              <input
                v-if="editingItemId === item.id"
                :ref="setNameInputEl"
                v-model="editingValue"
                type="text"
                spellcheck="false"
                draggable="false"
                data-borderless-button="true"
                class="w-full min-w-0 rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-[11px] font-medium text-zinc-100 outline-none focus:border-cyan-500"
                @click.stop
                @dblclick.stop
                @mousedown.stop
                @dragstart.stop.prevent
              >
              <div
                v-else
                class="min-w-0 truncate text-[11px] font-medium text-zinc-100"
                title="Double-click to rename"
                @dblclick.stop="startRename(item)"
              >
                {{ displayTitle(item) }}
              </div>
              <div class="min-w-0 truncate text-[10px] text-amber-300/80">
                Source file missing
              </div>
            </div>
            <span class="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400">
              {{ formatClipDuration(item.durationMs) }}
            </span>
          </div>
        </div>
      </div>

      <!-- OS-drag overlay - blue dashed outline + tint when dragging files in. -->
      <div
        v-if="isDragOver"
        class="pointer-events-none absolute inset-1 flex items-center justify-center rounded border-2 border-dashed border-blue-500 bg-blue-500/10 text-sm font-medium text-blue-200"
      >
        Drop audio files to add them to the library
      </div>
    </div>
    <LibraryItemInfoDialog
      :open="infoItem !== null"
      :item="infoItem"
      @close="closeItemInfo"
    />
    <ClipContextMenu
      :open="contextMenu !== null"
      :x="contextMenu?.x ?? 0"
      :y="contextMenu?.y ?? 0"
      :items="contextMenuItems"
      @close="closeItemContextMenu"
      @command="onContextMenuCommand"
    />
  </section>
</template>

<style scoped>
.library-item {
    /* Hide the default text-cursor on drag and give the card a subtle shadow on hover. */
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
}

.library-panel-body {
    scrollbar-color: rgb(113 113 122) rgb(24 24 27 / 0.8);
    scrollbar-width: thin;
}

.library-panel-body::-webkit-scrollbar {
    width: 12px;
}

.library-panel-body::-webkit-scrollbar-track {
    background: rgb(24 24 27 / 0.8);
}

.library-panel-body::-webkit-scrollbar-thumb {
    background-color: rgb(113 113 122);
    border: 3px solid rgb(24 24 27 / 0.8);
    border-radius: 9999px;
}

.library-panel-body::-webkit-scrollbar-thumb:hover {
    background-color: rgb(161 161 170);
}
</style>
