<script setup lang="ts">
import { computed } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import type { ScratchNotationEditor } from '@/lib/scratch/useScratchNotationEditor'
import type { NotationPointerInteraction } from '@/lib/scratch/scratchNotationPointer'
import { classifyPlatterLane } from '@/lib/scratch/scratchPatternEditing'
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  platter: ScratchPattern['platter']
  svgWidth: number
  laneHeight: number
  editor: ScratchNotationEditor
  pointerInteraction: NotationPointerInteraction
  toX(timeUs: number): number
  toY(turns: number): number
}>()

const POINT_RADIUS = 5

const segments = computed(() => classifyPlatterLane(props.platter))

function isSelected(index: number): boolean {
  const sel = props.editor.selection.value
  return sel !== null && sel.lane === 'platter' && sel.index === index
}

function segmentColor(kind: string): string {
  if (kind === 'forward') return 'rgb(56 189 248)' // sky-400
  if (kind === 'reverse') return 'rgb(251 146 60)' // amber-400 (caution)
  return 'rgb(161 161 170)' // zinc-400 (hold)
}
</script>

<template>
  <g>
    <!-- Platter lane background -->
    <rect
      x="0"
      y="0"
      :width="svgWidth"
      :height="laneHeight"
      fill="transparent"
      @dblclick="pointerInteraction.handleDoubleClick('platter', $event)"
    />

    <!-- Platter segment coloured lines -->
    <line
      v-for="(seg, segIdx) in segments"
      :key="`seg-${segIdx}`"
      :x1="toX(seg.startTimeUs)"
      :y1="toY(platter[seg.startIndex]!.turns)"
      :x2="toX(seg.endTimeUs)"
      :y2="toY(platter[seg.endIndex]!.turns)"
      :stroke="segmentColor(seg.kind)"
      stroke-width="2"
      stroke-linecap="round"
    />

    <!-- Platter keyframe points -->
    <circle
      v-for="(kf, i) in platter"
      :key="`p-${i}`"
      :cx="toX(kf.timeUs)"
      :cy="toY(kf.turns)"
      :r="POINT_RADIUS"
      :fill="isSelected(i) ? 'rgb(56 189 248)' : 'rgb(228 228 231)'"
      :stroke="isSelected(i) ? 'rgb(14 165 233)' : 'rgb(113 113 122)'"
      stroke-width="1.5"
      class="cursor-pointer"
      role="button"
      :aria-label="`Platter point ${i + 1}: ${formatUsTime(kf.timeUs)}, ${kf.turns.toFixed(3)} turns${kf.touched ? ', touched' : ''}`"
      :tabindex="0"
      @pointerdown="pointerInteraction.handlePointDown('platter', i, $event)"
      @keydown.enter.prevent="editor.selectKeyframe('platter', i)"
      @focus="editor.selectKeyframe('platter', i)"
    />
  </g>
</template>
