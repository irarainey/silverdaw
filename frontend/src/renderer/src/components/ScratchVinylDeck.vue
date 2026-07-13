<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { platterAngleDeg, pointerAngleDeltaTurns } from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  platterTurns: number
  touched: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  platterTouch: [touched: boolean]
  platterMove: [deltaTurns: number]
}>()

const CX = 100
const CY = 100
const SWEEP_RADIUS = 88
const KEYBOARD_STEP_TURNS = 0.02
const KEYBOARD_LARGE_STEP_TURNS = 0.1

const svgEl = ref<SVGSVGElement | null>(null)
const isDown = ref(false)
const isFocused = ref(false)
let prevClientX = 0
let prevClientY = 0
let prevAngleValid = true
let capturedId: number | null = null

const angleDeg = computed(() => platterAngleDeg(props.platterTurns))
const sweepAngleRad = computed(() => (angleDeg.value - 90) * (Math.PI / 180))
const sweepX2 = computed(() => CX + SWEEP_RADIUS * Math.cos(sweepAngleRad.value))
const sweepY2 = computed(() => CY + SWEEP_RADIUS * Math.sin(sweepAngleRad.value))

function clientCenter(): { cx: number; cy: number } {
  const svg = svgEl.value
  if (!svg) return { cx: 0, cy: 0 }
  const r = svg.getBoundingClientRect()
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  event.preventDefault()
  svgEl.value?.setPointerCapture(event.pointerId)
  capturedId = event.pointerId
  isDown.value = true
  prevClientX = event.clientX
  prevClientY = event.clientY
  prevAngleValid = true
  emit('platterTouch', true)
}

function onPointerMove(event: PointerEvent): void {
  if (!isDown.value || capturedId !== event.pointerId) return
  const { cx, cy } = clientCenter()
  const dx = event.clientX - cx
  const dy = event.clientY - cy
  if (dx * dx + dy * dy < 25) {
    // Inside the dead zone — invalidate prior angle so exit doesn't jump.
    prevAngleValid = false
    return
  }
  if (!prevAngleValid) {
    // Re-entering valid zone: reseed without emitting a delta.
    prevClientX = event.clientX
    prevClientY = event.clientY
    prevAngleValid = true
    return
  }
  const delta = pointerAngleDeltaTurns(prevClientX, prevClientY, event.clientX, event.clientY, cx, cy)
  prevClientX = event.clientX
  prevClientY = event.clientY
  if (delta !== 0) emit('platterMove', delta)
}

function releasePointer(event: PointerEvent): void {
  if (capturedId !== event.pointerId) return
  capturedId = null
  isDown.value = false
  emit('platterTouch', false)
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  let delta = 0
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      delta = event.shiftKey ? KEYBOARD_LARGE_STEP_TURNS : KEYBOARD_STEP_TURNS
      break
    case 'ArrowLeft':
    case 'ArrowDown':
      delta = event.shiftKey ? -KEYBOARD_LARGE_STEP_TURNS : -KEYBOARD_STEP_TURNS
      break
    case 'Home':
      delta = -KEYBOARD_LARGE_STEP_TURNS * 5
      break
    case 'End':
      delta = KEYBOARD_LARGE_STEP_TURNS * 5
      break
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
  emit('platterMove', delta)
}

onBeforeUnmount(() => {
  if (capturedId !== null) {
    svgEl.value?.releasePointerCapture(capturedId)
    capturedId = null
  }
  if (isDown.value) {
    isDown.value = false
    emit('platterTouch', false)
  }
})
</script>

<template>
  <div
    class="flex flex-col items-center"
    role="presentation"
  >
    <svg
      ref="svgEl"
      viewBox="0 0 200 200"
      class="w-full select-none outline-none"
      style="aspect-ratio: 1 / 1"
      :class="[
        isDown ? 'cursor-grabbing' : 'cursor-grab',
        disabled ? 'cursor-not-allowed opacity-50' : ''
      ]"
      role="slider"
      aria-label="Virtual vinyl platter"
      :aria-valuenow="Math.round(angleDeg)"
      aria-valuemin="0"
      aria-valuemax="360"
      :aria-disabled="disabled"
      tabindex="0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="releasePointer"
      @pointercancel="releasePointer"
      @lostpointercapture="releasePointer"
      @keydown="onKeydown"
      @focus="isFocused = true"
      @blur="isFocused = false"
    >
      <!-- Focus ring -->
      <circle
        v-if="isFocused && !disabled"
        cx="100"
        cy="100"
        r="98"
        fill="none"
        stroke="#38bdf8"
        stroke-width="2"
        opacity="0.6"
      />
      <!-- Outer rim -->
      <circle
        cx="100"
        cy="100"
        r="96"
        fill="#0d0d0d"
        stroke="#27272a"
        stroke-width="2"
      />
      <!-- Vinyl grooves -->
      <circle
        v-for="r in [88, 76, 64, 52, 40]"
        :key="r"
        cx="100"
        cy="100"
        :r="r"
        fill="none"
        stroke="#27272a"
        stroke-width="1.5"
      />
      <!-- Label area -->
      <circle
        cx="100"
        cy="100"
        r="28"
        fill="#27272a"
      />
      <!-- Sweep line -->
      <line
        x1="100"
        y1="100"
        :x2="sweepX2"
        :y2="sweepY2"
        stroke="#38bdf8"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <!-- Spindle -->
      <circle
        cx="100"
        cy="100"
        r="5"
        fill="#38bdf8"
      />
      <!-- Touch ring — sky accent when platter is held -->
      <circle
        v-if="touched || isDown"
        cx="100"
        cy="100"
        r="96"
        fill="none"
        stroke="#38bdf8"
        stroke-width="2"
        opacity="0.35"
      />
    </svg>
  </div>
</template>
