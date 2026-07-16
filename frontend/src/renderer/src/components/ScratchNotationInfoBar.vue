<script setup lang="ts">
import type { NotationSelection } from '@/lib/scratch/useScratchNotationEditor'
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'
import {
  MIN_ZOOM_PERCENT,
  MAX_ZOOM_PERCENT
} from '@/lib/scratch/useScratchNotationLayout'

defineProps<{
  durationUs: number
  platterCount: number
  crossfaderCount: number
  selection: NotationSelection | null
  zoomPercent: number
}>()

const emit = defineEmits<{
  (event: 'zoom-out'): void
  (event: 'zoom-reset'): void
  (event: 'zoom-in'): void
}>()
</script>

<template>
  <div class="flex items-center gap-3 px-1 pt-1 text-[10px] text-zinc-500">
    <span>
      Duration: <span class="font-mono tabular-nums text-zinc-300">{{ formatUsTime(durationUs) }}</span>
    </span>
    <span>
      Platter: <span class="font-mono tabular-nums text-zinc-300">{{ platterCount }}</span> pts
    </span>
    <span>
      Crossfader: <span class="font-mono tabular-nums text-zinc-300">{{ crossfaderCount }}</span> pts
    </span>
    <span v-if="selection">
      Selected: <span class="text-sky-300">{{ selection.lane }}[{{ selection.index }}]</span>
    </span>
    <div class="ml-auto inline-flex items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900/90">
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom out"
        :disabled="zoomPercent <= MIN_ZOOM_PERCENT"
        aria-label="Zoom notation out"
        @click="emit('zoom-out')"
      >
        <span class="text-sm leading-none">-</span>
      </button>
      <button
        type="button"
        class="min-w-10 border-x border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-200 hover:bg-zinc-800"
        title="Reset notation zoom"
        @click="emit('zoom-reset')"
      >
        {{ zoomPercent }}%
      </button>
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom in"
        :disabled="zoomPercent >= MAX_ZOOM_PERCENT"
        aria-label="Zoom notation in"
        @click="emit('zoom-in')"
      >
        <span class="text-sm leading-none">+</span>
      </button>
    </div>
  </div>
</template>
