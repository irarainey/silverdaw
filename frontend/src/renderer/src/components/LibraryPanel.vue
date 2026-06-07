<script setup lang="ts">
// Bottom library/effects panel; library items drag to the timeline with a custom payload.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLibraryStore, libraryItemDisplayName, libraryItemIsSample, type LibraryItem } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import { importAudioIntoLibrary, preflightSampleRates } from '@/lib/importAudio'
import { log } from '@/lib/log'
import { keyBadgeClass } from '@/lib/keyBadge'
import { effectiveTempoRatio } from '@/lib/warp'
import ClipContextMenu from '@/components/ClipContextMenu.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'
import ClipEditorDialog from '@/components/ClipEditorDialog.vue'
import TrackFxPanel from '@/components/TrackFxPanel.vue'
import ProjectFxPanel from '@/components/ProjectFxPanel.vue'
import { useLibraryDropZone } from '@/lib/library/useLibraryDropZone'
import { useLibraryItemRename } from '@/lib/library/useLibraryItemRename'
import { useLibraryItemActions } from '@/lib/library/useLibraryItemActions'

const props = defineProps<{
    /** Panel height in CSS pixels, excluding the resize handle. */
    height: number
}>()

const emit = defineEmits<{
    (e: 'update:height', value: number): void
}>()

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
const sourceItems = computed(() => library.items.filter((item) => item.kind === 'audio-file'))
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

/** Mirrors drop-time warp rules so sample tiles match drop behavior. */
function tileIsSample(item: LibraryItem): boolean {
    return libraryItemIsSample(item, library.byId)
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
</script>

<template>
  <section
    class="relative flex shrink-0 flex-col border-t border-zinc-800 bg-zinc-900 text-zinc-100"
    :class="isResizing ? '' : 'transition-[height] duration-150 ease-out'"
    :style="{ height: (ui.libraryPanelCollapsed ? COLLAPSED_PANEL_HEIGHT : height) + 'px' }"
    @dragenter="onPanelDragEnter"
    @dragover="onPanelDragOver"
    @dragleave="onPanelDragLeave"
    @drop="onPanelDrop"
  >
    <!-- Top resize handle; hidden while minimised. -->
    <div
      v-if="!ui.libraryPanelCollapsed"
      class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      title="Drag to resize"
      @pointerdown="onResizePointerDown"
    />

    <!-- Header tab strip. -->
    <header
      class="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 text-xs uppercase tracking-wide text-zinc-400"
    >
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="mr-1 flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          :title="ui.libraryPanelCollapsed ? 'Expand panel' : 'Minimise panel'"
          :aria-label="ui.libraryPanelCollapsed ? 'Expand panel' : 'Minimise panel'"
          :aria-expanded="!ui.libraryPanelCollapsed"
          @click="ui.toggleLibraryPanelCollapsed()"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="h-3.5 w-3.5 transition-transform"
            :class="ui.libraryPanelCollapsed ? 'rotate-180' : ''"
            aria-hidden="true"
          >
            <path d="M7 10l5 5 5-5H7z" />
          </svg>
        </button>
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

    <!-- Kept mounted so collapse animates without remount flicker. -->
    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden"
      :inert="ui.libraryPanelCollapsed"
    >
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
          <!-- Source group: source tile plus derived saved clips. -->
          <div
            v-for="source in sourceItems"
            :key="source.id"
            class="library-group flex w-60 max-w-full shrink-0 flex-col overflow-hidden rounded-md border"
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
              <div
                v-if="ui.showLibraryTileImages"
                class="flex aspect-square w-18.75 shrink-0 items-center justify-center border-r border-zinc-800 bg-zinc-900"
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

            <!-- Saved clips derived from this source. -->
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

          <!-- Orphan saved clips. -->
          <div
            v-if="orphanSavedClipItems.length > 0"
            class="library-group flex w-60 max-w-full shrink-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/50"
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

        <!-- OS-drag overlay. -->
        <div
          v-if="isDragOver"
          class="pointer-events-none absolute inset-1 flex items-center justify-center rounded border-2 border-dashed border-blue-500 bg-blue-500/10 text-sm font-medium text-blue-200"
        >
          Drop audio files to add them to the library
        </div>
      </div>

      <!-- Track FX body. -->
      <TrackFxPanel
        v-else-if="activeTab === 'trackfx'"
        class="min-h-0 flex-1"
      />

      <!-- Project FX body. -->
      <ProjectFxPanel
        v-else
        class="min-h-0 flex-1"
      />
    </div>
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
    /* Suppress drag text-cursor and add subtle card depth. */
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
}

.library-panel-body {
}
</style>

