<script setup lang="ts">
import type { SkipButtonTarget, WaveformDisplayMode } from '@/stores/uiStore'
import type { BrakeDurationDto, BrakeCurveDto } from '@shared/types'

const toastsEnabled = defineModel<boolean>('toastsEnabled', { required: true })
const followPlayback = defineModel<boolean>('followPlayback', { required: true })
const showLibraryTileImages = defineModel<boolean>('showLibraryTileImages', { required: true })
const matchProjectTempoOnDrop = defineModel<boolean>('matchProjectTempoOnDrop', { required: true })
const cleanupProjectFiles = defineModel<boolean>('cleanupProjectFiles', { required: true })
const skipButtonTarget = defineModel<SkipButtonTarget>('skipButtonTarget', { required: true })
const waveformDisplayMode = defineModel<WaveformDisplayMode>('waveformDisplayMode', { required: true })
const brakeDuration = defineModel<BrakeDurationDto>('brakeDuration', { required: true })
const brakeCurve = defineModel<BrakeCurveDto>('brakeCurve', { required: true })
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
          class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            v-model="skipButtonTarget"
            type="radio"
            name="skip-button-target"
            value="timelineEnds"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">Start and end of the timeline</span>
            <span class="mt-0.5 block text-zinc-500">
              Previous jumps to the start of the project; next jumps to
              the end.
            </span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            v-model="skipButtonTarget"
            type="radio"
            name="skip-button-target"
            value="markers"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">Previous and next marker</span>
            <span class="mt-0.5 block text-zinc-500">
              Step through your timeline markers. Past the last marker
              in either direction, jumps to the start or end instead.
            </span>
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
          class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="summary"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">Single waveform</span>
            <span class="mt-0.5 block text-zinc-500">
              Show one combined waveform per clip. Cleaner and easier
              to read at a glance.
            </span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            v-model="waveformDisplayMode"
            type="radio"
            name="waveform-display-mode"
            value="stereo"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">Left and right channels</span>
            <span class="mt-0.5 block text-zinc-500">
              Stack separate left and right waveforms for stereo clips
              so you can see differences between the channels.
            </span>
          </span>
        </label>
      </div>
    </div>
    <div class="mt-4">
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Turntable brake
      </h2>
      <p class="mb-3 text-zinc-500">
        The brake (right-click a clip ▸ Brake) decelerates the clip to a stop at
        its end, like a vinyl record-stop. These set how long it takes and how
        the slowdown is shaped, for every braked clip.
      </p>
      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <span class="w-20 font-medium text-zinc-200">Duration</span>
          <select
            v-model="brakeDuration"
            class="flex-1 cursor-pointer rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 accent-sky-500"
          >
            <option value="short">Short — quick stop (~0.4 s)</option>
            <option value="medium">Medium — balanced (~0.6 s)</option>
            <option value="long">Long — drawn-out (~0.9 s)</option>
          </select>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <span class="w-20 font-medium text-zinc-200">Curve</span>
          <select
            v-model="brakeCurve"
            class="flex-1 cursor-pointer rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 accent-sky-500"
          >
            <option value="linear">Linear — constant slowdown</option>
            <option value="curved">Curved — fast then easing (record-stop)</option>
            <option value="steep">Steep — very fast then a long sag</option>
          </select>
        </label>
      </div>
    </div>
  </section>
</template>
