<script setup lang="ts">
// Right-side inspector inside the Clip Editor that exposes the draft
// warp + pitch controls. Pure presentation: the actual draft state
// lives in `useClipEditorWarpDraft` and is passed in via props so this
// component stays trivially testable and the parent dialog can decide
// when (e.g. only for existing-clip targets) to mount it.

import { computed } from 'vue'
import { keyBadgeClass } from '@/lib/keyBadge'
import { keyPresetsFor, shiftedKey } from '@/lib/pitchKey'
import type { ClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'
import type { ClipWarpMode } from '@shared/bridge-protocol'

const props = defineProps<{
  draft: ClipEditorWarpDraft
  sourceBpm: number | undefined
  sourceKey: string | undefined
  projectBpm: number
  /** Drives the "Saving updates …" footnote: linked-clip edits affect
   *  every linked timeline instance, unlinked edits affect only that
   *  clip. */
  editsSavedClipLibrary: boolean
}>()

const WARP_MODES: ClipWarpMode[] = ['rhythmic', 'tonal', 'complex']

// Alias the draft's refs into local consts so the template never
// reaches through the `draft` prop directly. This keeps the
// `vue/no-mutating-props` lint rule happy — writing to a ref's
// `.value` is correct, but ESLint can't tell the difference when the
// ref is accessed via a prop path.
const draftTempoEnabled = props.draft.draftTempoEnabled
const draftMode = props.draft.draftMode
const draftPinnedBpm = props.draft.draftPinnedBpm
const draftSemitones = props.draft.draftSemitones
const draftCents = props.draft.draftCents
const draftEffectiveBpm = props.draft.draftEffectiveBpm
const draftEffectiveRatio = props.draft.draftEffectiveRatio
const tempoFollowsProject = props.draft.tempoFollowsProject
const followProjectBpm = props.draft.followProjectBpm
const pinTempo = props.draft.pinTempo
const applyKeyPreset = props.draft.applyKeyPreset

const keyPresets = computed(() => keyPresetsFor(props.sourceKey))
const currentPitchKey = computed(() =>
  shiftedKey(props.sourceKey, draftSemitones.value, draftCents.value)
)
</script>

<template>
  <aside
    class="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/40 p-4 text-xs"
  >
    <div>
      <h3 class="text-sm font-semibold text-zinc-100">
        Clip settings
      </h3>
      <p class="mt-1 text-[11px] leading-4 text-zinc-500">
        Changes are preview-only until Save.
        <template v-if="editsSavedClipLibrary">
          Saving updates every linked timeline clip.
        </template>
        <template v-else>
          Saving updates only this timeline clip.
        </template>
      </p>
    </div>

    <section class="rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <label class="flex items-center gap-2 text-zinc-200">
        <input
          v-model="draftTempoEnabled"
          type="checkbox"
          class="h-3.5 w-3.5 cursor-pointer"
        >
        <span class="font-medium">Enable Warp</span>
      </label>

      <div class="mt-3 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-zinc-400">
        <div>
          <div class="text-[10px] uppercase tracking-wider text-zinc-500">
            Source BPM
          </div>
          <div class="font-mono text-zinc-200">
            {{ sourceBpm ? sourceBpm.toFixed(2) : '—' }}
          </div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-zinc-500">
            Effective BPM
          </div>
          <div class="font-mono text-zinc-200">
            {{ draftEffectiveBpm !== null ? draftEffectiveBpm.toFixed(2) : '—' }}
            <span class="ml-1 text-[10px] text-zinc-500">
              ({{ draftEffectiveRatio.toFixed(2) }}×)
            </span>
          </div>
        </div>
      </div>

      <fieldset
        class="mt-3 flex flex-col gap-1"
        :disabled="!draftTempoEnabled"
        :class="!draftTempoEnabled ? 'opacity-50' : ''"
      >
        <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
          Mode
        </legend>
        <div class="flex gap-1">
          <button
            v-for="m in WARP_MODES"
            :key="m"
            type="button"
            class="flex-1 rounded border px-2 py-1 text-xs capitalize transition-colors"
            :class="draftMode === m
              ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
              : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            "
            @click="draftMode = m"
          >
            {{ m }}
          </button>
        </div>
      </fieldset>

      <fieldset
        class="mt-3 flex flex-col gap-1"
        :disabled="!draftTempoEnabled || !sourceBpm"
        :class="!draftTempoEnabled || !sourceBpm ? 'opacity-50' : ''"
      >
        <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
          Tempo
        </legend>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            :checked="tempoFollowsProject"
            @change="followProjectBpm()"
          >
          <span class="text-zinc-200">Follow project BPM</span>
          <span class="ml-auto text-[10px] text-zinc-500">
            ({{ projectBpm.toFixed(2) }})
          </span>
        </label>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            :checked="!tempoFollowsProject"
            @change="pinTempo()"
          >
          <span class="text-zinc-200">Pin to</span>
          <input
            v-model.number="draftPinnedBpm"
            type="number"
            min="20"
            max="300"
            step="0.01"
            :disabled="tempoFollowsProject"
            class="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none disabled:opacity-50"
          >
          <span class="text-[10px] text-zinc-500">BPM</span>
        </label>
      </fieldset>
    </section>

    <section class="rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <div class="font-medium text-zinc-200">
        Pitch shift
      </div>
      <fieldset class="mt-3 flex flex-col gap-2">
        <label class="flex items-center gap-2">
          <span class="w-16 text-zinc-400">Semitones</span>
          <input
            v-model.number="draftSemitones"
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
        class="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400"
      >
        Current pitch:
        <span :class="keyBadgeClass(currentPitchKey)">{{ currentPitchKey }}</span>
      </div>

      <div class="mt-3 rounded border border-zinc-800 bg-zinc-950/50 p-3">
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
    </section>
  </aside>
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
