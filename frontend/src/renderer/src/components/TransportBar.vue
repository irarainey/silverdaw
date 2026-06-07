<script setup lang="ts">
// Transport controls and project timing readouts.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import {
  formatLinearAsDb,
  linearToTaperPosition,
  MAX_MASTER_DB,
  taperPositionToLinear
} from '@/lib/audio/db'
import { barPositionDisplay, formatTime, parseTime } from '@/lib/musicTime'
import { useAudioQuickSwitch } from '@/lib/transport/useAudioQuickSwitch'
import { useTransportSkip } from '@/lib/transport/useTransportSkip'
import MasterMeter from '@/components/MasterMeter.vue'

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const ui = useUiStore()
const audioDevices = useAudioDeviceStore()
const notifications = useNotificationsStore()

// ─── Audio output device quick-switch ────────────────────────────────────
// The SFC only owns document listeners for outside-click / Escape.
const {
  audioMenuOpen,
  audioMenuRoot,
  audioMenuLabel,
  audioLatencyCaption,
  quickSwitchDevices,
  toggleAudioMenu,
  pickDevice,
  pickUniqueDevice,
  isCurrentDevice,
  isCurrentUniqueDevice,
  onAudioMenuDocClick,
  onAudioMenuKey
} = useAudioQuickSwitch()

onMounted(() => {
  document.addEventListener('mousedown', onAudioMenuDocClick)
  document.addEventListener('keydown', onAudioMenuKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onAudioMenuDocClick)
  document.removeEventListener('keydown', onAudioMenuKey)
})

// User edits update local state and persist to the backend.
function applyBpm(bpm: number): void {
  transport.setBpm(bpm)
  // Send the clamped value.
  sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
}

function applyProjectLength(ms: number): void {
  const minLengthMs = project.longestClipEndMs
  const requestedMs = Math.max(0, Math.floor(ms))
  const nextMs = Math.max(requestedMs, minLengthMs)
  if (requestedMs < minLengthMs) {
    notifications.pushInfo(
      `Project length cannot be shorter than the last clip (${formatTime(minLengthMs)}).`
    )
  }
  project.setProjectLengthMs(nextMs)
  // Send the post-clamp length.
  sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
}

const positionDisplay = computed(() => formatTime(transport.positionMs))

/** Playhead as 0-indexed Bar.Beat.Sub using the timeline grid rounding. */
const barPosition = computed(() => barPositionDisplay(transport.positionMs, transport.bpm))

/** Project sample-rate label using the same fallback as import preflight. */
const effectiveSampleRateLabel = computed(() => {
  const projectRate = project.targetSampleRate
  if (projectRate === 44100 || projectRate === 48000) {
    return `${(projectRate / 1000).toFixed(1)} kHz`
  }
  const fallback = ui.defaultProjectSampleRate
  return `${(fallback / 1000).toFixed(1)} kHz`
})

// Length input mirrors the store while not focused, then parses on commit.
const lengthInput = ref(formatTime(project.durationMs))
const isEditingLength = ref(false)

watch(
  () => project.durationMs,
  (ms) => {
    if (!isEditingLength.value) lengthInput.value = formatTime(ms)
  }
)

// Renderer pauses at project end because the audio engine streams past it.
watch(
  () => transport.positionMs,
  (ms) => {
    if (!transport.isPlaying) return
    const end = project.durationMs
    if (end <= 0) return
    if (ms < end) return
    sendBridge('TRANSPORT_PAUSE')
    // Flip the play button without waiting for backend ack.
    transport.setPlaybackState(false)
    transport.setPosition(end)
  }
)

// BPM mirrors the store while not focused.
const bpmInput = ref(transport.bpm.toFixed(2))
const isEditingBpm = ref(false)
watch(
  () => transport.bpm,
  (bpm) => {
    if (!isEditingBpm.value) bpmInput.value = bpm.toFixed(2)
  }
)

const lengthEditable = computed(() => project.tracks.length > 0)
/** Timing readouts are disabled until the project has playable content. */
const timingEditable = lengthEditable

const projectClipCount = computed(() =>
  project.tracks.reduce((count, track) => count + track.clipIds.length, 0)
)

// Disable starting playback from project end; Pause remains reachable.
const playDisabled = computed(() => {
  if (transport.isPlaying) return false
  const end = project.durationMs
  return end > 0 && transport.positionMs >= end
})

const playButtonTitle = computed(() => {
  if (transport.isPlaying) return 'Pause'
  if (playDisabled.value) return 'Playhead at end of project — skip back to play'
  return 'Play'
})

const skipBackTitle = computed(() =>
  ui.skipButtonTarget === 'markers' ? 'Skip to previous marker' : 'Skip to start'
)
const skipForwardTitle = computed(() =>
  ui.skipButtonTarget === 'markers' ? 'Skip to next marker' : 'Skip to end'
)

const projectBpmPending = computed(() => {
  if (!timingEditable.value || projectClipCount.value === 0) return false
  const projectHasAnalysedItem = library.items.some((item) => typeof item.bpm === 'number' && item.bpm > 0)
  if (projectHasAnalysedItem) return false
  return library.imports.some(
    (entry) => entry.stage === 'detectingTempo' || entry.stage === 'detectingBeats'
  )
})

function onLengthCommit(): void {
  isEditingLength.value = false
  const ms = parseTime(lengthInput.value)
  if (ms === null) {
    // Reject and snap back.
    lengthInput.value = formatTime(project.durationMs)
    return
  }
  applyProjectLength(ms)
  lengthInput.value = formatTime(project.durationMs)
}

function onLengthKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  else if (e.key === 'Escape') {
    lengthInput.value = formatTime(project.durationMs)
      ; (e.target as HTMLInputElement).blur()
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    bumpLength(e.shiftKey ? 10 : 1)
  }
  else if (e.key === 'ArrowDown') {
    e.preventDefault()
    bumpLength(e.shiftKey ? -10 : -1)
  }
}

/** Bump length from in-edit text when focused, otherwise from the store. */
function bumpLength(deltaSeconds: number): void {
  if (!lengthEditable.value) return
  const base = isEditingLength.value
    ? parseTime(lengthInput.value) ?? project.durationMs
    : project.durationMs
  const next = Math.max(0, base + deltaSeconds * 1000)
  applyProjectLength(next)
  lengthInput.value = formatTime(project.durationMs)
}

function onBpmCommit(): void {
  isEditingBpm.value = false
  const n = Number(bpmInput.value)
  if (!Number.isFinite(n)) {
    bpmInput.value = transport.bpm.toFixed(2)
    return
  }
  applyBpm(n)
  bpmInput.value = transport.bpm.toFixed(2)
}

function onBpmKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  else if (e.key === 'Escape') {
    bpmInput.value = transport.bpm.toFixed(2)
      ; (e.target as HTMLInputElement).blur()
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    bumpBpm(e.shiftKey ? 10 : 1)
  }
  else if (e.key === 'ArrowDown') {
    e.preventDefault()
    bumpBpm(e.shiftKey ? -10 : -1)
  }
}

/** Bump BPM; `setBpm` clamps and rounds. */
function bumpBpm(delta: number): void {
  const base = isEditingBpm.value ? Number(bpmInput.value) : transport.bpm
  const start = Number.isFinite(base) ? base : transport.bpm
  applyBpm(start + delta)
  bpmInput.value = transport.bpm.toFixed(2)
}

// ─── Transport navigation ────────────────────────────────────────────────
const { onSkipBack, onPlay, onSkipForward } = useTransportSkip()

function onToggleFollow(): void {
  ui.setFollowPlayback(!ui.followPlayback)
  log.info('transport', `follow playback=${ui.followPlayback}`)
}

function onMasterVolumeInput(event: Event): void {
  // Send every drag tick; backend coalesces the stream into one undo step.
  const target = event.target as HTMLInputElement
  const pos = Number(target.value)
  if (!Number.isFinite(pos)) return
  const linear = taperPositionToLinear(pos, MAX_MASTER_DB)
  project.setMasterVolume(Math.min(1, Math.max(0, linear)))
}
</script>

<template>
  <header
    class="flex h-16 w-full select-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 text-zinc-300"
  >
    <!-- Left: audio output quick-switch + master volume. -->
    <div class="flex flex-1 items-center gap-3">
      <div
        ref="audioMenuRoot"
        class="relative"
      >
        <button
          type="button"
          data-borderless-button="true"
          class="flex max-w-xs items-center gap-1.5 rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900"
          :class="{
            'border-amber-700 text-amber-200': audioDevices.lastError,
            'animate-pulse': audioDevices.pendingSelection !== null
          }"
          :title="
            audioDevices.lastError
              ? audioDevices.lastError
              : audioLatencyCaption
                ? `Audio output: ${audioDevices.currentDeviceName || 'System default'} (${audioLatencyCaption} of output latency — playhead is auto-compensated during playback)`
                : 'Audio output device'
          "
          @click="toggleAudioMenu"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
          <span class="flex min-w-0 flex-col items-start leading-none">
            <span class="truncate text-xs">{{ audioMenuLabel }}</span>
            <span
              v-if="audioLatencyCaption"
              class="mt-0.5 text-[9px] tracking-wide text-zinc-500"
            >{{ audioLatencyCaption }}</span>
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            class="h-3 w-3 shrink-0 text-zinc-500"
            aria-hidden="true"
          >
            <path d="M4.427 6.427a.6.6 0 0 1 .849 0L8 9.151l2.724-2.724a.6.6 0 0 1 .849.849l-3.149 3.148a.6.6 0 0 1-.848 0L4.427 7.276a.6.6 0 0 1 0-.849Z" />
          </svg>
        </button>

        <div
          v-if="audioMenuOpen"
          class="silverdaw-scroll absolute left-0 top-full z-40 mt-1 max-h-80 w-80 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
        >
          <button
            type="button"
            data-borderless-button="true"
            class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-zinc-800"
            @click="pickDevice(null, null)"
          >
            <span class="text-zinc-200">System default</span>
            <span
              v-if="isCurrentDevice(null, null)"
              class="text-sky-400"
              aria-hidden="true"
            >✓</span>
          </button>
          <div class="my-1 border-t border-zinc-800" />
          <button
            v-for="device in quickSwitchDevices"
            :key="device.name"
            type="button"
            data-borderless-button="true"
            class="flex w-full items-center justify-between gap-3 px-3 py-1 text-left text-xs hover:bg-zinc-800"
            @click="pickUniqueDevice(device)"
          >
            <span class="truncate text-zinc-200">{{ device.name }}</span>
            <span
              v-if="isCurrentUniqueDevice(device)"
              class="text-sky-400"
              aria-hidden="true"
            >✓</span>
          </button>
          <div class="my-1 border-t border-zinc-800" />
          <button
            type="button"
            data-borderless-button="true"
            class="w-full px-3 py-1 text-left text-[11px] text-zinc-400 hover:bg-zinc-800"
            @click="audioDevices.requestRescan(); audioMenuOpen = false"
          >
            Rescan devices
          </button>
        </div>
      </div>

      <!-- Master volume drives live playback and mixdown export. -->
      <div
        class="flex items-center gap-1.5"
        :title="`Master volume: ${formatLinearAsDb(project.masterVolume, { unit: true })}`"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5 shrink-0 text-zinc-400"
          aria-hidden="true"
        >
          <path d="M3 10v4h4l5 4V6l-5 4H3z" />
          <path d="M16 8a5 5 0 0 1 0 8" />
        </svg>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          aria-label="Master volume"
          :value="linearToTaperPosition(project.masterVolume, MAX_MASTER_DB)"
          class="silverdaw-master-volume h-1 w-28 cursor-pointer appearance-none rounded bg-zinc-700 accent-sky-400 outline-none focus:outline-none focus-visible:outline-none"
          @input="onMasterVolumeInput($event)"
          @pointerup="($event.currentTarget as HTMLInputElement).blur()"
          @change="($event.currentTarget as HTMLInputElement).blur()"
        >
        <MasterMeter />
      </div>
    </div>

    <!-- Centre: transport buttons -->
    <div class="flex items-center gap-1">
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        :title="skipBackTitle"
        @click="onSkipBack"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        >
          <path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" />
        </svg>
      </button>
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 hover:bg-blue-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-100"
        :class="transport.isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
        :title="playButtonTitle"
        :disabled="playDisabled"
        @click="onPlay"
      >
        <svg
          v-if="transport.isPlaying"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6"
        >
          <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
        </svg>
        <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-6 w-6"
        >
          <path d="M8 5v14l11-7L8 5z" />
        </svg>
      </button>
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        :title="skipForwardTitle"
        @click="onSkipForward"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
        >
          <path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" />
        </svg>
      </button>
      <div class="mx-1 h-7 w-px bg-zinc-800" />
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 hover:bg-zinc-800"
        :class="ui.followPlayback ? 'text-blue-400 hover:text-blue-300' : 'text-zinc-500 hover:text-zinc-300'"
        :title="ui.followPlayback ? 'Follow playback (on) — timeline scrolls with the playhead' : 'Follow playback (off) — timeline stays put during playback'"
        @click="onToggleFollow"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-5 w-5"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
          />
          <path d="M10 8l5 4-5 4V8z" />
        </svg>
      </button>
    </div>

    <!-- Right: timing box. -->
    <div class="flex flex-1 justify-end">
      <div
        class="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-950/40 py-1 pl-3 pr-2"
        title="Timing"
      >
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Pos</span>
          <span
            :class="[
              'font-mono text-base tabular-nums',
              timingEditable ? 'text-zinc-100' : 'text-zinc-500'
            ]"
          >{{ positionDisplay }}</span>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Bar</span>
          <span
            :class="[
              'font-mono text-base tabular-nums',
              timingEditable ? 'text-zinc-100' : 'text-zinc-500'
            ]"
            title="Bar.Beat.Sub"
          >{{
            barPosition
          }}</span>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div class="-mr-1 flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Length</span>
          <div class="flex items-center">
            <input
              v-model="lengthInput"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              :disabled="!lengthEditable"
              :title="lengthEditable ? 'Project length (mm:ss or h:mm:ss). Use ↑/↓ or the spinner to adjust by 1s; hold Shift for 10s.' : 'Add a track to edit project length'"
              class="w-[5ch] bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500"
              @focus="isEditingLength = true"
              @blur="onLengthCommit"
              @keydown="onLengthKeydown"
            >
            <div class="ml-1 flex flex-col text-zinc-500">
              <button
                type="button"
                data-borderless-button="true"
                tabindex="-1"
                :disabled="!lengthEditable"
                title="Increase length (Shift: +10s)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent
                @click="(e) => bumpLength(e.shiftKey ? 10 : 1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="h-3 w-3"
                >
                  <path d="M7 14l5-5 5 5H7z" />
                </svg>
              </button>
              <button
                type="button"
                data-borderless-button="true"
                tabindex="-1"
                :disabled="!lengthEditable"
                title="Decrease length (Shift: -10s)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent
                @click="(e) => bumpLength(e.shiftKey ? -10 : -1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="h-3 w-3"
                >
                  <path d="M7 10l5 5 5-5H7z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">BPM</span>
          <div class="flex items-center">
            <input
              v-model="bpmInput"
              type="number"
              min="20"
              max="300"
              step="0.01"
              spellcheck="false"
              :disabled="!timingEditable"
              :title="projectBpmPending ? 'Detecting tempo for the first clip…' : timingEditable ? 'Tempo (20 – 300 BPM). Use ↑/↓ or the spinner to adjust by 1; hold Shift for 10.' : 'Add a track to edit project tempo'"
              :class="[
                'w-[6ch] rounded bg-transparent font-mono text-base tabular-nums outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
                projectBpmPending
                  ? 'animate-pulse bg-blue-500/10 px-1 text-blue-200 ring-1 ring-blue-400/40'
                  : 'text-zinc-100'
              ]"
              @focus="isEditingBpm = true"
              @blur="onBpmCommit"
              @keydown="onBpmKeydown"
            >
            <div class="ml-1 flex flex-col text-zinc-500">
              <button
                type="button"
                data-borderless-button="true"
                tabindex="-1"
                :disabled="!timingEditable"
                title="Increase BPM (Shift: +10)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent
                @click="(e) => bumpBpm(e.shiftKey ? 10 : 1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="h-3 w-3"
                >
                  <path d="M7 14l5-5 5 5H7z" />
                </svg>
              </button>
              <button
                type="button"
                data-borderless-button="true"
                tabindex="-1"
                :disabled="!timingEditable"
                title="Decrease BPM (Shift: -10)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent
                @click="(e) => bumpBpm(e.shiftKey ? -10 : -1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="h-3 w-3"
                >
                  <path d="M7 10l5 5 5-5H7z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div
          class="flex flex-col items-start leading-none"
          :title="`Project sample rate: ${effectiveSampleRateLabel}. Edit in File ▸ Project Properties…`"
        >
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">RATE</span>
          <span class="font-mono text-base tabular-nums text-zinc-100">{{ effectiveSampleRateLabel }}</span>
        </div>
      </div>
    </div>
  </header>
</template>
