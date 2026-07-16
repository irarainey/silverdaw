<script setup lang="ts">
// Modal progress dialog shown while a mixdown render is in flight. Driven by
// the singleton `mixdownState` ref: mounts on the first MIXDOWN_PROGRESS and
// dismisses when the terminal envelope (DONE/FAILED) clears the state. Modal
// with backdrop so the timeline can't be edited mid-render.

import { computed } from 'vue'
import { useMixdownState, type MixdownStage } from '@/lib/mixdownState'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

const state = useMixdownState()

const STAGE_LABELS: Record<MixdownStage, string> = {
  prepare: 'Preparing render…',
  render: 'Mixing tracks…',
  finalize: 'Finalising file…',
  encode: 'Encoding…',
  analyze: 'Measuring loudness…',
  'normalize-pass1': 'Measuring loudness…',
  'normalize-pass2': 'Adjusting levels…'
}

const visible = computed(() => state.value !== null)
const percent = computed(() => Math.round(state.value?.percent ?? 0))
const stageLabel = computed(() => {
  const s = state.value?.stage
  return s ? STAGE_LABELS[s] : ''
})
const outputBasename = computed(() => {
  const p = state.value?.outputPath ?? ''
  return p.replace(/^.*[\\/]/, '')
})

function onCancel(): void {
  log.info('mixdown', 'cancel button clicked')
  sendBridge('MIXDOWN_CANCEL')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop z-1200"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="mixdown-progress-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(440px,88vw)]"
      >
        <div class="dialog-header">
          <h1
            id="mixdown-progress-title"
            class="dialog-title"
          >
            Exporting Mixdown
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
            :title="state?.outputPath ?? ''"
          >
            → {{ outputBasename }}
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
