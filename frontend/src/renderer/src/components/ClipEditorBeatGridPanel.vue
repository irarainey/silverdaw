<script setup lang="ts">
// Manual-tempo fallback inside the Clip Editor effects rack. Lets the user pin
// a BPM for the source when detection fails or is wrong, then slide the rigid
// beat grid over the waveform to fix its phase. Pure presentation: the state +
// actions live in `useClipEditorBeatGrid` and are passed in via the `grid` prop.

import type { ClipEditorBeatGrid } from '@/lib/clipEditor/useClipEditorBeatGrid'

const props = defineProps<{
  grid: ClipEditorBeatGrid
}>()

// Alias refs so the template never reaches through the prop directly.
const manualBpmInput = props.grid.manualBpmInput
const originalBpm = props.grid.originalBpm
const alignActive = props.grid.alignActive

/** Wheel over the BPM field steps by 1 (whole integer), or 0.01 with Alt held (fine). */
function onBpmWheel(e: WheelEvent): void {
  if (!props.grid.hasGrid()) return
  e.preventDefault()
  const direction = e.deltaY < 0 ? 1 : -1
  props.grid.bumpBpm(direction * (e.altKey ? 0.01 : 1))
}
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <!-- Tempo: the beat spacing. This field IS the source BPM. -->
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Tempo
      </legend>
      <div class="flex items-center gap-2">
        <input
          v-model="manualBpmInput"
          type="number"
          min="20"
          max="300"
          step="0.01"
          placeholder="BPM"
          aria-label="Beat grid BPM"
          title="Scroll to adjust by 1 BPM; hold Alt for 0.01"
          class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
          @focus="props.grid.beginTempoEdit()"
          @keydown.enter.prevent="props.grid.commitTempoEdit()"
          @blur="props.grid.commitTempoEdit(true)"
          @wheel="onBpmWheel"
        >
        <span class="text-[10px] text-zinc-500">BPM</span>
        <button
          type="button"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40"
          :disabled="!props.grid.hasGrid()"
          aria-label="Halve BPM"
          title="Halve the tempo"
          @click="props.grid.halveBpm()"
        >
          ÷2
        </button>
        <button
          type="button"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40"
          :disabled="!props.grid.hasGrid()"
          aria-label="Double BPM"
          title="Double the tempo"
          @click="props.grid.doubleBpm()"
        >
          ×2
        </button>
        <button
          type="button"
          class="ml-auto rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          :class="{ invisible: !props.grid.canRestore() }"
          :disabled="!props.grid.canRestore()"
          :title="originalBpm !== null ? `Restore the original tempo (${originalBpm.toFixed(2)} BPM)` : 'Restore the original tempo'"
          @click="props.grid.restoreOriginalBpm()"
        >
          Restore
        </button>
      </div>
      <div
        class="text-[10px] text-zinc-500"
        :class="{ invisible: !props.grid.canRestore() }"
      >
        Original {{ originalBpm !== null ? originalBpm.toFixed(2) : '—' }} BPM · press Enter to set a new tempo
      </div>
    </fieldset>

    <!-- Position: where beat 1 sits over the waveform. -->
    <fieldset
      class="flex flex-col gap-1"
      :disabled="!props.grid.hasGrid()"
      :class="!props.grid.hasGrid() ? 'opacity-50' : ''"
    >
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Position
      </legend>
      <button
        type="button"
        class="rounded border px-2 py-1 text-xs transition-colors"
        :class="alignActive
          ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
          : 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:border-zinc-600 hover:text-zinc-100'
        "
        :aria-pressed="alignActive"
        @click="props.grid.toggleAlign()"
      >
        {{ alignActive ? 'Aligning — drag the waveform' : 'Slide grid to align' }}
      </button>
      <p class="text-[10px] text-zinc-500">
        Drag left/right across the waveform to slide the beat grid onto the beats.
      </p>
      <div class="mt-1 flex items-center gap-1.5">
        <span class="text-[10px] text-zinc-500">Nudge</span>
        <button
          type="button"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          aria-label="Nudge grid 5 milliseconds earlier"
          @click="props.grid.nudgeAnchorMs(-5)"
        >
          ◀
        </button>
        <button
          type="button"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          aria-label="Nudge grid 5 milliseconds later"
          @click="props.grid.nudgeAnchorMs(5)"
        >
          ▶
        </button>
        <button
          type="button"
          class="ml-auto rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          aria-label="Shift grid by half a beat"
          @click="props.grid.nudgeHalfBeat(1)"
        >
          ½ beat
        </button>
      </div>
      <p class="text-[10px] text-zinc-500">
        Fine-nudge by 5 ms, or shift a half beat if the grid sits on the off-beat.
      </p>
    </fieldset>
  </div>
</template>

<style scoped>
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
