<script setup lang="ts">
// Transport bar: visual playback controls only — no behaviour yet.
// The buttons will be wired to backend `TRANSPORT_*` commands in Phase 1.

import { computed } from 'vue'
import { useProjectStore } from '@/stores/projectStore'

const project = useProjectStore()

// Placeholder state until the transport store + backend land.
const positionMs = 0
const bpm = 120

const positionDisplay = computed(() => formatTime(positionMs))
const durationDisplay = computed(() => formatTime(project.durationMs))

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// Stubs — clicking does nothing yet.
function onSkipBack(): void {}
function onRewind(): void {}
function onPlay(): void {}
function onStop(): void {}
function onSkipForward(): void {}
</script>

<template>
  <footer
    class="flex h-16 w-full select-none items-center justify-between border-t border-zinc-800 bg-zinc-900 px-4 text-zinc-300"
  >
    <!-- Left: time display -->
    <div class="flex items-baseline gap-2 font-mono tabular-nums">
      <span class="text-xl text-zinc-100">{{ positionDisplay }}</span>
      <span class="text-xs text-zinc-500">/ {{ durationDisplay }}</span>
    </div>

    <!-- Centre: transport buttons -->
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Skip to start"
        @click="onSkipBack"
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
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Rewind"
        @click="onRewind"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        ><path d="M11 5L2 12l9 7V5zm11 0l-9 7 9 7V5z" /></svg>
      </button>
      <button
        type="button"
        class="rounded p-2 text-zinc-100 hover:bg-blue-600 hover:text-white"
        title="Play"
        @click="onPlay"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6"
        ><path d="M8 5v14l11-7L8 5z" /></svg>
      </button>
      <button
        type="button"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Stop"
        @click="onStop"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        ><path d="M6 6h12v12H6z" /></svg>
      </button>
      <button
        type="button"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Skip to end"
        @click="onSkipForward"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        ><path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" /></svg>
      </button>
    </div>

    <!-- Right: BPM display -->
    <div class="flex items-baseline gap-2 font-mono tabular-nums">
      <span class="text-xl text-zinc-100">{{ bpm.toFixed(1) }}</span>
      <span class="text-xs uppercase tracking-wide text-zinc-500">BPM</span>
    </div>
  </footer>
</template>
