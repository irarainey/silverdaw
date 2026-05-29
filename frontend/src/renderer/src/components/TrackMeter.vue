<script setup lang="ts">
// Per-track stereo peak meter. Wraps `PeakMeter` and pulls levels
// from the shared `trackLevelsChannel` keyed by `trackId`. Sits on
// the track header panel next to the volume slider so the user can
// gauge relative balance across the project at a glance.
//
// Reference ticks are intentionally OFF here — the per-track meter
// is narrow enough that 0 dB / -12 dB lines would dominate the
// visual; the master meter retains them as the single source of
// project-wide headroom truth.

import { linearToDb, MIN_DISPLAY_DB } from '@/lib/audio/db'
import { readTrackLevels } from '@/lib/audio/trackLevelsChannel'
import PeakMeter from './PeakMeter.vue'

const props = withDefaults(
  defineProps<{
    trackId: string
    width?: number
    height?: number
  }>(),
  { width: 80, height: 8 }
)

function source(): { peakL: number; peakR: number } {
  const { peakL, peakR } = readTrackLevels(props.trackId)
  return { peakL, peakR }
}

function titleFormatter(peakL: number, peakR: number): string {
  return `Track peaks — L: ${fmt(peakL)} dB, R: ${fmt(peakR)} dB`
}
function fmt(linear: number): string {
  if (linear <= 0) return '-∞'
  const db = linearToDb(linear)
  if (db <= MIN_DISPLAY_DB) return MIN_DISPLAY_DB.toFixed(1)
  return (db >= 0 ? '+' : '') + db.toFixed(1)
}
</script>

<template>
  <PeakMeter
    :source="source"
    orientation="horizontal"
    :width="width"
    :height="height"
    :show-reference-ticks="false"
    :title-formatter="titleFormatter"
  />
</template>
