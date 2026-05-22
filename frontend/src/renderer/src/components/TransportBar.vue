<script setup lang="ts">
// Transport bar: play / pause / stop wired to the JUCE backend over the
// WebSocket bridge. Playhead position is mirrored from the backend's
// `PLAYHEAD_UPDATE` messages into `transportStore`.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { barPositionDisplay, formatTime, parseTime } from '@/lib/musicTime'

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const ui = useUiStore()
const audioDevices = useAudioDeviceStore()

// ─── Audio output device quick-switch ────────────────────────────────────
//
// Compact chip on the left of the transport bar showing the current
// output device. Clicking opens a popover with every device grouped
// by type (mirrors the Preferences > Audio tab) plus a "System
// default" entry on top. Picking a device routes through the same
// `audioDeviceStore.selectDevice` action as the Preferences tab —
// the renderer optimistic-updates the label, the backend acks via
// `AUDIO_DEVICE_CHANGED`, and main persists the choice only on
// `ok: true`.
const audioMenuOpen = ref(false)
const audioMenuRoot = ref<HTMLElement | null>(null)

const audioMenuLabel = computed(() => {
  // Show the *target* device name immediately on click rather than a
  // verbose "Switching to X…" string. Optimistic update — when the
  // backend acks (the round-trip is ~50–300 ms on Windows depending
  // on driver), the `pendingSelection` clears and we fall through to
  // the live `currentDeviceName` which is the same string. If the
  // switch fails, `audioDevices.lastError` flips and the chip border
  // goes amber, but the label still reads the device the user picked
  // so the failure is obvious in context rather than via a label flip.
  const pending = audioDevices.pendingSelection
  if (pending) {
    if (!pending.typeName && !pending.deviceName) return 'System default'
    return pending.deviceName || 'System default'
  }
  if (audioDevices.onSystemDefault) return 'System default'
  return audioDevices.currentDeviceName || 'System default'
})

/** Latency caption shown under the device name in the chip when the
 *  active device has a meaningful end-to-end delay (>30 ms). Stays
 *  hidden for low-latency wired / ASIO devices so the chip doesn't
 *  feel busy in the common case. */
const audioLatencyCaption = computed<string | null>(() => {
  const ms = audioDevices.outputLatencyMs
  if (ms === null || ms < 30) return null
  const rounded = Math.round(ms)
  return audioDevices.isBluetoothHeuristic ? `~${rounded} ms · BT` : `${rounded} ms`
})

/** Unique-device list for the quick-switch popover. Identical
 *  dedupe rule to the one in `PreferencesDialog.vue` — same physical
 *  device exposed by multiple Windows backends collapses into one
 *  row, so the user picks "Speakers" once, not three times. */
interface QuickSwitchDevice {
  name: string
  backends: string[]
}
const quickSwitchDevices = computed<QuickSwitchDevice[]>(() => {
  const map = new Map<string, QuickSwitchDevice>()
  for (const type of audioDevices.types) {
    for (const dev of type.devices) {
      const key = dev.toLowerCase()
      const existing = map.get(key)
      if (existing) {
        if (!existing.backends.includes(type.name)) existing.backends.push(type.name)
      } else {
        map.set(key, { name: dev, backends: [type.name] })
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
})

/** Same backend-preference ordering as the Preferences dialog. */
const QUICK_SWITCH_BACKEND_PRIORITY = [
  'Windows Audio',
  'CoreAudio',
  'ALSA',
  'DirectSound',
  'Windows Audio (Exclusive Mode)',
  'JACK',
  'ASIO'
]

function preferredBackendForQuickSwitch(device: QuickSwitchDevice): string {
  for (const b of QUICK_SWITCH_BACKEND_PRIORITY) {
    if (device.backends.includes(b)) return b
  }
  return device.backends[0] ?? ''
}

function toggleAudioMenu(): void {
  audioMenuOpen.value = !audioMenuOpen.value
}

function pickDevice(typeName: string | null, deviceName: string | null): void {
  audioDevices.selectDevice(typeName, deviceName)
  audioMenuOpen.value = false
}

function pickUniqueDevice(device: QuickSwitchDevice): void {
  // Auto-pick the most-friendly backend for the chosen device. The
  // transport-bar popover deliberately doesn't expose the backend
  // distinction — advanced users who want ASIO use Preferences →
  // Audio → Audio driver instead.
  pickDevice(preferredBackendForQuickSwitch(device), device.name)
}

function isCurrentDevice(typeName: string | null, deviceName: string | null): boolean {
  const activeType = audioDevices.pendingSelection?.typeName ?? audioDevices.currentTypeName
  const activeDevice = audioDevices.pendingSelection?.deviceName ?? audioDevices.currentDeviceName
  return activeType === typeName && activeDevice === deviceName
}

function isCurrentUniqueDevice(device: QuickSwitchDevice): boolean {
  const activeDevice = audioDevices.pendingSelection?.deviceName ?? audioDevices.currentDeviceName
  return !!activeDevice && activeDevice.toLowerCase() === device.name.toLowerCase()
}

function onAudioMenuDocClick(e: MouseEvent): void {
  if (!audioMenuRoot.value) return
  if (!audioMenuRoot.value.contains(e.target as Node)) audioMenuOpen.value = false
}
function onAudioMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') audioMenuOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onAudioMenuDocClick)
  document.addEventListener('keydown', onAudioMenuKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onAudioMenuDocClick)
  document.removeEventListener('keydown', onAudioMenuKey)
})

// Wrappers that mutate local state AND push the change to the backend
// so it persists with the project. The wrapped underlying setters are
// also called by `applyProjectStateSnapshot` (without sending) so the
// load path round-trips cleanly.
function applyBpm(bpm: number): void {
  transport.setBpm(bpm)
  // `transport.setBpm` clamps to [20, 300]; read back the clamped value.
  sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
}

function applyProjectLength(ms: number): void {
  project.setProjectLengthMs(ms)
  // The setter may clamp upward to fit existing clips; send the final
  // value so the backend and renderer stay aligned.
  sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
}

const positionDisplay = computed(() => formatTime(transport.positionMs))

/**
 * Playhead position as `Bar.Beat.Sub` (0-indexed). 4/4 with four
 * sub-beats per beat — same as the timeline grid. See `musicTime.ts`
 * for the integer-sub-beat rounding that avoids float drift at exact
 * bar boundaries.
 */
const barPosition = computed(() => barPositionDisplay(transport.positionMs, transport.bpm))

// Editable project-length field. Mirrors `project.durationMs` whenever the
// user is not actively editing it; on commit (blur / Enter) we parse the
// `mm:ss` / `h:mm:ss` text back to ms and push it through the store.
const lengthInput = ref(formatTime(project.durationMs))
const isEditingLength = ref(false)

// Keep the displayed length in sync with the store while not editing —
// importing a clip can grow the duration and that should appear here too.
watch(
  () => project.durationMs,
  (ms) => {
    if (!isEditingLength.value) lengthInput.value = formatTime(ms)
  }
)

// Auto-stop at the end of the project. The audio engine streams
// forever (it has no notion of `projectLengthMs`), so when the
// playhead crosses the project ruler's end we send a TRANSPORT_PAUSE
// from the renderer. We pause (not stop) so the playhead stays parked
// at the end — matches the user's mental model of "playback finished
// here", and a fresh Play picks up from start via the existing
// auto-rewind in `onPlay`. Guard against a 0-length project so a
// fresh / cropped-empty timeline doesn't get into a pause loop.
watch(
  () => transport.positionMs,
  (ms) => {
    if (!transport.isPlaying) return
    const end = project.durationMs
    if (end <= 0) return
    if (ms < end) return
    sendBridge('TRANSPORT_PAUSE')
    // Optimistic local stop so the play / pause button flips
    // immediately rather than waiting for the backend ack.
    transport.setPlaybackState(false)
    transport.setPosition(end)
  }
)

// Editable BPM. Same pattern as length — mirror the store while not focused.
const bpmInput = ref(transport.bpm.toFixed(2))
const isEditingBpm = ref(false)
watch(
  () => transport.bpm,
  (bpm) => {
    if (!isEditingBpm.value) bpmInput.value = bpm.toFixed(2)
  }
)

const lengthEditable = computed(() => project.tracks.length > 0)
/**
 * Pos / Bar / BPM are only meaningful once the user has something
 * playable in the project. Until then we render them all greyed out
 * to match the disabled-length affordance — the user doesn't have to
 * wonder whether tweaking the BPM "did something" on an empty
 * canvas. Same gate as `lengthEditable` so the four readouts switch
 * together when the first track lands.
 */
const timingEditable = lengthEditable

const projectClipCount = computed(() =>
  project.tracks.reduce((count, track) => count + track.clipIds.length, 0)
)

// Play is disabled when the playhead is parked at (or past) the end of
// the project ruler. Pause is always reachable, so we only gate the
// "start playing" path. Empty projects (durationMs===0) keep Play
// enabled — the disabled-while-empty case is already covered by
// `timingEditable` further down.
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
    // Reject and snap back to the current store value.
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

/**
 * Increment or decrement the project length by `deltaSeconds`. Used by the
 * up/down spinner buttons next to the Length field and by ArrowUp/Down on
 * the input itself. Operates on the in-edit text if the user is currently
 * editing, otherwise on the committed store value.
 */
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

/**
 * Increment or decrement BPM by `delta` (whole BPM units — `setBpm` will
 * clamp to the [20, 300] range and round to one decimal). Used by the
 * spinner buttons next to the BPM field and by ArrowUp/Down on the input.
 */
function bumpBpm(delta: number): void {
  const base = isEditingBpm.value ? Number(bpmInput.value) : transport.bpm
  const start = Number.isFinite(base) ? base : transport.bpm
  applyBpm(start + delta)
  bpmInput.value = transport.bpm.toFixed(2)
}

function onSkipBack(): void {
  // Skip-back rewinds the playhead and scrolls the view to the start
  // but never changes the playback state — if playback was running,
  // it just carries on from position 0.
  log.info('transport', 'click skip-back')
  project.viewScrollX = 0
  sendBridge('PROJECT_SET_VIEW', { scrollX: 0 })
  transport.setPosition(0)
  sendBridge('TRANSPORT_SEEK', { positionMs: 0 })
}

function onPlay(): void {
  // Optimistically flip the UI state; the backend's PLAYHEAD_UPDATE will
  // overwrite this within ~16 ms either way.
  if (transport.isPlaying) {
    log.info('transport', 'click pause')
    sendBridge('TRANSPORT_PAUSE')
    transport.setPlaybackState(false)
  } else {
    // Playhead parked at (or past) the end of the project — Play is a
    // no-op. The button itself is disabled in this case (see
    // `playDisabled`); this guard also catches the keyboard-shortcut
    // path so Spacebar can't sneak past the UI.
    const end = project.durationMs
    if (end > 0 && transport.positionMs >= end) {
      log.info('transport', 'click play ignored (at end of project)')
      return
    }
    log.info('transport', 'click play')
    sendBridge('TRANSPORT_PLAY')
    transport.setPlaybackState(true)
  }
}

function onSkipForward(): void {
  // Seek to the end of the project — the union of every track's length
  // and every clip's end time. Mirrors the existing back/stop semantics:
  // we send the seek and let the backend's PLAYHEAD_UPDATE confirm.
  const end = project.durationMs
  if (!Number.isFinite(end) || end <= 0) return
  log.info('transport', `click skip-forward -> ${end}ms`)
  sendBridge('TRANSPORT_SEEK', { positionMs: end })
}

function onToggleFollow(): void {
  ui.setFollowPlayback(!ui.followPlayback)
  log.info('transport', `follow playback=${ui.followPlayback}`)
}
</script>

<template>
  <header
    class="flex h-16 w-full select-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 text-zinc-300"
  >
    <!-- Left: audio output device quick-switch. Replaces the
         flex-spacer; the chip's natural width still keeps the
         centre transport buttons centred relative to the right
         timing-box width. -->
    <div
      ref="audioMenuRoot"
      class="relative flex-1"
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

    <!-- Centre: transport buttons -->
    <div class="flex items-center gap-1">
      <button
        type="button"
        data-borderless-button="true"
        class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Skip to start"
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
        title="Skip to end"
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
        <!-- Right-arrow chevron inside a circle: when on, the chevron is
             active; when off, the icon is dimmed. -->
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

    <!-- Right: Timing box (position / bar / length / BPM). -->
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
      </div>
    </div>
  </header>
</template>
