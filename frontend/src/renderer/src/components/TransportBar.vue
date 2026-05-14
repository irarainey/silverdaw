<script setup lang="ts">
// Transport bar: play / pause / stop wired to the JUCE backend over the
// WebSocket bridge. Playhead position is mirrored from the backend's
// `PLAYHEAD_UPDATE` messages into `transportStore`.

import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { send as sendBridge } from '@/lib/bridgeService'

const project = useProjectStore()
const transport = useTransportStore()

const positionDisplay = computed(() => formatTime(transport.positionMs))

/**
 * Current playhead position expressed as Bar.Beat.Sub (0-indexed), the
 * usual DAW convention. 4/4 time and 4 sub-beats per beat are assumed —
 * same as the timeline grid.
 *
 * Operates on integer sub-beat counts (rather than fractional beats) so
 * floating-point drift doesn't push exact bar boundaries down to the
 * previous bar (e.g. 3.9999… → bar 0 beat 3 sub 3 instead of bar 1).
 * The error otherwise compounds with position and shows up most clearly
 * far along the timeline.
 */
const barPositionDisplay = computed(() => {
  const bpm = Math.max(1, transport.bpm)
  const subsPerBeat = 4
  const beatsPerBar = 4
  const subsPerBar = subsPerBeat * beatsPerBar
  const msPerSub = 60000 / (bpm * subsPerBeat)
  const totalSubs = Math.max(0, Math.round(transport.positionMs / msPerSub))
  const bar = Math.floor(totalSubs / subsPerBar)
  const subsInBar = totalSubs % subsPerBar
  const beatInBar = Math.floor(subsInBar / subsPerBeat)
  const subInBeat = subsInBar % subsPerBeat
  return `${bar}.${beatInBar}.${subInBeat}`
})

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
const bpmInput = ref(transport.bpm.toFixed(1))
const isEditingBpm = ref(false)
watch(
  () => transport.bpm,
  (bpm) => {
    if (!isEditingBpm.value) bpmInput.value = bpm.toFixed(1)
  }
)

const lengthEditable = computed(() => project.tracks.length > 0)

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Parse a user-entered time string into milliseconds. Accepts `ss`,
 * `mm:ss` and `h:mm:ss` (fractional seconds allowed in the last
 * component). Returns `null` on a malformed input so the caller can fall
 * back to the previous value.
 */
function parseTime(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':').map((p) => p.trim())
  if (parts.length > 3) return null
  for (const p of parts) {
    if (p === '' || Number.isNaN(Number(p))) return null
  }
  let h = 0,
    m = 0,
    s = 0
  if (parts.length === 1) {
    s = Number(parts[0])
  } else if (parts.length === 2) {
    m = Number(parts[0])
    s = Number(parts[1])
  } else {
    h = Number(parts[0])
    m = Number(parts[1])
    s = Number(parts[2])
  }
  if (h < 0 || m < 0 || s < 0) return null
  return Math.round((h * 3600 + m * 60 + s) * 1000)
}

function onLengthCommit(): void {
  isEditingLength.value = false
  const ms = parseTime(lengthInput.value)
  if (ms === null) {
    // Reject and snap back to the current store value.
    lengthInput.value = formatTime(project.durationMs)
    return
  }
  project.setProjectLengthMs(ms)
  // setProjectLengthMs may clamp upwards if a clip extends past `ms`.
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
  project.setProjectLengthMs(next)
  lengthInput.value = formatTime(project.durationMs)
}

function onBpmCommit(): void {
  isEditingBpm.value = false
  const n = Number(bpmInput.value)
  if (!Number.isFinite(n)) {
    bpmInput.value = transport.bpm.toFixed(1)
    return
  }
  transport.setBpm(n)
  bpmInput.value = transport.bpm.toFixed(1)
}

function onBpmKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  else if (e.key === 'Escape') {
    bpmInput.value = transport.bpm.toFixed(1)
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
  transport.setBpm(start + delta)
  bpmInput.value = transport.bpm.toFixed(1)
}

function onSkipBack(): void {
  // Stop + rewind for now; Skip-back behaves like Stop until we have markers.
  sendBridge('TRANSPORT_STOP')
}

function onPlay(): void {
  // Optimistically flip the UI state; the backend's PLAYHEAD_UPDATE will
  // overwrite this within ~16 ms either way.
  if (transport.isPlaying) {
    sendBridge('TRANSPORT_PAUSE')
    transport.setPlaybackState(false)
  } else {
    sendBridge('TRANSPORT_PLAY')
    transport.setPlaybackState(true)
  }
}

function onSkipForward(): void {
  // No end-of-project marker yet.
}
</script>

<template>
  <header
    class="flex h-16 w-full select-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 text-zinc-300">
    <!-- Left: spacer (matches the right Timing box width so the centre buttons stay truly centred). -->
    <div class="flex-1" />

    <!-- Centre: transport buttons -->
    <div class="flex items-center gap-1">
      <button type="button" class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        title="Skip to start" @click="onSkipBack">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5">
          <path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" />
        </svg>
      </button>
      <button type="button" class="rounded p-2 hover:bg-blue-600 hover:text-white"
        :class="transport.isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
        :title="transport.isPlaying ? 'Pause' : 'Play'" @click="onPlay">
        <svg v-if="transport.isPlaying" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
          class="h-6 w-6">
          <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-6 w-6">
          <path d="M8 5v14l11-7L8 5z" />
        </svg>
      </button>
      <button type="button" class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100" title="Skip to end"
        @click="onSkipForward">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5">
          <path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" />
        </svg>
      </button>
    </div>

    <!-- Right: Timing box (position / bar / length / BPM). -->
    <div class="flex flex-1 justify-end">
      <div class="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1" title="Timing">
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Pos</span>
          <span class="font-mono text-base tabular-nums text-zinc-100">{{ positionDisplay }}</span>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Bar</span>
          <span class="font-mono text-base tabular-nums text-zinc-100" title="Bar.Beat.Sub">{{
            barPositionDisplay
            }}</span>
        </div>
        <div class="h-7 w-px bg-zinc-800" />
        <div class="flex flex-col items-start leading-none">
          <span class="text-[9px] uppercase tracking-wide text-zinc-500">Length</span>
          <div class="flex items-center">
            <input v-model="lengthInput" type="text" inputmode="numeric" spellcheck="false" :disabled="!lengthEditable"
              :title="lengthEditable ? 'Project length (mm:ss or h:mm:ss). Use ↑/↓ or the spinner to adjust by 1s; hold Shift for 10s.' : 'Add a track to edit project length'"
              class="w-12 bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500"
              @focus="isEditingLength = true" @blur="onLengthCommit" @keydown="onLengthKeydown" />
            <div class="ml-0.5 flex flex-col text-zinc-500">
              <button type="button" tabindex="-1" :disabled="!lengthEditable" title="Increase length (Shift: +10s)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent @click="(e) => bumpLength(e.shiftKey ? 10 : 1)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3">
                  <path d="M7 14l5-5 5 5H7z" />
                </svg>
              </button>
              <button type="button" tabindex="-1" :disabled="!lengthEditable" title="Decrease length (Shift: -10s)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                @mousedown.prevent @click="(e) => bumpLength(e.shiftKey ? -10 : -1)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3">
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
            <input v-model="bpmInput" type="number" min="20" max="300" step="0.1" spellcheck="false"
              title="Tempo (20 – 300 BPM). Use ↑/↓ or the spinner to adjust by 1; hold Shift for 10."
              class="w-12 bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              @focus="isEditingBpm = true" @blur="onBpmCommit" @keydown="onBpmKeydown" />
            <div class="ml-0.5 flex flex-col text-zinc-500">
              <button type="button" tabindex="-1" title="Increase BPM (Shift: +10)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100" @mousedown.prevent
                @click="(e) => bumpBpm(e.shiftKey ? 10 : 1)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3">
                  <path d="M7 14l5-5 5 5H7z" />
                </svg>
              </button>
              <button type="button" tabindex="-1" title="Decrease BPM (Shift: -10)"
                class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100" @mousedown.prevent
                @click="(e) => bumpBpm(e.shiftKey ? -10 : -1)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3">
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
