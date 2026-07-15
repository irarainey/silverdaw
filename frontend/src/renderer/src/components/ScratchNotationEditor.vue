<script setup lang="ts">
import { computed, nextTick, ref, onMounted, onBeforeUnmount } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import {
  useScratchNotationEditor
} from '@/lib/scratch/useScratchNotationEditor'
import {
  classifyPlatterLane
} from '@/lib/scratch/scratchPatternEditing'
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'
import {
  timeToX,
  turnsToY,
  cfValueToY,
  DEFAULT_NOTATION_LAYOUT
} from '@/lib/scratch/scratchNotationCoordinates'
import {
  createNotationPointerInteraction
} from '@/lib/scratch/scratchNotationPointer'
import {
  handleNotationKeydown
} from '@/lib/scratch/scratchNotationKeyboard'

const props = defineProps<{
  sessionId: string | null
  /** Live replay position (0..1 across the cropped window), or null when idle. */
  replayPositionNormalized?: number | null
}>()

const sessionIdRef = computed(() => props.sessionId)
const editor = useScratchNotationEditor(sessionIdRef)

const svgEl = ref<SVGSVGElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)
const viewportEl = ref<HTMLDivElement | null>(null)
const zoomPercent = ref(100)
const scrollLeftPx = ref(0)

// Static layout constants (horizontal padding + turns margin never change).
const {
  paddingX: PADDING_X,
  turnsMargin: TURNS_MARGIN
} = DEFAULT_NOTATION_LAYOUT

// Vertical layout is responsive: the SVG fills the available viewport height and
// the platter/crossfader lanes split it in the same proportion as the fixed
// default, so the notation panel grows to fill its container instead of leaving
// empty space below the lanes.
const CF_LANE_RATIO =
  DEFAULT_NOTATION_LAYOUT.cfLaneHeight /
  (DEFAULT_NOTATION_LAYOUT.platterLaneHeight + DEFAULT_NOTATION_LAYOUT.cfLaneHeight)
// The crossfader's share of the lane area is user-adjustable by dragging the
// separator between the two lanes; it seeds from the fixed default proportion.
const cfLaneRatio = ref(CF_LANE_RATIO)
const MIN_LANE_HEIGHT = 48 // keep both lanes usable while dragging the divider
const LANE_VERTICAL_MARGIN = 24 // 12px gap between lanes + 12px bottom padding
const MIN_SVG_HEIGHT =
  DEFAULT_NOTATION_LAYOUT.platterLaneHeight +
  DEFAULT_NOTATION_LAYOUT.cfLaneHeight +
  LANE_VERTICAL_MARGIN
const POINT_RADIUS = 5
const LANE_LABEL_X = 10
const MIN_ZOOM_PERCENT = 100
const MAX_ZOOM_PERCENT = 800
const ZOOM_STEP_PERCENT = 10

const pattern = computed<ScratchPattern | null>(() => editor.pattern.value)
const durationUs = computed(() => pattern.value?.durationUs ?? 0)

const svgWidth = computed(() => {
  void resizeKey.value // depend on resize trigger
  if (!viewportEl.value) return 600
  return Math.max(300, viewportEl.value.clientWidth * zoomPercent.value / 100)
})
const contentWidth = computed(() => Math.max(1, svgWidth.value - PADDING_X * 2))
const svgHeight = computed(() => {
  void resizeKey.value // depend on resize trigger
  const measured = viewportEl.value?.clientHeight ?? 0
  return Math.max(MIN_SVG_HEIGHT, measured)
})
const laneArea = computed(() => svgHeight.value - LANE_VERTICAL_MARGIN)
const PLATTER_LANE_HEIGHT = computed(() => laneArea.value * (1 - cfLaneRatio.value))
const CF_LANE_HEIGHT = computed(() => laneArea.value * cfLaneRatio.value)
const cfLaneTop = computed(() => PLATTER_LANE_HEIGHT.value + 12)

// Platter bounds
const platterMinTurns = computed(() => {
  const p = pattern.value
  if (!p || p.platter.length === 0) return 0
  return Math.min(...p.platter.map((k) => k.turns))
})
const platterMaxTurns = computed(() => {
  const p = pattern.value
  if (!p || p.platter.length === 0) return 1
  return Math.max(...p.platter.map((k) => k.turns))
})

// Coordinate helpers bound to current layout
function toX(timeUsVal: number): number {
  return timeToX(timeUsVal, durationUs.value, contentWidth.value, PADDING_X)
}

function toPlatterY(turns: number): number {
  return turnsToY(turns, platterMinTurns.value, platterMaxTurns.value, PLATTER_LANE_HEIGHT.value, TURNS_MARGIN)
}

function toCfY(value: number): number {
  return cfValueToY(value, cfLaneTop.value, CF_LANE_HEIGHT.value)
}

// Pointer interaction (extracted module)
const pointerInteraction = createNotationPointerInteraction(
  {
    svgEl,
    viewBoxWidth: svgWidth,
    viewBoxHeight: svgHeight,
    durationUs,
    contentWidth,
    paddingX: PADDING_X,
    platterLaneHeight: PLATTER_LANE_HEIGHT,
    platterMinTurns,
    platterMaxTurns,
    turnsMargin: TURNS_MARGIN,
    cfLaneTop,
    cfLaneHeight: CF_LANE_HEIGHT
  },
  {
    onSelect: (lane, index) => editor.selectKeyframe(lane, index),
    onMovePlatter: (index, t, turns) => editor.movePlatter(index, t, turns),
    onMoveCrossfader: (index, t, value) => editor.moveCrossfader(index, t, value),
    onAddPlatter: (t) => editor.addPlatter(t),
    onAddCrossfader: (t) => editor.addCrossfaderPoint(t)
  }
)

// Segments
const platterSegments = computed(() => {
  const p = pattern.value
  if (!p) return []
  return classifyPlatterLane(p.platter)
})

// Crossfader path
const crossfaderPath = computed(() => {
  const p = pattern.value
  if (!p || p.crossfader.length === 0) return ''
  return p.crossfader
    .map((k, i) => `${i === 0 ? 'M' : 'L'} ${toX(k.timeUs)} ${toCfY(k.value)}`)
    .join(' ')
})

// Replay playhead: the normalized position runs 0..1 across the cropped window,
// so map it back onto absolute pattern time before converting to an x coordinate.
const replayPlayheadX = computed<number | null>(() => {
  const n = props.replayPositionNormalized
  if (n == null) return null
  const p = pattern.value
  if (!p) return null
  return toX(p.cropStartUs + n * (p.cropEndUs - p.cropStartUs))
})

// Selection styling
function isPlatterSelected(index: number): boolean {
  const sel = editor.selection.value
  return sel !== null && sel.lane === 'platter' && sel.index === index
}

function isCrossfaderSelected(index: number): boolean {
  const sel = editor.selection.value
  return sel !== null && sel.lane === 'crossfader' && sel.index === index
}

// Keyboard handler (extracted module) — events stop propagation when consumed
function onKeydown(event: KeyboardEvent): void {
  handleNotationKeydown(event, {
    editor,
    durationUs: durationUs.value
  })
}

async function setZoom(nextZoom: number): Promise<void> {
  const viewport = viewportEl.value
  const previousCentre = viewport && viewport.scrollWidth > 0
    ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
    : 0.5
  zoomPercent.value = Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, nextZoom))
  await nextTick()
  if (viewport) {
    viewport.scrollLeft = previousCentre * viewport.scrollWidth - viewport.clientWidth / 2
    scrollLeftPx.value = viewport.scrollLeft
  }
}

function onZoomWheel(event: WheelEvent): void {
  const delta = event.deltaY < 0 ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT
  void setZoom(zoomPercent.value + delta)
}

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
  const scaleY = rect.height > 0 ? svgHeight.value / rect.height : 1
  const yUnits = (event.clientY - rect.top) * scaleY
  // The separator is drawn 6px below the platter lane (mid-gap), so subtract it
  // to keep the divider under the cursor.
  const newPlatter = Math.min(
    laneArea.value - MIN_LANE_HEIGHT,
    Math.max(MIN_LANE_HEIGHT, yUnits - 6)
  )
  cfLaneRatio.value = (laneArea.value - newPlatter) / laneArea.value
}

function onDividerPointerUp(event: PointerEvent): void {
  draggingDivider.value = false
  ;(event.target as Element).releasePointerCapture?.(event.pointerId)
}

// Custom horizontal scrollbar (matches the waveform window). The viewport
// scrolls natively but hides its native scrollbars; this overlay reflects and
// drives the scroll position. Vertical scrolling is disabled entirely.
function onViewportScroll(): void {
  scrollLeftPx.value = viewportEl.value?.scrollLeft ?? 0
}

const canScrollHorizontally = computed(() => {
  void resizeKey.value
  const view = viewportEl.value?.clientWidth ?? 0
  return svgWidth.value - view > 0.5
})

const scrollThumbWidthPct = computed(() => {
  void resizeKey.value
  const total = svgWidth.value
  const view = viewportEl.value?.clientWidth ?? 0
  if (total <= 0) return 100
  return Math.max(2, Math.min(100, (view / total) * 100))
})

const scrollThumbLeftPct = computed(() => {
  const total = svgWidth.value
  if (total <= 0) return 0
  const maxLeft = 100 - scrollThumbWidthPct.value
  return Math.max(0, Math.min(maxLeft, (scrollLeftPx.value / total) * 100))
})

function onScrollbarMouseDown(event: MouseEvent): void {
  const viewport = viewportEl.value
  const track = event.currentTarget as HTMLElement
  if (!viewport) return
  const rect = track.getBoundingClientRect()
  const total = svgWidth.value
  const view = viewport.clientWidth
  if (total <= view || rect.width <= 0) return

  const thumbWidth = (view / total) * rect.width
  const thumbLeft = (viewport.scrollLeft / total) * rect.width
  const clickX = event.clientX - rect.left

  let grabOffset: number
  if (clickX < thumbLeft || clickX > thumbLeft + thumbWidth) {
    // Page to the click position, then drag from the thumb centre.
    viewport.scrollLeft = ((clickX - thumbWidth / 2) / rect.width) * total
    grabOffset = thumbWidth / 2
  } else {
    grabOffset = clickX - thumbLeft
  }
  scrollLeftPx.value = viewport.scrollLeft

  const onMove = (moveEvent: MouseEvent): void => {
    const x = moveEvent.clientX - rect.left - grabOffset
    viewport.scrollLeft = Math.max(0, Math.min(total - view, (x / rect.width) * total))
    scrollLeftPx.value = viewport.scrollLeft
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// Resize observer for SVG width tracking
let resizeObserver: ResizeObserver | null = null
const resizeKey = ref(0)
onMounted(() => {
  if (containerEl.value) {
    resizeObserver = new ResizeObserver(() => {
      resizeKey.value++
    })
    resizeObserver.observe(containerEl.value)
  }
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// Segment color
function segmentColor(kind: string): string {
  if (kind === 'forward') return 'rgb(56 189 248)' // sky-400
  if (kind === 'reverse') return 'rgb(251 146 60)' // amber-400 (caution)
  return 'rgb(161 161 170)' // zinc-400 (hold)
}
</script>

<template>
  <div
    ref="containerEl"
    class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-950 p-2"
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
          @wheel.ctrl.prevent="onZoomWheel"
          @scroll="onViewportScroll"
        >
          <svg
            ref="svgEl"
            class="block max-w-none select-none"
            :style="{ width: `${svgWidth}px` }"
            :height="svgHeight"
            :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
            preserveAspectRatio="none"
            aria-label="Pattern lanes. Use arrow keys to move selected point, Insert to add, Delete to remove, T to toggle touch."
            @pointermove="pointerInteraction.handlePointerMove"
            @pointerup="pointerInteraction.handlePointerUp"
            @pointercancel="pointerInteraction.handlePointerCancel"
            @lostpointercapture="pointerInteraction.handleLostPointerCapture"
          >
            <!-- Platter lane background -->
            <rect
              x="0"
              y="0"
              :width="svgWidth"
              :height="PLATTER_LANE_HEIGHT"
              fill="transparent"
              @dblclick="pointerInteraction.handleDoubleClick('platter', $event)"
            />

            <!-- Platter segment coloured lines -->
            <line
              v-for="(seg, segIdx) in platterSegments"
              :key="`seg-${segIdx}`"
              :x1="toX(seg.startTimeUs)"
              :y1="toPlatterY(pattern!.platter[seg.startIndex]!.turns)"
              :x2="toX(seg.endTimeUs)"
              :y2="toPlatterY(pattern!.platter[seg.endIndex]!.turns)"
              :stroke="segmentColor(seg.kind)"
              stroke-width="2"
              stroke-linecap="round"
            />

            <!-- Platter keyframe points -->
            <circle
              v-for="(kf, i) in pattern!.platter"
              :key="`p-${i}`"
              :cx="toX(kf.timeUs)"
              :cy="toPlatterY(kf.turns)"
              :r="POINT_RADIUS"
              :fill="isPlatterSelected(i) ? 'rgb(56 189 248)' : 'rgb(228 228 231)'"
              :stroke="isPlatterSelected(i) ? 'rgb(14 165 233)' : 'rgb(113 113 122)'"
              stroke-width="1.5"
              class="cursor-pointer"
              role="button"
              :aria-label="`Platter point ${i + 1}: ${formatUsTime(kf.timeUs)}, ${kf.turns.toFixed(3)} turns${kf.touched ? ', touched' : ''}`"
              :tabindex="0"
              @pointerdown="pointerInteraction.handlePointDown('platter', i, $event)"
              @keydown.enter.prevent="editor.selectKeyframe('platter', i)"
              @focus="editor.selectKeyframe('platter', i)"
            />

            <!-- Separator line (draggable to resize the two lanes) -->
            <line
              :x1="0"
              :y1="PLATTER_LANE_HEIGHT + 6"
              :x2="svgWidth"
              :y2="PLATTER_LANE_HEIGHT + 6"
              :stroke="draggingDivider ? 'rgb(113 113 122)' : 'rgb(63 63 70)'"
              stroke-width="1"
            />
            <line
              :x1="0"
              :y1="PLATTER_LANE_HEIGHT + 6"
              :x2="svgWidth"
              :y2="PLATTER_LANE_HEIGHT + 6"
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

            <!-- Crossfader lane background -->
            <rect
              :x="0"
              :y="cfLaneTop"
              :width="svgWidth"
              :height="CF_LANE_HEIGHT"
              fill="transparent"
              @dblclick="pointerInteraction.handleDoubleClick('crossfader', $event)"
            />

            <!-- Crossfader path -->
            <path
              v-if="crossfaderPath"
              :d="crossfaderPath"
              fill="none"
              stroke="rgb(34 211 238)"
              stroke-width="1.5"
              stroke-linejoin="round"
            />

            <!-- Crossfader keyframe points -->
            <circle
              v-for="(kf, i) in pattern!.crossfader"
              :key="`cf-${i}`"
              :cx="toX(kf.timeUs)"
              :cy="toCfY(kf.value)"
              :r="POINT_RADIUS - 1"
              :fill="isCrossfaderSelected(i) ? 'rgb(34 211 238)' : 'rgb(228 228 231)'"
              :stroke="isCrossfaderSelected(i) ? 'rgb(8 145 178)' : 'rgb(113 113 122)'"
              stroke-width="1.5"
              class="cursor-pointer"
              role="button"
              :aria-label="`Crossfader point ${i + 1}: ${formatUsTime(kf.timeUs)}, ${(kf.value * 100).toFixed(0)}%`"
              :tabindex="0"
              @pointerdown="pointerInteraction.handlePointDown('crossfader', i, $event)"
              @keydown.enter.prevent="editor.selectKeyframe('crossfader', i)"
              @focus="editor.selectKeyframe('crossfader', i)"
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
                :y="PLATTER_LANE_HEIGHT / 2"
                :transform="`rotate(-90 ${scrollLeftPx + LANE_LABEL_X} ${PLATTER_LANE_HEIGHT / 2})`"
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
                :y="cfLaneTop + CF_LANE_HEIGHT / 2"
                :transform="`rotate(-90 ${scrollLeftPx + LANE_LABEL_X} ${cfLaneTop + CF_LANE_HEIGHT / 2})`"
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
        </div>

        <!-- Custom horizontal scrollbar (matches the waveform window). Only shown
           when the notation is zoomed wider than the viewport. -->
        <div
          v-show="canScrollHorizontally"
          class="relative mt-0.5 h-2 shrink-0 cursor-pointer rounded bg-zinc-900/80"
          :title="`Scroll (zoom ${zoomPercent}%)`"
          @mousedown="onScrollbarMouseDown"
        >
          <div
            class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
            :style="{ left: `${scrollThumbLeftPct}%`, width: `${scrollThumbWidthPct}%` }"
          />
        </div>
      </div>

      <!-- Info bar (with zoom controls grouped at the right, matching the
           scratch waveform window). -->
      <div class="flex items-center gap-3 px-1 pt-1 text-[10px] text-zinc-500">
        <span>
          Duration: <span class="font-mono tabular-nums text-zinc-300">{{ formatUsTime(pattern!.durationUs) }}</span>
        </span>
        <span>
          Platter: <span class="font-mono tabular-nums text-zinc-300">{{ pattern!.platter.length }}</span> pts
        </span>
        <span>
          Crossfader: <span class="font-mono tabular-nums text-zinc-300">{{ pattern!.crossfader.length }}</span> pts
        </span>
        <span v-if="editor.selection.value">
          Selected: <span class="text-sky-300">{{ editor.selection.value.lane }}[{{ editor.selection.value.index }}]</span>
        </span>
        <div class="ml-auto inline-flex items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900/90">
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            title="Zoom out"
            :disabled="zoomPercent <= MIN_ZOOM_PERCENT"
            aria-label="Zoom notation out"
            @click="setZoom(zoomPercent - ZOOM_STEP_PERCENT)"
          >
            <span class="text-sm leading-none">-</span>
          </button>
          <button
            type="button"
            class="min-w-10 border-x border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-200 hover:bg-zinc-800"
            title="Reset notation zoom"
            @click="setZoom(100)"
          >
            {{ zoomPercent }}%
          </button>
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            title="Zoom in"
            :disabled="zoomPercent >= MAX_ZOOM_PERCENT"
            aria-label="Zoom notation in"
            @click="setZoom(zoomPercent + ZOOM_STEP_PERCENT)"
          >
            <span class="text-sm leading-none">+</span>
          </button>
        </div>
      </div>
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
