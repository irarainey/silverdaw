<script setup lang="ts">
// A single labelled range slider used by every Track FX module (Tone
// bands, per-track Reverb / Delay amounts, project Reverb / Delay).
// Presentational only: it owns
// the slider chrome (the dark track + light thumb, no focus ring) and the
// label / value-readout layout, and re-emits the raw numeric value on
// `input` / `change` plus a `reset` on double-click. The parent owns the
// value domain, the formatted `display` string, and the undo-gesture
// wiring — keeping a single source of truth for the slider styling that
// every effect shares.

defineProps<{
  /** Short uppercase control label, e.g. "Bass", "Reverb", "Mix". */
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
  /** When true, show a small "A" button that re-emits `automate`. */
  automatable?: boolean
  /** When true, a curve owns this value: dim the slider and flag it automated. */
  automated?: boolean
}>()

const emit = defineEmits<{
  input: [value: number]
  change: [value: number]
  reset: []
  automate: []
}>()

function num(target: EventTarget | null): number {
  return Number((target as HTMLInputElement).value)
}
</script>

<template>
  <label class="flex flex-col gap-1.5">
    <span class="flex items-center justify-between">
      <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
        {{ label }}
        <span
          v-if="automated"
          class="rounded bg-sky-900/60 px-1 text-[8px] font-semibold tracking-normal text-sky-300"
        >AUTO</span>
      </span>
      <span class="flex items-center gap-1">
        <span class="font-mono text-[10px] tabular-nums text-zinc-400">{{ display }}</span>
        <button
          v-if="automatable"
          type="button"
          class="flex h-3.5 w-3.5 items-center justify-center rounded border text-[8px] font-bold leading-none transition-colors"
          :class="automated
            ? 'border-sky-400 bg-sky-500 text-zinc-950'
            : 'border-zinc-600 bg-zinc-800 text-zinc-400 hover:border-sky-500 hover:text-sky-300'"
          :title="automated ? 'Editing automation lane' : 'Automate this over the timeline'"
          aria-label="Automate parameter"
          @click.prevent="emit('automate')"
        >A</button>
      </span>
    </span>
    <input
      class="fx-range-input w-full"
      :class="{ 'fx-range-input--disabled opacity-70': automated }"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      :disabled="automated"
      :aria-label="assistiveLabel"
      :title="automated ? 'Automated over the timeline — edit the lane to change this' : title"
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

.fx-range-input--disabled {
  cursor: not-allowed;
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
