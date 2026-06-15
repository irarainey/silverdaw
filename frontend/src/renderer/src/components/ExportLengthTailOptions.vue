<script setup lang="ts">
import { formatTime } from '@/lib/musicTime'

type ExportLengthMode = 'trim-to-last-clip' | 'fixed-duration'

const lengthMode = defineModel<ExportLengthMode>('lengthMode', { required: true })
const durationText = defineModel<string>('durationText', { required: true })
const tailSecondsText = defineModel<string>('tailSecondsText', { required: true })
const mixdownStartBar = defineModel<number>('mixdownStartBar', { required: true })

defineProps<Readonly<{
  lastClipEndMs: number
  tailValid: boolean
  mixdownStartMs: number
}>>()
</script>

<template>
  <div class="mb-5 flex gap-8">
    <section class="flex-1">
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Start from bar
      </label>
      <div class="flex items-center gap-2">
        <input
          v-model.number="mixdownStartBar"
          type="number"
          min="-64"
          max="4096"
          step="1"
          class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-right font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500"
        >
        <span class="text-xs text-zinc-400">timeline ruler bar</span>
      </div>
      <p class="mt-1 text-[10px] text-zinc-500">
        {{ mixdownStartMs > 0
          ? `Skips the first ${formatTime(mixdownStartMs)}.`
          : 'Renders from the project start.' }}
      </p>
    </section>

    <section class="flex-1">
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Tail
      </label>
      <div class="flex items-center gap-2">
        <input
          v-model="tailSecondsText"
          type="text"
          spellcheck="false"
          inputmode="decimal"
          class="w-20 rounded border px-2 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500"
          :class="tailValid
            ? 'border-zinc-700 bg-zinc-950'
            : 'border-rose-600 bg-zinc-950'"
        >
        <span class="text-xs text-zinc-400">seconds of silence after the timeline</span>
      </div>
      <p class="mt-1 text-[10px] text-zinc-500">
        Lets reverb / delay clips ring out past the timeline end. Range 0–60 s.
      </p>
    </section>
  </div>

  <section class="mb-5">
    <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
      Length
    </label>
    <div class="space-y-2">
      <label class="flex cursor-pointer items-center gap-1.5">
        <input
          v-model="lengthMode"
          type="radio"
          value="fixed-duration"
          class="accent-cyan-500"
        >
        <span>Clip at duration</span>
        <input
          v-model="durationText"
          type="text"
          spellcheck="false"
          :disabled="lengthMode !== 'fixed-duration'"
          class="ml-2 w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
      </label>
      <label class="flex cursor-pointer items-center gap-1.5">
        <input
          v-model="lengthMode"
          type="radio"
          value="trim-to-last-clip"
          class="accent-cyan-500"
        >
        <span>Trim to end of last clip</span>
        <span
          v-if="lengthMode === 'trim-to-last-clip'"
          class="ml-2 font-mono text-[11px] text-zinc-500"
        >({{ formatTime(lastClipEndMs) }})</span>
      </label>
    </div>
  </section>
</template>

<style scoped>
/* Hide native number spinners to match the other Silverdaw numeric inputs. */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
