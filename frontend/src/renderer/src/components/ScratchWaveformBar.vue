<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'
import {
  COL_BEAT,
  COL_PLAYHEAD,
  COL_RULER_BG,
  COL_RULER_BORDER,
  COL_RULER_TICK,
  COL_WAVE
} from '@/lib/clipEditor/clipEditorWaveformTheme'
import { drawScratchWaveformLane } from '@/lib/scratch/scratchWaveformLane'

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
const zoom = ref(1)
const scrollMs = ref(0)
const canvasCssWidth = ref(0)
let resizeObserver: ResizeObserver | null = null
let followFrame: number | null = null
let lastFollowMs = 0
let positionReceivedAtMs = 0
const RULER_HEIGHT = 20
const MIN_ZOOM = 1
const MAX_ZOOM = 64
const ZOOM_STEP = 0.1

const basePxPerMs = computed(() => {
  const durationMs = props.preparedDurationMs
  const fitPxPerMs =
    canvasCssWidth.value > 0 && durationMs > 0
      ? canvasCssWidth.value / durationMs
      : 0
  return Math.max(fitPxPerMs, Math.max(0.001, ui.zoomPxPerSecond / 1000))
})
const visibleDurationMs = computed(() => {
  const durationMs = props.preparedDurationMs
  if (durationMs <= 0 || canvasCssWidth.value <= 0) return durationMs
  return Math.min(durationMs, canvasCssWidth.value / (basePxPerMs.value * zoom.value))
})
const maxScrollMs = computed(() =>
  Math.max(0, props.preparedDurationMs - visibleDurationMs.value)
)
const visibleStartMs = computed(() =>
  Math.max(0, Math.min(maxScrollMs.value, scrollMs.value))
)

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function draw(): void {
  const canvas = canvasEl.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const W = canvas.width
  const H = canvas.height
  if (W <= 0 || H <= 0) return

  ctx.fillStyle = cssHex(COL_RULER_BG)
  ctx.fillRect(0, 0, W, H)
  const viewStartMs = visibleStartMs.value
  const viewDurationMs = visibleDurationMs.value
  drawRuler(ctx, W, viewStartMs, viewDurationMs)

  const waveTop = RULER_HEIGHT
  const waveHeight = H - waveTop
  const mid = waveTop + waveHeight / 2

  const { peaks, peaksPerSecond, sourceDurationMs, preparedDurationMs, inMs, reversed } = props
  if (
    !peaks
    || peaks.length < 2
    || peaksPerSecond <= 0
    || sourceDurationMs <= 0
    || preparedDurationMs <= 0
  ) {
    drawBaseline(ctx, W, mid)
    drawBeatMarkers(ctx, W, H, viewStartMs, viewDurationMs)
    drawPlayhead(ctx, W, H, viewStartMs, viewDurationMs)
    return
  }

  const visibleStartFraction = viewStartMs / preparedDurationMs
  const visibleFraction = viewDurationMs / preparedDurationMs
  const stereoPeaks = ui.waveformDisplayMode === 'stereo' && props.channelPeaks.length === 2
    ? props.channelPeaks
    : null
  const lanes = stereoPeaks ?? [peaks]
  const lanePeaksPerSecond = stereoPeaks
    ? props.channelPeaksPerSecond
    : peaksPerSecond
  const laneHeight = waveHeight / lanes.length
  for (let channel = 0; channel < lanes.length; channel++) {
    const laneMidY = waveTop + laneHeight * (channel + 0.5)
    drawScratchWaveformLane({
      ctx,
      peaks: lanes[channel]!,
      peaksPerSecond: lanePeaksPerSecond,
      width: W,
      laneMidY,
      laneHalfHeight: laneHeight / 2 - 1,
      visibleStartFraction,
      visibleFraction,
      inMs,
      sourceDurationMs,
      reversed,
      color: cssHex(COL_WAVE)
    })
  }

  for (let channel = 0; channel < lanes.length; channel++) {
    drawBaseline(ctx, W, waveTop + laneHeight * (channel + 0.5))
  }
  drawBeatMarkers(ctx, W, H, viewStartMs, viewDurationMs)
  drawPlayhead(ctx, W, H, viewStartMs, viewDurationMs)
}

function drawBaseline(ctx: CanvasRenderingContext2D, width: number, midY: number): void {
  const lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1))
  const y = Math.round(midY) + (lineWidth % 2 === 1 ? 0.5 : 0)
  ctx.strokeStyle = cssHex(COL_WAVE)
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(width, y)
  ctx.stroke()
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  W: number,
  viewStartMs: number,
  viewDurationMs: number
): void {
  ctx.strokeStyle = cssHex(COL_RULER_BORDER)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, RULER_HEIGHT - 0.5)
  ctx.lineTo(W, RULER_HEIGHT - 0.5)
  ctx.stroke()

  if (viewDurationMs <= 0) return
  const majorStepsMs = [100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000]
  const desiredStepMs = (viewDurationMs / W) * 80
  const majorMs = majorStepsMs.find((step) => step >= desiredStepMs) ?? 60_000
  const minorMs = majorMs / 5
  const viewEndMs = viewStartMs + viewDurationMs
  const firstTickMs = Math.ceil(viewStartMs / minorMs) * minorMs
  ctx.strokeStyle = cssHex(COL_RULER_TICK)
  ctx.fillStyle = '#a1a1aa'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  for (let timeMs = firstTickMs; timeMs <= viewEndMs + 0.001; timeMs += minorMs) {
    const x = Math.round(((timeMs - viewStartMs) / viewDurationMs) * W) + 0.5
    const isMajor = Math.abs(timeMs / majorMs - Math.round(timeMs / majorMs)) < 1e-6
    const tickHeight = isMajor ? 8 : 4
    ctx.beginPath()
    ctx.moveTo(x, RULER_HEIGHT - tickHeight)
    ctx.lineTo(x, RULER_HEIGHT)
    ctx.stroke()
    if (isMajor) {
      const seconds = timeMs / 1000
      const minutes = Math.floor(seconds / 60)
      ctx.fillText(`${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`, x + 3, 10)
    }
  }
}

function drawBeatMarkers(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  viewStartMs: number,
  viewDurationMs: number
): void {
  const { sourceBpm, beatAnchorSec, inMs, sourceDurationMs, reversed } = props
  if (!sourceBpm || sourceBpm <= 0 || beatAnchorSec === undefined || sourceDurationMs <= 0) return
  const beatSpacingMs = (60 / sourceBpm) * 1000
  const windowEndMs = inMs + sourceDurationMs
  let beatMs = beatAnchorSec * 1000 + Math.ceil((inMs - beatAnchorSec * 1000) / beatSpacingMs) * beatSpacingMs
  ctx.strokeStyle = cssHex(COL_BEAT)
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  let lastX = Number.NEGATIVE_INFINITY
  while (beatMs <= windowEndMs + 0.5) {
    const sourceFraction = (beatMs - inMs) / sourceDurationMs
    const preparedMs =
      (reversed ? 1 - sourceFraction : sourceFraction) * props.preparedDurationMs
    const x = Math.round(((preparedMs - viewStartMs) / viewDurationMs) * W) + 0.5
    if (x >= 0 && x <= W && Math.abs(x - lastX) >= 4) {
      ctx.beginPath()
      ctx.moveTo(x, RULER_HEIGHT)
      ctx.lineTo(x, H)
      ctx.stroke()
      lastX = x
    }
    beatMs += beatSpacingMs
  }
  ctx.globalAlpha = 1
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  viewStartMs: number,
  viewDurationMs: number
): void {
  if (viewDurationMs <= 0) return
  const phX = Math.round(((props.positionMs - viewStartMs) / viewDurationMs) * W)
  if (phX < 0 || phX > W) return
  ctx.strokeStyle = cssHex(COL_PLAYHEAD)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(phX, 0)
  ctx.lineTo(phX, H)
  ctx.stroke()
  ctx.fillStyle = cssHex(COL_PLAYHEAD)
  ctx.beginPath()
  ctx.moveTo(phX - 5, 0)
  ctx.lineTo(phX + 5, 0)
  ctx.lineTo(phX, 8)
  ctx.closePath()
  ctx.fill()
}

function syncSize(): void {
  const canvas = canvasEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvasCssWidth.value = rect.width
  const w = Math.round(rect.width * dpr)
  const h = Math.round(rect.height * dpr)
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w
    canvas.height = h
  }
  draw()
}

function setZoomAnchored(nextZoom: number, anchorMs: number): void {
  const previousDurationMs = visibleDurationMs.value
  const anchorFraction =
    previousDurationMs > 0
      ? (anchorMs - visibleStartMs.value) / previousDurationMs
      : 0.5
  const steppedZoom = Math.round(nextZoom / ZOOM_STEP) * ZOOM_STEP
  zoom.value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, steppedZoom))
  const nextDurationMs = visibleDurationMs.value
  scrollMs.value = Math.max(
    0,
    Math.min(maxScrollMs.value, anchorMs - anchorFraction * nextDurationMs)
  )
}

function setZoomAroundCenter(nextZoom: number): void {
  setZoomAnchored(
    nextZoom,
    visibleStartMs.value + visibleDurationMs.value / 2
  )
}

function zoomOut(): void {
  setZoomAroundCenter(zoom.value - ZOOM_STEP)
}

function resetZoom(): void {
  setZoomAroundCenter(MIN_ZOOM)
}

function zoomIn(): void {
  setZoomAroundCenter(zoom.value + ZOOM_STEP)
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  const canvas = canvasEl.value
  if (!canvas || visibleDurationMs.value <= 0) return
  event.preventDefault()
  const rect = canvas.getBoundingClientRect()
  const anchorMs =
    visibleStartMs.value
    + ((event.clientX - rect.left) / rect.width) * visibleDurationMs.value
  setZoomAnchored(
    zoom.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
    anchorMs
  )
}

function onScrollbarMouseDown(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const durationMs = props.preparedDurationMs
  if (durationMs <= 0) return
  const thumbWidth = (visibleDurationMs.value / durationMs) * rect.width
  const grabOffsetMs = (event.clientX - rect.left) / rect.width * durationMs - scrollMs.value
  const onMove = (moveEvent: MouseEvent): void => {
    const next =
      (moveEvent.clientX - rect.left) / rect.width * durationMs - grabOffsetMs
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, next))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  const thumbLeft = (scrollMs.value / durationMs) * rect.width
  if (event.clientX - rect.left < thumbLeft || event.clientX - rect.left > thumbLeft + thumbWidth) {
    scrollMs.value = Math.max(
      0,
      Math.min(
        maxScrollMs.value,
        ((event.clientX - rect.left - thumbWidth / 2) / rect.width) * durationMs
      )
    )
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function followPlayhead(now: number): void {
  const fullDurationMs = props.preparedDurationMs
  const viewDurationMs = visibleDurationMs.value
  if (props.isPlaying && viewDurationMs > 0 && viewDurationMs < fullDurationMs - 0.5) {
    const dtSeconds = lastFollowMs === 0 ? 0 : Math.min(0.1, (now - lastFollowMs) / 1000)
    lastFollowMs = now
    const elapsedSincePositionMs = Math.min(
      100,
      Math.max(0, now - positionReceivedAtMs)
    )
    const estimatedPositionMs =
      props.positionMs
      + elapsedSincePositionMs * Math.max(0, props.playbackRate)
    const desiredMs = Math.max(
      0,
      Math.min(maxScrollMs.value, estimatedPositionMs - viewDurationMs / 2)
    )
    const gapMs = desiredMs - scrollMs.value
    if (gapMs > 0.5) {
      const rateMsPerSecond = Math.max(3000, gapMs * 5)
      scrollMs.value += Math.min(gapMs, rateMsPerSecond * dtSeconds)
    }
  } else {
    lastFollowMs = 0
  }
  followFrame = window.requestAnimationFrame(followPlayhead)
}

watch(
  () => props.positionMs,
  () => {
    positionReceivedAtMs = performance.now()
  },
  { immediate: true }
)

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
    visibleStartMs.value,
    visibleDurationMs.value
  ] as const,
  draw
)

watch(
  () => props.preparedDurationMs,
  () => {
    zoom.value = 1
    scrollMs.value = 0
  }
)

watch(maxScrollMs, (maximum) => {
  scrollMs.value = Math.max(0, Math.min(maximum, scrollMs.value))
})

onMounted(() => {
  const canvas = canvasEl.value
  if (!canvas) return
  resizeObserver = new ResizeObserver(syncSize)
  resizeObserver.observe(canvas)
  syncSize()
  followFrame = window.requestAnimationFrame(followPlayhead)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (followFrame !== null) window.cancelAnimationFrame(followFrame)
  followFrame = null
})
</script>

<template>
  <div class="relative w-full overflow-hidden rounded border border-zinc-800 bg-zinc-950">
    <canvas
      ref="canvasEl"
      class="block h-[min(195px,20vh)] w-full"
      aria-label="Scratch waveform"
      role="img"
      @wheel="onWheel"
    />
    <!-- Zoom controls overlaid in the bottom-right corner as a single grouped box
         to reclaim the vertical space a separate control row would otherwise take. -->
    <div class="absolute bottom-3 right-1.5 inline-flex items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900/90">
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom out"
        :disabled="zoom <= MIN_ZOOM + 0.0001"
        @click="zoomOut"
      >
        <span class="text-sm leading-none">-</span>
      </button>
      <button
        type="button"
        class="min-w-10 border-x border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-200 hover:bg-zinc-800"
        title="Reset zoom"
        @click="resetZoom"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        title="Zoom in"
        :disabled="zoom >= MAX_ZOOM - 0.01"
        @click="zoomIn"
      >
        <span class="text-sm leading-none">+</span>
      </button>
    </div>
    <!-- Horizontal scrollbar, flush to the bottom edge of the waveform window
         and full width, matching how the main timeline renders it. -->
    <div
      class="absolute inset-x-0 bottom-0 h-2 cursor-pointer bg-zinc-900/80"
      :title="`Scroll (zoom ${Math.round(zoom * 100)}%)`"
      @mousedown="onScrollbarMouseDown"
    >
      <div
        class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
        :style="{
          left: preparedDurationMs > 0
            ? `${(visibleStartMs / preparedDurationMs) * 100}%`
            : '0%',
          width: preparedDurationMs > 0
            ? `${Math.max(2, (visibleDurationMs / preparedDurationMs) * 100)}%`
            : '100%'
        }"
      />
    </div>
  </div>
</template>
