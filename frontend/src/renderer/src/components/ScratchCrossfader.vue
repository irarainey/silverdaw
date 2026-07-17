<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { crossfaderValueFromHorizontalDelta } from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  value: number
  disabled: boolean
  reversed?: boolean
}>()

const emit = defineEmits<{
  change: [value: number]
}>()

const KNOB_W = 28
const KEYBOARD_STEP = 0.02
const KEYBOARD_LARGE_STEP = 0.1
const DISPLAY_ACK_TIMEOUT_MS = 250

const trackEl = ref<HTMLDivElement | null>(null)
const isDown = ref(false)
const isFocused = ref(false)
const trackW = ref(200)
const displayValue = ref(props.value)
let startClientX = 0
let startValue = 0
let capturedId: number | null = null
let ro: ResizeObserver | null = null
let pendingDisplayValue: number | null = null
let pendingDisplayTimer: ReturnType<typeof setTimeout> | null = null
let pendingPointerValue: number | null = null
let pointerFrame: number | null = null

const knobLeft = computed(() =>
  Math.max(0, Math.min(trackW.value - KNOB_W, displayValue.value * (trackW.value - KNOB_W)))
)

// The fill colours the bar by fader position and the direction supplied by the
// session. Deck ownership and platter touch never affect it. Not reversed: blue
// grows from the left as the knob moves right. Reversed: it is mirrored.
const reversed = computed(() => props.reversed === true)

const positionFillStyle = computed(() => {
  if (reversed.value) {
    const width = Math.max(0, trackW.value - (knobLeft.value + KNOB_W))
    return { right: '0px', width: `${width}px` }
  }
  return { left: '0px', width: `${knobLeft.value}px` }
})

function emitDisplayValue(value: number): void {
  const nextValue = Math.max(0, Math.min(1, value))
  displayValue.value = nextValue
  pendingDisplayValue = nextValue
  if (pendingDisplayTimer !== null) clearTimeout(pendingDisplayTimer)
  pendingDisplayTimer = setTimeout(() => {
    pendingDisplayTimer = null
    pendingDisplayValue = null
    displayValue.value = props.value
  }, DISPLAY_ACK_TIMEOUT_MS)
  emit('change', nextValue)
}

function clearPendingDisplay(): void {
  if (pendingDisplayTimer !== null) {
    clearTimeout(pendingDisplayTimer)
    pendingDisplayTimer = null
  }
  pendingDisplayValue = null
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  event.preventDefault()
  trackEl.value?.setPointerCapture(event.pointerId)
  capturedId = event.pointerId
  isDown.value = true
  startClientX = event.clientX
  startValue = displayValue.value
}

function onPointerMove(event: PointerEvent): void {
  if (!isDown.value || capturedId !== event.pointerId) return
  const usable = trackW.value - KNOB_W
  if (usable <= 0) return
  pendingPointerValue = crossfaderValueFromHorizontalDelta(
    startValue,
    event.clientX - startClientX,
    usable
  )
  if (pointerFrame === null) {
    pointerFrame = requestAnimationFrame(flushPointerValue)
  }
}

function releasePointer(event: PointerEvent): void {
  if (capturedId !== event.pointerId) return
  capturedId = null
  isDown.value = false
  if (pointerFrame !== null) {
    cancelAnimationFrame(pointerFrame)
    pointerFrame = null
    flushPointerValue()
  }
}

function flushPointerValue(): void {
  pointerFrame = null
  if (pendingPointerValue === null) return
  const value = pendingPointerValue
  pendingPointerValue = null
  emitDisplayValue(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  let delta = 0
  switch (event.key) {
    case 'ArrowRight':
      delta = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP
      break
    case 'ArrowLeft':
      delta = event.shiftKey ? -KEYBOARD_LARGE_STEP : -KEYBOARD_STEP
      break
    case 'Home':
      emitDisplayValue(0)
      event.preventDefault()
      event.stopPropagation()
      return
    case 'End':
      emitDisplayValue(1)
      event.preventDefault()
      event.stopPropagation()
      return
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
  emitDisplayValue(displayValue.value + delta)
}

watch(
  () => props.value,
  (value) => {
    if (pendingDisplayValue !== null) {
      if (Math.abs(value - pendingDisplayValue) <= 0.001) {
        clearPendingDisplay()
        displayValue.value = value
      }
      return
    }
    displayValue.value = value
  }
)

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      clearPendingDisplay()
      displayValue.value = props.value
    }
  }
)

onMounted(() => {
  const el = trackEl.value
  if (!el) return
  ro = new ResizeObserver(([entry]) => {
    if (entry) trackW.value = entry.contentRect.width
  })
  ro.observe(el)
  trackW.value = el.getBoundingClientRect().width || 200
})

onBeforeUnmount(() => {
  clearPendingDisplay()
  if (pointerFrame !== null) {
    cancelAnimationFrame(pointerFrame)
    pointerFrame = null
  }
  pendingPointerValue = null
  ro?.disconnect()
  ro = null
  if (capturedId !== null) {
    capturedId = null
    isDown.value = false
  }
})
</script>

<template>
  <div
    class="flex w-full flex-col gap-1.5"
    role="presentation"
  >
    <div class="flex items-center gap-2">
      <div
        ref="trackEl"
        class="relative h-5 flex-1 rounded-sm border border-zinc-700 bg-zinc-800 outline-none"
        :class="[
          disabled ? 'cursor-not-allowed opacity-50' : isDown ? 'cursor-grabbing' : 'cursor-grab',
          isFocused && !disabled ? 'border-sky-500' : ''
        ]"
        role="slider"
        aria-label="Crossfader position"
        :aria-valuenow="Math.round(displayValue * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-orientation="horizontal"
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
        <div
          class="absolute inset-y-0 rounded-sm bg-sky-600/30"
          :style="positionFillStyle"
        />
        <div
          class="absolute inset-y-0 flex items-center justify-center"
          :style="{ left: `${knobLeft}px`, width: `${KNOB_W}px` }"
        >
          <div
            class="h-5 w-full rounded-sm shadow-md"
            :class="isDown ? 'bg-sky-400' : 'bg-sky-500'"
          />
        </div>
      </div>
    </div>
  </div>
</template>
