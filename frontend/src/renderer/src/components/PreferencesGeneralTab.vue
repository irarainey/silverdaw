<script setup lang="ts">
import type { SkipButtonTarget, WaveformDisplayMode } from '@/stores/uiStore'

const toastsEnabled = defineModel<boolean>('toastsEnabled', { required: true })
const followPlayback = defineModel<boolean>('followPlayback', { required: true })
const showLibraryTileImages = defineModel<boolean>('showLibraryTileImages', { required: true })
const matchProjectTempoOnDrop = defineModel<boolean>('matchProjectTempoOnDrop', { required: true })
const cleanupProjectFiles = defineModel<boolean>('cleanupProjectFiles', { required: true })
const skipButtonTarget = defineModel<SkipButtonTarget>('skipButtonTarget', { required: true })
const waveformDisplayMode = defineModel<WaveformDisplayMode>('waveformDisplayMode', { required: true })
</script>

<template>
  <section>
    <label class="flex cursor-pointer items-start gap-3">
      <input
        v-model="toastsEnabled"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Show toast notifications</span>
        <span class="mt-0.5 block text-zinc-500">
          Pop transient feedback (errors, save confirmations) in the
          bottom-right corner. Turn off for a quieter UI; events are
          still written to the log when debugging is enabled.
        </span>
      </span>
    </label>
    <label class="mt-3 flex cursor-pointer items-start gap-3">
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
        v-model="showLibraryTileImages"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Show images on library tiles</span>
        <span class="mt-0.5 block text-zinc-500">
          Display embedded cover art, or the fallback audio icon, on
          each library tile. Turn off for a denser text-only library.
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
        v-model="cleanupProjectFiles"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Clean up project files on remove</span>
        <span class="mt-0.5 block text-zinc-500">
          When you remove a stem or sample from the library, also delete its
          generated file from the project's stems / samples folder (and the empty
          folder it leaves behind). Cover art and tag data are removed once nothing
          else in the project uses them. Your original imported audio files are
          never deleted. Off by default — removal only unlinks from the project.
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
            value="timelineEnds"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Timeline ends</span>
            <span class="text-zinc-500"> — Jump to project start / end</span>
          </span>
        </label>
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
      </div>
    </div>
    <div class="mt-4">
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Waveform display
      </h2>
      <p class="mb-3 text-zinc-500">
        Choose how clip waveforms are drawn in the timeline and Clip
        Editor. Mono clips always show a single waveform.
      </p>
      <div class="space-y-2">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="summary"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Single waveform</span>
            <span class="text-zinc-500"> — One combined waveform per clip</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="stereo"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Left and right</span>
            <span class="text-zinc-500"> — Separate L / R for stereo clips</span>
          </span>
        </label>
      </div>
    </div>
  </section>
</template>
