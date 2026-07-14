<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

const trackEl = ref<HTMLDivElement | null>(null)
const isDown = ref(false)
const isFocused = ref(false)
const trackW = ref(200)
let startClientX = 0
let startValue = 0
let capturedId: number | null = null
let ro: ResizeObserver | null = null

const knobLeft = computed(() =>
  Math.max(0, Math.min(trackW.value - KNOB_W, props.value * (trackW.value - KNOB_W)))
)

// The fill colours the bar by fader position and the `reversed` flag the parent
// supplies — deck ownership and platter touch never affect it. The parent decides
// the flag's meaning: for MIDI-controlled sessions it mirrors the per-device
// crossfader direction preference; for keyboard/pointer operation it reflects the
// open/closed state (the scratch deck is audible at value 0, so `reversed` keeps
// blue on the open, value-0 edge). Not reversed: blue grows from the left as the
// knob moves right (blue at the right extreme). Reversed: mirrored, so blue grows
// from the right as the knob moves left (blue at the left extreme).
const reversed = computed(() => props.reversed === true)

const openFillStyle = computed(() => {
  if (reversed.value) {
    const width = Math.max(0, trackW.value - (knobLeft.value + KNOB_W))
    return { right: '0px', width: `${width}px` }
  }
  return { left: '0px', width: `${knobLeft.value}px` }
})

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  event.preventDefault()
  trackEl.value?.setPointerCapture(event.pointerId)
  capturedId = event.pointerId
  isDown.value = true
  startClientX = event.clientX
  startValue = props.value
}

function onPointerMove(event: PointerEvent): void {
  if (!isDown.value || capturedId !== event.pointerId) return
  const usable = trackW.value - KNOB_W
  if (usable <= 0) return
  const newValue = crossfaderValueFromHorizontalDelta(startValue, event.clientX - startClientX, usable)
  emit('change', newValue)
}

function releasePointer(event: PointerEvent): void {
  if (capturedId !== event.pointerId) return
  capturedId = null
  isDown.value = false
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
      emit('change', 0)
      event.preventDefault()
      event.stopPropagation()
      return
    case 'End':
      emit('change', 1)
      event.preventDefault()
      event.stopPropagation()
      return
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
  emit('change', Math.max(0, Math.min(1, props.value + delta)))
}

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
      <span
        class="font-mono text-[10px] uppercase tracking-wider"
        :class="reversed ? 'text-sky-400' : 'text-zinc-500'"
      >L</span>
      <div
        ref="trackEl"
        class="relative h-5 flex-1 rounded-full border border-zinc-700 bg-zinc-800 outline-none"
        :class="[
          disabled ? 'cursor-not-allowed opacity-50' : isDown ? 'cursor-grabbing' : 'cursor-grab',
          isFocused && !disabled ? 'border-sky-500' : ''
        ]"
        role="slider"
        aria-label="Crossfader position"
        :aria-valuenow="Math.round(value * 100)"
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
          class="absolute inset-y-0 rounded-full bg-sky-600/30"
          :style="openFillStyle"
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
      <span
        class="font-mono text-[10px] uppercase tracking-wider"
        :class="reversed ? 'text-zinc-500' : 'text-sky-400'"
      >R</span>
    </div>
  </div>
</template>
