<script setup lang="ts">
// Top-of-dialog scratch audition transport: skip-to-start, play/pause,
// skip-to-end, plus a position / duration / rate / touch readout. Purely
// presentational — the parent owns the scratch session and handles the emitted
// intents against the local audition transport only (never the arrangement).
import { formatUsTime } from '@/lib/scratch/scratchControlHelpers'

defineProps<{
  positionUs: number
  durationUs: number
  playbackRate: number
  isTouched: boolean
  isPlaying: boolean
  canControl: boolean
}>()

defineEmits<{
  (e: 'skip-to-start'): void
  (e: 'toggle-play'): void
  (e: 'skip-to-end'): void
}>()
</script>

<template>
  <div class="grid shrink-0 grid-cols-3 items-center bg-zinc-900 px-3 py-1.5">
    <div />

    <div class="flex items-center gap-1 justify-self-center">
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canControl"
        title="Skip to start (Home)"
        aria-label="Skip to start"
        @click="$emit('skip-to-start')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        ><path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" /></svg>
      </button>
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 hover:bg-blue-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        :class="isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
        :disabled="!canControl"
        :title="isPlaying ? 'Pause (Space)' : 'Play (Space)'"
        :aria-label="isPlaying ? 'Pause scratch preview' : 'Play scratch preview'"
        @click="$emit('toggle-play')"
      >
        <svg
          v-if="isPlaying"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6"
        ><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" /></svg>
        <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6"
        ><path d="M8 5v14l11-7L8 5z" /></svg>
      </button>
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canControl"
        title="Skip to end (End)"
        aria-label="Skip to end"
        @click="$emit('skip-to-end')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        ><path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" /></svg>
      </button>
    </div>

    <div
      class="flex items-center gap-3 justify-self-end rounded border border-zinc-700 bg-zinc-950/40 py-1 pl-3 pr-3"
      title="Timing"
    >
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Pos</span>
        <span class="w-[8ch] font-mono text-sm tabular-nums text-zinc-100">{{ formatUsTime(positionUs) }}</span>
      </div>
      <div class="h-6 w-px bg-zinc-800" />
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Len</span>
        <span class="w-[8ch] font-mono text-sm tabular-nums text-zinc-400">{{ formatUsTime(durationUs) }}</span>
      </div>
      <div class="h-6 w-px bg-zinc-800" />
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Rate</span>
        <span class="w-[5ch] font-mono text-sm tabular-nums text-zinc-400">{{ playbackRate.toFixed(2) }}×</span>
      </div>
      <div class="h-6 w-px bg-zinc-800" />
      <span
        class="h-2 w-2 rounded-full transition-colors"
        :class="isTouched ? 'bg-sky-400' : 'bg-zinc-700'"
        :title="isTouched ? 'Platter touched' : 'Platter free'"
        aria-hidden="true"
      />
    </div>
  </div>
</template>
