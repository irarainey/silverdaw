<script setup lang="ts">
// Modal stem picker shown first when a separation is requested. Lets the user
// choose which of the four stems to extract (all ticked by default); only the
// ticked stems are separated. Driven by the singleton `stemSelection` ref —
// confirming proceeds to the model gate, cancelling dismisses without starting.

import { computed } from 'vue'
import {
  useStemSelection,
  toggleStemSelection,
  setStemQuality,
  confirmStemSelection,
  cancelStemSelection
} from '@/lib/stems/stemSeparationFlow'
import type { StemName, StemQuality } from '@shared/bridge-protocol'

const selection = useStemSelection()

const STEM_ROWS: ReadonlyArray<{ stem: StemName; label: string }> = [
  { stem: 'vocals', label: 'Vocals' },
  { stem: 'drums', label: 'Drums' },
  { stem: 'bass', label: 'Bass' },
  { stem: 'other', label: 'Other' }
]

const QUALITY_OPTIONS: ReadonlyArray<{ value: StemQuality; label: string; hint: string }> = [
  { value: 'fast', label: 'Fast', hint: 'Fastest, with slightly rougher separation.' },
  { value: 'balanced', label: 'Balanced', hint: 'A good balance of quality and speed.' },
  { value: 'best', label: 'Best', hint: 'Cleanest separation, but noticeably slower.' }
]

const visible = computed(() => selection.value !== null)
const sourceName = computed(() => selection.value?.target.sourceName ?? '')
const canStart = computed(() =>
  STEM_ROWS.some((row) => selection.value?.selected[row.stem])
)
const qualityHint = computed(
  () => QUALITY_OPTIONS.find((o) => o.value === selection.value?.quality)?.hint ?? ''
)

function onToggle(stem: StemName): void {
  toggleStemSelection(stem)
}

function onQuality(quality: StemQuality): void {
  setStemQuality(quality)
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

          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
              Quality
            </span>
            <div
              class="flex gap-1"
              role="radiogroup"
              aria-label="Separation quality"
            >
              <button
                v-for="opt in QUALITY_OPTIONS"
                :key="opt.value"
                type="button"
                role="radio"
                :aria-checked="selection?.quality === opt.value"
                class="flex-1 rounded border px-2 py-1.5 text-xs outline-none transition-colors"
                :class="
                  selection?.quality === opt.value
                    ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                    : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800'
                "
                @click="onQuality(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
            <p class="text-xs text-zinc-400">
              {{ qualityHint }}
            </p>
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
