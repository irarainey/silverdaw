<script setup lang="ts">
// Modal progress dialog shown while a stem separation runs. Driven by the
// singleton `stemSeparationState` ref: mounts on the first STEM_PROGRESS and
// dismisses when a terminal envelope (READY/FAILED/cancel) clears the state.
// Modal with backdrop so the timeline can't be edited mid-separation.

import { computed } from 'vue'
import { useStemSeparationState, type StemStage } from '@/lib/stemSeparationState'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

const state = useStemSeparationState()

const STAGE_LABELS: Record<StemStage, string> = {
  prepare: 'Preparing audio…',
  separate: 'Separating stems…',
  write: 'Writing files…'
}

// Friendly stem labels so the dialog can show "Drums (2 of 3)" from the backend's
// stem name alone, keeping user-facing wording in the renderer. The counter is
// scoped to the stems the user actually selected (state.stems), not a fixed four.
const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other'
}

const visible = computed(() => state.value !== null)
const percent = computed(() => Math.round(state.value?.percent ?? 0))
const stageLabel = computed(() => {
  const s = state.value?.stage
  if (!s) return ''
  const detail = state.value?.detail
  const selected = state.value?.stems ?? []
  if (s === 'separate' && detail && STEM_LABELS[detail]) {
    const position = (selected as readonly string[]).indexOf(detail) + 1
    const counter = position > 0 ? ` (${position} of ${selected.length})` : ''
    return `Separating ${STEM_LABELS[detail]}${counter}…`
  }
  return STAGE_LABELS[s]
})
const sourceName = computed(() => state.value?.target.sourceName ?? '')

function onCancel(): void {
  const jobId = state.value?.jobId
  if (!jobId) return
  log.info('stems', 'cancel button clicked')
  sendBridge('STEM_SEPARATE_CANCEL', { jobId })
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
            Separating stems
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
              class="h-full bg-cyan-500 transition-[width] duration-150 ease-out"
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
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
