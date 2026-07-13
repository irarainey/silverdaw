<script setup lang="ts">
import { computed } from 'vue'
import type { useScratchBacking } from '@/lib/scratch/useScratchBacking'
import {
  SCRATCH_BACKING_DURATIONS_SEC,
  type ScratchBackingStartAnchor
} from '@shared/bridge-protocol'

const props = defineProps<{
  backing: ReturnType<typeof useScratchBacking>
  disabled?: boolean
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

const monitorPct = computed(() => `${Math.round(props.backing.monitorGain.value * 100)}%`)
const scratchPct = computed(() => `${Math.round(props.backing.scratchGain.value * 100)}%`)

function onMonitorGain(event: Event): void {
  props.backing.setMonitorGain((event.target as HTMLInputElement).valueAsNumber)
}

function onScratchGain(event: Event): void {
  props.backing.setScratchGain((event.target as HTMLInputElement).valueAsNumber)
}
</script>

<template>
  <section
    class="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2"
    aria-label="Backing accompaniment"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
        Backing deck
      </span>
      <span
        class="font-mono text-[10px] tabular-nums"
        :class="statusClass"
        role="status"
      >{{ statusText }}</span>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <!-- Track selection -->
      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
        <span class="text-[11px] text-zinc-500">Tracks</span>
        <template v-if="backing.tracks.value.length">
          <button
            v-for="track in backing.tracks.value"
            :key="track.id"
            type="button"
            class="max-w-[10rem] truncate rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            :class="backing.isSelected(track.id)
              ? 'border border-sky-500 bg-sky-500/15 text-sky-200'
              : 'border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'"
            :aria-pressed="backing.isSelected(track.id)"
            :disabled="disabled"
            @click="backing.toggleTrack(track.id)"
          >
            {{ track.name }}
          </button>
        </template>
        <span
          v-else
          class="text-[11px] text-zinc-600"
        >No tracks available</span>
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
            :disabled="disabled"
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
            :disabled="disabled"
            @click="backing.setDuration(seconds)"
          >
            {{ seconds }}s
          </button>
        </div>
      </div>

      <!-- Monitor levels (audition-only trims; never baked into the pattern) -->
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
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-zinc-500">Scratch</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            class="h-1 w-20 cursor-pointer accent-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            :value="backing.scratchGain.value"
            :disabled="disabled"
            aria-label="Scratch monitor level"
            @input="onScratchGain"
          >
          <span class="w-8 font-mono text-[10px] tabular-nums text-zinc-400">{{ scratchPct }}</span>
        </label>
      </div>

      <!-- Actions -->
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded bg-sky-600 px-3 py-1 text-[11px] font-medium text-zinc-50 transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="disabled || !backing.canPrepare.value"
          @click="backing.prepare()"
        >
          <span
            v-if="backing.isPreparing.value"
            class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-50/40 border-t-zinc-50"
            aria-hidden="true"
          />
          <span>{{ backing.isPreparing.value ? 'Preparing' : 'Prepare' }}</span>
        </button>
        <button
          type="button"
          class="rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="disabled || backing.status.value === 'none'"
          @click="backing.clear()"
        >
          Clear
        </button>
      </div>
    </div>
  </section>
</template>
