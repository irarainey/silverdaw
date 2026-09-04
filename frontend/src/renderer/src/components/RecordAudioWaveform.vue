<script setup lang="ts">
// Review waveform for a finished recording: the peaks cache drawn as min/max
// columns, with the audition playhead over it. Peaks, never audio — the file
// stays on disk (ADR 0003).

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** Alternating min/max pairs from the peaks cache. */
  peaks: Float32Array
  durationMs: number
  positionMs: number
}>()

const emit = defineEmits<{ seek: [ms: number] }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null

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
  const mid = height / 2
  const pairCount = Math.floor(props.peaks.length / 2)

  ctx.fillStyle = '#3f3f46'
  ctx.fillRect(0, mid, width, Math.max(1, ratio))

  if (pairCount > 0) {
    ctx.fillStyle = '#38bdf8'
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor((x / width) * pairCount)
      const to = Math.max(from + 1, Math.floor(((x + 1) / width) * pairCount))
      let min = 0
      let max = 0
      for (let pair = from; pair < to && pair < pairCount; pair += 1) {
        min = Math.min(min, props.peaks[pair * 2] ?? 0)
        max = Math.max(max, props.peaks[pair * 2 + 1] ?? 0)
      }
      const top = mid - max * mid
      const bottom = mid - min * mid
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  }

  if (props.durationMs > 0 && props.positionMs > 0) {
    const x = Math.round((props.positionMs / props.durationMs) * width)
    ctx.fillStyle = '#fafafa'
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

watch(() => [props.peaks, props.durationMs, props.positionMs] as const, draw)
</script>

<template>
  <canvas
    ref="canvasEl"
    class="block h-24 w-full cursor-pointer rounded border border-zinc-800 bg-zinc-950"
    role="img"
    aria-label="Recording waveform"
    @click="onClick"
  />
</template>
