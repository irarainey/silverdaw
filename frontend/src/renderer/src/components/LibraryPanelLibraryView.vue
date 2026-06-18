<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { LibraryItem } from '@/stores/libraryStore'
import LibrarySourceGroup from '@/components/LibrarySourceGroup.vue'
import LibraryClipRow from '@/components/LibraryClipRow.vue'

const props = defineProps<{
  itemCount: number
  sourceItems: readonly LibraryItem[]
  orphanLibraryClipItems: readonly LibraryItem[]
  isDragOver: boolean
  showTileImages: boolean
  editingItemId: string | null
  libraryClipPillClass: string
  libraryClipBpmPillClass: string
  samplePillClass: string
  formatDuration: (ms: number) => string
  formatClipDuration: (ms: number) => string
  displayTitle: (item: LibraryItem) => string
  displayArtist: (item: LibraryItem) => string
  childItems: (source: LibraryItem) => LibraryItem[]
  groupCoverArtUrl: (item: LibraryItem) => string | undefined
  libraryClipEffectiveBpm: (item: LibraryItem) => number | undefined
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
</script>

<template>
  <div class="library-panel-body silverdaw-scroll relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
    <div
      v-if="props.itemCount === 0"
      class="flex h-full w-full items-center justify-center text-xs text-zinc-500"
    >
      Drop audio files here, or click <span class="mx-1 font-medium text-zinc-300">Import</span> to add them.
    </div>
    <div
      v-else
      class="flex w-full min-w-0 flex-wrap items-start content-start gap-3"
    >
      <LibrarySourceGroup
        v-for="source in props.sourceItems"
        :key="source.id"
        v-model:editing-value="editingValue"
        :source="source"
        :children="props.childItems(source)"
        :cover-art-url="props.groupCoverArtUrl(source)"
        :show-tile-images="props.showTileImages"
        :editing-item-id="props.editingItemId"
        :library-clip-pill-class="props.libraryClipPillClass"
        :library-clip-bpm-pill-class="props.libraryClipBpmPillClass"
        :sample-pill-class="props.samplePillClass"
        :format-duration="props.formatDuration"
        :format-clip-duration="props.formatClipDuration"
        :display-title="props.displayTitle"
        :display-artist="props.displayArtist"
        :library-clip-effective-bpm="props.libraryClipEffectiveBpm"
        :key-badge-class="props.keyBadgeClass"
        :tile-is-sample="props.tileIsSample"
        :tile-is-sample-asset="props.tileIsSampleAsset"
        :tile-use-count="props.tileUseCount"
        :set-name-input-el="props.setNameInputEl"
        @drag-start="(e, item) => emit('dragStart', e, item)"
        @drag-end="emit('dragEnd')"
        @open-editor="(item) => emit('openEditor', item)"
        @open-context-menu="(e, item) => emit('openContextMenu', e, item)"
        @start-rename="(item) => emit('startRename', item)"
        @toggle-collapsed="(itemId, collapsed) => emit('toggleCollapsed', itemId, collapsed)"
      />

      <div
        v-if="props.orphanLibraryClipItems.length > 0"
        class="library-group flex w-60 max-w-full shrink-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/50"
      >
        <div class="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Saved clips (source missing)
        </div>
        <LibraryClipRow
          v-for="item in props.orphanLibraryClipItems"
          :key="item.id"
          v-model:editing-value="editingValue"
          :item="item"
          :editing-item-id="props.editingItemId"
          row-class="library-clip group flex h-10 cursor-grab select-none items-center gap-2 border-t border-zinc-800/60 px-2 text-left transition-colors hover:bg-zinc-800/70 active:cursor-grabbing"
          marker-class="h-6 w-1 shrink-0 rounded-sm bg-amber-500/60"
          missing-source
          :library-clip-pill-class="props.libraryClipPillClass"
          :library-clip-bpm-pill-class="props.libraryClipBpmPillClass"
          :format-clip-duration="props.formatClipDuration"
          :display-title="props.displayTitle"
          :key-badge-class="props.keyBadgeClass"
          :tile-use-count="props.tileUseCount"
          :set-name-input-el="props.setNameInputEl"
          @drag-start="(e, item) => emit('dragStart', e, item)"
          @drag-end="emit('dragEnd')"
          @open-editor="(item) => emit('openEditor', item)"
          @open-context-menu="(e, item) => emit('openContextMenu', e, item)"
          @start-rename="(item) => emit('startRename', item)"
        />
      </div>
    </div>

    <div
      v-if="props.isDragOver"
      class="pointer-events-none absolute inset-1 flex items-center justify-center rounded border-2 border-dashed border-blue-500 bg-blue-500/10 text-sm font-medium text-blue-200"
    >
      Drop audio files to add them to the library
    </div>
  </div>
</template>
