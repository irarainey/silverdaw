<script setup lang="ts">
// Transport bar: play / pause / stop wired to the JUCE backend over the
// WebSocket bridge. Playhead position is mirrored from the backend's
// `PLAYHEAD_UPDATE` messages into `transportStore`.

import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { barPositionDisplay, formatTime, parseTime } from '@/lib/musicTime'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()

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
  // Stop + rewind for now; Skip-back behaves like Stop until we have markers.
  log.info('transport', 'click skip-back')
  sendBridge('TRANSPORT_STOP')
}

function onPlay(): void {
  // Optimistically flip the UI state; the backend's PLAYHEAD_UPDATE will
  // overwrite this within ~16 ms either way.
  if (transport.isPlaying) {
    log.info('transport', 'click pause')
    sendBridge('TRANSPORT_PAUSE')
    transport.setPlaybackState(false)
  } else {
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
    <!-- Left: spacer (matches the right Timing box width so the centre buttons stay truly centred). -->
    <div class="flex-1" />

    <!-- Centre: transport buttons -->
    <div class="flex items-center gap-1">
      <button
        type="button"
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
        class="rounded p-2 hover:bg-blue-600 hover:text-white"
        :class="transport.isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
        :title="transport.isPlaying ? 'Pause' : 'Play'"
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
        class="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1"
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
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Length</span>
          <div class="flex items-center">
            <input
              v-model="lengthInput"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              :disabled="!lengthEditable"
              :title="lengthEditable ? 'Project length (mm:ss or h:mm:ss). Use ↑/↓ or the spinner to adjust by 1s; hold Shift for 10s.' : 'Add a track to edit project length'"
              class="w-12 bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500"
              @focus="isEditingLength = true"
              @blur="onLengthCommit"
              @keydown="onLengthKeydown"
            >
            <div class="ml-0.5 flex flex-col text-zinc-500">
              <button
                type="button"
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
              :title="timingEditable ? 'Tempo (20 – 300 BPM). Use ↑/↓ or the spinner to adjust by 1; hold Shift for 10.' : 'Add a track to edit project tempo'"
              class="w-16 bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              @focus="isEditingBpm = true"
              @blur="onBpmCommit"
              @keydown="onBpmKeydown"
            >
            <div class="ml-0.5 flex flex-col text-zinc-500">
              <button
                type="button"
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
