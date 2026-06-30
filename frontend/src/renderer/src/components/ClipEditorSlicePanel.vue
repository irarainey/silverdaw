<script setup lang="ts">
// Loop-slice controls shown in the Clip Editor effects rack while Slice mode is
// active: pick a grid subdivision, generate markers, see the count, and commit
// the chop to the timeline. Manual marker editing happens directly on the
// waveform; this panel is the keyboard-free command surface.
import type { SliceSubdivision } from '@/lib/clipEditor/loopSlice'

const subdivision = defineModel<SliceSubdivision>('subdivision', { required: true })

defineProps<{
  sliceCount: number
  canSlice: boolean
}>()

defineEmits<{
  (e: 'generate'): void
  (e: 'slice-to-timeline'): void
  (e: 'slice-to-samples'): void
}>()

const SUBDIVISIONS: SliceSubdivision[] = ['1 bar', '1/2 bar', '1/4', '1/8', '1/16', '1/32']
</script>

<template>
  <div class="flex h-full flex-col gap-2 text-[11px]">
    <div>
      <div class="mb-1 text-zinc-400">
        Grid
      </div>
      <div class="grid grid-cols-3 gap-1">
        <button
          v-for="d in SUBDIVISIONS"
          :key="d"
          type="button"
          class="rounded px-1 py-1 font-mono font-medium"
          :class="
            subdivision === d
              ? 'bg-emerald-600 text-white'
              : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
          "
          @click="subdivision = d"
        >
          {{ d }}
        </button>
      </div>
    </div>

    <button
      type="button"
      class="rounded bg-zinc-800 px-2 py-1 font-medium text-zinc-200 hover:bg-zinc-700"
      title="Place slice markers on the chosen beat-grid division"
      @click="$emit('generate')"
    >
      Generate to grid
    </button>

    <div class="tabular-nums text-zinc-400">
      {{ sliceCount }} marker{{ sliceCount === 1 ? '' : 's' }}
    </div>

    <button
      type="button"
      class="mt-auto rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
      :disabled="!canSlice || sliceCount === 0"
      title="Cut the clip into adjacent clips at every marker"
      @click="$emit('slice-to-timeline')"
    >
      Slice to timeline
    </button>

    <button
      type="button"
      class="rounded bg-zinc-800 px-2 py-1 font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canSlice || sliceCount === 0"
      title="Save each slice as its own one-shot sample in the library"
      @click="$emit('slice-to-samples')"
    >
      Slice to samples
    </button>

    <p class="leading-snug text-zinc-500">
      Drag on the waveform to add a marker; Alt-click a marker to remove it.
    </p>
  </div>
</template>
