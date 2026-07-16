<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'
import { useScratchWaveformView } from '@/lib/scratch/useScratchWaveformView'
import { renderScratchWaveform } from '@/lib/scratch/scratchWaveformRenderer'

const props = defineProps<{
  peaks: Float32Array
  peaksPerSecond: number
  channelPeaks: readonly Float32Array[]
  channelPeaksPerSecond: number
  /** Source-window duration in ms. */
  sourceDurationMs: number
  /** Prepared playback duration in ms. */
  preparedDurationMs: number
  /** Source-window start offset in ms. */
  inMs: number
  /** Whether the clip source is reversed. */
  reversed: boolean
  /** Source beat-grid tempo. */
  sourceBpm: number | undefined
  /** Source-file beat-grid anchor in seconds. */
  beatAnchorSec: number | undefined
  positionMs: number
  isPlaying: boolean
  playbackRate: number
}>()

const ui = useUiStore()
const canvasEl = ref<HTMLCanvasElement | null>(null)

function draw(): void {
  const ctx = canvasEl.value?.getContext('2d')
  if (!ctx) return
  renderScratchWaveform(ctx, {
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    viewStartMs: view.visibleStartMs.value,
    viewDurationMs: view.visibleDurationMs.value,
    peaks: props.peaks,
    peaksPerSecond: props.peaksPerSecond,
    channelPeaks: props.channelPeaks,
    useStereoLanes: ui.waveformDisplayMode === 'stereo',
    channelPeaksPerSecond: props.channelPeaksPerSecond,
    sourceDurationMs: props.sourceDurationMs,
    preparedDurationMs: props.preparedDurationMs,
    inMs: props.inMs,
    reversed: props.reversed,
    sourceBpm: props.sourceBpm,
    beatAnchorSec: props.beatAnchorSec,
    positionMs: props.positionMs
  })
}

const view = useScratchWaveformView({
  canvasEl,
  preparedDurationMs: computed(() => props.preparedDurationMs),
  positionMs: computed(() => props.positionMs),
  isPlaying: computed(() => props.isPlaying),
  playbackRate: computed(() => props.playbackRate),
  zoomPxPerSecond: computed(() => ui.zoomPxPerSecond),
  onResize: draw
})

watch(
  () => [
    props.peaks,
    props.peaksPerSecond,
    props.channelPeaks,
    props.channelPeaksPerSecond,
    props.sourceDurationMs,
    props.preparedDurationMs,
    props.inMs,
    props.reversed,
    props.sourceBpm,
    props.beatAnchorSec,
    props.positionMs,
    ui.waveformDisplayMode,
    view.visibleStartMs.value,
    view.visibleDurationMs.value
  ] as const,
  draw
)
</script>

<template>
  <div class="relative w-full overflow-hidden rounded border border-zinc-800 bg-zinc-950">
    <canvas
      ref="canvasEl"
      class="block h-[min(195px,20vh)] w-full"
      aria-label="Scratch waveform"
      role="img"
      @wheel="view.onWheel"
    />
    <!-- Zoom controls overlaid in the bottom-right corner as a single grouped box
         to reclaim the vertical space a separate control row would otherwise take. -->
    <div class="absolute bottom-3 right-1.5 inline-flex items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900/90">
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom out"
        :disabled="view.zoom.value <= view.MIN_ZOOM + 0.0001"
        @click="view.zoomOut"
      >
        <span class="text-sm leading-none">-</span>
      </button>
      <button
        type="button"
        class="min-w-10 border-x border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-200 hover:bg-zinc-800"
        title="Reset zoom"
        @click="view.resetZoom"
      >
        {{ Math.round(view.zoom.value * 100) }}%
      </button>
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom in"
        :disabled="view.zoom.value >= view.MAX_ZOOM - 0.01"
        @click="view.zoomIn"
      >
        <span class="text-sm leading-none">+</span>
      </button>
    </div>
    <!-- Horizontal scrollbar, flush to the bottom edge of the waveform window
         and full width, matching how the main timeline renders it. -->
    <div
      class="absolute inset-x-0 bottom-0 h-2 cursor-pointer bg-zinc-900/80"
      :title="`Scroll (zoom ${Math.round(view.zoom.value * 100)}%)`"
      @mousedown="view.onScrollbarMouseDown"
    >
      <div
        class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
        :style="{
          left: preparedDurationMs > 0
            ? `${(view.visibleStartMs.value / preparedDurationMs) * 100}%`
            : '0%',
          width: preparedDurationMs > 0
            ? `${Math.max(2, (view.visibleDurationMs.value / preparedDurationMs) * 100)}%`
            : '100%'
        }"
      />
    </div>
  </div>
</template>
