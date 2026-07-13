<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
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
}>()

const sessionIdRef = computed(() => props.sessionId)
const editor = useScratchNotationEditor(sessionIdRef)

const svgEl = ref<SVGSVGElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)

// Layout constants
const {
  platterLaneHeight: PLATTER_LANE_HEIGHT,
  cfLaneHeight: CF_LANE_HEIGHT,
  paddingX: PADDING_X,
  cfLaneTop,
  turnsMargin: TURNS_MARGIN
} = DEFAULT_NOTATION_LAYOUT
const POINT_RADIUS = 5

const pattern = computed<ScratchPattern | null>(() => editor.pattern.value)
const durationUs = computed(() => pattern.value?.durationUs ?? 0)

const svgWidth = computed(() => {
  void resizeKey.value // depend on resize trigger
  if (!containerEl.value) return 600
  return Math.max(300, containerEl.value.clientWidth - 2)
})
const contentWidth = computed(() => Math.max(1, svgWidth.value - PADDING_X * 2))
const svgHeight = computed(() => PLATTER_LANE_HEIGHT + CF_LANE_HEIGHT + 24)

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
  return turnsToY(turns, platterMinTurns.value, platterMaxTurns.value, PLATTER_LANE_HEIGHT, TURNS_MARGIN)
}

function toCfY(value: number): number {
  return cfValueToY(value, cfLaneTop, CF_LANE_HEIGHT)
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

// Crop markers
const cropStartX = computed(() => toX(editor.cropStartUs.value))
const cropEndX = computed(() => toX(editor.cropEndUs.value))

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
      <!-- Toolbar row -->
      <div class="flex items-center gap-2 px-1 pb-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">Notation</span>
        <span class="flex-1" />
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!editor.canUndo.value"
          aria-label="Undo edit"
          @click="editor.undo()"
        >
          Undo
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!editor.canRedo.value"
          aria-label="Redo edit"
          @click="editor.redo()"
        >
          Redo
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
          aria-label="Apply crop"
          @click="editor.applyCrop()"
        >
          Crop
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
          aria-label="Reset crop"
          @click="editor.resetCrop()"
        >
          Reset Crop
        </button>
      </div>

      <!-- SVG notation lanes -->
      <svg
        ref="svgEl"
        class="block w-full select-none"
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

        <!-- Separator line -->
        <line
          :x1="0"
          :y1="PLATTER_LANE_HEIGHT + 6"
          :x2="svgWidth"
          :y2="PLATTER_LANE_HEIGHT + 6"
          stroke="rgb(63 63 70)"
          stroke-width="1"
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

        <!-- Crop markers -->
        <line
          :x1="cropStartX"
          :y1="0"
          :x2="cropStartX"
          :y2="svgHeight"
          stroke="rgb(245 158 11)"
          stroke-width="1"
          stroke-dasharray="3 2"
          class="pointer-events-none"
        />
        <line
          :x1="cropEndX"
          :y1="0"
          :x2="cropEndX"
          :y2="svgHeight"
          stroke="rgb(245 158 11)"
          stroke-width="1"
          stroke-dasharray="3 2"
          class="pointer-events-none"
        />
      </svg>

      <!-- Info bar -->
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
      </div>

      <!-- Crop controls -->
      <div class="flex items-center gap-2 px-1 pt-1">
        <label class="flex items-center gap-1 text-[10px] text-zinc-400">
          Crop start
          <input
            v-model.number="editor.cropStartUs.value"
            type="number"
            min="0"
            :max="editor.cropEndUs.value"
            step="1000"
            class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums text-zinc-100 outline-none focus:border-sky-500"
            aria-label="Crop start microseconds"
          >
        </label>
        <label class="flex items-center gap-1 text-[10px] text-zinc-400">
          Crop end
          <input
            v-model.number="editor.cropEndUs.value"
            type="number"
            :min="editor.cropStartUs.value"
            :max="pattern!.durationUs"
            step="1000"
            class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums text-zinc-100 outline-none focus:border-sky-500"
            aria-label="Crop end microseconds"
          >
        </label>
      </div>

      <!-- Keyboard instructions -->
      <div
        class="px-1 pt-1 text-[9px] text-zinc-600"
        aria-hidden="true"
      >
        Arrow keys: move point · Insert: add point · Delete: remove · T: toggle touch · Shift: large step
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
