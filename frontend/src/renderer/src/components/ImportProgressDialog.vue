<script setup lang="ts">
// Floating audio-work progress panel (bottom-right) for in-flight imports and
// reanalysis jobs. One row per file (spinner + name + stage), added on
// `library.beginImport` and removed shortly after `library.finishImport`.
// Stages: decoding, detecting (backend BPM), done, failed (done/failed flash
// briefly then clear). Surfaces the slow backend stage the old bar hid.

import { computed } from 'vue'
import { useLibraryStore, type ImportStage } from '@/stores/libraryStore'

const library = useLibraryStore()
const entries = computed(() => library.imports)

function stageLabel(stage: ImportStage): string {
  switch (stage) {
    case 'decoding':
      return 'Preparing audio…'
    case 'detectingTempo':
      return 'Analysing tempo…'
    case 'detectingBeats':
      return 'Analysing beats…'
    case 'warping':
      return 'Applying warp…'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return ''
  }
}

function stageColor(stage: ImportStage): string {
  switch (stage) {
    case 'done':
      return 'text-emerald-400'
    case 'failed':
      return 'text-red-400'
    default:
      return 'text-zinc-400'
  }
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="entries.length > 0"
      class="fixed bottom-12 right-4 z-1100 flex w-72 flex-col gap-1 rounded-lg border border-zinc-700 bg-zinc-900/95 p-2 shadow-xl backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <div class="mb-1 px-1 text-[10px] uppercase tracking-wide text-zinc-500">
        Processing audio ({{ entries.length }})
      </div>
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="flex items-center gap-2 rounded px-2 py-1.5"
      >
        <!-- Spinner / state icon -->
        <span class="flex h-3 w-3 shrink-0 items-center justify-center">
          <svg
            v-if="entry.stage === 'decoding' || entry.stage === 'detectingTempo' || entry.stage === 'detectingBeats' || entry.stage === 'warping'"
            class="h-3 w-3 animate-spin text-zinc-300"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          <svg
            v-else-if="entry.stage === 'done'"
            class="h-3 w-3 text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
          <svg
            v-else
            class="h-3 w-3 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs text-zinc-100">
            {{ entry.fileName }}
          </div>
          <div :class="['text-[10px]', stageColor(entry.stage)]">
            {{ stageLabel(entry.stage) }}
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 150ms ease-out;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
