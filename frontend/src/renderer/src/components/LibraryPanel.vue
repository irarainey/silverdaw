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
        :source-items="sourceItems"
        :orphan-saved-clip-items="orphanSavedClipItems"
        :is-drag-over="isDragOver"
        :show-tile-images="ui.showLibraryTileImages"
        :editing-item-id="editingItemId"
        :saved-clip-pill-class="SAVED_CLIP_PILL_CLASS"
        :saved-clip-bpm-pill-class="SAVED_CLIP_BPM_PILL_CLASS"
        :sample-pill-class="SAMPLE_PILL_CLASS"
        :format-duration="formatDuration"
        :format-clip-duration="formatClipDuration"
        :display-title="displayTitle"
        :display-artist="displayArtist"
        :child-items="childItems"
        :group-cover-art-url="groupCoverArtUrl"
        :saved-clip-effective-bpm="savedClipEffectiveBpm"
        :key-badge-class="keyBadgeClass"
        :tile-is-sample="tileIsSample"
        :set-name-input-el="setNameInputEl"
        @drag-start="onItemDragStart"
        @drag-end="onItemDragEnd"
        @open-editor="openItemEditor"
        @open-context-menu="openItemContextMenu"
        @start-rename="startRename"
        @toggle-collapsed="library.setItemCollapsed"
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
