<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { useScratchNotationEditor } from '@/lib/scratch/useScratchNotationEditor'
import { useScratchNotationLayout, ZOOM_STEP_PERCENT } from '@/lib/scratch/useScratchNotationLayout'
import { handleNotationKeydown } from '@/lib/scratch/scratchNotationKeyboard'
import ScratchNotationLanes from '@/components/ScratchNotationLanes.vue'
import ScratchNotationInfoBar from '@/components/ScratchNotationInfoBar.vue'

const props = defineProps<{
  sessionId: string | null
  /** Live replay position (0..1 across the cropped window), or null when idle. */
  replayPositionNormalized?: number | null
}>()

const sessionIdRef = computed(() => props.sessionId)
const editor = useScratchNotationEditor(sessionIdRef)

const containerEl = ref<HTMLDivElement | null>(null)
const viewportEl = ref<HTMLDivElement | null>(null)
const pattern = computed<ScratchPattern | null>(() => editor.pattern.value)
const durationUs = computed(() => pattern.value?.durationUs ?? 0)
const layout = useScratchNotationLayout({ containerEl, viewportEl, durationUs })

watch(
  () => props.replayPositionNormalized,
  (position) => {
    if (position === null || position === undefined || !pattern.value) return
    const { cropStartUs, cropEndUs } = pattern.value
    layout.followPlayback(cropStartUs + position * (cropEndUs - cropStartUs))
  }
)

// Keyboard handler (extracted module) — events stop propagation when consumed
function onKeydown(event: KeyboardEvent): void {
  handleNotationKeydown(event, { editor, durationUs: durationUs.value })
}
</script>

<template>
  <div
    ref="containerEl"
    class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-950 p-2 outline-none focus:border-zinc-800 focus:outline-none focus-visible:border-zinc-800 focus-visible:outline-none"
    tabindex="0"
    role="application"
    :aria-label="pattern ? 'Scratch notation editor' : 'No pattern to edit'"
    @keydown="onKeydown"
  >
    <template v-if="pattern">
      <!-- Lane viewport + overlaid controls -->
      <div class="relative flex min-h-0 w-full flex-1 flex-col">
        <!-- SVG notation lanes -->
        <div
          ref="viewportEl"
          class="no-native-scrollbar min-h-0 w-full flex-1 overflow-x-auto overflow-y-hidden"
          @wheel.ctrl.prevent="layout.onZoomWheel"
          @scroll="layout.onViewportScroll"
        >
          <ScratchNotationLanes
            :pattern="pattern"
            :replay-position-normalized="replayPositionNormalized ?? null"
            :editor="editor"
            :svg-width="layout.svgWidth.value"
            :svg-height="layout.svgHeight.value"
            :platter-lane-height="layout.platterLaneHeight.value"
            :cf-lane-height="layout.cfLaneHeight.value"
            :cf-lane-top="layout.cfLaneTop.value"
            :lane-area="layout.laneArea.value"
            :scroll-left-px="layout.scrollLeftPx.value"
            @resize-lanes="(ratio) => (layout.cfLaneRatio.value = ratio)"
          />
        </div>

        <!-- Custom horizontal scrollbar (matches the waveform window). Only shown
           when the notation is zoomed wider than the viewport. -->
        <div
          v-show="layout.canScrollHorizontally.value"
          class="relative mt-0.5 h-2 shrink-0 cursor-pointer rounded bg-zinc-900/80"
          :title="`Scroll (zoom ${layout.zoomPercent.value}%)`"
          @mousedown="layout.onScrollbarMouseDown"
        >
          <div
            class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
            :style="{
              left: `${layout.scrollThumbLeftPct.value}%`,
              width: `${layout.scrollThumbWidthPct.value}%`
            }"
          />
        </div>
      </div>

      <!-- Info bar (with zoom controls grouped at the right, matching the
           scratch waveform window). -->
      <ScratchNotationInfoBar
        :duration-us="pattern.durationUs"
        :platter-count="pattern.platter.length"
        :crossfader-count="pattern.crossfader.length"
        :selection="editor.selection.value"
        :zoom-percent="layout.zoomPercent.value"
        @zoom-out="layout.setZoom(layout.zoomPercent.value - ZOOM_STEP_PERCENT)"
        @zoom-reset="layout.setZoom(100)"
        @zoom-in="layout.setZoom(layout.zoomPercent.value + ZOOM_STEP_PERCENT)"
      />
    </template>

    <!-- Empty state -->
    <template v-else>
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-zinc-500">
          No pattern to edit
        </p>
      </div>
    </template>
  </div>
</template>
