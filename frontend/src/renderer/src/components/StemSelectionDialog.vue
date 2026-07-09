<script setup lang="ts">
// Modal stem picker shown first when a separation is requested. Lets the user
// choose which of the four stems to extract (all ticked by default); only the
// ticked stems are separated. Driven by the singleton `stemSelection` ref —
// confirming proceeds to the model gate, cancelling dismisses without starting.

import { computed } from 'vue'
import {
  useStemSelection,
  toggleStemSelection,
  toggleStemDereverb,
  setStemDereverbStrength,
  setStemQuality,
  confirmStemSelection,
  cancelStemSelection
} from '@/lib/stems/stemSeparationFlow'
import type { StemName, StemQuality, DereverbStrength } from '@shared/bridge-protocol'

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
// Dereverb only affects the vocals stem, so the option is only offered when vocals
// are being extracted.
const vocalsSelected = computed(() => selection.value?.selected.vocals ?? false)
// The strength buttons stay visible but inert until reverb removal is actually on.
const dereverbEnabled = computed(() => vocalsSelected.value && (selection.value?.dereverb ?? false))
const qualityHint = computed(
  () => QUALITY_OPTIONS.find((o) => o.value === selection.value?.quality)?.hint ?? ''
)

function onToggle(stem: StemName): void {
  toggleStemSelection(stem)
}

function onQuality(quality: StemQuality): void {
  setStemQuality(quality)
}

function onToggleDereverb(): void {
  toggleStemDereverb()
}

const DEREVERB_STRENGTHS: ReadonlyArray<{ value: DereverbStrength; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' }
]

function onDereverbStrength(strength: DereverbStrength): void {
  setStemDereverbStrength(strength)
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
            Separate Stems
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
              <label
                v-if="row.stem === 'vocals'"
                class="ml-7 flex items-center gap-2 rounded px-2 py-1 text-sm"
                :class="vocalsSelected
                  ? 'cursor-pointer text-zinc-300 hover:bg-zinc-800'
                  : 'cursor-not-allowed text-zinc-500 opacity-60'"
                title="Reduce room reverb and slap-back echo on the vocals stem. Chosen per run — not saved."
              >
                <input
                  type="checkbox"
                  class="accent-cyan-500"
                  :checked="selection?.dereverb ?? false"
                  :disabled="!vocalsSelected"
                  @change="onToggleDereverb"
                >
                Remove Reverb &amp; Echo
              </label>
              <div
                v-if="row.stem === 'vocals'"
                class="ml-7 flex gap-1 pb-1"
                role="radiogroup"
                aria-label="Reverb removal strength"
              >
                <button
                  v-for="opt in DEREVERB_STRENGTHS"
                  :key="opt.value"
                  type="button"
                  role="radio"
                  :aria-checked="selection?.dereverbStrength === opt.value"
                  :disabled="!dereverbEnabled"
                  class="flex-1 rounded border px-2 py-1 text-xs outline-none transition-colors"
                  :class="[
                    dereverbEnabled ? '' : 'cursor-not-allowed opacity-50',
                    selection?.dereverbStrength === opt.value
                      ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                      : 'border-zinc-700 bg-zinc-950 text-zinc-300'
                        + (dereverbEnabled ? ' hover:bg-zinc-800' : '')
                  ]"
                  @click="onDereverbStrength(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
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
