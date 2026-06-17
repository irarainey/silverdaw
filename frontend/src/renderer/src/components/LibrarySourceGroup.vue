<script setup lang="ts">
import { computed, type ComponentPublicInstance } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import LibrarySavedClipRow from '@/components/LibrarySavedClipRow.vue'
import LibraryTypeBadge from '@/components/LibraryTypeBadge.vue'
import { LIBRARY_BPM_VARIABLE_PILL_CLASS } from '@/lib/library/libraryPillClasses'

const props = defineProps<{
  source: LibraryItem
  children: readonly LibraryItem[]
  coverArtUrl?: string
  showTileImages: boolean
  editingItemId: string | null
  savedClipPillClass: string
  savedClipBpmPillClass: string
  samplePillClass: string
  formatDuration: (ms: number) => string
  formatClipDuration: (ms: number) => string
  displayTitle: (item: LibraryItem) => string
  displayArtist: (item: LibraryItem) => string
  savedClipEffectiveBpm: (item: LibraryItem) => number | undefined
  keyBadgeClass: (key: string) => string
  tileIsSample: (item: LibraryItem) => boolean
  tileIsSampleAsset: (item: LibraryItem) => boolean
  tileUseCount: (item: LibraryItem) => number
  setNameInputEl: (el: Element | ComponentPublicInstance | null) => void
}>()

const emit = defineEmits<{
  (e: 'dragStart', event: DragEvent, item: LibraryItem): void
  (e: 'dragEnd'): void
  (e: 'openEditor', item: LibraryItem): void
  (e: 'openContextMenu', event: MouseEvent, item: LibraryItem): void
  (e: 'startRename', item: LibraryItem): void
  (e: 'toggleCollapsed', itemId: string, collapsed: boolean): void
}>()

const editingValue = defineModel<string>('editingValue', { required: true })

const useCount = computed(() => props.tileUseCount(props.source))
const isInUse = computed(() => useCount.value > 0)
// Same chrome as the BPM badge (shared base class), recoloured by in-use state.
const inUsePillClass = computed(
  () =>
    `${props.savedClipPillClass} ${isInUse.value ? 'border-emerald-700 bg-emerald-900/60 text-emerald-200' : 'border-zinc-700 bg-zinc-800 text-zinc-400'}`
)
const tileCoverArtUrl = computed(() => props.coverArtUrl ?? props.source.coverArtUrl)
// Drives the sample tint, fallback waveform icon, and cover-art badge: a saved sample
// asset (music OR simple) gets the sample treatment. The narrower `tileIsSample`
// (non-musical) still drives the "Sample"-vs-BPM/key metadata pill below, so a music
// sample shows its pitch + BPM while still reading as a sample at a glance.
const isSampleTile = computed(() => props.tileIsSampleAsset(props.source))
const isStemTile = computed(() => props.source.kind === 'stem')
const savedClipChildren = computed(() => props.children.filter((item) => item.kind === 'saved-clip'))

/** Compact summary for the collapse header, e.g. "3 saved clips". */
const childSummary = computed(() => {
  const clipCount = savedClipChildren.value.length
  if (clipCount === 0) return ''
  return `${clipCount} saved ${clipCount === 1 ? 'clip' : 'clips'}`
})
</script>

<template>
  <div
    class="library-group flex w-60 max-w-full shrink-0 flex-col overflow-hidden rounded-md border"
    :class="props.children.length > 0 ? 'border-zinc-800 bg-zinc-950/50' : 'border-zinc-800 bg-zinc-950/30'"
  >
    <div
      draggable="true"
      class="library-item group relative flex cursor-grab select-none items-stretch overflow-hidden bg-zinc-950/60 text-left transition-colors hover:bg-zinc-900 active:cursor-grabbing"
      @dragstart="(e) => emit('dragStart', e, props.source)"
      @dragend="emit('dragEnd')"
      @dblclick="emit('openEditor', props.source)"
      @contextmenu.prevent="(e) => emit('openContextMenu', e, props.source)"
    >
      <div
        v-if="props.showTileImages"
        class="relative flex aspect-square w-18.75 shrink-0 items-center justify-center border-r border-zinc-800"
        :class="isSampleTile ? 'bg-indigo-900/40' : 'bg-zinc-900'"
      >
        <img
          v-if="tileCoverArtUrl"
          :src="tileCoverArtUrl"
          alt=""
          class="h-full w-full object-cover"
          draggable="false"
        >
        <svg
          v-else-if="isSampleTile"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6 text-indigo-400"
          aria-hidden="true"
        >
          <path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z" />
        </svg>
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
        <LibraryTypeBadge
          v-if="isStemTile"
          kind="stem"
        />
        <LibraryTypeBadge
          v-else-if="isSampleTile"
          kind="sample"
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col px-2 py-1.5">
        <input
          v-if="props.editingItemId === props.source.id"
          :ref="props.setNameInputEl"
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
          @dblclick.stop="emit('startRename', props.source)"
        >
          {{ props.displayTitle(props.source) }}
        </div>
        <div
          v-if="props.displayArtist(props.source)"
          class="-mt-px min-w-0 truncate text-[11px] text-zinc-400"
        >
          {{ props.displayArtist(props.source) }}
        </div>
        <div class="-mt-px min-w-0 truncate font-mono text-[10px] tabular-nums text-zinc-500">
          {{ props.formatDuration(props.source.durationMs) }}
        </div>
        <div class="mt-auto flex items-center text-[10px] text-zinc-500">
          <span class="ml-auto flex items-center gap-1">
            <span
              v-if="props.tileIsSample(props.source)"
              :class="props.samplePillClass"
              title="Treated as a non-musical sample — beat / key analysis is hidden and auto-warp on drop is skipped. Toggle from the right-click menu."
            >
              Sample
            </span>
            <template v-else>
              <span
                v-if="props.source.key"
                :class="props.keyBadgeClass(props.source.key)"
                title="Detected key"
              >
                {{ props.source.key }}
              </span>
              <span
                v-if="props.source.bpm"
                :class="props.source.variableTempo ? LIBRARY_BPM_VARIABLE_PILL_CLASS : props.savedClipBpmPillClass"
                :title="props.source.variableTempo ? 'Tempo varies across the file - the BPM shown is a rough average' : 'Detected tempo'"
              >
                <span
                  v-if="props.source.variableTempo"
                  class="mr-0.5"
                >~</span>{{ props.source.bpm.toFixed(2) }} BPM
              </span>
            </template>
            <span
              :class="inUsePillClass"
              :title="isInUse ? `Used on ${useCount} ${useCount === 1 ? 'track clip' : 'track clips'}` : 'Not used on a track'"
            >{{ useCount }}</span>
          </span>
        </div>
      </div>
    </div>

    <div
      v-if="props.children.length > 0"
      class="flex flex-col bg-zinc-900/60"
    >
      <button
        type="button"
        data-borderless-button="true"
        class="flex w-full items-center gap-1.5 border-t border-zinc-800/80 px-2 py-1 text-left text-[10px] uppercase tracking-wide text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-300"
        :title="props.source.collapsed ? 'Show stems and saved clips' : 'Hide stems and saved clips'"
        @click="emit('toggleCollapsed', props.source.id, !props.source.collapsed)"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3 w-3 transition-transform"
          :class="props.source.collapsed ? '-rotate-90' : ''"
          aria-hidden="true"
        >
          <path d="M7 10l5 5 5-5H7z" />
        </svg>
        <span>{{ childSummary }}</span>
      </button>
      <template v-if="!props.source.collapsed">
        <LibrarySavedClipRow
          v-for="item in savedClipChildren"
          :key="item.id"
          v-model:editing-value="editingValue"
          :item="item"
          :editing-item-id="props.editingItemId"
          row-class="saved-clip group relative flex h-10 cursor-grab select-none items-center gap-2 border-t border-zinc-800/60 px-2 pr-1 text-left transition-colors hover:bg-zinc-800/70 active:cursor-grabbing"
          marker-class="h-6 w-1 shrink-0 rounded-sm bg-cyan-500/60"
          :saved-clip-bpm="props.savedClipEffectiveBpm(item)"
          :saved-clip-pill-class="props.savedClipPillClass"
          :saved-clip-bpm-pill-class="props.savedClipBpmPillClass"
          :format-clip-duration="props.formatClipDuration"
          :display-title="props.displayTitle"
          :key-badge-class="props.keyBadgeClass"
          :tile-use-count="props.tileUseCount"
          :set-name-input-el="props.setNameInputEl"
          @drag-start="(e, draggedItem) => emit('dragStart', e, draggedItem)"
          @drag-end="emit('dragEnd')"
          @open-editor="(editedItem) => emit('openEditor', editedItem)"
          @open-context-menu="(e, menuItem) => emit('openContextMenu', e, menuItem)"
          @start-rename="(renamedItem) => emit('startRename', renamedItem)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.library-item {
  /* Suppress drag text-cursor and add subtle card depth. */
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
}
</style>
