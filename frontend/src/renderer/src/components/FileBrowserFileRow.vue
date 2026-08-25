<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useFileBrowserStore, fileBrowserRowIndentPx, fileBrowserFileTypeLabel, MIME_FILE_BROWSER_PATH } from '@/stores/fileBrowserStore'
import { formatTrackTime } from '@/lib/library/trackTime'

const props = defineProps<{
  row: {
    path: string
    name: string
    depth: number
    pinned?: boolean
  }
}>()

const emit = defineEmits<{
  (e: 'contextMenu', payload: { event: MouseEvent; path: string }): void
}>()

const browser = useFileBrowserStore()
const { info } = storeToRefs(browser)

const fileInfo = computed(() => info.value[props.row.path])
const title = computed(() => {
  const tagged = fileInfo.value?.title?.trim()
  return tagged && tagged.length > 0 ? tagged : props.row.name
})
const isPlaying = computed(() => browser.isPlaying(props.row.path))
// A format the engine cannot read is decoded on demand, so the click has a delay.
const isPreparing = computed(() => browser.preparingPath === props.row.path)
const isSelected = computed(() => browser.selectedPath === props.row.path)
const typeLabel = computed(() => fileBrowserFileTypeLabel(props.row.path))

const durationLabel = computed(() => {
  const ms = fileInfo.value?.durationMs
  return typeof ms === 'number' && ms > 0 ? formatTrackTime(ms) : ''
})

/** Only the audited row shows a running counter; every other row stays static. */
const positionLabel = computed(() => {
  const ms = browser.positionMs(props.row.path)
  return ms === null ? '' : formatTrackTime(ms)
})

const COVER_PREVIEW_PX = 180
const COVER_PREVIEW_GAP_PX = 8

// The tree scrolls with `overflow-auto`, which would clip a popup rendered
// inside the row, so the preview is teleported out and positioned against the
// thumbnail's viewport rect instead.
const coverPreview = ref<{ x: number; y: number } | null>(null)

function showCoverPreview(event: MouseEvent): void {
  if (!fileInfo.value?.coverArtUrl) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const room = window.innerWidth - rect.right - COVER_PREVIEW_GAP_PX
  const x =
    room >= COVER_PREVIEW_PX
      ? rect.right + COVER_PREVIEW_GAP_PX
      : rect.left - COVER_PREVIEW_PX - COVER_PREVIEW_GAP_PX
  const centred = rect.top + rect.height / 2 - COVER_PREVIEW_PX / 2
  const maxY = window.innerHeight - COVER_PREVIEW_PX - COVER_PREVIEW_GAP_PX
  coverPreview.value = {
    x: Math.max(COVER_PREVIEW_GAP_PX, x),
    y: Math.max(COVER_PREVIEW_GAP_PX, Math.min(centred, maxY))
  }
}

function hideCoverPreview(): void {
  coverPreview.value = null
}

// Dragging a row onto a track imports the file and places it in one gesture, so
// the path travels on the DataTransfer and is mirrored into the store for the
// dragover phase, which cannot read it.
function onDragStart(event: DragEvent): void {
  if (!event.dataTransfer) return
  hideCoverPreview()
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(MIME_FILE_BROWSER_PATH, props.row.path)
  // Plain text helps identify drags that escape the app.
  event.dataTransfer.setData('text/plain', props.row.name)
  browser.setDragPath(props.row.path)
}

function onDragEnd(): void {
  browser.setDragPath(null)
}

onMounted(() => {
  void browser.ensureInfo(props.row.path)
})

// A teleported preview would outlive a row removed while hovered, and a row
// removed mid-drag never fires `dragend`, which would strand the drag flag.
onBeforeUnmount(() => {
  hideCoverPreview()
  if (browser.draggingPath === props.row.path) browser.setDragPath(null)
})

// A folder refresh can reuse a row for a different file.
watch(
  () => props.row.path,
  (path) => {
    hideCoverPreview()
    void browser.ensureInfo(path)
  }
)

// A refresh drops the covers it re-crawled, so an already-mounted row asks for
// its artwork again — otherwise a cover changed on disk would stay stale until
// the row happened to be recycled.
watch(
  () => browser.coverEpoch,
  () => {
    hideCoverPreview()
    void browser.ensureInfo(props.row.path)
  }
)
</script>

<template>
  <div
    class="group flex h-8 cursor-pointer select-none items-center gap-2 rounded pr-2 text-xs text-zinc-300 hover:bg-zinc-800/60"
    :class="[
      isSelected && !props.row.pinned ? 'bg-sky-500/15' : isPlaying ? 'bg-zinc-800/60' : '',
      props.row.pinned ? 'rounded-none' : ''
    ]"
    :style="{ paddingLeft: fileBrowserRowIndentPx(props.row.depth) + 'px' }"
    :role="props.row.pinned ? undefined : 'treeitem'"
    :aria-level="props.row.pinned ? undefined : props.row.depth + 1"
    :aria-selected="props.row.pinned ? undefined : isSelected"
    :data-selected="props.row.pinned ? undefined : isSelected"
    draggable="true"
    title="Drag onto a track to add it. Double-click to preview."
    @click="browser.select(props.row.path)"
    @dblclick="browser.togglePlay(props.row.path)"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @contextmenu.prevent.stop="emit('contextMenu', { event: $event, path: props.row.path })"
  >
    <div
      class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-zinc-800"
      @mouseenter="showCoverPreview"
      @mouseleave="hideCoverPreview"
    >
      <img
        v-if="fileInfo?.coverArtUrl"
        :src="fileInfo.coverArtUrl"
        alt=""
        class="h-full w-full object-cover"
        draggable="false"
      >
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-3 w-3 text-zinc-400"
        aria-hidden="true"
      >
        <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
      </svg>
    </div>

    <span
      class="min-w-0 flex-1 truncate"
      :class="isPlaying ? 'text-sky-400' : isSelected ? 'text-sky-200' : 'text-zinc-200'"
      :title="props.row.path"
    >{{ title }}</span>
    <span
      v-if="props.row.pinned"
      class="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300"
    >Playing</span>
    <span class="w-40 shrink-0 truncate text-zinc-500">{{ fileInfo?.artist ?? '' }}</span>
    <span class="w-40 shrink-0 truncate text-zinc-500">{{ fileInfo?.album ?? '' }}</span>
    <span class="w-12 shrink-0 truncate text-zinc-500">{{ typeLabel }}</span>
    <span
      class="w-12 shrink-0 text-right font-mono tabular-nums"
      :class="positionLabel ? 'text-sky-400' : 'text-zinc-600'"
    >{{ positionLabel }}</span>
    <span
      class="w-12 shrink-0 text-right font-mono tabular-nums text-zinc-500"
    >{{ durationLabel }}</span>

    <!-- The row's own double-click plays the file; the buttons here have their own
         meaning, so a quick second click on one must not also start playback. -->
    <div
      class="flex shrink-0 items-center gap-1"
      @dblclick.stop
    >
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
        title="Back to start"
        aria-label="Back to start"
        @click.stop="browser.restart(props.row.path)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3 w-3"
          aria-hidden="true"
        >
          <path d="M6 6h2.5v12H6zm4 6l9 6V6z" />
        </svg>
      </button>
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-zinc-700 hover:text-zinc-100"
        :class="isPreparing ? 'text-sky-400' : 'text-zinc-400'"
        :title="isPreparing ? 'Preparing…' : isPlaying ? 'Pause' : 'Play'"
        :aria-label="isPreparing ? 'Preparing…' : isPlaying ? 'Pause' : 'Play'"
        @click.stop="browser.togglePlay(props.row.path)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3 w-3"
          aria-hidden="true"
        >
          <path
            v-if="isPlaying"
            d="M6 5h4v14H6zm8 0h4v14h-4z"
          />
          <path
            v-else
            d="M8 5v14l11-7z"
          />
        </svg>
      </button>
      <button
        type="button"
        class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
        title="Import into the library"
        @click.stop="browser.importFile(props.row.path)"
      >
        Import
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="coverPreview && fileInfo?.coverArtUrl"
        class="pointer-events-none fixed z-50 overflow-hidden rounded border border-zinc-700 bg-zinc-900 shadow-lg shadow-black/50"
        :style="{
          left: coverPreview.x + 'px',
          top: coverPreview.y + 'px',
          width: COVER_PREVIEW_PX + 'px',
          height: COVER_PREVIEW_PX + 'px'
        }"
      >
        <img
          :src="fileInfo.coverArtUrl"
          alt=""
          class="h-full w-full object-cover"
          draggable="false"
        >
      </div>
    </Teleport>
  </div>
</template>
