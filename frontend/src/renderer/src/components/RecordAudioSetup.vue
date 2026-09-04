<script setup lang="ts">
// Record Audio, before the recording exists: what to capture, where it starts,
// and whether to count in. Everything here is locked while audio is rolling —
// none of it can change under a performance in progress.

import { computed } from 'vue'
import PeakMeter from '@/components/PeakMeter.vue'
import {
  buildChannelOptions,
  buildDeviceOptions,
  channelOptionValue,
  findDeviceOption,
  findDeviceOptionForInput
} from '@/lib/recording/recordingInputOptions'
import type { RecordingSession } from '@/lib/recording/useRecordingSession'
import { useProjectStore } from '@/stores/projectStore'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import {
  MAX_RECORDING_INPUT_GAIN_DB,
  MIN_RECORDING_INPUT_GAIN_DB,
  type RecordingChannelCount
} from '@shared/bridge-protocol'

const props = defineProps<{ session: RecordingSession }>()

const store = useRecordingSessionStore()
const project = useProjectStore()

const deviceOptions = computed(() => buildDeviceOptions(store.inputs))
const openInput = computed(() => store.current?.input ?? null)
const selectedDevice = computed(() => findDeviceOptionForInput(deviceOptions.value, openInput.value))
const selectedDeviceValue = computed(() => selectedDevice.value?.value ?? '')
const channelOptions = computed(() => buildChannelOptions(openInput.value?.channelNames ?? []))
const selectedChannelValue = computed(() =>
  store.current ? channelOptionValue(store.current.firstChannel, store.current.channelCount) : ''
)

const locked = computed(() => store.isRolling)
const hasSelection = computed(() => store.current?.hasSelection === true)
const windowMode = computed(() => store.current?.windowMode ?? 'playhead')
const countInEnabled = computed(() => (store.current?.countInBars ?? 0) > 0)
const inputGainDb = computed(() => store.current?.inputGainDb ?? 0)

const meterSource = (): { peakL: number; peakR: number } => ({
  peakL: store.inputPeakL,
  peakR: store.inputPeakR
})

/** The driver pinned in Preferences, when it offers the chosen device. */
function driverFor(option: { typeName: string; typeNames: string[] }): string {
  const preferred = store.preferredInputTypeName
  return preferred !== null && option.typeNames.includes(preferred) ? preferred : option.typeName
}

function onDeviceChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const option = findDeviceOption(deviceOptions.value, value)
  if (option) props.session.selectInput({ typeName: driverFor(option), deviceName: option.deviceName })
}

function onChannelChange(event: Event): void {
  const option = channelOptions.value.find(
    (candidate) => candidate.value === (event.target as HTMLSelectElement).value
  )
  if (option) props.session.selectChannels(option.firstChannel, option.channelCount)
}

function onGainChange(event: Event): void {
  props.session.setInputGain(Number((event.target as HTMLInputElement).value))
}

function onWindowMode(mode: 'playhead' | 'selection'): void {
  props.session.setWindowMode(mode)
}

function onCountInChange(event: Event): void {
  props.session.setCountInBars((event.target as HTMLInputElement).checked ? 1 : 0)
}

function channelSummary(count: RecordingChannelCount): string {
  return count === 2 ? 'Recording in stereo.' : 'Recording in mono.'
}

// The same project metronome the timeline uses, so the dialog and the K shortcut
// never disagree. A count-in clicks either way.
const metronomeEnabled = computed(() => project.metronomeEnabled)

function onMetronomeChange(event: Event): void {
  project.setMetronomeEnabled((event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="flex flex-col gap-2">
      <h2 class="text-[11px] uppercase tracking-wider text-zinc-500">
        Input
      </h2>
      <select
        class="app-select w-full"
        :disabled="locked || deviceOptions.length === 0"
        aria-label="Recording input device"
        :value="selectedDeviceValue"
        @change="onDeviceChange"
      >
        <option
          v-if="selectedDeviceValue === ''"
          value=""
          disabled
        >
          No input available
        </option>
        <option
          v-for="device in deviceOptions"
          :key="device.value"
          :value="device.value"
        >
          {{ device.deviceName }}
        </option>
      </select>

      <select
        class="app-select w-full"
        :disabled="locked || channelOptions.length === 0"
        aria-label="Recording input channels"
        :value="selectedChannelValue"
        @change="onChannelChange"
      >
        <option
          v-if="channelOptions.length === 0"
          value=""
          disabled
        >
          No channels available
        </option>
        <option
          v-for="option in channelOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>

      <div class="flex items-center gap-3">
        <PeakMeter
          :source="meterSource"
          orientation="horizontal"
          :width="220"
          :height="12"
          :segment-size="3"
          :segment-gap="1"
        />
        <span class="text-xs text-zinc-400">
          {{
            store.current ? channelSummary(store.current.channelCount) : 'Waiting for the input…'
          }}
        </span>
      </div>

      <label class="flex items-center gap-3">
        <span class="w-16 shrink-0 text-xs text-zinc-400">Input gain</span>
        <input
          type="range"
          class="min-w-0 flex-1 cursor-pointer accent-sky-500"
          aria-label="Input gain"
          :min="MIN_RECORDING_INPUT_GAIN_DB"
          :max="MAX_RECORDING_INPUT_GAIN_DB"
          step="0.5"
          :disabled="!store.current"
          :value="inputGainDb"
          @input="onGainChange"
        >
        <span class="w-14 shrink-0 text-right font-mono text-xs text-zinc-400">
          {{ inputGainDb > 0 ? '+' : '' }}{{ inputGainDb.toFixed(1) }} dB
        </span>
      </label>
      <p class="text-xs text-zinc-500">
        Set the level so the meter peaks well short of the end. Gain is applied to what is
        recorded, and can be adjusted while recording.
      </p>
      <p class="text-xs text-zinc-500">
        Silverdaw does not play your input back — listen on headphones, or use your interface's own
        monitoring.
      </p>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-[11px] uppercase tracking-wider text-zinc-500">
        Record Window
      </h2>
      <div class="space-y-2">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            type="radio"
            name="record-window"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
            value="playhead"
            :disabled="locked"
            :checked="windowMode === 'playhead'"
            @change="onWindowMode('playhead')"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">From Playhead</span>
            <span class="text-zinc-500"> — runs until you stop</span>
          </span>
        </label>
        <label
          class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
          :class="hasSelection && !locked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
        >
          <input
            type="radio"
            name="record-window"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
            value="selection"
            :disabled="locked || !hasSelection"
            :checked="windowMode === 'selection'"
            @change="onWindowMode('selection')"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Over the Selected Range</span>
            <span class="text-zinc-500"> — stops at the end of the range</span>
          </span>
        </label>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-[11px] uppercase tracking-wider text-zinc-500">
        Count-In
      </h2>
      <div class="space-y-2">
        <label
          class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
          :class="locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-not-allowed"
            :disabled="locked"
            :checked="countInEnabled"
            @change="onCountInChange"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Count Me In</span>
            <span class="text-zinc-500"> — one bar of clicks before recording</span>
          </span>
        </label>
      </div>
      <label
        class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        :class="locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
      >
        <input
          type="checkbox"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-not-allowed"
          :disabled="locked"
          :checked="metronomeEnabled"
          @change="onMetronomeChange"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">Click While Recording</span>
          <span class="text-zinc-500"> — keeps clicking after the count-in</span>
        </span>
      </label>
      <p class="text-xs text-zinc-500">
        The click is monitoring only and is never captured. This is the same metronome as the
        timeline's.
      </p>
    </section>
  </div>
</template>
