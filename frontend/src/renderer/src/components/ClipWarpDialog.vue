<script setup lang="ts">
import { ref } from 'vue'
import { useClipWarpDialogController, type ClipWarpDialogProps } from '@/lib/clipEditor/useClipWarpDialogController'
import { useInlineNumberEdit } from '@/lib/useInlineNumberEdit'
import type { ClipWarpMode } from '@shared/bridge-protocol'

const props = withDefaults(defineProps<ClipWarpDialogProps>(), { clipId: null, itemId: null, panel: 'tempo' })
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)

const {
  clip,
  libItem,
  sourceBpm,
  projectBpm,
  dialogTitle,
  isLinkedTarget,
  clipTitle,
  draftEnabled,
  draftMode,
  draftPinnedBpm,
  draftSemitones,
  draftCents,
  sourceKey,
  keyPresets,
  currentPitchKey,
  tempoFollowsProject,
  followProjectBpm,
  pinTempo,
  applyKeyPreset,
  effectiveRatio,
  effectiveBpm,
  keyBadgeClass,
  save,
  cancel,
  onKeydown
} = useClipWarpDialogController(props, emit, dialogEl)

// Double-click the readouts to type an exact value; Enter commits, Escape cancels.
const {
  editing: semitonesEditing,
  text: semitonesText,
  inputRef: semitonesInputRef,
  begin: beginSemitonesEdit,
  commit: commitSemitonesEdit,
  onKeydown: onSemitonesKeydown
} = useInlineNumberEdit({
  get: () => draftSemitones.value,
  set: (v) => { draftSemitones.value = v },
  min: -12,
  max: 12
})
const {
  editing: centsEditing,
  text: centsText,
  inputRef: centsInputRef,
  begin: beginCentsEdit,
  commit: commitCentsEdit,
  onKeydown: onCentsKeydown
} = useInlineNumberEdit({
  get: () => draftCents.value,
  set: (v) => { draftCents.value = v },
  min: -100,
  max: 100
})
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open && (clip || libItem)"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-warp-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(440px,92vw)]"
        @keydown="onKeydown"
      >
        <!-- Header -->
        <div class="dialog-header">
          <h1
            id="clip-warp-title"
            class="dialog-title truncate"
          >
            {{ dialogTitle }}
            <span class="ml-2 truncate text-xs font-normal text-zinc-500">
              {{ clipTitle }}
            </span>
          </h1>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-4 px-5 py-4 text-xs">
          <!-- Enabled toggle -->
          <label class="flex items-center gap-2 text-zinc-200">
            <template v-if="panel === 'tempo'">
              <input
                v-model="draftEnabled"
                type="checkbox"
                class="h-3.5 w-3.5 cursor-pointer"
              >
              <span class="font-medium">Enable Warp</span>
            </template>
            <template v-else>
              <span class="font-medium">Pitch shift</span>
            </template>
          </label>

          <!-- Source / project BPM readout -->
          <div
            v-if="panel === 'tempo'"
            class="grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-zinc-400"
          >
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
                {{ effectiveBpm !== null ? effectiveBpm.toFixed(2) : '—' }}
                <span class="ml-1 text-[10px] text-zinc-500">
                  ({{ effectiveRatio.toFixed(2) }}×)
                </span>
              </div>
            </div>
          </div>

          <!-- Mode picker -->
          <fieldset
            v-if="panel === 'tempo'"
            class="flex flex-col gap-1"
            :disabled="!draftEnabled"
            :class="!draftEnabled ? 'opacity-50' : ''"
          >
            <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              Mode
            </legend>
            <div class="flex gap-1">
              <button
                v-for="m in (['rhythmic', 'tonal', 'complex'] as ClipWarpMode[])"
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

          <!-- Tempo source -->
          <fieldset
            v-if="panel === 'tempo'"
            class="flex flex-col gap-1"
            :disabled="!draftEnabled || !sourceBpm"
            :class="!draftEnabled || !sourceBpm ? 'opacity-50' : ''"
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
            <div
              v-if="!sourceBpm"
              class="mt-1 text-[10px] text-amber-400"
            >
              Source BPM not detected yet — pinning unavailable until analysis completes.
            </div>
          </fieldset>

          <!-- Pitch shift -->
          <fieldset
            v-if="panel === 'pitch'"
            class="flex flex-col gap-2"
          >
            <label class="flex items-center gap-2">
              <span class="w-16 text-zinc-400">Semitones</span>
              <input
                v-model.number="draftSemitones"
                v-slider-detent="{ value: 0, reset: true }"
                type="range"
                min="-12"
                max="12"
                step="1"
                class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 outline-none focus:outline-none focus-visible:outline-none"
              >
              <input
                v-if="semitonesEditing"
                ref="semitonesInputRef"
                v-model="semitonesText"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                autocomplete="off"
                aria-label="Semitones"
                class="w-10 rounded border border-zinc-600 bg-zinc-950 px-0.5 py-px text-right font-mono text-[11px] tabular-nums text-zinc-100 outline-none focus:border-sky-500"
                @keydown="onSemitonesKeydown"
                @blur="commitSemitonesEdit"
              >
              <span
                v-else
                class="w-10 cursor-text text-right font-mono text-[11px] tabular-nums text-zinc-200"
                title="Double-click to type a value"
                @dblclick="beginSemitonesEdit"
              >
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
                class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 outline-none focus:outline-none focus-visible:outline-none"
              >
              <input
                v-if="centsEditing"
                ref="centsInputRef"
                v-model="centsText"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                autocomplete="off"
                aria-label="Cents"
                class="w-10 rounded border border-zinc-600 bg-zinc-950 px-0.5 py-px text-right font-mono text-[11px] tabular-nums text-zinc-100 outline-none focus:border-sky-500"
                @keydown="onCentsKeydown"
                @blur="commitCentsEdit"
              >
              <span
                v-else
                class="w-10 cursor-text text-right font-mono text-[11px] tabular-nums text-zinc-200"
                title="Double-click to type a value"
                @dblclick="beginCentsEdit"
              >
                {{ draftCents > 0 ? '+' : '' }}{{ draftCents }}
              </span>
            </label>
            <div
              v-if="currentPitchKey"
              class="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400"
            >
              Current pitch:
              <span :class="keyBadgeClass(currentPitchKey)">{{ currentPitchKey }}</span>
            </div>
            <div class="mt-2 rounded border border-zinc-800 bg-zinc-950/50 p-3">
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
          </fieldset>
        </div>

        <!-- Footer -->
        <div class="dialog-footer">
          <p
            v-if="isLinkedTarget"
            class="mr-auto max-w-[60%] text-[11px] leading-4 text-zinc-500"
          >
            Saving updates the library entry and every linked timeline clip.
          </p>
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            @click="save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Range thumb styled to match the rest of the chrome (cribbed from
   TrackHeaderPanel's track-volume slider). */
input[type='range']::-webkit-slider-thumb {
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
input[type='range']::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}
input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
input[type='range']::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>
