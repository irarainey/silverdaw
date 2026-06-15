<script setup lang="ts">
import { ref } from 'vue'
import {
  useProjectPropertiesController,
  type ProjectPropertiesProps
} from '@/lib/app/useProjectPropertiesController'

const props = defineProps<ProjectPropertiesProps>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)

const {
  BPM_MIN,
  BPM_MAX,
  BAR_COUNTER_START_MIN,
  BAR_COUNTER_START_MAX,
  draftName,
  draftBpm,
  draftDurationText,
  draftSampleRate,
  draftBarCounterStart,
  draftAudioDeviceName,
  minDurationLabel,
  deviceOptions,
  driverOptions,
  draftAudioDeviceValue,
  draftAudioTypeValue,
  nameError,
  bpmError,
  durationError,
  barCounterStartError,
  canSave,
  onSave,
  onCancel,
  onKeydown
} = useProjectPropertiesController(props, emit, nameInputRef)
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
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-properties-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(480px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="project-properties-title"
            class="dialog-title"
          >
            Project properties
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-4">
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project name</span>
            <input
              ref="nameInputRef"
              v-model="draftName"
              type="text"
              maxlength="120"
              class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="nameError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="nameError"
              class="text-[11px] text-red-400"
            >{{ nameError }}</span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Tempo (BPM)</span>
            <input
              v-model.number="draftBpm"
              type="number"
              :min="BPM_MIN"
              :max="BPM_MAX"
              step="0.01"
              class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="bpmError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="bpmError"
              class="text-[11px] text-red-400"
            >{{ bpmError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Range {{ BPM_MIN }} – {{ BPM_MAX }}. Affects warp + grid layout immediately.</span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project duration</span>
            <input
              v-model="draftDurationText"
              type="text"
              inputmode="numeric"
              placeholder="mm:ss or h:mm:ss"
              class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="durationError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="durationError"
              class="text-[11px] text-red-400"
            >{{ durationError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Minimum {{ minDurationLabel }} (the end of the last clip).</span>
          </label>

          <!-- Project sample rate; engine resampling covers playback today. -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Sample rate</span>
            <select
              v-model.number="draftSampleRate"
              class="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
            >
              <option :value="44100">44 100 Hz</option>
              <option :value="48000">48 000 Hz</option>
            </select>
            <span class="text-[11px] text-zinc-500">
              Set the application default for new projects in <span class="text-zinc-300">Preferences ▸ Audio</span>.
            </span>
          </label>

          <!-- Bar counter start: the first bar's number; 0 or lower adds lead-in bars before bar one. -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Bar counter start</span>
            <input
              v-model.number="draftBarCounterStart"
              type="number"
              :min="BAR_COUNTER_START_MIN"
              :max="BAR_COUNTER_START_MAX"
              step="1"
              class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="barCounterStartError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="barCounterStartError"
              class="text-[11px] text-red-400"
            >{{ barCounterStartError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >The number shown for the first bar. 1 is the default; set 0 or lower to add lead-in bars before bar one.</span>
          </label>

          <!-- Audio output: device primary, driver override secondary. -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Audio device</span>
            <select
              v-model="draftAudioDeviceValue"
              class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
            >
              <option
                v-for="opt in deviceOptions"
                :key="opt.value || 'system-default'"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <span class="text-[11px] text-zinc-500">
              Applied on every project load. Selecting <span class="text-zinc-300">System default</span> clears the project override so the global Preferences ▸ Audio device applies instead.
            </span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Audio driver</span>
            <select
              v-model="draftAudioTypeValue"
              :disabled="draftAudioDeviceName === null"
              class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option
                v-for="opt in driverOptions"
                :key="opt.value || 'system-default'"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </label>
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
            :disabled="!canSave"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Hide native number spinners; TransportBar already provides nudges. */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
