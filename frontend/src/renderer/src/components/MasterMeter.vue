<script setup lang="ts">
// Stereo peak meter for the master bus. Reads from the non-reactive
// `masterLevelChannel` (fed by `bridgeService` on every `MASTER_LEVEL`
// envelope, ~60 Hz while audio is active) and renders two vertical
// bars: instantaneous level plus a 1.5 s peak-hold marker that decays
// linearly over the next 0.6 s. The dB→position mapping uses the same
// taper as the master fader so the meter and slider read consistently
// at a glance.
//
// All animation lives in a single `requestAnimationFrame` loop —
// nothing here is Vue-reactive, so the meter never causes the rest
// of the UI to re-render when audio is playing.

import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  linearToDb,
  MAX_MASTER_DB,
  MIN_DISPLAY_DB,
  taperDbToPosition
} from '@/lib/audio/db'
import { readMasterLevels } from '@/lib/audio/masterLevelChannel'

// ─── Tunables ────────────────────────────────────────────────────────────
// Peak-hold marker stays at the captured peak for this long after the
// last new maximum, then decays linearly to the current level over
// `PEAK_DECAY_MS`. Matches typical DAW conventions (Logic / Ableton).
const PEAK_HOLD_MS = 1500
const PEAK_DECAY_MS = 600
// Level bar follows the instantaneous reading with a short attack
// (snappy on transients) and a slower release so the bar doesn't
// jitter on a quiet sustained tone. Both expressed as the fraction
// of the gap closed per render frame at ~60 Hz.
const ATTACK_PER_FRAME = 1.0   // instant on rise (transient-accurate)
const RELEASE_PER_FRAME = 0.18 // ~120 ms half-life at 60 Hz

// SVG geometry (kept tiny — the meter sits next to the master fader
// in the transport bar). Bar widths/gaps are in pixels.
const WIDTH = 14
const HEIGHT = 22
const BAR_WIDTH = 5
const BAR_GAP = 2

// ─── Per-channel rendering state ─────────────────────────────────────────
// Held outside Vue's reactive graph deliberately — the RAF loop writes
// to the refs we expose to the template directly. Using a plain object
// avoids the per-frame reactivity overhead.

interface ChannelState {
  // Instantaneous level the bar is currently drawing (0..1, mapped via
  // the same taper as the master fader so the meter and slider line
  // up visually).
  barPos: number
  // Held peak position (0..1) + the wall-clock at which we last
  // captured a new maximum.
  holdPos: number
  holdSetAtMs: number
  // Last raw linear sample the audio thread reported. Compared
  // against fresh updates so we know when to advance the hold.
  lastLinear: number
  // True if the most recent peak crossed unity (0 dBFS) — the marker
  // recolours red to flag clipping risk until it decays away.
  clipped: boolean
}

const left = ref<ChannelState>(makeChannel())
const right = ref<ChannelState>(makeChannel())

function makeChannel(): ChannelState {
  return { barPos: 0, holdPos: 0, holdSetAtMs: 0, lastLinear: 0, clipped: false }
}

// ─── RAF loop ────────────────────────────────────────────────────────────

let raf = 0

function tick(): void {
  const now = performance.now()
  const { peakL, peakR } = readMasterLevels()
  advance(left.value, peakL, now)
  advance(right.value, peakR, now)
  raf = requestAnimationFrame(tick)
}

function advance(ch: ChannelState, linear: number, nowMs: number): void {
  // Map linear → taper position via dB. `-Infinity` (true silence)
  // collapses to position 0; anything above MAX_MASTER_DB clamps to 1.
  const db = linear > 0 ? linearToDb(linear) : -Infinity
  const targetPos = taperDbToPosition(db, MAX_MASTER_DB)

  // Attack/release smoothing on the bar itself. Rises track instantly
  // so a transient lights up the meter on the same frame the audio
  // arrived; falls are eased so a sustained tone doesn't visibly
  // pulse with the 60 Hz envelope cadence.
  if (targetPos >= ch.barPos) {
    ch.barPos += (targetPos - ch.barPos) * ATTACK_PER_FRAME
  } else {
    ch.barPos += (targetPos - ch.barPos) * RELEASE_PER_FRAME
  }

  // Peak hold: capture any new maximum and reset the hold timer.
  if (targetPos > ch.holdPos) {
    ch.holdPos = targetPos
    ch.holdSetAtMs = nowMs
    ch.clipped = linear >= 1.0
  } else {
    // Decay after the hold window expires. Linear ramp to the live
    // bar level over PEAK_DECAY_MS — once it lands the marker just
    // tracks the bar's top edge.
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

// ─── Geometry helpers (template-side) ────────────────────────────────────

function barY(pos: number): number {
  // SVG y grows downward — pos=1 fills from bottom to top.
  return HEIGHT * (1 - pos)
}
function barHeight(pos: number): number {
  return HEIGHT * pos
}
// 0 dBFS reference line, drawn across both bars so the user has a
// constant visual cue of unity.
const ZERO_DB_Y = barY(taperDbToPosition(0, MAX_MASTER_DB))
// -12 dB reference (the green→yellow transition). Just informational.
const MINUS_12_Y = barY(taperDbToPosition(-12, MAX_MASTER_DB))

function barX(side: 'L' | 'R'): number {
  return side === 'L' ? 0 : BAR_WIDTH + BAR_GAP
}

function titleText(): string {
  // Render dB rounded to 1 dp; `-∞` for true silence so the tooltip
  // mirrors what the slider displays.
  const l = left.value.lastLinear
  const r = right.value.lastLinear
  return `Master peaks — L: ${fmt(l)} dB, R: ${fmt(r)} dB`
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
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    :width="WIDTH"
    :height="HEIGHT"
    class="shrink-0"
    role="img"
    :aria-label="titleText()"
    :title="titleText()"
  >
    <!-- Channel troughs (the unlit background) -->
    <rect
      :x="barX('L')"
      y="0"
      :width="BAR_WIDTH"
      :height="HEIGHT"
      rx="1"
      fill="#27272a"
    />
    <rect
      :x="barX('R')"
      y="0"
      :width="BAR_WIDTH"
      :height="HEIGHT"
      rx="1"
      fill="#27272a"
    />

    <!-- Lit bar segments. The gradient runs green→yellow→red top-down
         so as the bar fills upward it traverses the warning zone. -->
    <defs>
      <linearGradient
        id="meter-grad"
        x1="0"
        y1="1"
        x2="0"
        y2="0"
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
      :x="barX('L')"
      :y="barY(left.barPos)"
      :width="BAR_WIDTH"
      :height="barHeight(left.barPos)"
      rx="1"
      fill="url(#meter-grad)"
    />
    <rect
      :x="barX('R')"
      :y="barY(right.barPos)"
      :width="BAR_WIDTH"
      :height="barHeight(right.barPos)"
      rx="1"
      fill="url(#meter-grad)"
    />

    <!-- 0 dB reference tick across both bars -->
    <line
      x1="0"
      :x2="WIDTH"
      :y1="ZERO_DB_Y"
      :y2="ZERO_DB_Y"
      stroke="#52525b"
      stroke-width="0.5"
    />
    <line
      x1="0"
      :x2="WIDTH"
      :y1="MINUS_12_Y"
      :y2="MINUS_12_Y"
      stroke="#3f3f46"
      stroke-width="0.5"
    />

    <!-- Peak hold marks (1 px line). Red when the held peak crossed
         0 dBFS so the user gets a transient clipping warning. -->
    <line
      v-if="left.holdPos > 0"
      :x1="barX('L')"
      :x2="barX('L') + BAR_WIDTH"
      :y1="barY(left.holdPos)"
      :y2="barY(left.holdPos)"
      :stroke="left.clipped ? '#f87171' : '#fafafa'"
      stroke-width="1"
    />
    <line
      v-if="right.holdPos > 0"
      :x1="barX('R')"
      :x2="barX('R') + BAR_WIDTH"
      :y1="barY(right.holdPos)"
      :y2="barY(right.holdPos)"
      :stroke="right.clipped ? '#f87171' : '#fafafa'"
      stroke-width="1"
    />
  </svg>
</template>
