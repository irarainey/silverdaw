<script setup lang="ts">
import { computed, type ComponentPublicInstance } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'

const props = defineProps<{
  item: LibraryItem
  editingItemId: string | null
  rowClass: string
  markerClass: string
  missingSource?: boolean
  savedClipBpm?: number
  savedClipPillClass: string
  savedClipBpmPillClass: string
  formatClipDuration: (ms: number) => string
  displayTitle: (item: LibraryItem) => string
  keyBadgeClass: (key: string) => string
  tileUseCount: (item: LibraryItem) => number
  setNameInputEl: (el: Element | ComponentPublicInstance | null) => void
}>()

const emit = defineEmits<{
  (e: 'dragStart', event: DragEvent, item: LibraryItem): void
  (e: 'dragEnd'): void
  (e: 'openEditor', item: LibraryItem): void
  (e: 'openContextMenu', event: MouseEvent, item: LibraryItem): void
  (e: 'startRename', item: LibraryItem): void
}>()

const editingValue = defineModel<string>('editingValue', { required: true })
const useCount = computed(() => props.tileUseCount(props.item))
const isInUse = computed(() => useCount.value > 0)
// Same chrome as the BPM badge (shared base class), recoloured by in-use state.
const inUsePillClass = computed(
  () =>
    `${props.savedClipPillClass} ${isInUse.value ? 'border-emerald-700 bg-emerald-900/60 text-emerald-200' : 'border-zinc-700 bg-zinc-800 text-zinc-400'}`
)
</script>

<template>
  <div
    draggable="true"
    :class="props.rowClass"
    @dragstart="(e) => emit('dragStart', e, props.item)"
    @dragend="emit('dragEnd')"
    @dblclick="emit('openEditor', props.item)"
    @contextmenu.prevent="(e) => emit('openContextMenu', e, props.item)"
  >
    <span
      :class="props.markerClass"
      aria-hidden="true"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <input
        v-if="props.editingItemId === props.item.id"
        :ref="props.setNameInputEl"
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
        @dblclick.stop="emit('startRename', props.item)"
      >
        {{ props.displayTitle(props.item) }}
      </div>
      <div
        v-if="props.missingSource"
        class="min-w-0 truncate text-[10px] text-amber-300/80"
      >
        Source file missing
      </div>
      <div
        v-else
        class="min-w-0 truncate font-mono text-[10px] tabular-nums text-zinc-500"
      >
        {{ props.formatClipDuration(props.item.durationMs) }}
      </div>
    </div>
    <span
      v-if="props.missingSource"
      class="ml-auto flex shrink-0 items-center gap-1.5"
    >
      <span class="font-mono text-[10px] tabular-nums text-zinc-400">
        {{ props.formatClipDuration(props.item.durationMs) }}
      </span>
      <span
        :class="inUsePillClass"
        :title="isInUse ? `Used on ${useCount} ${useCount === 1 ? 'track clip' : 'track clips'}` : 'Not used on a track'"
      >{{ useCount }}</span>
    </span>
    <div
      v-else
      class="ml-auto flex shrink-0 items-center gap-1"
    >
      <span
        v-if="props.item.key && ((props.item.semitones ?? 0) !== 0 || (props.item.cents ?? 0) !== 0)"
        :class="props.keyBadgeClass(props.item.key)"
        title="Clip pitch key"
      >
        {{ props.item.key }}
      </span>
      <span
        v-if="props.savedClipBpm"
        :class="props.savedClipBpmPillClass"
        title="Warped clip tempo"
      >
        {{ props.savedClipBpm.toFixed(2) }} BPM
      </span>
      <span
        :class="inUsePillClass"
        :title="isInUse ? `Used on ${useCount} ${useCount === 1 ? 'track clip' : 'track clips'}` : 'Not used on a track'"
      >{{ useCount }}</span>
    </div>
  </div>
</template>
