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

import { computed, ref } from 'vue'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { importAudioIntoLibrary } from '@/lib/importAudio'
import { log } from '@/lib/log'

const props = defineProps<{
    /** Current panel height in CSS pixels (excluding the resize handle). */
    height: number
}>()

const emit = defineEmits<{
    (e: 'update:height', value: number): void
}>()

const library = useLibraryStore()

// True while an OS drag is hovering over the panel — used to highlight the
// drop zone. We track depth to handle nested dragenter/dragleave correctly.
const isDragOver = ref(false)
let dragDepth = 0

const itemCount = computed(() => library.items.length)

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

function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Metadata display helpers ─────────────────────────────────────
// Cards show the track title on the top line (falling back to the file
// name) and the artist on a second muted line when tags are present. The
// full metadata payload (album, BPM, key, codec, bitrate, sample rate,
// tag versions, …) is exposed via the `title` attribute so hovering
// surfaces everything without cluttering the grid.

function displayTitle(item: LibraryItem): string {
    return item.metadata?.title ?? item.fileName
}

function displayArtist(item: LibraryItem): string {
    return item.metadata?.artist ?? ''
}

function channelLabel(count: number): string {
    if (count === 1) return 'Mono'
    if (count === 2) return 'Stereo'
    return `${count} ch`
}

function buildTooltip(item: LibraryItem): string {
    const lines: string[] = [item.filePath]
    const m = item.metadata
    if (m) {
        const tagLines: string[] = []
        if (m.title) tagLines.push(`Title: ${m.title}`)
        if (m.artist) tagLines.push(`Artist: ${m.artist}`)
        if (m.albumArtist && m.albumArtist !== m.artist)
            tagLines.push(`Album artist: ${m.albumArtist}`)
        if (m.album) {
            tagLines.push(m.year ? `Album: ${m.album} (${m.year})` : `Album: ${m.album}`)
        } else if (m.year) {
            tagLines.push(`Year: ${m.year}`)
        }
        if (typeof m.trackNumber === 'number') {
            tagLines.push(
                `Track: ${m.trackNumber}${m.trackTotal ? ' of ' + m.trackTotal : ''}`
            )
        }
        if (typeof m.discNumber === 'number') {
            tagLines.push(
                `Disc: ${m.discNumber}${m.discTotal ? ' of ' + m.discTotal : ''}`
            )
        }
        if (m.genre && m.genre.length > 0) tagLines.push(`Genre: ${m.genre.join(', ')}`)
        if (m.composer) tagLines.push(`Composer: ${m.composer}`)
        if (typeof m.bpm === 'number') tagLines.push(`BPM: ${m.bpm}`)
        if (m.key) tagLines.push(`Key: ${m.key}`)
        if (tagLines.length > 0) {
            lines.push('')
            lines.push(...tagLines)
        }
    }
    // Technical line is always shown so users can compare files at a glance.
    const tech: string[] = []
    if (m?.codec) tech.push(m.codec)
    if (typeof m?.bitrate === 'number') tech.push(`${Math.round(m.bitrate / 1000)} kbps`)
    tech.push(`${(item.sampleRate / 1000).toFixed(1)} kHz`)
    tech.push(channelLabel(item.channelCount))
    if (m && typeof m.lossless === 'boolean') tech.push(m.lossless ? 'Lossless' : 'Lossy')
    lines.push('')
    lines.push(tech.join(' · '))
    if (m?.tagTypes && m.tagTypes.length > 0) lines.push(`Tags: ${m.tagTypes.join(', ')}`)
    return lines.join('\n')
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
        class="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Import audio files into the library"
        @click="onImportClick"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M12 3v10.59l3.3-3.3 1.4 1.42L12 17.4l-4.7-5.69 1.4-1.42 3.3 3.3V3h2zM5 19h14v2H5v-2z" />
        </svg>
        <span>Import</span>
      </button>
    </header>

    <!-- Body. Either an empty-state hint or a horizontal-scrolling row of cards. -->
    <div class="relative flex-1 overflow-auto p-2">
      <div
        v-if="library.items.length === 0"
        class="flex h-full w-full items-center justify-center text-xs text-zinc-500"
      >
        Drop audio files here, or click <span class="mx-1 font-medium text-zinc-300">Import</span> to add them.
      </div>
      <div
        v-else
        class="flex flex-wrap gap-2"
      >
        <div
          v-for="item in library.items"
          :key="item.id"
          draggable="true"
          class="library-item group relative flex h-20 w-48 shrink-0 cursor-grab select-none items-stretch overflow-hidden rounded border border-zinc-700 bg-zinc-950/60 text-left transition-colors hover:border-zinc-500 hover:bg-zinc-950 active:cursor-grabbing"
          :title="buildTooltip(item)"
          @dragstart="(e) => onItemDragStart(e, item)"
          @dragend="onItemDragEnd"
        >
          <!-- Cover art thumbnail (or fallback) on the left edge. -->
          <div
            class="flex h-full w-15 shrink-0 items-center justify-center border-r border-zinc-800 bg-zinc-900"
          >
            <img
              v-if="item.coverArtUrl"
              :src="item.coverArtUrl"
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
            <div class="min-w-0 truncate text-xs font-medium text-zinc-100">
              {{ displayTitle(item) }}
            </div>
            <div
              v-if="displayArtist(item)"
              class="min-w-0 truncate text-[11px] text-zinc-400"
            >
              {{ displayArtist(item) }}
            </div>
            <div class="mt-auto flex items-center justify-between text-[10px] text-zinc-500">
              <span class="font-mono tabular-nums">{{ formatDuration(item.durationMs) }}</span>
              <button
                type="button"
                tabindex="-1"
                :disabled="library.isItemInUse(item.id)"
                class="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent disabled:hover:text-zinc-700"
                :title="library.isItemInUse(item.id) ? 'In use \u2014 remove the clip from the track first' : 'Remove from library'"
                @click="library.removeItem(item.id)"
                @mousedown.stop
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
      </div>

      <!-- OS-drag overlay — blue dashed outline + tint when dragging files in. -->
      <div
        v-if="isDragOver"
        class="pointer-events-none absolute inset-1 flex items-center justify-center rounded border-2 border-dashed border-blue-500 bg-blue-500/10 text-sm font-medium text-blue-200"
      >
        Drop audio files to add them to the library
      </div>
    </div>
  </section>
</template>

<style scoped>
.library-item {
    /* Hide the default text-cursor on drag and give the card a subtle shadow on hover. */
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
}
</style>
