<script setup lang="ts">
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'

defineProps<{
  positionUs: number
  durationUs: number
  playbackRate: number
  isTouched: boolean
}>()
</script>

<template>
  <div class="flex shrink-0 items-center gap-4 rounded border border-zinc-800 bg-zinc-950 px-4 py-1.5">
    <span class="font-mono text-xs tabular-nums text-zinc-200">
      {{ formatUsTime(positionUs) }}
    </span>
    <span class="text-[10px] text-zinc-600">/</span>
    <span class="font-mono text-xs tabular-nums text-zinc-500">
      {{ formatUsTime(durationUs) }}
    </span>
    <span class="ml-2 font-mono text-xs tabular-nums text-zinc-400">
      {{ playbackRate.toFixed(2) }}×
    </span>
    <span
      class="ml-1 h-2 w-2 rounded-full transition-colors"
      :class="isTouched ? 'bg-sky-400' : 'bg-zinc-700'"
      :title="isTouched ? 'Platter touched' : 'Platter free'"
      aria-hidden="true"
    />
  </div>
</template>
