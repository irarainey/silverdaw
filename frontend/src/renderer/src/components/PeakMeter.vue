<script setup lang="ts">
// Reusable stereo peak meter; RAF updates SVG attrs without per-frame Vue renders.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  linearToDb,
  MAX_MASTER_DB,
  MIN_DISPLAY_DB,
  taperDbToPosition
} from '@/lib/audio/db'

const props = withDefaults(
  defineProps<{
    /** Pulled once per RAF tick; must be cheap. */
    source: () => { peakL: number; peakR: number }
    /** `horizontal` fills L→R; `vertical` fills bottom-up. */
    orientation?: 'horizontal' | 'vertical'
    width?: number
    height?: number
    /** Draws the 0 dB and -12 dB reference ticks. */
    showReferenceTicks?: boolean
    /** Builds the tooltip / aria-label from latest linear peaks. */
    titleFormatter?: (peakL: number, peakR: number) => string
    /** Pixel gap between the two bars. */
    barGap?: number
    /** Long-axis LED segment size; `0` draws a smooth bar. */
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

// ─── Tunables ────────────────────────────────────────────────────
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
// Computed geometry keeps per-frame work to reading bar positions.

const horizontal = computed(() => props.orientation === 'horizontal')

const crossSize = computed(() => (horizontal.value ? props.height : props.width))
const longSize = computed(() => (horizontal.value ? props.width : props.height))
const barCross = computed(() => Math.max(1, Math.floor((crossSize.value - props.barGap) / 2)))

function barCrossOffset(side: 'L' | 'R'): number {
  return side === 'L' ? 0 : barCross.value + props.barGap
}

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

const zeroDbPos = computed(() => taperDbToPosition(0, MAX_MASTER_DB))
const minus12Pos = computed(() => taperDbToPosition(-12, MAX_MASTER_DB))

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

// Gradient coordinates orient quiet-to-hot per meter direction.
const gradId = `peak-meter-grad-${Math.random().toString(36).slice(2, 8)}`

// ─── LED segmentation overlay ─────────────────────────────────────
// Gap stripes are cheaper than masking and work in both orientations.
const segmentPitch = computed(() => Math.max(1, props.segmentSize + props.segmentGap))
const segmentGapOffsets = computed<number[]>(() => {
  if (props.segmentSize <= 0 || props.segmentGap <= 0) return []
  const offsets: number[] = []
  // First segment stays flush against the trough edge.
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
