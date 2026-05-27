<script setup lang="ts">
// Modal progress dialog shown while a mixdown render is in flight.
// Driven entirely by the singleton `mixdownState` ref — mounts on the
// first MIXDOWN_PROGRESS / beginMixdown() and dismisses when the
// terminal envelope (DONE / FAILED) clears the state.
//
// The dialog is purposely modal-with-backdrop so the user can't
// interact with the rest of the timeline while a render is happening
// (the backend additionally rejects TRANSPORT_PLAY while busy as a
// belt-and-braces guard, but the visible block matches user
// expectations).

import { computed } from 'vue'
import { useMixdownState, type MixdownStage } from '@/lib/mixdownState'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

const state = useMixdownState()

const STAGE_LABELS: Record<MixdownStage, string> = {
  prepare: 'Preparing render…',
  render: 'Mixing tracks…',
  finalize: 'Finalising file…',
  encode: 'Encoding…'
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
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="mixdown-progress-title"
    >
      <div
        tabindex="-1"
        class="flex w-[min(440px,88vw)] flex-col overflow-hidden rounded-lg border border-cyan-700 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <div class="border-b border-cyan-700 bg-cyan-700/10 px-6 py-3">
          <h1
            id="mixdown-progress-title"
            class="text-sm font-semibold tracking-tight text-cyan-200"
          >
            Exporting mixdown
          </h1>
        </div>

        <div class="flex flex-col gap-3 px-6 py-4 text-sm">
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
            :title="state?.outputPath ?? ''"
          >
            → {{ outputBasename }}
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-950/60 px-6 py-3">
          <button
            type="button"
            class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700"
            @click="onCancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
