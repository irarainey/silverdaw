<script setup lang="ts">
// Modal stem picker shown first when a separation is requested. Lets the user
// choose which of the four stems to extract (all ticked by default); only the
// ticked stems are separated. Driven by the singleton `stemSelection` ref —
// confirming proceeds to the model gate, cancelling dismisses without starting.

import { computed } from 'vue'
import {
  useStemSelection,
  toggleStemSelection,
  confirmStemSelection,
  cancelStemSelection
} from '@/lib/stems/stemSeparationFlow'
import type { StemName } from '@shared/bridge-protocol'

const selection = useStemSelection()

const STEM_ROWS: ReadonlyArray<{ stem: StemName; label: string }> = [
  { stem: 'vocals', label: 'Vocals' },
  { stem: 'drums', label: 'Drums' },
  { stem: 'bass', label: 'Bass' },
  { stem: 'other', label: 'Other' }
]

const visible = computed(() => selection.value !== null)
const sourceName = computed(() => selection.value?.target.sourceName ?? '')
const canStart = computed(() =>
  STEM_ROWS.some((row) => selection.value?.selected[row.stem])
)

function onToggle(stem: StemName): void {
  toggleStemSelection(stem)
}

function onStart(): void {
  void confirmStemSelection()
}

function onCancel(): void {
  cancelStemSelection()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop z-1200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stem-selection-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(420px,88vw)]"
      >
        <div class="dialog-header">
          <h1
            id="stem-selection-title"
            class="dialog-title"
          >
            Separate stems
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-3">
          <p class="text-sm text-zinc-300">
            Choose which stems to extract from
            <span class="font-medium text-zinc-100">{{ sourceName }}</span>.
          </p>
          <ul class="flex flex-col gap-1">
            <li
              v-for="row in STEM_ROWS"
              :key="row.stem"
            >
              <label
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                <input
                  type="checkbox"
                  class="accent-cyan-500"
                  :checked="selection?.selected[row.stem] ?? false"
                  @change="onToggle(row.stem)"
                >
                {{ row.label }}
              </label>
            </li>
          </ul>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!canStart"
            @click="onStart"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
