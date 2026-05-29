<script setup lang="ts">
// Reusable stereo peak meter. Drives its animation off the shared
// `requestAnimationFrame` loop and the `source` callback the caller
// provides — the meter never touches Vue reactivity per frame, so
// dozens of these can sit on the page (one per project track plus
// the master) at zero per-tick render cost beyond their own SVG
// attribute updates.
//
// Originally inlined in `MasterMeter.vue` (Phase 4); extracted in
// Phase 5 step 1c so the per-track meters in `TrackHeaderPanel`
// share one well-tested implementation of the dB taper, attack /
// release smoothing, and peak-hold-then-decay marker.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  linearToDb,
  MAX_MASTER_DB,
  MIN_DISPLAY_DB,
  taperDbToPosition
} from '@/lib/audio/db'

const props = withDefaults(
  defineProps<{
    /** Pulled once per frame on the meter's RAF tick. Must be cheap. */
    source: () => { peakL: number; peakR: number }
    /** `horizontal` lays the two bars top-over-bottom and fills L→R.
     *  `vertical` lays them side-by-side and fills bottom-up. */
    orientation?: 'horizontal' | 'vertical'
    width?: number
    height?: number
    /** Draws the 0 dB and -12 dB reference ticks. Off by default
     *  on the small track meters where they'd dominate the visual. */
    showReferenceTicks?: boolean
    /** Builds the tooltip / aria-label. Receives the latest linear
     *  peaks — usually formatted via `formatLinearAsDb`. */
    titleFormatter?: (peakL: number, peakR: number) => string
    /** Pixel gap between the two bars. */
    barGap?: number
    /** Long-axis length of each LED segment, in px. Set to `0` to
     *  disable the segmented overlay and draw a smooth bar. */
    segmentSize?: number
    /** Gap between LED segments, in px. */
    segmentGap?: number
  }>(),
  {
    orientation: 'vertical',
    width: 14,
    height: 22,
    showReferenceTicks: true,
    titleFormatter: undefined,
    barGap: 2,
    segmentSize: 4,
    segmentGap: 1
  }
)

// ─── Tunables (kept identical to the original MasterMeter so the
//     existing meter look-and-feel is preserved bit-for-bit) ──────
const PEAK_HOLD_MS = 1500
const PEAK_DECAY_MS = 600
const ATTACK_PER_FRAME = 1.0
const RELEASE_PER_FRAME = 0.18

interface ChannelState {
  barPos: number
  holdPos: number
  holdSetAtMs: number
  lastLinear: number
  clipped: boolean
}

const left = ref<ChannelState>(makeChannel())
const right = ref<ChannelState>(makeChannel())

function makeChannel(): ChannelState {
  return { barPos: 0, holdPos: 0, holdSetAtMs: 0, lastLinear: 0, clipped: false }
}

let raf = 0
function tick(): void {
  const now = performance.now()
  const { peakL, peakR } = props.source()
  advance(left.value, peakL, now)
  advance(right.value, peakR, now)
  raf = requestAnimationFrame(tick)
}

function advance(ch: ChannelState, linear: number, nowMs: number): void {
  const db = linear > 0 ? linearToDb(linear) : -Infinity
  const targetPos = taperDbToPosition(db, MAX_MASTER_DB)

  if (targetPos >= ch.barPos) {
    ch.barPos += (targetPos - ch.barPos) * ATTACK_PER_FRAME
  } else {
    ch.barPos += (targetPos - ch.barPos) * RELEASE_PER_FRAME
  }

  if (targetPos > ch.holdPos) {
    ch.holdPos = targetPos
    ch.holdSetAtMs = nowMs
    ch.clipped = linear >= 1.0
  } else {
    const sinceHold = nowMs - ch.holdSetAtMs
    if (sinceHold > PEAK_HOLD_MS) {
      const decayFrac = Math.min(1, (sinceHold - PEAK_HOLD_MS) / PEAK_DECAY_MS)
      const decayed = ch.holdPos + (ch.barPos - ch.holdPos) * decayFrac
      ch.holdPos = Math.max(ch.barPos, decayed)
      if (sinceHold > PEAK_HOLD_MS + PEAK_DECAY_MS) ch.clipped = false
    }
  }

  ch.lastLinear = linear
}

onMounted(() => {
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
})

// ─── Geometry (orientation-aware) ────────────────────────────────────
// Each "bar" occupies half of the cross-axis (minus the gap). The
// long axis is the value axis: width when horizontal, height when
// vertical. Computed so the SVG geometry stays declarative in the
// template — no per-frame layout work in JS beyond `barPos` reads.

const horizontal = computed(() => props.orientation === 'horizontal')

// Cross-axis = the axis perpendicular to the bar fill direction.
const crossSize = computed(() => (horizontal.value ? props.height : props.width))
// Long axis = the axis the bar grows along.
const longSize = computed(() => (horizontal.value ? props.width : props.height))
const barCross = computed(() => Math.max(1, Math.floor((crossSize.value - props.barGap) / 2)))

function barCrossOffset(side: 'L' | 'R'): number {
  return side === 'L' ? 0 : barCross.value + props.barGap
}

// Lit-bar rect helpers. Pre-compute the 4 attrs at template time.
function barX(side: 'L' | 'R', _pos: number): number {
  return horizontal.value ? 0 : barCrossOffset(side)
}
function barY(side: 'L' | 'R', pos: number): number {
  if (horizontal.value) return barCrossOffset(side)
  return longSize.value * (1 - pos)
}
function barW(_side: 'L' | 'R', pos: number): number {
  return horizontal.value ? longSize.value * pos : barCross.value
}
function barH(_side: 'L' | 'R', pos: number): number {
  return horizontal.value ? barCross.value : longSize.value * pos
}

// Background trough rect (always full long-axis extent).
function troughX(side: 'L' | 'R'): number {
  return horizontal.value ? 0 : barCrossOffset(side)
}
function troughY(side: 'L' | 'R'): number {
  return horizontal.value ? barCrossOffset(side) : 0
}
function troughW(): number {
  return horizontal.value ? longSize.value : barCross.value
}
function troughH(): number {
  return horizontal.value ? barCross.value : longSize.value
}

// Reference-tick (0 dB, -12 dB) coordinates — drawn across both bars
// perpendicular to the fill direction.
const zeroDbPos = computed(() => taperDbToPosition(0, MAX_MASTER_DB))
const minus12Pos = computed(() => taperDbToPosition(-12, MAX_MASTER_DB))

// Peak-hold tick line endpoints (perpendicular to fill direction,
// spanning a single bar across its cross-axis).
function holdLineX1(side: 'L' | 'R', pos: number): number {
  return horizontal.value ? longSize.value * pos : barCrossOffset(side)
}
function holdLineX2(side: 'L' | 'R', pos: number): number {
  return horizontal.value ? longSize.value * pos : barCrossOffset(side) + barCross.value
}
function holdLineY1(side: 'L' | 'R', pos: number): number {
  return horizontal.value ? barCrossOffset(side) : longSize.value * (1 - pos)
}
function holdLineY2(side: 'L' | 'R', pos: number): number {
  return horizontal.value ? barCrossOffset(side) + barCross.value : longSize.value * (1 - pos)
}

// Reference-tick line endpoints (span ALL bars across the meter's
// cross-axis, so the line crosses both L and R together).
function refLineX1(pos: number): number {
  return horizontal.value ? longSize.value * pos : 0
}
function refLineX2(pos: number): number {
  return horizontal.value ? longSize.value * pos : props.width
}
function refLineY1(pos: number): number {
  return horizontal.value ? 0 : longSize.value * (1 - pos)
}
function refLineY2(pos: number): number {
  return horizontal.value ? props.height : longSize.value * (1 - pos)
}

// Gradient direction: green at quiet end → red at hot end. For
// vertical the quiet end is the bottom (y=height), for horizontal
// the quiet end is the left (x=0). Encoded as SVG userSpaceOnUse
// gradient coordinates per orientation.
const gradId = `peak-meter-grad-${Math.random().toString(36).slice(2, 8)}`

// ─── LED segmentation overlay ─────────────────────────────────────
// Rather than mask the bar, we leave the gradient-filled bar intact
// and lay narrow trough-coloured "gap" stripes across it at a fixed
// pitch on the long axis. Cheap, and works identically for both
// orientations. The trough rect peeks through each gap → the lit
// LEDs visually pop. Disabled when `segmentSize <= 0`.
const segmentPitch = computed(() => Math.max(1, props.segmentSize + props.segmentGap))
const segmentGapOffsets = computed<number[]>(() => {
  if (props.segmentSize <= 0 || props.segmentGap <= 0) return []
  const offsets: number[] = []
  // Gap stripes sit BEFORE each segment from index 1 onward, so the
  // first segment sits flush against the trough's leading edge.
  for (let pos = props.segmentSize; pos < longSize.value; pos += segmentPitch.value) {
    offsets.push(pos)
  }
  return offsets
})
function gapStripeX(offset: number): number {
  return horizontal.value ? offset : 0
}
function gapStripeY(offset: number): number {
  return horizontal.value ? 0 : offset
}
function gapStripeW(): number {
  return horizontal.value ? props.segmentGap : props.width
}
function gapStripeH(): number {
  return horizontal.value ? props.height : props.segmentGap
}

function titleText(): string {
  if (props.titleFormatter) {
    return props.titleFormatter(left.value.lastLinear, right.value.lastLinear)
  }
  return `Peaks — L: ${fmt(left.value.lastLinear)} dB, R: ${fmt(right.value.lastLinear)} dB`
}
function fmt(linear: number): string {
  if (linear <= 0) return '-∞'
  const db = linearToDb(linear)
  if (db <= MIN_DISPLAY_DB) return MIN_DISPLAY_DB.toFixed(1)
  return (db >= 0 ? '+' : '') + db.toFixed(1)
}
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    class="shrink-0"
    role="img"
    :aria-label="titleText()"
    :title="titleText()"
  >
    <defs>
      <linearGradient
        :id="gradId"
        gradientUnits="userSpaceOnUse"
        :x1="horizontal ? 0 : 0"
        :y1="horizontal ? 0 : height"
        :x2="horizontal ? width : 0"
        :y2="horizontal ? 0 : 0"
      >
        <stop
          offset="0"
          stop-color="#22c55e"
        />
        <stop
          offset="0.65"
          stop-color="#22c55e"
        />
        <stop
          offset="0.85"
          stop-color="#eab308"
        />
        <stop
          offset="1"
          stop-color="#ef4444"
        />
      </linearGradient>
    </defs>

    <rect
      :x="troughX('L')"
      :y="troughY('L')"
      :width="troughW()"
      :height="troughH()"
      rx="1"
      fill="#27272a"
    />
    <rect
      :x="troughX('R')"
      :y="troughY('R')"
      :width="troughW()"
      :height="troughH()"
      rx="1"
      fill="#27272a"
    />

    <rect
      :x="barX('L', left.barPos)"
      :y="barY('L', left.barPos)"
      :width="barW('L', left.barPos)"
      :height="barH('L', left.barPos)"
      :rx="segmentSize > 0 ? 0 : 1"
      :fill="`url(#${gradId})`"
    />
    <rect
      :x="barX('R', right.barPos)"
      :y="barY('R', right.barPos)"
      :width="barW('R', right.barPos)"
      :height="barH('R', right.barPos)"
      :rx="segmentSize > 0 ? 0 : 1"
      :fill="`url(#${gradId})`"
    />

    <rect
      v-for="offset in segmentGapOffsets"
      :key="`gap-${offset}`"
      :x="gapStripeX(offset)"
      :y="gapStripeY(offset)"
      :width="gapStripeW()"
      :height="gapStripeH()"
      fill="#27272a"
    />

    <template v-if="showReferenceTicks">
      <line
        :x1="refLineX1(zeroDbPos)"
        :x2="refLineX2(zeroDbPos)"
        :y1="refLineY1(zeroDbPos)"
        :y2="refLineY2(zeroDbPos)"
        stroke="#52525b"
        stroke-width="0.5"
      />
      <line
        :x1="refLineX1(minus12Pos)"
        :x2="refLineX2(minus12Pos)"
        :y1="refLineY1(minus12Pos)"
        :y2="refLineY2(minus12Pos)"
        stroke="#3f3f46"
        stroke-width="0.5"
      />
    </template>

    <line
      v-if="left.holdPos > 0"
      :x1="holdLineX1('L', left.holdPos)"
      :x2="holdLineX2('L', left.holdPos)"
      :y1="holdLineY1('L', left.holdPos)"
      :y2="holdLineY2('L', left.holdPos)"
      :stroke="left.clipped ? '#f87171' : '#fafafa'"
      stroke-width="1"
    />
    <line
      v-if="right.holdPos > 0"
      :x1="holdLineX1('R', right.holdPos)"
      :x2="holdLineX2('R', right.holdPos)"
      :y1="holdLineY1('R', right.holdPos)"
      :y2="holdLineY2('R', right.holdPos)"
      :stroke="right.clipped ? '#f87171' : '#fafafa'"
      stroke-width="1"
    />
  </svg>
</template>
