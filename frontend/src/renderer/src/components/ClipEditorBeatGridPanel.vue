<script setup lang="ts">
// Manual-tempo fallback inside the Clip Editor effects rack. Lets the user pin
// a BPM for the source when detection fails or is wrong, then slide the rigid
// beat grid over the waveform to fix its phase. Pure presentation: the state +
// actions live in `useClipEditorBeatGrid` and are passed in via the `grid` prop.

import type { ClipEditorBeatGrid } from '@/lib/clipEditor/useClipEditorBeatGrid'

const props = defineProps<{
  grid: ClipEditorBeatGrid
  sourceBpm: number | undefined
}>()

// Alias refs so the template never reaches through the prop directly.
const manualBpmInput = props.grid.manualBpmInput
const alignActive = props.grid.alignActive
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <div class="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-zinc-400">
      <div class="text-[10px] uppercase tracking-wider text-zinc-500">
        Source BPM
      </div>
      <div class="font-mono text-zinc-200">
        {{ sourceBpm ? sourceBpm.toFixed(2) : '—' }}
      </div>
    </div>

    <fieldset class="flex flex-col gap-1">
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Set tempo manually
      </legend>
      <div class="flex items-center gap-2">
        <input
          v-model.number="manualBpmInput"
          type="number"
          min="20"
          max="300"
          step="0.01"
          placeholder="BPM"
          aria-label="Manual BPM"
          class="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
        >
        <span class="text-[10px] text-zinc-500">BPM</span>
        <button
          type="button"
          class="ml-auto rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40"
          :disabled="!props.grid.canApply()"
          @click="props.grid.applyManualBpm()"
        >
          Apply
        </button>
      </div>
    </fieldset>

    <fieldset
      class="flex flex-col gap-1"
      :disabled="!props.grid.hasGrid()"
      :class="!props.grid.hasGrid() ? 'opacity-50' : ''"
    >
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Align grid
      </legend>
      <button
        type="button"
        class="rounded border px-2 py-1 text-xs transition-colors"
        :class="alignActive
          ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
          : 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:border-zinc-600 hover:text-zinc-100'
        "
        :aria-pressed="alignActive"
        @click="props.grid.toggleAlign()"
      >
        {{ alignActive ? 'Aligning — drag the waveform' : 'Slide grid to align' }}
      </button>
      <p class="text-[10px] text-zinc-500">
        Drag left/right across the waveform to slide the beat grid onto the beats.
      </p>
    </fieldset>
  </div>
</template>
