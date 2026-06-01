<script setup lang="ts">
// A single labelled range slider used by every Track FX module (Tone
// bands, track Sends, project Room / Echo). Presentational only: it owns
// the slider chrome (the dark track + light thumb, no focus ring) and the
// label / value-readout layout, and re-emits the raw numeric value on
// `input` / `change` plus a `reset` on double-click. The parent owns the
// value domain, the formatted `display` string, and the undo-gesture
// wiring — keeping a single source of truth for the slider styling that
// every effect shares.

defineProps<{
  /** Short uppercase control label, e.g. "Bass", "Room", "Mix". */
  label: string
  /** Pre-formatted right-aligned value readout, e.g. "+3.0 dB", "45%". */
  display: string
  /** Current value in the parent's domain. */
  value: number
  min: number
  max: number
  step: number
  /** Spoken-form accessible label for assistive tech. */
  assistiveLabel: string
  /** Optional native tooltip (e.g. the double-click-to-reset hint). */
  title?: string
}>()

const emit = defineEmits<{
  input: [value: number]
  change: [value: number]
  reset: []
}>()

function num(target: EventTarget | null): number {
  return Number((target as HTMLInputElement).value)
}
</script>

<template>
  <label class="flex flex-col gap-1">
    <span class="flex items-center justify-between">
      <span class="text-[10px] uppercase tracking-wider text-zinc-500">{{ label }}</span>
      <span class="font-mono text-[10px] tabular-nums text-zinc-400">{{ display }}</span>
    </span>
    <input
      class="fx-range-input w-full"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      :aria-label="assistiveLabel"
      :title="title"
      @input="emit('input', num($event.target))"
      @change="emit('change', num($event.target))"
      @dblclick="emit('reset')"
    >
  </label>
</template>

<style scoped>
.fx-range-input {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  background: #3f3f46;
  cursor: pointer;
  outline: none;
}

.fx-range-input:focus,
.fx-range-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.fx-range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.fx-range-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

/* Firefox draws a dotted focus ring around the thumb; suppress it. */
.fx-range-input::-moz-focus-outer {
  border: 0;
}
</style>
