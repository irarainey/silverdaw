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
import { useLibraryStore, libraryItemDisplayName, libraryItemIsSample, type LibraryItem } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import { importAudioIntoLibrary, preflightSampleRates, reanalyseLibraryItem } from '@/lib/importAudio'
import { log } from '@/lib/log'
import { keyBadgeClass } from '@/lib/keyBadge'
import { effectiveTempoRatio } from '@/lib/warp'
import ClipContextMenu, { type ClipContextMenuItem } from '@/components/ClipContextMenu.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'
import ClipEditorDialog from '@/components/ClipEditorDialog.vue'
import TrackFxPanel from '@/components/TrackFxPanel.vue'
import ProjectFxPanel from '@/components/ProjectFxPanel.vue'

const props = defineProps<{
    /** Current panel height in CSS pixels (excluding the resize handle). */
    height: number
}>()

const emit = defineEmits<{
    (e: 'update:height', value: number): void
}>()

const library = useLibraryStore()
const ui = useUiStore()
const project = useProjectStore()

// Which bottom-panel tab is showing. `fxPanelOpen` (persisted project view
// state) records whether an effects rack is showing instead of the Library,
// so a track header's Fx button can open the rack from outside this
// component and the open/closed choice survives File > Save / Load.
// `fxTab` (UI-only) selects which rack — per-track (Track FX) or project-wide
// (Project FX). The panel opens on the Library.
const activeTab = computed<'library' | 'trackfx' | 'projectfx'>({
  get: () => {
    if (!project.fxPanelOpen) return 'library'
    return project.fxTab === 'project' ? 'projectfx' : 'trackfx'
  },
  set: (tab) => {
    if (tab === 'library') {
      project.setFxPanelOpen(false)
      return
    }
    project.setFxTab(tab === 'projectfx' ? 'project' : 'track')
    project.setFxPanelOpen(true)
  }
})

// True while an OS drag is hovering over the panel — used to highlight the
// drop zone. We track depth to handle nested dragenter/dragleave correctly.
const isDragOver = ref(false)
const infoItemId = ref<string | null>(null)
const editorItemId = ref<string | null>(null)
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
const infoItem = computed(() => (infoItemId.value ? library.byId[infoItemId.value] ?? null : null))
const editorItem = computed(() => (editorItemId.value ? library.byId[editorItemId.value] ?? null : null))

const SAVED_CLIP_PILL_CLASS =
    'shrink-0 whitespace-nowrap rounded border px-1 py-0.5 text-[9px] leading-none shadow-sm'
const SAVED_CLIP_BPM_PILL_CLASS =
    `${SAVED_CLIP_PILL_CLASS} border-zinc-700 bg-zinc-800 text-zinc-300`
const SAMPLE_PILL_CLASS =
    `${SAVED_CLIP_PILL_CLASS} border-indigo-800 bg-indigo-900/60 text-indigo-200`
const contextMenuItem = computed(() =>
    contextMenu.value ? library.byId[contextMenu.value?.itemId] ?? null : null
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
        { command: 'library.edit', label: 'Open in Editor' },
        { command: 'library.info', label: 'Show Information' },
        { command: 'library.rename', label: 'Rename', separatorAbove: true }
    ]
    if (item.kind === 'audio-file') {
        items.push({ command: 'library.reanalyse', label: 'Reanalyse File' })
    } else if (item.kind === 'saved-clip') {
        items.push({
            command: 'library.saveSample',
            label: 'Save as Sample',
            title:
                'Bakes the saved clip\u2019s current trim, warp, and pitch into a new independent WAV file. ' +
                'Re-running it always creates another fresh sample \u2014 baked samples are not linked back ' +
                'to this clip, so future edits to the saved clip do not affect previously-baked samples.'
        })
    }
    // Sample / music classification submenu. Audio-file items only —
    // saved clips inherit from their source unless the source is
    // missing (then they edit their own override here).
    if (item.kind === 'audio-file') {
        const auto = item.sampleMode === undefined
        items.push({
            command: 'library.classifyAuto',
            label: auto
                ? `Auto-classify (currently ${item.lowConfidence ? 'sample' : 'music'})`
                : 'Auto-classify',
            separatorAbove: true,
            disabled: auto
        })
        items.push({
            command: 'library.classifyMusic',
            label: 'Treat as Music',
            disabled: item.sampleMode === 'music'
        })
        items.push({
            command: 'library.classifySample',
            label: 'Treat as Sample',
            title: 'Hide BPM / key / beat markers, and skip auto-warp on drop. Warp and pitch dialogs still work manually.',
            disabled: item.sampleMode === 'sample'
        })
    }
    // Saved clips can always be removed — doing so just unlinks any
    // timeline clips that reference them (they keep their audio and
    // become independent). Audio-file sources stay gated because
    // removing them would orphan the actual sound data.
    const isSavedClip = item.kind === 'saved-clip'
    const blockRemove = inUse && !isSavedClip
    items.push(
        {
            command: 'library.delete',
            label: 'Remove',
            disabled: blockRemove,
            separatorAbove: true
        }
    )
    return items
})

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
    // Sample-rate preflight: probe every file and prompt if any differ
    // from the project's effective target rate. Cancel aborts the
    // whole batch; "Switch project rate" updates `targetSampleRate`
    // before the loop runs.
    const decision = await preflightSampleRates(opened.map((f) => f.filePath))
    if (decision === 'cancel') {
        log.info('library', 'import cancelled at sample-rate prompt')
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
    // Resolve file paths first so the preflight probe has something to
    // hand the backend. Drops that lack a path (rare; usually only
    // in-browser drags) are filtered out before the preflight so they
    // don't skew the rate buckets.
    const pairs: { file: File; path: string }[] = []
    for (const file of files) {
        const path = window.silverdaw.getPathForFile(file)
        if (!path) {
            log.warn('library', `dropped file has no path: ${file.name}`)
            continue
        }
        pairs.push({ file, path })
    }
    if (pairs.length === 0) return
    const decision = await preflightSampleRates(pairs.map((p) => p.path))
    if (decision === 'cancel') {
        log.info('library', 'import (drag/drop) cancelled at sample-rate prompt')
        return
    }
    // Count every dropped file towards the progress total, even ones that
    // turn out to fail to read — we call `noteImportFinished()` for
    // those too so the bar still completes.
    library.beginImportBatch(pairs.length)
    for (const { path } of pairs) {
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

function openItemEditor(item: LibraryItem): void {
    closeItemContextMenu()
    editorItemId.value = item.id
}

function closeItemEditor(): void {
    editorItemId.value = null
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
    if (command === 'library.edit') {
        openItemEditor(item)
        return
    }
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
    if (command === 'library.saveSample') {
        closeItemContextMenu()
        void library.saveLibraryItemAsSample(item.id)
        return
    }
    if (command === 'library.classifyAuto') {
        closeItemContextMenu()
        library.setItemSampleMode(item.id, 'auto')
        return
    }
    if (command === 'library.classifyMusic') {
        closeItemContextMenu()
        library.setItemSampleMode(item.id, 'music')
        return
    }
    if (command === 'library.classifySample') {
        closeItemContextMenu()
        library.setItemSampleMode(item.id, 'sample')
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
        return seconds.toFixed(seconds < 10 ? 2 : 1)
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

/**
 * Helper: should this library item be treated as a non-musical sample?
 * Used to suppress BPM / key / variable-tempo badges on its tile in
 * favour of a single "sample" pill. Mirrors `applyDropTimeWarp` so
 * the tile UI matches what the drop will do.
 */
function tileIsSample(item: LibraryItem): boolean {
    return libraryItemIsSample(item, library.byId)
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

    <!-- Header: [Library | Track FX | Project FX] tab strip. The Import
         action belongs to the Library tab only. -->
    <header
      class="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 text-xs uppercase tracking-wide text-zinc-400"
    >
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
          :class="
            activeTab === 'library'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300'
          "
          :aria-pressed="activeTab === 'library'"
          @click="activeTab = 'library'"
        >
          Library
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
          :class="
            activeTab === 'trackfx'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300'
          "
          :aria-pressed="activeTab === 'trackfx'"
          @click="activeTab = 'trackfx'"
        >
          Track FX
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
          :class="
            activeTab === 'projectfx'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300'
          "
          :aria-pressed="activeTab === 'projectfx'"
          @click="activeTab = 'projectfx'"
        >
          Project FX
        </button>
        <span
          v-if="activeTab === 'library'"
          class="ml-1 text-zinc-500"
        >{{ itemCount }} {{ itemCount === 1 ? 'item' : 'items' }}</span>
      </div>
      <button
        v-if="activeTab === 'library'"
        type="button"
        class="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
        title="Import audio files into the library"
        @click="onImportClick"
      >
        Import
      </button>
    </header>

    <!-- Body. Tiles wrap to the available width; only vertical overflow scrolls. -->
    <div
      v-if="activeTab === 'library'"
      class="library-panel-body silverdaw-scroll relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2"
    >
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
          class="library-group flex w-[240px] max-w-full shrink-0 flex-col overflow-hidden rounded-md border"
          :class="
            childItems(source).length > 0
              ? 'border-zinc-800 bg-zinc-950/50'
              : 'border-zinc-800 bg-zinc-950/30'
          "
        >
          <div
            draggable="true"
            class="library-item group relative flex cursor-grab select-none items-stretch overflow-hidden bg-zinc-950/60 text-left transition-colors hover:bg-zinc-900 active:cursor-grabbing"
            @dragstart="(e) => onItemDragStart(e, source)"
            @dragend="onItemDragEnd"
            @dblclick="openItemEditor(source)"
            @contextmenu.prevent="(e) => openItemContextMenu(e, source)"
          >
            <!-- Cover art thumbnail (or fallback) on the left edge. -->
            <div
              v-if="ui.showLibraryTileImages"
              class="flex aspect-square w-[75px] shrink-0 items-center justify-center border-r border-zinc-800 bg-zinc-900"
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
                <span class="font-mono tabular-nums">{{ formatDuration(source.durationMs) }}</span>
                <span class="ml-auto flex items-center gap-1">
                  <span
                    v-if="tileIsSample(source)"
                    :class="SAMPLE_PILL_CLASS"
                    title="Treated as a non-musical sample — beat / key analysis is hidden and auto-warp on drop is skipped. Toggle from the right-click menu."
                  >
                    Sample
                  </span>
                  <template v-else>
                    <span
                      v-if="source.key"
                      :class="keyBadgeClass(source.key)"
                      title="Detected key"
                    >
                      {{ source.key }}
                    </span>
                    <span
                      v-if="source.bpm"
                      :class="
                        source.variableTempo
                          ? `${SAVED_CLIP_PILL_CLASS} border-amber-800 bg-amber-900/60 text-amber-200`
                          : SAVED_CLIP_BPM_PILL_CLASS
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
                  </template>
                </span>
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
                class="saved-clip group relative flex h-10 cursor-grab select-none items-center gap-2 border-t border-zinc-800/60 px-2 pr-1 text-left transition-colors hover:bg-zinc-800/70 active:cursor-grabbing"
                @dragstart="(e) => onItemDragStart(e, item)"
                @dragend="onItemDragEnd"
                @dblclick="openItemEditor(item)"
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
                    {{ formatClipDuration(item.durationMs) }}
                  </div>
                </div>
                <div class="ml-auto flex shrink-0 items-center gap-1">
                  <span
                    v-if="item.key && ((item.semitones ?? 0) !== 0 || (item.cents ?? 0) !== 0)"
                    :class="keyBadgeClass(item.key)"
                    title="Clip pitch key"
                  >
                    {{ item.key }}
                  </span>
                  <span
                    v-if="savedClipEffectiveBpm(item)"
                    :class="SAVED_CLIP_BPM_PILL_CLASS"
                    title="Warped clip tempo"
                  >
                    {{ savedClipEffectiveBpm(item)?.toFixed(2) }} BPM
                  </span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Orphan saved clips: source file was removed from the library. -->
        <div
          v-if="orphanSavedClipItems.length > 0"
          class="library-group flex w-[240px] max-w-full shrink-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/50"
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
            @dblclick="openItemEditor(item)"
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

    <!-- Track FX body. Edits the selected track's Tone + Sends. -->
    <TrackFxPanel
      v-else-if="activeTab === 'trackfx'"
      class="min-h-0 flex-1"
    />

    <!-- Project FX body. Edits the project-wide shared Room + Echo. -->
    <ProjectFxPanel
      v-else
      class="min-h-0 flex-1"
    />
    <LibraryItemInfoDialog
      :open="infoItem !== null"
      :item="infoItem"
      @close="closeItemInfo"
    />
    <ClipEditorDialog
      :open="editorItem !== null"
      :item="editorItem"
      @close="closeItemEditor"
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
    /* Scrollbar styling shared with the rest of the app via the
     * `silverdaw-scroll` utility in App.vue. Keeping the class on the
     * element preserves any layout assumptions earlier code made about
     * it without re-declaring the colour rules here. */
}
</style>

