<script setup lang="ts">
// Modal progress dialog shown while a stem separation runs. Driven by the
// singleton `stemSeparationState` ref: mounts on the first STEM_PROGRESS and
// dismisses when a terminal envelope (READY/FAILED/cancel) clears the state.
// Modal with backdrop so the timeline can't be edited mid-separation.

import { computed, ref, watch } from 'vue'
import { useStemSeparationState, type StemStage } from '@/lib/stemSeparationState'
import { cancelActiveStemSeparation } from '@/lib/stems/stemSeparationFlow'
import { useSmoothProgress } from '@/lib/stems/useSmoothProgress'
import { log } from '@/lib/log'

const state = useStemSeparationState()

const STAGE_LABELS: Record<StemStage, string> = {
  prepare: 'Preparing audio...',
  'load-model': 'Loading separation model...',
  separate: 'Separating stems...',
  cleanup: 'Cleaning up stems...',
  write: 'Writing files...'
}

// Friendly labels keep backend stem names out of user-facing text.
const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  // The rhythm quality pack separates drums and bass in a single pass.
  'drums+bass': 'Drums and Bass'
}

const visible = computed(() => state.value !== null)
// The backend delivers progress in bursts (websocket flushes stall during sustained inference),
// so drive the bar through a smoothing layer that keeps it moving and snaps to each real value.
const { displayPercent } = useSmoothProgress({
  target: () => state.value?.percent ?? 0,
  active: () => state.value !== null,
  done: () => state.value?.stage === 'write'
})
const percent = computed(() => Math.round(displayPercent.value))
// Once finalising (reading + placing stems), the backend job is done, so there
// is nothing left to cancel — the button is disabled for that phase.
const canCancel = computed(() => state.value?.stage !== 'write')
// Per-stem verbs for the stages that carry a stem name in `detail`.
const STEM_STAGE_VERBS: Partial<Record<StemStage, string>> = {
  separate: 'Separating',
  cleanup: 'Cleaning up'
}
const stageLabel = computed(() => {
  const s = state.value?.stage
  if (!s) return ''
  const detail = state.value?.detail
  if (s === 'prepare' && detail === 'gpu-fallback') {
    return 'GPU unavailable. Continuing on CPU...'
  }
  if (s === 'load-model' && detail && STEM_LABELS[detail]) {
    return `Loading ${STEM_LABELS[detail]} model...`
  }
  const verb = STEM_STAGE_VERBS[s]
  if (verb && detail && STEM_LABELS[detail]) {
    return `${verb} ${STEM_LABELS[detail]}...`
  }
  return STAGE_LABELS[s]
})
const sourceName = computed(() => state.value?.target.sourceName ?? '')

// Cancellation can take a moment to unwind on the backend, so give the click
// immediate feedback: the button flips to a spinning "Cancelling…" affordance
// until the terminal envelope clears the dialog. Reset whenever a new job
// starts (the dialog persists between separations).
const cancelling = ref(false)
watch(
  () => state.value?.jobId,
  () => {
    cancelling.value = false
  }
)

function onCancel(): void {
  const jobId = state.value?.jobId
  if (!jobId || cancelling.value) return
  log.info('stems', 'cancel button clicked')
  cancelling.value = true
  cancelActiveStemSeparation()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop z-1200"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stem-progress-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(440px,88vw)]"
      >
        <div class="dialog-header">
          <h1
            id="stem-progress-title"
            class="dialog-title"
          >
            Separating Stems
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-3">
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-zinc-300">{{ stageLabel }}</span>
            <span class="font-mono text-xs tabular-nums text-zinc-400">{{ percent }}%</span>
          </div>
          <div
            class="h-2 w-full overflow-hidden rounded bg-zinc-800"
            role="progressbar"
            :aria-valuenow="percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full bg-sky-500 transition-[width] duration-150 ease-out"
              :style="{ width: `${percent}%` }"
            />
          </div>
          <div
            class="truncate font-mono text-[10px] text-zinc-500"
            :title="sourceName"
          >
            {{ sourceName }}
          </div>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed"
            :class="
              cancelling
                ? 'border-amber-600 bg-amber-900/40 text-amber-200 hover:bg-amber-900/40'
                : !canCancel
                  ? 'opacity-50'
                  : ''
            "
            :disabled="!canCancel || cancelling"
            @click="onCancel"
          >
            <svg
              v-if="cancelling"
              class="h-3 w-3 animate-spin text-amber-200"
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
            {{ cancelling ? 'Cancelling…' : 'Cancel' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
