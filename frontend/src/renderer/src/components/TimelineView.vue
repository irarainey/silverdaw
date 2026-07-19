<script setup lang="ts">
import { ref } from 'vue'
import TrackHeaderPanel from '@/components/TrackHeaderPanel.vue'
import ClipContextMenu from '@/components/ClipContextMenu.vue'
import ClipWarpDialog from '@/components/ClipWarpDialog.vue'
import ClipEditorDialog from '@/components/ClipEditorDialog.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'
import SampleTypeDialog from '@/components/SampleTypeDialog.vue'
import { useTimelineViewController } from '@/lib/timeline/useTimelineViewController'
import { useUiStore } from '@/stores/uiStore'

const ui = useUiStore()

const host = ref<HTMLDivElement | null>(null)
const scrollbarTrack = ref<HTMLDivElement | null>(null)
const vScrollbarTrack = ref<HTMLDivElement | null>(null)

const {
  project,
  hoverCursor,
  isFileDragOver,
  scrollY,
  onWheel,
  renameOverlayStyle,
  renameInputRef,
  renameValue,
  headerWidth,
  onHeaderResizePointerDown,
  onHeaderResizePointerMove,
  onHeaderResizePointerUp,
  maxScrollY,
  SCROLLBAR_WIDTH,
  vThumbTopPx,
  vThumbHeightPx,
  onVTrackPointerDown,
  onVThumbPointerDown,
  onVThumbPointerMove,
  onVThumbPointerUp,
  showScrollbar,
  SCROLLBAR_HEIGHT,
  onTrackPointerDown,
  thumbLeftPx,
  thumbWidthPx,
  onThumbPointerDown,
  onThumbPointerMove,
  onThumbPointerUp,
  contextMenuOpen,
  contextMenuX,
  contextMenuY,
  contextMenuItems,
  onContextMenuClose,
  onContextMenuCommand,
  warpDialogOpen,
  warpDialogClipId,
  warpDialogPanel,
  sampleTypeOpen,
  sampleTypeClipId,
  dialogs,
  infoClipId,
  infoItem,
  editorClipId,
  editorItem
} = useTimelineViewController(host, scrollbarTrack, vScrollbarTrack)
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <div
      ref="host"
      class="absolute inset-0"
      :style="{ cursor: hoverCursor }"
    />
    <div
      v-if="isFileDragOver"
      class="pointer-events-none absolute inset-1 z-10 flex items-center justify-center border-2 border-dashed border-sky-500 bg-sky-500/10 text-sm font-medium text-sky-200"
    >
      Drop audio to import and add to the timeline
    </div>

    <!-- HTML overlay for track headers (name + M/S/X buttons). The header rows
             are pointer-events-auto and would otherwise swallow wheel events, so
             forward them to the timeline's wheel handler to keep vertical
             scroll / zoom working when the pointer is over a header. -->
    <TrackHeaderPanel
      :scroll-y="scrollY"
      :on-wheel="onWheel"
    />

    <!-- Inline rename input for a clip's title strip. Floats over the
             drawn header pixels and updates its position reactively as the
             user scrolls or zooms during the edit. -->
    <input
      v-if="renameOverlayStyle"
      ref="renameInputRef"
      v-model="renameValue"
      type="text"
      spellcheck="false"
      data-borderless-button="true"
      class="z-30 rounded-sm border border-sky-500 bg-zinc-950 px-1 text-[10px] font-medium text-zinc-100 outline-none"
      :style="renameOverlayStyle"
      @pointerdown.stop
      @dblclick.stop
      @click.stop
    >

    <!-- Vertical divider drag handle. Sits on top of the column boundary
             between the track-header panel and the timeline canvas. The
             visible line is 1px (drawn by Pixi); this hit area is 6px wide
             and straddles the seam so it's easy to grab. -->
    <div
      class="absolute inset-y-0 z-20 w-1.5 cursor-col-resize"
      :style="{ left: (headerWidth() - 3) + 'px' }"
      title="Drag to resize track header column"
      @pointerdown="onHeaderResizePointerDown"
      @pointermove="onHeaderResizePointerMove"
      @pointerup="onHeaderResizePointerUp"
      @pointercancel="onHeaderResizePointerUp"
    />

    <!-- Vertical scrollbar lane. Spans the full canvas height (over the
             ruler row at the top and over the corner above the horizontal
             scrollbar at the bottom) so the thumb travels the entire canvas.
             The thumb only becomes interactive when there's overflow
             (`maxScrollY > 0`). -->
    <div
      ref="vScrollbarTrack"
      class="absolute inset-y-0 right-0 bg-zinc-900/80"
      :class="maxScrollY > 0 ? 'cursor-pointer' : ''"
      :style="{
        width: SCROLLBAR_WIDTH + 'px'
      }"
      @pointerdown="onVTrackPointerDown"
    >
      <div
        v-if="maxScrollY > 0"
        class="absolute left-1 w-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ top: vThumbTopPx + 'px', height: vThumbHeightPx + 'px' }"
        @pointerdown="onVThumbPointerDown"
        @pointermove="onVThumbPointerMove"
        @pointerup="onVThumbPointerUp"
        @pointercancel="onVThumbPointerUp"
      />
    </div>

    <!-- Horizontal scrollbar. Sits above the transport bar (which lives
             outside this component) and to the right of the track header
             column. Only rendered when content overflows the viewport. -->
    <div
      v-if="showScrollbar"
      ref="scrollbarTrack"
      class="absolute bottom-0 cursor-pointer bg-zinc-900/80"
      :style="{
        left: headerWidth() + 'px',
        right: SCROLLBAR_WIDTH + 'px',
        height: SCROLLBAR_HEIGHT + 'px'
      }"
      @pointerdown="onTrackPointerDown"
    >
      <div
        class="absolute top-1 h-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ left: thumbLeftPx + 'px', width: thumbWidthPx + 'px' }"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
        @pointerup="onThumbPointerUp"
        @pointercancel="onThumbPointerUp"
      />
    </div>

    <!-- Empty state hint. -->
    <div
      v-if="project.tracks.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600"
    >
      Add a track or open a project to start
    </div>

    <!-- Right-click context menu for clip blocks. Teleported to body
         so its z-index / positioning are independent of the timeline's
         transformed children. -->
    <ClipContextMenu
      :open="contextMenuOpen"
      :x="contextMenuX"
      :y="contextMenuY"
      :items="contextMenuItems"
      @close="onContextMenuClose"
      @command="onContextMenuCommand"
    />

    <!-- Per-clip warp settings. Surfaced from the right-click context
         menu; every control commits live through projectStore so close
         is just a dismiss, never a confirm/cancel. -->
    <ClipWarpDialog
      :open="warpDialogOpen"
      :clip-id="warpDialogClipId"
      :panel="warpDialogPanel"
      @close="dialogs.closeWarp()"
    />
    <LibraryItemInfoDialog
      :open="infoClipId !== null && infoItem !== null"
      :item="infoItem"
      :clip-id="infoClipId"
      @close="dialogs.closeInfo()"
    />
    <ClipEditorDialog
      :open="editorClipId !== null && editorItem !== null"
      :item="editorItem"
      :clip-id="editorClipId"
      @close="dialogs.closeEditor()"
    />
    <SampleTypeDialog
      :open="sampleTypeOpen"
      :clip-id="sampleTypeClipId"
      @close="dialogs.closeSampleType()"
    />

    <!-- Hover readout for an automation breakpoint (offset off the cursor). -->
    <div
      v-if="ui.automationHoverTip"
      class="pointer-events-none fixed z-50 rounded bg-zinc-900/95 px-1.5 py-0.5 text-[10px] font-mono text-sky-200 ring-1 ring-sky-700"
      :style="{ left: ui.automationHoverTip.x + 12 + 'px', top: ui.automationHoverTip.y - 22 + 'px' }"
    >
      {{ ui.automationHoverTip.text }}
    </div>
  </div>
</template>
