<script setup lang="ts">
// Review waveform for a finished recording: the peaks cache drawn as min/max
// columns, with the audition playhead over it. Peaks, never audio — the file
// stays on disk (ADR 0003).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { WAVEFORM_COLORS } from '@/lib/waveform/waveformPalette'
import { waveformFillScale } from '@/lib/waveform/fillScale'
import { waveformColumnDown, waveformColumnUp } from '@/lib/timeline/waveformColumn'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps<{
  /** Alternating min/max pairs from the peaks cache. */
  peaks: Float32Array
  /** The same pairs per channel, when the cache carried separable lanes. Empty for
   *  a mono take, which has nothing to stack. */
  channelPeaks: readonly Float32Array[]
  durationMs: number
  positionMs: number
}>()

const emit = defineEmits<{ seek: [ms: number] }>()

const ui = useUiStore()
const canvasEl = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null

/**
 * The peak lanes to draw: the two channels stacked when the app's waveform preference
 * asks for stereo and the take has two to stack, otherwise the single summary. A mono
 * take stays one lane whatever the preference says — the timeline and the Clip Editor
 * fall back the same way, since there is no second channel to show.
 */
const lanes = computed<readonly Float32Array[]>(() =>
  ui.waveformDisplayMode === 'stereo' && props.channelPeaks.length === 2
    ? props.channelPeaks
    : [props.peaks]
)

/**
 * How much to scale the peaks by so the take fills the box.
 *
 * Shared with the live waveform in the record dialog, so a take does not change
 * size the moment it stops rolling. See `fillScale.ts` for why the recording
 * views auto-fit and the timeline does not. One scale across both lanes, so a
 * channel that is genuinely quieter than the other still looks it.
 */
function fillScale(): number {
  let loudest = 0
  for (const lane of lanes.value) for (const value of lane) loudest = Math.max(loudest, Math.abs(value))
  return waveformFillScale(loudest)
}

function draw(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  const ratio = window.devicePixelRatio || 1
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  const width = Math.max(1, Math.floor(cssWidth * ratio))
  const height = Math.max(1, Math.floor(cssHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  ctx.clearRect(0, 0, width, height)
  const drawLanes = lanes.value
  const scale = fillScale()

  drawLanes.forEach((lanePeaks, laneIndex) => {
    const laneMid = height * ((laneIndex + 0.5) / drawLanes.length)
    const laneHalfHeight = height / (drawLanes.length * 2)

    ctx.fillStyle = WAVEFORM_COLORS.baseline
    ctx.fillRect(0, laneMid, width, Math.max(1, ratio))

    const pairCount = Math.floor(lanePeaks.length / 2)
    if (pairCount <= 0) return
    ctx.fillStyle = WAVEFORM_COLORS.wave
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor((x / width) * pairCount)
      const to = Math.max(from + 1, Math.floor(((x + 1) / width) * pairCount))
      let min = 0
      let max = 0
      for (let pair = from; pair < to && pair < pairCount; pair += 1) {
        min = Math.min(min, lanePeaks[pair * 2] ?? 0)
        max = Math.max(max, lanePeaks[pair * 2 + 1] ?? 0)
      }
      const top = laneMid - waveformColumnUp(max * scale, laneHalfHeight, 1)
      const bottom = laneMid + waveformColumnDown(min * scale, laneHalfHeight, 1)
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  })

  if (props.durationMs > 0 && props.positionMs > 0) {
    const x = Math.round((props.positionMs / props.durationMs) * width)
    ctx.fillStyle = WAVEFORM_COLORS.playhead
    ctx.fillRect(x, 0, Math.max(1, ratio), height)
  }
}

function onClick(event: MouseEvent): void {
  const canvas = canvasEl.value
  if (!canvas || props.durationMs <= 0) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0) return
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  emit('seek', fraction * props.durationMs)
}

onMounted(() => {
  draw()
  if (canvasEl.value) {
    observer = new ResizeObserver(draw)
    observer.observe(canvasEl.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(
  () => [lanes.value, props.durationMs, props.positionMs] as const,
  draw
)
</script>

<template>
  <canvas
    ref="canvasEl"
    class="block h-44 w-full cursor-pointer rounded border border-zinc-800 bg-zinc-950"
    role="img"
    aria-label="Recording waveform"
    @click="onClick"
  />
</template>
