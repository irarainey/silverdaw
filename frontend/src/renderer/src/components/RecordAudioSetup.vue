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
  MIN_RECORDING_INPUT_GAIN_DB
} from '@shared/bridge-protocol'

const props = defineProps<{ session: RecordingSession }>()

const store = useRecordingSessionStore()
const project = useProjectStore()

// What the take is played along to. The selection starts as whatever the
// timeline is currently playing — mute and solo folded in — but from there it is
// the dialog's own: a muted track can be brought in for a single take, and the
// arrangement is handed straight back when the dialog closes.
const backingTracks = computed(() =>
  project.tracks.map((track) => ({
    id: track.id,
    name: track.name,
    silenced: track.muted || (project.anySoloed && !track.soloed)
  }))
)
const backingSelection = computed(() => new Set(store.current?.backingTrackIds ?? []))
const selectedBackingCount = computed(
  () => backingTracks.value.filter((track) => backingSelection.value.has(track.id)).length
)

function toggleBackingTrack(trackId: string): void {
  const next = new Set(backingSelection.value)
  if (next.has(trackId)) next.delete(trackId)
  else next.add(trackId)
  props.session.setBackingTracks([...next])
}

function selectAllBacking(): void {
  props.session.setBackingTracks(backingTracks.value.map((track) => track.id))
}

function selectNoBacking(): void {
  props.session.setBackingTracks([])
}

// How loud the backing sits under the performer. Monitoring only, so unlike the
// track selection it stays live while rolling: someone who cannot hear
// themselves over the arrangement should not have to stop to fix it.
const backingGain = computed(() => store.current?.backingGain ?? 1)
const backingGainPercent = computed(() => Math.round(backingGain.value * 100))

function onBackingGainChange(event: Event): void {
  props.session.setBackingGain(Number((event.target as HTMLInputElement).value) / 100)
}

function onBackingGainReset(): void {
  props.session.setBackingGain(1)
}

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

/** Double-click resets to unity, matching the pan and FX controls. */
function onGainReset(): void {
  props.session.setInputGain(0)
}

function onWindowMode(mode: 'playhead' | 'selection'): void {
  props.session.setWindowMode(mode)
}

function onCountInChange(event: Event): void {
  props.session.setCountInBars((event.target as HTMLInputElement).checked ? 1 : 0)
}

// The click is the session's own, seeded from the project's metronome when the
// dialog opens: recording with a click is not a reason for the timeline's
// metronome to be left on afterwards.
const clickEnabled = computed(() => store.current?.clickEnabled === true)

function onMetronomeChange(event: Event): void {
  props.session.setClickEnabled((event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="flex flex-col gap-5 text-xs leading-relaxed">
    <section class="flex flex-col gap-2">
      <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
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

      <div class="flex justify-end">
        <button
          type="button"
          :disabled="locked || store.rescanningInputs"
          class="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          @click="props.session.rescanInputs()"
        >
          <svg
            v-if="store.rescanningInputs"
            class="h-3 w-3 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {{ store.rescanningInputs ? 'Rescanning…' : 'Rescan devices' }}
        </button>
      </div>

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
        <span class="w-16 shrink-0 text-zinc-400">Level</span>
        <PeakMeter
          :source="meterSource"
          orientation="horizontal"
          :width="220"
          :height="12"
          :segment-size="3"
          :segment-gap="1"
        />
      </div>

      <label class="flex items-center gap-3">
        <span class="w-16 shrink-0 text-zinc-400">Input gain</span>
        <input
          type="range"
          class="app-range min-w-0 flex-1"
          aria-label="Input gain"
          :min="MIN_RECORDING_INPUT_GAIN_DB"
          :max="MAX_RECORDING_INPUT_GAIN_DB"
          step="0.5"
          :disabled="!store.current"
          :value="inputGainDb"
          title="Double-click to reset to 0 dB"
          @input="onGainChange"
          @dblclick="onGainReset"
        >
        <span class="w-14 shrink-0 text-right font-mono text-xs text-zinc-400">
          {{ inputGainDb > 0 ? '+' : '' }}{{ inputGainDb.toFixed(1) }} dB
        </span>
      </label>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
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
      <div class="flex items-center justify-between">
        <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          Backing
        </h2>
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] tabular-nums text-zinc-500">
            {{ selectedBackingCount }} of {{ backingTracks.length }}
          </span>
          <button
            type="button"
            class="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="locked || backingTracks.length === 0"
            @click="selectAllBacking"
          >
            All
          </button>
          <button
            type="button"
            class="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="locked || backingTracks.length === 0"
            @click="selectNoBacking"
          >
            None
          </button>
        </div>
      </div>
      <p
        v-if="backingTracks.length === 0"
        class="text-xs text-zinc-500"
      >
        There are no tracks to play along to yet.
      </p>
      <div
        v-else
        class="silverdaw-scroll max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-1"
      >
        <label
          v-for="track in backingTracks"
          :key="track.id"
          class="flex items-center gap-3 rounded px-2 py-1.5 text-xs"
          :class="locked
            ? 'cursor-not-allowed text-zinc-600'
            : 'cursor-pointer text-zinc-200 hover:bg-zinc-900'"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-sky-500 disabled:cursor-not-allowed"
            :disabled="locked"
            :checked="backingSelection.has(track.id)"
            @change="toggleBackingTrack(track.id)"
          >
          <span class="min-w-0 flex-1 truncate">{{ track.name }}</span>
          <span
            v-if="track.silenced"
            class="shrink-0 text-[10px] uppercase tracking-wider text-zinc-500"
          >Muted</span>
        </label>
      </div>

      <label
        v-if="backingTracks.length > 0"
        class="flex items-center gap-3"
      >
        <span class="w-16 shrink-0 text-zinc-400">Volume</span>
        <input
          type="range"
          class="app-range min-w-0 flex-1"
          aria-label="Backing volume"
          min="0"
          max="100"
          step="1"
          :disabled="!store.current"
          :value="backingGainPercent"
          title="Double-click to reset to 100%"
          @input="onBackingGainChange"
          @dblclick="onBackingGainReset"
        >
        <span class="w-14 shrink-0 text-right font-mono text-xs text-zinc-400">
          {{ backingGainPercent }}%
        </span>
      </label>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Metronome
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
        <label
          class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
          :class="locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-not-allowed"
            :disabled="locked"
            :checked="clickEnabled"
            @change="onMetronomeChange"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Click While Recording</span>
            <span class="text-zinc-500"> — keeps clicking after the count-in</span>
          </span>
        </label>
      </div>
    </section>
  </div>
</template>
