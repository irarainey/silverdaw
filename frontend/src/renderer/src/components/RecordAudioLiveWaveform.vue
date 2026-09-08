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
//
// The columns are placed on the timeline rather than simply starting at the
// anchor. Input arriving now is a performance from a round trip ago — the
// performer heard the backing late and Silverdaw heard them late again — so the
// first column belongs at `anchor - latency`, which is exactly the audio the
// head trim discards at finalise. Drawing it from the anchor instead puts an
// on-time performance a round trip behind the beat it was played on, so the
// live picture disagrees with the take that comes out of it.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createLiveWaveform,
  liveBeatFractions,
  pushLiveColumn,
  readFittedChannelColumns,
  readFittedColumns,
  resetLiveWaveform,
  LIVE_COLUMN_MS
} from '@/lib/recording/liveWaveform'
import { DEFAULT_BEATS_PER_BAR, formatTime } from '@/lib/musicTime'
import { waveformFillScale } from '@/lib/waveform/fillScale'
import { waveformColumnUp } from '@/lib/timeline/waveformColumn'
import {
  WAVEFORM_BAR_ALPHA,
  WAVEFORM_BEAT_ALPHA,
  WAVEFORM_COLORS
} from '@/lib/waveform/waveformPalette'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps<{
  /** Draw the project's beat grid over the columns. */
  musical: boolean
}>()

const store = useRecordingSessionStore()
const transport = useTransportStore()
const ui = useUiStore()

/**
 * Whether to stack the two channels as separate lanes, honouring the app's waveform
 * preference. Only for a capture that actually is stereo: a mono input meters both
 * sides identically, so two lanes would be the same picture drawn twice, and the
 * timeline and Clip Editor fall back to one lane for mono sources for the same reason.
 */
const stereoLanes = computed(
  () => ui.waveformDisplayMode === 'stereo' && store.current?.channelCount === 2
)

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

// Elapsed time and the count-in read *over* the waveform rather than under it.
// A readout in the dialog's flow appears and disappears as a take starts and
// stops, which resizes the dialog under a performance in progress; the box here
// is a fixed height, so nothing moves.
const rollingReadout = computed(() => {
  const state = store.current
  if (!state) return ''
  if (state.status === 'countIn') {
    const bars = state.countInBarsRemaining ?? state.countInBars
    return bars > 0 ? `Counting in — ${bars} bar${bars === 1 ? '' : 's'}` : 'Counting in…'
  }
  if (state.status === 'recording') return formatTime(state.recordedMs)
  if (state.status === 'finalising') return 'Finishing…'
  return ''
})

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
  const columnWidth = Math.max(1, Math.round(2 * ratio))
  const visible = Math.max(1, Math.floor(width / columnWidth))
  // The view holds a fixed span until the take fills it; after that the take is
  // summarised into the same columns, so the span is however long the take is.
  const spanMs = Math.max(visible * LIVE_COLUMN_MS, buffer.count * LIVE_COLUMN_MS)

  if (props.musical && buffer.count > 0) {
    // Where the left edge sits on the project's timeline, so the grid lines up with the
    // beats the performer is actually hearing rather than with the start of the buffer.
    const viewStartMs = (store.current?.anchorMs ?? 0) - (store.current?.latencyMs ?? 0)
    ctx.fillStyle = WAVEFORM_COLORS.beat
    for (const line of liveBeatFractions(viewStartMs, spanMs, transport.bpm, DEFAULT_BEATS_PER_BAR)) {
      ctx.globalAlpha = line.bar ? WAVEFORM_BAR_ALPHA : WAVEFORM_BEAT_ALPHA
      ctx.fillRect(Math.round(line.fraction * width), 0, Math.max(1, ratio), height)
    }
    ctx.globalAlpha = 1
  }

  // Left-aligned and drawn edge to edge with no gap between columns, so the take
  // reads as one continuous shape like every other waveform in the app. Scaled to
  // fill the box exactly as the review waveform is, so a take does not change size
  // the moment it stops rolling (see `fillScale.ts`).
  const lanes = stereoLanes.value
    ? readFittedChannelColumns(buffer, visible)
    : [readFittedColumns(buffer, visible)]
  const laneMid = (index: number): number => height * ((index + 0.5) / lanes.length)
  const laneHalfHeight = height / (lanes.length * 2)

  ctx.fillStyle = WAVEFORM_COLORS.baseline
  // No centre line on an empty view: it would run straight through the "your
  // recording appears here" prompt.
  if (buffer.count > 0) {
    for (let lane = 0; lane < lanes.length; lane += 1) {
      ctx.fillRect(0, laneMid(lane), width, Math.max(1, ratio))
    }
  }

  // One scale across both lanes, so a channel that is genuinely quieter than the
  // other looks it rather than being normalised up to match.
  let loudest = 0
  for (const lane of lanes) for (const magnitude of lane) loudest = Math.max(loudest, magnitude)
  const scale = waveformFillScale(loudest)
  ctx.fillStyle = WAVEFORM_COLORS.wave
  lanes.forEach((columns, laneIndex) => {
    const mid = laneMid(laneIndex)
    for (let index = 0; index < columns.length; index += 1) {
      const half = Math.max(
        ratio,
        waveformColumnUp((columns[index] ?? 0) * scale, laneHalfHeight, 1)
      )
      ctx.fillRect(index * columnWidth, mid - half, columnWidth, half * 2)
    }
  })
}

function tick(now: number): void {
  frame = requestAnimationFrame(tick)
  if (!capturing.value) return
  if (now - lastSampleAt < LIVE_COLUMN_MS) return
  lastSampleAt = now
  pushLiveColumn(buffer, store.inputPeakL, store.inputPeakR)
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
// The preference can be changed, and the input switched between mono and stereo,
// while the dialog is open and nothing is rolling to repaint it.
watch(stereoLanes, draw)

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
    <p
      v-if="rollingReadout"
      class="pointer-events-none absolute top-2 right-2 rounded bg-zinc-950/80 px-2 py-1 font-mono text-xs tabular-nums text-sky-200"
    >
      {{ rollingReadout }}
    </p>
  </div>
</template>
