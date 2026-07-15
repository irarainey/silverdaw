<script setup lang="ts">
import { computed } from 'vue'
import type { ScratchRecordPhase } from '@/lib/scratch/useScratchRecordControl'
import ScratchVinylDeck from '@/components/ScratchVinylDeck.vue'
import ScratchCrossfader from '@/components/ScratchCrossfader.vue'

const props = defineProps<{
  scratchGain: number
  scratchGainDisabled: boolean
  platterTurns: number
  platterTouched: boolean
  platterDisabled: boolean
  crossfaderValue: number
  crossfaderReversed: boolean
  crossfaderDisabled: boolean
  recordPhase: ScratchRecordPhase
  recordButtonLabel: string
  recordButtonClass: string
  recordButtonAriaLabel: string
  recordDisabled: boolean
  hasPattern: boolean
  isPatternReplaying: boolean
}>()

const emit = defineEmits<{
  (event: 'scratch-gain', value: number): void
  (event: 'platter-touch', touched: boolean): void
  (event: 'platter-move', deltaTurns: number, clientTimeMs: number): void
  (event: 'crossfader-change', value: number): void
  (event: 'record'): void
  (event: 'play-toggle'): void
  (event: 'clear'): void
}>()

const scratchGainPct = computed(() => `${Math.round(props.scratchGain * 100)}%`)

function onScratchGain(event: Event): void {
  emit('scratch-gain', (event.target as HTMLInputElement).valueAsNumber)
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-col items-stretch gap-3">
    <div class="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
      <span class="text-[11px] text-zinc-500">Scratch</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="h-1 flex-1 cursor-pointer accent-sky-500 outline-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        :value="scratchGain"
        :disabled="scratchGainDisabled"
        aria-label="Scratch monitor level"
        @input="onScratchGain"
      >
      <span class="w-8 text-right font-mono text-[10px] tabular-nums text-zinc-400">{{ scratchGainPct }}</span>
    </div>
    <div class="flex items-center justify-center">
      <ScratchVinylDeck
        :platter-turns="platterTurns"
        :touched="platterTouched"
        :disabled="platterDisabled"
        @platter-touch="(touched) => emit('platter-touch', touched)"
        @platter-move="(deltaTurns, clientTimeMs) => emit('platter-move', deltaTurns, clientTimeMs)"
      />
    </div>
    <div class="flex justify-center">
      <div class="w-1/2">
        <ScratchCrossfader
          :value="crossfaderValue"
          :reversed="crossfaderReversed"
          :disabled="crossfaderDisabled"
          @change="(value) => emit('crossfader-change', value)"
        />
      </div>
    </div>

    <!-- Record + draft controls, pinned to the bottom so the row aligns
         with the foot of the notation panel. Play and Clear act on the
         recorded scratch draft and stay disabled until one exists. -->
    <div class="mt-auto mb-[3px] flex items-stretch gap-1">
      <button
        type="button"
        class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        :class="recordButtonClass"
        :disabled="recordDisabled"
        :aria-label="recordButtonAriaLabel"
        title="Toggle record (R)"
        @click="emit('record')"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="recordPhase === 'idle' ? 'bg-red-400' : 'animate-pulse bg-white'"
          aria-hidden="true"
        />
        {{ recordButtonLabel }}
      </button>
      <button
        type="button"
        class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded bg-sky-600 px-2 py-1 text-xs font-medium text-zinc-50 transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        :disabled="!hasPattern"
        :aria-label="isPatternReplaying ? 'Stop scratch playback' : 'Play scratch'"
        @click="emit('play-toggle')"
      >
        {{ isPatternReplaying ? 'Stop' : 'Play' }}
      </button>
      <button
        type="button"
        class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded bg-sky-600 px-2 py-1 text-xs font-medium text-zinc-50 transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        :disabled="!hasPattern"
        aria-label="Clear recorded scratch"
        title="Discard the recorded scratch"
        @click="emit('clear')"
      >
        Clear
      </button>
    </div>
  </div>
</template>
