<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  platterAngleDeg,
  pointerAngleDeltaTurns,
  wheelDeltaToTurns,
  WHEEL_PIXELS_PER_TURN
} from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  platterTurns: number
  touched: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  platterTouch: [touched: boolean]
  platterMove: [deltaTurns: number, clientTimeMs: number]
}>()

const CX = 100
const CY = 100
const SWEEP_RADIUS = 88
const KEYBOARD_STEP_TURNS = 0.02
const KEYBOARD_LARGE_STEP_TURNS = 0.1

// Trackpad two-finger pan (delivered as wheel events) jogs the platter. Windows
// precision touchpads only emit events while fingers move, so touch is inferred:
// the first delta claims the platter and an idle timeout releases it.
const WHEEL_IDLE_RELEASE_MS = 120
const MAX_WHEEL_DELTA_TURNS = 8

const svgEl = ref<SVGSVGElement | null>(null)
const isDown = ref(false)
const isFocused = ref(false)
let prevClientX = 0
let prevClientY = 0
let prevAngleValid = true
let capturedId: number | null = null

// Pointer moves are coalesced and flushed once per animation frame so the rate
// the backend derives pairs one accumulated delta with one frame-length client
// interval (performance.now()), instead of one raw pointer event against the
// backend's own jittery receive clock. High-rate mice therefore can't spike the
// rate, and the delta/elapsed pair share a single clock and interval.
let pointerPendingTurns = 0
let pointerRafId: number | null = null
// True once motion has been emitted since the last idle-zero. Lets the per-frame
// tick fire a single explicit zero-rate the instant the finger stops moving.
let pointerHadMotion = false

let wheelTouched = false
let wheelPendingTurns = 0
let wheelRafId: number | null = null
let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null

// Runs every frame while the platter is held. Emits one accumulated delta per
// frame during motion, and a single explicit zero-rate the frame after motion
// stops so a stationary-but-still-touching finger halts the platter within a
// frame instead of coasting for the backend's manual-rate hold ("sluggish
// release"). Re-arms itself while the pointer remains down.
function pointerTick(): void {
  if (pointerPendingTurns !== 0) {
    const delta = pointerPendingTurns
    pointerPendingTurns = 0
    pointerHadMotion = true
    emit('platterMove', delta, performance.now())
  } else if (pointerHadMotion) {
    pointerHadMotion = false
    emit('platterMove', 0, performance.now())
  }
  pointerRafId = isDown.value ? requestAnimationFrame(pointerTick) : null
}

function flushWheelMove(): void {
  wheelRafId = null
  if (wheelPendingTurns === 0) return
  const delta = Math.max(-MAX_WHEEL_DELTA_TURNS, Math.min(MAX_WHEEL_DELTA_TURNS, wheelPendingTurns))
  wheelPendingTurns = 0
  emit('platterMove', delta, performance.now())
}

function releaseWheelTouch(): void {
  if (wheelIdleTimer !== null) {
    clearTimeout(wheelIdleTimer)
    wheelIdleTimer = null
  }
  if (wheelRafId !== null) {
    cancelAnimationFrame(wheelRafId)
    flushWheelMove()
  }
  if (wheelTouched) {
    wheelTouched = false
    emit('platterTouch', false)
  }
}

function onWheel(event: WheelEvent): void {
  if (props.disabled) return
  event.preventDefault()
  if (!wheelTouched) {
    wheelTouched = true
    emit('platterTouch', true)
  }
  // Inverted so the wheel gesture matches the expected scratch direction.
  wheelPendingTurns -= wheelDeltaToTurns(event.deltaX, event.deltaY, WHEEL_PIXELS_PER_TURN)
  if (wheelRafId === null) {
    wheelRafId = requestAnimationFrame(flushWheelMove)
  }
  if (wheelIdleTimer !== null) clearTimeout(wheelIdleTimer)
  wheelIdleTimer = setTimeout(releaseWheelTouch, WHEEL_IDLE_RELEASE_MS)
}

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
  pointerPendingTurns = 0
  pointerHadMotion = false
  if (pointerRafId === null) pointerRafId = requestAnimationFrame(pointerTick)
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
  if (delta !== 0) {
    pointerPendingTurns += delta
  }
}

function releasePointer(event: PointerEvent): void {
  if (capturedId !== event.pointerId) return
  capturedId = null
  isDown.value = false
  // Stop the per-frame tick and discard any sub-frame motion accumulated at the
  // instant of release. On a real deck the platter rides a slipmat at constant
  // motor speed, so letting go snaps the record straight back to full speed; the
  // little lift-off push a finger imparts on release is not a scratch and must
  // not be applied as a final rate (which would briefly play slow/reverse before
  // the motor re-engages). Dropping touch lets the backend resume motor speed.
  if (pointerRafId !== null) {
    cancelAnimationFrame(pointerRafId)
    pointerRafId = null
  }
  pointerPendingTurns = 0
  pointerHadMotion = false
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
  emit('platterMove', delta, performance.now())
}

onBeforeUnmount(() => {
  releaseWheelTouch()
  if (pointerRafId !== null) {
    cancelAnimationFrame(pointerRafId)
    pointerRafId = null
    pointerPendingTurns = 0
    pointerHadMotion = false
  }
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
      @wheel="onWheel"
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
