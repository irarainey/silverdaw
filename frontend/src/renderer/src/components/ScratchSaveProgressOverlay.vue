<script setup lang="ts">
import type { ScratchSavePhase } from '@/lib/scratch/useScratchSaveFlow'

defineProps<{
  phase: ScratchSavePhase
  errorMessage: string | null
}>()

const emit = defineEmits<{
  (event: 'dismiss'): void
  (event: 'retry'): void
}>()
</script>

<template>
  <div
    v-if="phase !== 'idle'"
    class="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="scratch-save-progress-title"
  >
    <div class="dialog-card w-[min(400px,90vw)]">
      <div class="dialog-header">
        <h3
          id="scratch-save-progress-title"
          class="dialog-title"
        >
          {{ phase === 'error' ? 'Save Failed' : 'Saving Scratch' }}
        </h3>
      </div>
      <div class="dialog-body">
        <p
          v-if="phase === 'saving'"
          class="flex items-center gap-2 text-xs text-zinc-400"
        >
          <svg
            class="h-4 w-4 animate-spin text-sky-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
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
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Baking your scratch to the library…
        </p>
        <p
          v-else
          class="text-xs text-red-400"
        >
          {{ errorMessage }}
        </p>
      </div>
      <div
        v-if="phase === 'error'"
        class="dialog-footer"
      >
        <button
          type="button"
          class="dialog-btn-cancel"
          @click="emit('dismiss')"
        >
          Close
        </button>
        <button
          type="button"
          class="dialog-btn-primary"
          autofocus
          @click="emit('retry')"
        >
          Retry
        </button>
      </div>
    </div>
  </div>
</template>
