<script setup lang="ts">
// Record Audio, before the recording exists: what to capture, where it starts,
// and whether to count in. Everything here is locked while audio is rolling —
// none of it can change under a performance in progress.

import { computed } from 'vue'
import BusySpinner from '@/components/BusySpinner.vue'
import PeakMeter from '@/components/PeakMeter.vue'
import RecordAudioLiveWaveform from '@/components/RecordAudioLiveWaveform.vue'
import {
  buildChannelOptions,
  buildDeviceOptions,
  channelOptionValue,
  deviceOptionValue,
  findDeviceOption,
  findDeviceOptionForInput
} from '@/lib/recording/recordingInputOptions'
import type { RecordingSession } from '@/lib/recording/useRecordingSession'
import { useProjectStore } from '@/stores/projectStore'
import { isTrackSilenced } from '@/stores/projectTypes'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import {
  MAX_RECORDING_INPUT_GAIN_DB,
  MIN_RECORDING_INPUT_GAIN_DB
} from '@shared/bridge-protocol'

const props = defineProps<{ session: RecordingSession }>()
const emit = defineEmits<{ calibrate: [] }>()

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
    silenced: isTrackSilenced(track, project.anySoloed)
  }))
)
const backingSelection = computed(
  () => new Set(store.current?.backingTrackIds ?? store.rememberedBackingTrackIds ?? [])
)
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
const backingGain = computed(() => store.current?.backingGain ?? store.rememberedBackingGain ?? 1)
const backingGainPercent = computed(() => Math.round(backingGain.value * 100))

function onBackingGainChange(event: Event): void {
  props.session.setBackingGain(Number((event.target as HTMLInputElement).value) / 100)
}

function onBackingGainReset(): void {
  props.session.setBackingGain(1)
}

const deviceOptions = computed(() => buildDeviceOptions(store.inputs))
const openInput = computed(() => store.current?.input ?? null)
// Until the session reports which device it opened, show the one it was asked
// for. The picker is otherwise empty for as long as the scan takes, which reads
// as "no microphone" at the exact moment someone is about to record.
const displayInput = computed(() => openInput.value ?? store.rememberedInput)
const selectedDevice = computed(() =>
  findDeviceOptionForInput(deviceOptions.value, displayInput.value)
)
const selectedDeviceValue = computed(
  () =>
    selectedDevice.value?.value ??
    (displayInput.value ? deviceOptionValue(displayInput.value.deviceName) : '')
)
// A stand-in row for a device the list cannot name yet. It disappears the moment
// the real option exists, so the picker never carries the same device twice.
const pendingDeviceName = computed(() =>
  selectedDevice.value === null && displayInput.value !== null
    ? displayInput.value.deviceName
    : ''
)
// Channels come from the device the session actually opened — a remembered name
// says nothing about how many inputs it has.
const channelOptions = computed(() => buildChannelOptions(openInput.value?.channelNames ?? []))
const selectedChannelValue = computed(() =>
  store.current ? channelOptionValue(store.current.firstChannel, store.current.channelCount) : ''
)

// Every setting below falls back to what this app session last used rather than
// to a hardcoded default. The session re-applies exactly these values the moment
// it opens, so showing them straight away is showing the truth early — not a
// guess that snaps to something else a moment later.
const locked = computed(() => store.isRolling)
const hasSelection = computed(() => store.current?.hasSelection === true)
const windowMode = computed(
  () => store.current?.windowMode ?? store.rememberedWindowMode ?? 'start'
)
const countInEnabled = computed(
  () => (store.current?.countInBars ?? store.rememberedCountInBars ?? 0) > 0
)
const inputGainDb = computed(() => store.current?.inputGainDb ?? store.rememberedInputGainDb)
const recordingMode = computed(
  () => store.current?.recordingMode ?? store.rememberedRecordingMode ?? 'music'
)
const monitorEnabled = computed(
  () => store.current?.monitorEnabled ?? store.rememberedMonitorEnabled ?? false
)
const cleanupEnabled = computed(
  () => store.current?.cleanupEnabled ?? store.rememberedCleanupEnabled ?? false
)

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

function onWindowMode(mode: 'playhead' | 'start' | 'selection'): void {
  props.session.setWindowMode(mode)
}

function onCountInChange(event: Event): void {
  props.session.setCountInBars((event.target as HTMLInputElement).checked ? 1 : 0)
}

// The click is the session's own, seeded from the project's metronome when the
// dialog opens: recording with a click is not a reason for the timeline's
// metronome to be left on afterwards.
const clickEnabled = computed(
  () => store.current?.clickEnabled ?? store.rememberedClickEnabled ?? false
)

function onMetronomeChange(event: Event): void {
  props.session.setClickEnabled((event.target as HTMLInputElement).checked)
}

// What the take is committed as. It changes nothing about the capture, only
// whether the finished clip carries the project's tempo and beat markers, so it
// stays live even while rolling.
function onRecordingMode(mode: 'music' | 'simple'): void {
  props.session.setRecordingMode(mode)
}

function onMonitorChange(event: Event): void {
  props.session.setMonitorEnabled((event.target as HTMLInputElement).checked)
}

function onCleanupChange(event: Event): void {
  props.session.setCleanupEnabled((event.target as HTMLInputElement).checked)
}

// Recording latency (ADR 0030, Amendment 17). Shown here because it is a property of the input
// the user has just chosen, and stated plainly whether it is set or not — an uncalibrated setup
// records late, so hiding that would leave the user hunting for a fault in their playing.
const calibration = computed(() => store.activeCalibration)
const calibrationLabel = computed(() => {
  if (store.current?.input == null) return 'Waiting for the input…'
  const stored = calibration.value
  if (stored === null) {
    return 'Uncalibrated · using driver estimate'
  }
  if (store.isCalibrationStale) return `${Math.round(stored.roundTripMs)} ms · sample rate changed`
  return `${Math.round(stored.roundTripMs)} ms${stored.manual ? ' · entered by hand' : ''}`
})
</script>

<template>
  <div class="flex flex-col gap-4 text-xs leading-relaxed">
    <RecordAudioLiveWaveform :musical="recordingMode === 'music'" />

    <div class="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
      <!-- Each row of the grid stretches its two cells to the same height, so the
           bottom row of Input lines up with the bottom row of Backing — Gain
           opposite Volume — and the option stacks below them end level in turn.
           The headings stay tight to what follows them: any slack collects at
           `mt-auto`, above the row that has to stay pinned to the bottom. -->
      <section class="flex min-w-0 flex-col gap-2">
        <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          Input
        </h2>
        <div class="flex min-w-0 items-center gap-2">
          <select
            class="app-select min-w-0 flex-1 bg-zinc-950/40 text-zinc-300 hover:bg-zinc-900"
            :class="{ 'cursor-wait': store.rescanningInputs && deviceOptions.length === 0 }"
            :disabled="locked || deviceOptions.length === 0"
            :aria-busy="store.rescanningInputs"
            aria-label="Recording input device"
            :value="selectedDeviceValue"
            @change="onDeviceChange"
          >
            <!-- Three different states, and saying the wrong one is worse than
                 saying nothing: the device the session was asked for while the
                 scan runs, "Finding…" when there is not even that, and only
                 once the scan is back does an empty list mean no input. -->
            <option
              v-if="pendingDeviceName !== ''"
              :value="selectedDeviceValue"
              disabled
            >
              {{ pendingDeviceName }}
            </option>
            <option
              v-else-if="selectedDeviceValue === ''"
              value=""
              disabled
            >
              {{ store.rescanningInputs ? 'Finding audio devices…' : 'No input available' }}
            </option>
            <option
              v-for="device in deviceOptions"
              :key="device.value"
              :value="device.value"
            >
              {{ device.deviceName }}
            </option>
          </select>
          <button
            type="button"
            :disabled="locked || store.rescanningInputs"
            :aria-busy="store.rescanningInputs"
            aria-label="Rescan audio input devices"
            class="flex shrink-0 items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            :class="{ 'cursor-wait': store.rescanningInputs }"
            @click="props.session.rescanInputs()"
          >
            <BusySpinner v-if="store.rescanningInputs" />
            <!-- The label does not change while a scan runs: the spinner says that,
                 and a wider label would squeeze the device picker beside it. -->
            Rescan
          </button>
        </div>

        <select
          class="app-select w-full bg-zinc-950/40 text-zinc-300 hover:bg-zinc-900"
          :class="{ 'cursor-wait': store.awaitingSession }"
          :disabled="locked || channelOptions.length === 0"
          :aria-busy="store.awaitingSession"
          aria-label="Recording input channels"
          :value="selectedChannelValue"
          @change="onChannelChange"
        >
          <option
            v-if="channelOptions.length === 0"
            value=""
            disabled
          >
            <!-- The channel count comes from the open device, so before the
                 session exists this is still loading, not a device with no
                 usable channels. -->
            {{ store.awaitingSession ? 'Opening input…' : 'No channels available' }}
          </option>
          <option
            v-for="option in channelOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>

        <div class="flex min-w-0 items-center gap-2">
          <span class="w-16 shrink-0 text-zinc-400">Timing</span>
          <span
            class="min-w-0 flex-1 truncate"
            :class="calibration === null || store.isCalibrationStale ? 'text-amber-300' : 'text-zinc-300'"
            :title="calibrationLabel"
          >
            {{ calibrationLabel }}
          </span>
          <button
            type="button"
            :disabled="locked || store.current?.input == null"
            class="shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            @click="emit('calibrate')"
          >
            {{ calibration === null ? 'Calibrate' : 'Recalibrate' }}
          </button>
        </div>

        <div class="mt-auto flex items-center gap-3">
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
          <span class="w-16 shrink-0 text-zinc-400">Gain</span>
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

      <section class="flex min-w-0 flex-col gap-2">
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
        <div
          class="silverdaw-scroll h-32 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-1"
        >
          <p
            v-if="backingTracks.length === 0"
            class="px-2 py-1.5 text-xs text-zinc-500"
          >
            There are no tracks to play along to yet.
          </p>
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

        <label class="mt-auto flex items-center gap-3">
          <span class="w-16 shrink-0 text-zinc-400">Volume</span>
          <input
            type="range"
            class="app-range min-w-0 flex-1"
            aria-label="Backing volume"
            min="0"
            max="100"
            step="1"
            :disabled="!store.current || backingTracks.length === 0"
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

      <div class="flex min-w-0 flex-col justify-between gap-5">
        <section class="flex min-w-0 flex-col gap-2">
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
                value="start"
                :disabled="locked"
                :checked="windowMode === 'start'"
                @change="onWindowMode('start')"
              >
              <span class="min-w-0 flex-1 truncate leading-tight">
                <span class="font-medium text-zinc-200">From Start</span>
                <span class="text-zinc-500"> — begins at the top of the project</span>
              </span>
            </label>
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

        <section class="flex min-w-0 flex-col gap-2">
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

      <div class="flex min-w-0 flex-col justify-between gap-5">
        <section class="flex min-w-0 flex-col gap-2">
          <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Monitor
          </h2>
          <label
            class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
          >
            <input
              type="checkbox"
              class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
              :checked="monitorEnabled"
              @change="onMonitorChange"
            >
            <span class="min-w-0 flex-1 truncate leading-tight">
              <span class="font-medium text-zinc-200">Hear Yourself</span>
              <span class="text-zinc-500"> — use headphones to prevent feedback</span>
            </span>
          </label>
        </section>

        <section class="flex min-w-0 flex-col gap-2">
          <h2 class="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Recording
          </h2>
          <div class="space-y-2">
            <label
              class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
            >
              <input
                type="radio"
                name="record-mode"
                class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
                value="music"
                :checked="recordingMode === 'music'"
                @change="onRecordingMode('music')"
              >
              <span class="min-w-0 flex-1 truncate leading-tight">
                <span class="font-medium text-zinc-200">Music</span>
                <span class="text-zinc-500"> — takes the project tempo and beat markers</span>
              </span>
            </label>
            <label
              class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
            >
              <input
                type="radio"
                name="record-mode"
                class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
                value="simple"
                :checked="recordingMode === 'simple'"
                @change="onRecordingMode('simple')"
              >
              <span class="min-w-0 flex-1 truncate leading-tight">
                <span class="font-medium text-zinc-200">Simple</span>
                <span class="text-zinc-500"> — no tempo, for speech and sound effects</span>
              </span>
            </label>
            <label
              class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
            >
              <input
                type="checkbox"
                class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
                :checked="cleanupEnabled"
                @change="onCleanupChange"
              >
              <span class="min-w-0 flex-1 truncate leading-tight">
                <span class="font-medium text-zinc-200">Clean Up Background Noise</span>
                <span class="text-zinc-500"> — for microphone vocals</span>
              </span>
            </label>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
