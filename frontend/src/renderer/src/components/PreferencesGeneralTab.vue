<script setup lang="ts">
import type { WaveformDisplayMode } from '@/stores/uiStore'

const waveformDisplayMode = defineModel<WaveformDisplayMode>('waveformDisplayMode', { required: true })
const showLibraryTileImages = defineModel<boolean>('showLibraryTileImages', { required: true })
const toastsEnabled = defineModel<boolean>('toastsEnabled', { required: true })
</script>

<template>
  <section>
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Waveform display
      </h2>
      <p class="mb-3 text-zinc-500">
        Choose how clip waveforms are drawn in the timeline and Clip
        Editor. Mono clips always show a single waveform.
      </p>
      <div class="space-y-2">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="summary"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Single waveform</span>
            <span class="text-zinc-500"> — One combined waveform per clip</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="stereo"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Left and right</span>
            <span class="text-zinc-500"> — Separate L / R for stereo clips</span>
          </span>
        </label>
      </div>
    </div>
    <label class="mt-4 flex cursor-pointer items-start gap-3">
      <input
        v-model="showLibraryTileImages"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Show images on library tiles</span>
        <span class="mt-0.5 block text-zinc-500">
          Display embedded cover art, or the fallback audio icon, on
          each library tile. Turn off for a denser text-only library.
        </span>
      </span>
    </label>
    <label class="mt-3 flex cursor-pointer items-start gap-3">
      <input
        v-model="toastsEnabled"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Show toast notifications</span>
        <span class="mt-0.5 block text-zinc-500">
          Pop transient feedback (errors, save confirmations) in the
          bottom-right corner. Turn off for a quieter UI; events are
          still written to the log when debugging is enabled.
        </span>
      </span>
    </label>
  </section>
</template>
