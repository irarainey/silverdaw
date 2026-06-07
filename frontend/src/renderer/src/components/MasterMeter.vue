<script setup lang="ts">
// Master-bus stereo peak meter. Thin wrapper over `PeakMeter` sourcing levels
// from `masterLevelChannel` (backend `MASTER_LEVEL`), rendered horizontally
// beside the master fader. Deliberately larger than per-track meters as the
// primary at-a-glance loudness indicator; width tuned to fit the transport bar.

import { linearToDb, MIN_DISPLAY_DB } from '@/lib/audio/db'
import { readMasterLevels } from '@/lib/audio/masterLevelChannel'
import PeakMeter from './PeakMeter.vue'

function source(): { peakL: number; peakR: number } {
  const { peakL, peakR } = readMasterLevels()
  return { peakL, peakR }
}

function titleFormatter(peakL: number, peakR: number): string {
  return `Master peaks — L: ${fmt(peakL)} dB, R: ${fmt(peakR)} dB`
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
    :width="96"
    :height="16"
    :show-reference-ticks="true"
    :title-formatter="titleFormatter"
  />
</template>
