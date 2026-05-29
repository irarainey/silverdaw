<script setup lang="ts">
// Master-bus stereo peak meter. Thin wrapper over `PeakMeter` that
// (a) sources its levels from `masterLevelChannel` (fed by the
// backend's `MASTER_LEVEL` envelope), (b) renders horizontally next
// to the master fader so the level reads naturally left-to-right at
// a glance, and (c) formats the tooltip in master-bus terms.
//
// Sizing rationale: the master meter is the primary at-a-glance
// loudness indicator for the whole project, so it's deliberately
// larger than the per-track meters (which exist for relative balance
// rather than overall headroom). Width tuned to fit the transport
// bar without crowding the fader / dB readout.

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
