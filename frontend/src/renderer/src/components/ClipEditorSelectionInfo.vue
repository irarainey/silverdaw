<script setup lang="ts">
// Clip Editor read-only selection metrics row (start / end / length / playhead).
// All times are shown relative to the current view start, matching the waveform.
import { formatTime } from '@/lib/musicTime'

defineProps<{
  selectionInMs: number
  selectionEndMs: number
  selectionDurationMs: number
  playheadAbsMs: number
  viewInMs: number
}>()
</script>

<template>
  <div class="flex min-w-0 items-center gap-6">
    <div>
      <span class="text-zinc-500">Selection start:</span>
      <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionInMs - viewInMs) }}</span>
    </div>
    <div>
      <span class="text-zinc-500">Selection end:</span>
      <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionEndMs - viewInMs) }}</span>
    </div>
    <div>
      <span class="text-zinc-500">Length:</span>
      <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionDurationMs) }}</span>
    </div>
    <div>
      <span class="text-zinc-500">Playhead:</span>
      <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(playheadAbsMs - viewInMs) }}</span>
    </div>
  </div>
</template>
