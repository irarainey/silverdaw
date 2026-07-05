<script setup lang="ts">
// Pitch-shift controls inside the Clip Editor effects rack. Pure
// presentation: the draft state lives in `useClipEditorWarpDraft` and is
// passed in via props (shared with the sibling warp panel).

import { computed } from 'vue'
import { keyBadgeClass } from '@/lib/keyBadge'
import { keyPresetsFor, shiftedKey } from '@/lib/pitchKey'
import type { ClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'

const props = defineProps<{
  draft: ClipEditorWarpDraft
  sourceKey: string | undefined
}>()

// Alias the draft's refs into local consts so the template never reaches
// through the `draft` prop directly, keeping `vue/no-mutating-props` happy.
const draftSemitones = props.draft.draftSemitones
const draftCents = props.draft.draftCents
const applyKeyPreset = props.draft.applyKeyPreset

const keyPresets = computed(() => keyPresetsFor(props.sourceKey))
const currentPitchKey = computed(() =>
  shiftedKey(props.sourceKey, draftSemitones.value, draftCents.value)
)
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <fieldset class="flex flex-col gap-2">
      <label class="flex items-center gap-2">
        <span class="w-16 text-zinc-400">Semitones</span>
        <input
          v-model.number="draftSemitones"
          v-slider-detent="{ value: 0, reset: true }"
          type="range"
          min="-12"
          max="12"
          step="1"
          class="pitch-range-input h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700"
        >
        <span class="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-200">
          {{ draftSemitones > 0 ? '+' : '' }}{{ draftSemitones }}
        </span>
      </label>
      <label class="flex items-center gap-2">
        <span class="w-16 text-zinc-400">Cents</span>
        <input
          v-model.number="draftCents"
          v-slider-detent="{ value: 0, reset: true }"
          type="range"
          min="-100"
          max="100"
          step="1"
          class="pitch-range-input h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700"
        >
        <span class="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-200">
          {{ draftCents > 0 ? '+' : '' }}{{ draftCents }}
        </span>
      </label>
    </fieldset>

    <div
      v-if="currentPitchKey"
      class="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400"
    >
      Current pitch:
      <span :class="keyBadgeClass(currentPitchKey)">{{ currentPitchKey }}</span>
    </div>

    <div class="rounded border border-zinc-800 bg-zinc-950/50 p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500">
          Key presets
        </div>
        <div
          v-if="sourceKey"
          class="text-[10px] text-zinc-500"
        >
          Source: <span :class="keyBadgeClass(sourceKey)">{{ sourceKey }}</span>
        </div>
      </div>
      <div
        v-if="keyPresets.length > 0"
        class="grid grid-cols-4 gap-1"
      >
        <button
          v-for="preset in keyPresets"
          :key="preset.note"
          type="button"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          :title="`${sourceKey} → ${preset.label} (${preset.semitones > 0 ? '+' : ''}${preset.semitones} semitones)`"
          @click="applyKeyPreset(preset.semitones)"
        >
          {{ preset.label.replace(' major', '').replace(' minor', 'm') }}
        </button>
      </div>
      <p
        v-else
        class="text-[11px] text-zinc-500"
      >
        No source key has been detected yet. Reanalyse the source file to generate key presets.
      </p>
    </div>
  </div>
</template>

<style scoped>
.pitch-range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
  margin-top: -5px;
}

.pitch-range-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.pitch-range-input::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}

.pitch-range-input::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>
