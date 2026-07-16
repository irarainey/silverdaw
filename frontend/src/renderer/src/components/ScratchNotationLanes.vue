<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import type { ScratchNotationEditor } from '@/lib/scratch/useScratchNotationEditor'
import {
  DEFAULT_NOTATION_LAYOUT,
  timeToX,
  turnsToY,
  cfValueToY
} from '@/lib/scratch/scratchNotationCoordinates'
import { createNotationPointerInteraction } from '@/lib/scratch/scratchNotationPointer'
import ScratchPlatterLane from '@/components/ScratchPlatterLane.vue'
import ScratchCrossfaderLane from '@/components/ScratchCrossfaderLane.vue'

const props = defineProps<{
  pattern: ScratchPattern
  /** Live replay position (0..1 across the cropped window), or null when idle. */
  replayPositionNormalized: number | null
  editor: ScratchNotationEditor
  svgWidth: number
  svgHeight: number
  platterLaneHeight: number
  cfLaneHeight: number
  cfLaneTop: number
  laneArea: number
  scrollLeftPx: number
}>()

const emit = defineEmits<{
  (event: 'resize-lanes', ratio: number): void
}>()

const { paddingX: PADDING_X, turnsMargin: TURNS_MARGIN } = DEFAULT_NOTATION_LAYOUT
const LANE_LABEL_X = 10
const MIN_LANE_HEIGHT = 48 // keep both lanes usable while dragging the divider

const svgEl = ref<SVGSVGElement | null>(null)

const durationUs = computed(() => props.pattern.durationUs)
const contentWidth = computed(() => Math.max(1, props.svgWidth - PADDING_X * 2))
const timeMarkers = computed(() => {
  const durationSeconds = durationUs.value / 1_000_000
  if (durationSeconds <= 0) return []

  const pixelsPerSecond = contentWidth.value / durationSeconds
  const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]
  const intervalSeconds = intervals.find((interval) => interval * pixelsPerSecond >= 80) ?? 60
  const markerCount = Math.floor(durationSeconds / intervalSeconds)
  return Array.from({ length: markerCount + 1 }, (_, index) => {
    const seconds = index * intervalSeconds
    return {
      timeUs: Math.round(seconds * 1_000_000),
      label: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
    }
  })
})

// Platter turns span used by both the pointer interaction (drag math) and the
// platter lane's own vertical scale.
const platterMinTurns = computed(() => {
  const platter = props.pattern.platter
  return platter.length === 0 ? 0 : Math.min(...platter.map((k) => k.turns))
})
const platterMaxTurns = computed(() => {
  const platter = props.pattern.platter
  return platter.length === 0 ? 1 : Math.max(...platter.map((k) => k.turns))
})

function toX(timeUsVal: number): number {
  return timeToX(timeUsVal, durationUs.value, contentWidth.value, PADDING_X)
}
function toPlatterY(turns: number): number {
  return turnsToY(turns, platterMinTurns.value, platterMaxTurns.value, props.platterLaneHeight, TURNS_MARGIN)
}
function toCfY(value: number): number {
  return cfValueToY(value, props.cfLaneTop, props.cfLaneHeight)
}

// Replay playhead: the normalized position runs 0..1 across the cropped window,
// so map it back onto absolute pattern time before converting to an x coordinate.
const replayPlayheadX = computed<number | null>(() => {
  const n = props.replayPositionNormalized
  if (n == null) return null
  return toX(props.pattern.cropStartUs + n * (props.pattern.cropEndUs - props.pattern.cropStartUs))
})

const pointerInteraction = createNotationPointerInteraction(
  {
    svgEl,
    viewBoxWidth: computed(() => props.svgWidth),
    viewBoxHeight: computed(() => props.svgHeight),
    durationUs,
    contentWidth,
    paddingX: PADDING_X,
    platterLaneHeight: computed(() => props.platterLaneHeight),
    platterMinTurns,
    platterMaxTurns,
    turnsMargin: TURNS_MARGIN,
    cfLaneTop: computed(() => props.cfLaneTop),
    cfLaneHeight: computed(() => props.cfLaneHeight)
  },
  {
    onBeginEdit: () => props.editor.beginEditGroup(),
    onEndEdit: () => props.editor.endEditGroup(),
    onSelect: (lane, index) => props.editor.selectKeyframe(lane, index),
    onMovePlatter: (index, t, turns) => props.editor.movePlatter(index, t, turns),
    onMoveCrossfader: (index, t, value) => props.editor.moveCrossfader(index, t, value),
    onAddPlatter: (t) => props.editor.addPlatter(t),
    onAddCrossfader: (t) => props.editor.addCrossfaderPoint(t),
    onDelete: (lane, index) => {
      props.editor.selectKeyframe(lane, index)
      props.editor.deleteSelected()
    }
  }
)

// Divider drag: resize the platter/crossfader lanes by dragging the separator.
// The pointer's Y (converted from screen pixels into SVG user units) sets the
// new platter height; the remainder becomes the crossfader lane. Both lanes are
// clamped to MIN_LANE_HEIGHT so neither collapses.
const draggingDivider = ref(false)

function onDividerPointerDown(event: PointerEvent): void {
  event.preventDefault()
  draggingDivider.value = true
  ;(event.target as Element).setPointerCapture(event.pointerId)
}

function onDividerPointerMove(event: PointerEvent): void {
  if (!draggingDivider.value || !svgEl.value) return
  const rect = svgEl.value.getBoundingClientRect()
  const scaleY = rect.height > 0 ? props.svgHeight / rect.height : 1
  const yUnits = (event.clientY - rect.top) * scaleY
  // The separator is drawn 6px below the platter lane (mid-gap), so subtract it
  // to keep the divider under the cursor.
  const newPlatter = Math.min(
    props.laneArea - MIN_LANE_HEIGHT,
    Math.max(MIN_LANE_HEIGHT, yUnits - 6)
  )
  emit('resize-lanes', (props.laneArea - newPlatter) / props.laneArea)
}

function onDividerPointerUp(event: PointerEvent): void {
  draggingDivider.value = false
  ;(event.target as Element).releasePointerCapture?.(event.pointerId)
}
</script>

<template>
  <svg
    ref="svgEl"
    class="block max-w-none select-none outline-none focus:outline-none focus-visible:outline-none"
    :style="{ width: `${svgWidth}px` }"
    :height="svgHeight"
    :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
    preserveAspectRatio="none"
    tabindex="-1"
    aria-label="Pattern lanes. Use arrow keys to move selected point, Insert to add, Delete to remove, T to toggle touch."
    @pointermove="pointerInteraction.handlePointerMove"
    @pointerup="pointerInteraction.handlePointerUp"
    @pointercancel="pointerInteraction.handlePointerCancel"
    @lostpointercapture="pointerInteraction.handleLostPointerCapture"
  >
    <!-- Time grid stays proportional to the recording, so longer takes gain
         usable horizontal space rather than compressing their keyframes. -->
    <g class="pointer-events-none select-none">
      <template
        v-for="marker in timeMarkers"
        :key="marker.timeUs"
      >
        <line
          :x1="toX(marker.timeUs)"
          y1="0"
          :x2="toX(marker.timeUs)"
          :y2="svgHeight"
          stroke="rgb(39 39 42)"
          stroke-width="1"
        />
        <text
          :x="toX(marker.timeUs) + 3"
          y="11"
          fill="rgb(113 113 122)"
          font-size="9"
        >
          {{ marker.label }}
        </text>
      </template>
    </g>

    <ScratchPlatterLane
      :platter="pattern.platter"
      :svg-width="svgWidth"
      :lane-height="platterLaneHeight"
      :editor="editor"
      :pointer-interaction="pointerInteraction"
      :to-x="toX"
      :to-y="toPlatterY"
    />

    <!-- Separator line (draggable to resize the two lanes) -->
    <line
      :x1="0"
      :y1="platterLaneHeight + 6"
      :x2="svgWidth"
      :y2="platterLaneHeight + 6"
      :stroke="draggingDivider ? 'rgb(113 113 122)' : 'rgb(63 63 70)'"
      stroke-width="1"
    />
    <line
      :x1="0"
      :y1="platterLaneHeight + 6"
      :x2="svgWidth"
      :y2="platterLaneHeight + 6"
      stroke="transparent"
      stroke-width="10"
      style="cursor: row-resize"
      role="separator"
      aria-label="Drag to resize the platter and crossfader lanes"
      @pointerdown="onDividerPointerDown"
      @pointermove="onDividerPointerMove"
      @pointerup="onDividerPointerUp"
      @pointercancel="onDividerPointerUp"
    />

    <ScratchCrossfaderLane
      :crossfader="pattern.crossfader"
      :svg-width="svgWidth"
      :lane-top="cfLaneTop"
      :lane-height="cfLaneHeight"
      :editor="editor"
      :pointer-interaction="pointerInteraction"
      :to-x="toX"
      :to-y="toCfY"
    />

    <!-- Replay playhead -->
    <g
      v-if="replayPlayheadX !== null"
      class="pointer-events-none"
    >
      <line
        :x1="replayPlayheadX"
        :y1="0"
        :x2="replayPlayheadX"
        :y2="svgHeight"
        stroke="rgb(74 222 128)"
        stroke-width="2"
      />
      <polygon
        :points="`${replayPlayheadX - 4},0 ${replayPlayheadX + 4},0 ${replayPlayheadX},7`"
        fill="rgb(74 222 128)"
      />
    </g>

    <!-- Pinned lane headers. These follow the horizontal scroll offset
         (and never scale) so the PLATTER / CROSSFADER labels stay fixed
         against the left edge while the notation is zoomed and scrolled.
         An opaque gutter occludes any keyframes scrolling underneath. -->
    <g class="pointer-events-none select-none">
      <rect
        :x="scrollLeftPx"
        y="0"
        :width="PADDING_X"
        :height="svgHeight"
        fill="rgb(9 9 11)"
      />
      <text
        :x="scrollLeftPx + LANE_LABEL_X"
        :y="platterLaneHeight / 2"
        :transform="`rotate(-90 ${scrollLeftPx + LANE_LABEL_X} ${platterLaneHeight / 2})`"
        fill="rgb(113 113 122)"
        font-size="9"
        letter-spacing="0.8"
        text-anchor="middle"
        dominant-baseline="middle"
      >
        PLATTER
      </text>
      <text
        :x="scrollLeftPx + LANE_LABEL_X"
        :y="cfLaneTop + cfLaneHeight / 2"
        :transform="`rotate(-90 ${scrollLeftPx + LANE_LABEL_X} ${cfLaneTop + cfLaneHeight / 2})`"
        fill="rgb(113 113 122)"
        font-size="7"
        letter-spacing="0.2"
        text-anchor="middle"
        dominant-baseline="middle"
      >
        CROSSFADER
      </text>
    </g>
  </svg>
</template>
