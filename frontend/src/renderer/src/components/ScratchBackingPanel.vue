<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { useScratchBacking } from '@/lib/scratch/useScratchBacking'
import ScratchTransportBar from '@/components/ScratchTransportBar.vue'
import {
  SCRATCH_BACKING_DURATIONS_SEC,
  type ScratchBackingStartAnchor
} from '@shared/bridge-protocol'

const props = defineProps<{
  backing: ReturnType<typeof useScratchBacking>
  disabled?: boolean
  isPlaying: boolean
  transportEnabled: boolean
}>()

defineEmits<{
  (e: 'skip-to-start'): void
  (e: 'toggle-play'): void
  (e: 'skip-to-end'): void
}>()

const anchorOptions: { value: ScratchBackingStartAnchor; label: string }[] = [
  { value: 'arrangement', label: 'Start' },
  { value: 'playhead', label: 'Playhead' }
]

const statusText = computed(() => {
  const b = props.backing
  if (b.isPreparing.value) return 'Preparing…'
  if (b.isReady.value) return `Ready · ${b.readyDurationSec.value}s`
  if (b.hasError.value) return b.errorMessage.value ?? 'Preparation failed'
  return 'Not prepared'
})

const statusClass = computed(() => {
  const b = props.backing
  if (b.isReady.value) return 'text-emerald-400'
  if (b.hasError.value) return 'text-red-400'
  if (b.isPreparing.value) return 'text-sky-300'
  return 'text-zinc-500'
})

// The prepared bed is fixed once it is playing: changing the track selection,
// anchor, or length would only take effect after a fresh Prepare, so locking the
// preparation config while playing avoids implying tracks can be swapped in live.
const configDisabled = computed(() => props.disabled || props.isPlaying)

const monitorPct = computed(() => `${Math.round(props.backing.monitorGain.value * 100)}%`)

// Fraction (0..1) of the prepared bed elapsed, for the slim progress line.
const backingProgress = computed(() => {
  const durationSec = props.backing.readyDurationSec.value
  if (durationSec <= 0) return 0
  return Math.max(0, Math.min(1, props.backing.positionSec.value / durationSec))
})
const backingProgressPercent = computed(() => `${backingProgress.value * 100}%`)

function onMonitorGain(event: Event): void {
  props.backing.setMonitorGain((event.target as HTMLInputElement).valueAsNumber)
}

// Track picker dropdown: a checkbox list keeps the panel compact when a project
// has many tracks. Closes on outside pointerdown, on Escape, and whenever the
// config locks (e.g. playback starts).
const trackMenuOpen = ref(false)
const trackMenuEl = ref<HTMLElement | null>(null)

const trackSummary = computed(() => {
  const total = props.backing.tracks.value.length
  if (total === 0) return 'No tracks'
  return `${props.backing.selectedCount.value} of ${total} selected`
})

function toggleTrackMenu(): void {
  if (configDisabled.value) return
  trackMenuOpen.value = !trackMenuOpen.value
}

function closeTrackMenu(): void {
  trackMenuOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (trackMenuEl.value && !trackMenuEl.value.contains(event.target as Node)) {
    closeTrackMenu()
  }
}

watch(trackMenuOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocumentPointerDown, { capture: true })
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true })
  }
})

watch(configDisabled, (locked) => {
  if (locked) closeTrackMenu()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true })
})
</script>

<template>
  <section
    class="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 pb-5 pt-2"
    aria-label="Backing accompaniment"
  >
    <div class="grid grid-cols-3 items-center gap-2">
      <span class="justify-self-start text-[10px] font-medium uppercase tracking-wider text-zinc-400">
        Backing deck
      </span>
      <div class="flex flex-col items-center gap-0.5 justify-self-center">
        <ScratchTransportBar
          :is-playing="isPlaying"
          :can-control="transportEnabled"
          @skip-to-start="$emit('skip-to-start')"
          @toggle-play="$emit('toggle-play')"
          @skip-to-end="$emit('skip-to-end')"
        />
      </div>
      <span
        class="justify-self-end font-mono text-[10px] tabular-nums"
        :class="statusClass"
        role="status"
      >{{ statusText }}</span>
    </div>

    <!-- Slim playback progress line: grey track, sky elapsed fill, playhead dot. -->
    <div
      class="relative h-1.5 w-full rounded-full bg-zinc-700"
      role="progressbar"
      aria-label="Backing playback progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(backingProgress * 100)"
    >
      <div
        class="absolute left-0 top-0 h-full rounded-full bg-sky-500"
        :style="{ width: backingProgressPercent }"
      />
      <div
        class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-300 bg-sky-400 shadow"
        :style="{ left: backingProgressPercent }"
      />
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <!-- Track selection (checkbox dropdown; scales to many tracks) -->
      <div
        ref="trackMenuEl"
        class="relative flex items-center gap-1.5"
      >
        <span class="text-[11px] text-zinc-500">Tracks</span>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-200 outline-none transition-colors hover:bg-zinc-800 focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="configDisabled || !backing.tracks.value.length"
          :aria-expanded="trackMenuOpen"
          aria-haspopup="listbox"
          @click="toggleTrackMenu"
          @keydown.escape.stop="closeTrackMenu"
        >
          <span class="tabular-nums">{{ trackSummary }}</span>
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
          v-if="trackMenuOpen"
          class="silverdaw-scroll absolute left-0 top-full z-40 mt-1 max-h-64 w-60 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1 shadow-2xl"
          role="listbox"
          aria-label="Backing tracks"
        >
          <label
            v-for="track in backing.tracks.value"
            :key="track.id"
            class="flex items-center gap-2 rounded px-2 py-1 text-[11px]"
            :class="track.muted
              ? 'cursor-not-allowed text-zinc-600'
              : 'cursor-pointer text-zinc-200 hover:bg-zinc-800'"
            :title="track.muted ? 'Muted on the timeline' : undefined"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5 shrink-0 accent-sky-500 disabled:cursor-not-allowed"
              :class="track.muted ? 'cursor-not-allowed' : 'cursor-pointer'"
              :checked="backing.isSelected(track.id)"
              :disabled="track.muted"
              @change="backing.toggleTrack(track.id)"
            >
            <span class="min-w-0 flex-1 truncate">{{ track.name }}</span>
          </label>
        </div>
      </div>

      <!-- Start anchor -->
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] text-zinc-500">From</span>
        <div class="inline-flex overflow-hidden rounded border border-zinc-700">
          <button
            v-for="option in anchorOptions"
            :key="option.value"
            type="button"
            class="px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            :class="backing.startAnchor.value === option.value
              ? 'bg-sky-600/30 text-sky-200'
              : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'"
            :aria-pressed="backing.startAnchor.value === option.value"
            :disabled="configDisabled"
            @click="backing.setStartAnchor(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <!-- Duration -->
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] text-zinc-500">Length</span>
        <div class="inline-flex overflow-hidden rounded border border-zinc-700">
          <button
            v-for="seconds in SCRATCH_BACKING_DURATIONS_SEC"
            :key="seconds"
            type="button"
            class="px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            :class="backing.durationSec.value === seconds
              ? 'bg-sky-600/30 text-sky-200'
              : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'"
            :aria-pressed="backing.durationSec.value === seconds"
            :disabled="configDisabled"
            @click="backing.setDuration(seconds)"
          >
            {{ seconds === 0 ? 'Full' : `${seconds}s` }}
          </button>
        </div>
      </div>

      <!-- Loop: auto-restart the bed at its end (off by default) -->
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] text-zinc-500">Loop</span>
        <button
          type="button"
          class="inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          :class="backing.loop.value
            ? 'border-sky-500 bg-sky-600/30 text-sky-200'
            : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'"
          :aria-pressed="backing.loop.value"
          :disabled="disabled"
          @click="backing.toggleLoop()"
        >
          {{ backing.loop.value ? 'On' : 'Off' }}
        </button>
      </div>

      <!-- Monitor level (audition-only trim; never baked into the pattern) -->
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-zinc-500">Monitor</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            class="h-1 w-20 cursor-pointer accent-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            :value="backing.monitorGain.value"
            :disabled="disabled || !backing.isReady.value"
            aria-label="Backing monitor level"
            @input="onMonitorGain"
          >
          <span class="w-8 font-mono text-[10px] tabular-nums text-zinc-400">{{ monitorPct }}</span>
        </label>
      </div>

      <!-- Actions -->
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded bg-sky-600 px-3 py-1 text-[11px] font-medium text-zinc-50 transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="configDisabled || !backing.canPrepare.value"
          @click="backing.prepare()"
        >
          <span
            v-if="backing.isPreparing.value"
            class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-50/40 border-t-zinc-50"
            aria-hidden="true"
          />
          <span>{{ backing.isPreparing.value ? 'Preparing' : 'Prepare' }}</span>
        </button>
      </div>
    </div>
  </section>
</template>
