<script setup lang="ts">
import type { SkipButtonTarget } from '@/stores/uiStore'

const followPlayback = defineModel<boolean>('followPlayback', { required: true })
const matchProjectTempoOnDrop = defineModel<boolean>('matchProjectTempoOnDrop', { required: true })
const seedProjectTempoFromFirstClip = defineModel<boolean>('seedProjectTempoFromFirstClip', { required: true })
const alignClipsToGridOnAnalysis = defineModel<boolean>('alignClipsToGridOnAnalysis', { required: true })
const skipButtonTarget = defineModel<SkipButtonTarget>('skipButtonTarget', { required: true })
</script>

<template>
  <section>
    <label class="flex cursor-pointer items-start gap-3">
      <input
        v-model="followPlayback"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Follow playback</span>
        <span class="mt-0.5 block text-zinc-500">
          Scroll the timeline during playback so the playhead stays
          centred in the viewport. Turn off if you want the view to
          stay still while playing. Can also be toggled from the
          transport bar.
        </span>
      </span>
    </label>
    <label class="mt-3 flex cursor-pointer items-start gap-3">
      <input
        v-model="seedProjectTempoFromFirstClip"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Set project tempo from first clip</span>
        <span class="mt-0.5 block text-zinc-500">
          When you drop the first clip onto a new project, adopt its
          detected tempo as the project BPM. Turn off to keep the
          project at its current tempo; you can always set the BPM
          yourself from the transport bar.
        </span>
      </span>
    </label>
    <label class="mt-3 flex cursor-pointer items-start gap-3">
      <input
        v-model="matchProjectTempoOnDrop"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Match project tempo on drop</span>
        <span class="mt-0.5 block text-zinc-500">
          When dragging a clip onto a track, automatically enable
          warp so its source BPM matches the project BPM. Turn off
          to drop clips at their native tempo; you can still enable
          warp per-clip via right-click ▸ Warp.
        </span>
      </span>
    </label>
    <label class="mt-3 flex cursor-pointer items-start gap-3">
      <input
        v-model="alignClipsToGridOnAnalysis"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Align clips to the beat grid after analysis</span>
        <span class="mt-0.5 block text-zinc-500">
          Once a clip's tempo has been detected, nudge it so its beats line up
          with the timeline's beat grid, so splitting and marker placement stay
          on the beat. Clips with no detected beats (such as simple samples) are
          left where you placed them.
        </span>
      </span>
    </label>
    <div class="mt-4">
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Previous / next buttons
      </h2>
      <p class="mb-3 text-zinc-500">
        Choose where the transport's previous and next buttons jump to.
      </p>
      <div class="space-y-2">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="skipButtonTarget"
            type="radio"
            name="skip-button-target"
            value="markers"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Markers</span>
            <span class="text-zinc-500"> — Step through timeline markers</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="skipButtonTarget"
            type="radio"
            name="skip-button-target"
            value="timelineEnds"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Timeline ends</span>
            <span class="text-zinc-500"> — Jump to project start / end</span>
          </span>
        </label>
      </div>
    </div>
  </section>
</template>
