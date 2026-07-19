<script setup lang="ts">
import ClipContextMenu from '@/components/ClipContextMenu.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'
import ClipEditorDialog from '@/components/ClipEditorDialog.vue'
import TrackFxPanel from '@/components/TrackFxPanel.vue'
import ProjectFxPanel from '@/components/ProjectFxPanel.vue'
import LibraryPanelHeader from '@/components/LibraryPanelHeader.vue'
import LibraryPanelLibraryView from '@/components/LibraryPanelLibraryView.vue'
import { useLibraryPanelController, type LibraryPanelEmit, type LibraryPanelProps } from '@/lib/library/useLibraryPanelController'

const props = defineProps<LibraryPanelProps>()
const emit = defineEmits<LibraryPanelEmit>()

const {
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
  filterQuery,
  filteredItemCount,
  LIBRARY_CLIP_PILL_CLASS,
  LIBRARY_CLIP_BPM_PILL_CLASS,
  SAMPLE_PILL_CLASS,
  sourceItems,
  orphanLibraryClipItems,
  onImportClick,
  onItemDragStart,
  onItemDragEnd,
  formatDuration,
  formatClipDuration,
  displayTitle,
  displayArtist,
  filteredChildItems,
  groupCoverArtUrl,
  libraryClipEffectiveBpm,
  keyBadgeClass,
  tileIsSample,
  tileIsSampleAsset,
  tileUseCount,
  COLLAPSED_PANEL_HEIGHT,
  isResizing,
  onResizePointerDown
} = useLibraryPanelController(props, emit)
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
    <div
      v-if="!ui.libraryPanelCollapsed"
      class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      title="Drag to resize"
      @pointerdown="onResizePointerDown"
    />

    <LibraryPanelHeader
      v-model:active-tab="activeTab"
      v-model:filter-query="filterQuery"
      :collapsed="ui.libraryPanelCollapsed"
      :item-count="itemCount"
      @toggle-collapsed="ui.toggleLibraryPanelCollapsed()"
      @import="onImportClick"
    />

    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden"
      :inert="ui.libraryPanelCollapsed"
    >
      <LibraryPanelLibraryView
        v-if="activeTab === 'library'"
        v-model:editing-value="editingValue"
        :item-count="library.items.length"
        :filtered-item-count="filteredItemCount"
        :filter-query="filterQuery"
        :source-items="sourceItems"
        :orphan-library-clip-items="orphanLibraryClipItems"
        :is-drag-over="isDragOver"
        :show-tile-images="ui.showLibraryTileImages"
        :editing-item-id="editingItemId"
        :library-clip-pill-class="LIBRARY_CLIP_PILL_CLASS"
        :library-clip-bpm-pill-class="LIBRARY_CLIP_BPM_PILL_CLASS"
        :sample-pill-class="SAMPLE_PILL_CLASS"
        :format-duration="formatDuration"
        :format-clip-duration="formatClipDuration"
        :display-title="displayTitle"
        :display-artist="displayArtist"
        :child-items="filteredChildItems"
        :group-cover-art-url="groupCoverArtUrl"
        :library-clip-effective-bpm="libraryClipEffectiveBpm"
        :key-badge-class="keyBadgeClass"
        :tile-is-sample="tileIsSample"
        :tile-is-sample-asset="tileIsSampleAsset"
        :tile-use-count="tileUseCount"
        :set-name-input-el="setNameInputEl"
        @drag-start="onItemDragStart"
        @drag-end="onItemDragEnd"
        @open-editor="openItemEditor"
        @open-context-menu="openItemContextMenu"
        @start-rename="startRename"
        @toggle-collapsed="library.setItemCollapsed"
        @import="onImportClick"
      />

      <TrackFxPanel
        v-else-if="activeTab === 'trackfx'"
        class="min-h-0 flex-1"
      />

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
