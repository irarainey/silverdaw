<script setup lang="ts">
// The waveform while a take is rolling.
//
// Built from the input meter the backend already broadcasts, not from audio: the
// renderer never receives samples (ADR 0003). Each tick pushes one column, and
// once the take is longer than the view has columns for, the whole take is
// summarised down to fit — a recording is always shown end to end, so what was
// captured a minute ago is still there to look at.
//
// In `music` mode the project's beat grid is drawn over it, which is what makes
// a bar-locked take reviewable at a glance; in `simple` mode there is no grid,
// because a spoken line has no beats to mark.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createLiveWaveform,
  liveBeatFractions,
  pushLiveColumn,
  readFittedColumns,
  resetLiveWaveform,
  LIVE_COLUMN_MS
} from '@/lib/recording/liveWaveform'
import { DEFAULT_BEATS_PER_BAR } from '@/lib/musicTime'
import {
  WAVEFORM_BAR_ALPHA,
  WAVEFORM_BEAT_ALPHA,
  WAVEFORM_COLORS
} from '@/lib/waveform/waveformPalette'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { useTransportStore } from '@/stores/transportStore'

const props = defineProps<{
  /** Draw the project's beat grid over the columns. */
  musical: boolean
}>()

const store = useRecordingSessionStore()
const transport = useTransportStore()

/** Roughly thirty minutes of columns: the length cap, past which the oldest
 *  audio is dropped rather than the buffer growing without bound. */
const CAPACITY = Math.ceil((30 * 60 * 1000) / LIVE_COLUMN_MS)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const buffer = createLiveWaveform(CAPACITY)
let observer: ResizeObserver | null = null
let frame: number | null = null
let lastSampleAt = 0

/** The take itself, not the count-in before it: nothing is drawn until the
 *  recording proper starts, so a count-in reads as counting in to something
 *  rather than as a take already under way. */
const capturing = computed(() => store.current?.status === 'recording')
/** Reactive mirror of the buffer's emptiness — the ring itself is deliberately
 *  outside reactivity, since it changes thirty times a second. */
const hasColumns = ref(false)
const waiting = computed(
  () =>
    store.current?.status === 'idle' ||
    store.current?.status === 'error' ||
    store.current?.status === 'countIn'
)

function draw(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  ctx.clearRect(0, 0, width, height)
  const mid = height / 2
  const columnWidth = Math.max(1, Math.round(2 * ratio))
  const visible = Math.max(1, Math.floor(width / columnWidth))
  const columns = readFittedColumns(buffer, visible)
  // The view holds a fixed span until the take fills it; after that the take is
  // summarised into the same columns, so the span is however long the take is.
  const spanMs = Math.max(visible * LIVE_COLUMN_MS, buffer.count * LIVE_COLUMN_MS)

  if (props.musical && buffer.count > 0) {
    // The take starts at the left edge, so the grid is measured from there.
    ctx.fillStyle = WAVEFORM_COLORS.beat
    for (const line of liveBeatFractions(spanMs, spanMs, transport.bpm, DEFAULT_BEATS_PER_BAR)) {
      ctx.globalAlpha = line.bar ? WAVEFORM_BAR_ALPHA : WAVEFORM_BEAT_ALPHA
      ctx.fillRect(Math.round(line.fraction * width), 0, Math.max(1, ratio), height)
    }
    ctx.globalAlpha = 1
  }

  ctx.fillStyle = WAVEFORM_COLORS.baseline
  // No centre line on an empty view: it would run straight through the "your
  // recording appears here" prompt.
  if (buffer.count > 0) ctx.fillRect(0, mid, width, Math.max(1, ratio))

  // Left-aligned and drawn edge to edge with no gap between columns, so the take
  // reads as one continuous shape like every other waveform in the app.
  ctx.fillStyle = WAVEFORM_COLORS.wave
  for (let index = 0; index < columns.length; index += 1) {
    const magnitude = columns[index] ?? 0
    const half = Math.max(ratio, magnitude * mid)
    ctx.fillRect(index * columnWidth, mid - half, columnWidth, half * 2)
  }
}

function tick(now: number): void {
  frame = requestAnimationFrame(tick)
  if (!capturing.value) return
  if (now - lastSampleAt < LIVE_COLUMN_MS) return
  lastSampleAt = now
  pushLiveColumn(buffer, Math.max(store.inputPeakL, store.inputPeakR))
  hasColumns.value = true
  draw()
}

// Each take starts from an empty view: a new recording showing the tail of the
// last one would read as audio that is not there.
watch(
  () => store.current?.status,
  (status, previous) => {
    if (status === 'countIn' || (status === 'recording' && previous !== 'countIn')) {
      resetLiveWaveform(buffer)
      hasColumns.value = false
      draw()
    }
  }
)

watch(() => props.musical, draw)

onMounted(() => {
  draw()
  if (canvasEl.value) {
    observer = new ResizeObserver(draw)
    observer.observe(canvasEl.value)
  }
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
})
</script>

<template>
  <div class="relative">
    <canvas
      ref="canvasEl"
      class="block h-28 w-full rounded border border-zinc-800 bg-zinc-950"
      role="img"
      aria-label="Live recording waveform"
    />
    <p
      v-if="waiting && !hasColumns"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-600"
    >
      Your recording appears here
    </p>
  </div>
</template>
