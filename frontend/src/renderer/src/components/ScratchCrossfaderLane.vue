<script setup lang="ts">
import { computed } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import type { ScratchNotationEditor } from '@/lib/scratch/useScratchNotationEditor'
import type { NotationPointerInteraction } from '@/lib/scratch/scratchNotationPointer'
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  crossfader: ScratchPattern['crossfader']
  svgWidth: number
  laneTop: number
  laneHeight: number
  editor: ScratchNotationEditor
  pointerInteraction: NotationPointerInteraction
  toX(timeUs: number): number
  toY(value: number): number
}>()

const POINT_RADIUS = 5

const path = computed(() => {
  if (props.crossfader.length === 0) return ''
  return props.crossfader
    .map((k, i) => `${i === 0 ? 'M' : 'L'} ${props.toX(k.timeUs)} ${props.toY(k.value)}`)
    .join(' ')
})

</script>

<template>
  <g>
    <!-- Crossfader lane background -->
    <rect
      :x="0"
      :y="laneTop"
      :width="svgWidth"
      :height="laneHeight"
      fill="transparent"
      @dblclick="pointerInteraction.handleDoubleClick('crossfader', $event)"
    />

    <!-- Crossfader path -->
    <path
      v-if="path"
      :d="path"
      fill="none"
      stroke="rgb(161 161 170)"
      pointer-events="none"
      stroke-width="1.5"
      stroke-linejoin="round"
    />

    <!-- Crossfader keyframe points -->
    <circle
      v-for="(kf, i) in crossfader"
      :key="`cf-${i}`"
      :cx="toX(kf.timeUs)"
      :cy="toY(kf.value)"
      :r="POINT_RADIUS - 1"
      fill="rgb(228 228 231)"
      stroke="rgb(113 113 122)"
      stroke-width="1.5"
      class="cursor-pointer outline-none"
      role="button"
      :aria-pressed="editor.selection.value?.lane === 'crossfader' && editor.selection.value.index === i"
      :aria-label="`Crossfader point ${i + 1}: ${formatUsTime(kf.timeUs)}, ${(kf.value * 100).toFixed(0)}%`"
      :tabindex="0"
      @pointerdown="pointerInteraction.handlePointDown('crossfader', i, $event)"
      @contextmenu="pointerInteraction.handlePointContextMenu('crossfader', i, $event)"
      @focus="editor.selectKeyframe('crossfader', i)"
    />
  </g>
</template>
