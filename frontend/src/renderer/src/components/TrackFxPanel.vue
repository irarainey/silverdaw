<script setup lang="ts">
// Track FX surface in the bottom panel beside the Library and Project FX tabs.
// Hosts the selected track's rack: Tone (3-band EQ), Filter (DJ-style LPF↔HPF
// sweep), Compressor, Punch, Saturation, Bit Crusher, and Reverb/Delay sends. (Pan
// lives in the track header, under the gain fader.)
//
// Modules are keyed by track id so changing selection remounts them (fresh
// inputs, torn-down gestures). Each module owns its live editing + undo wiring;
// this panel only lays them out and shows the no-selection hint.

import { computed } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import TrackToneModule from '@/components/TrackToneModule.vue'
import TrackFilterModule from '@/components/TrackFilterModule.vue'
import TrackSendsModule from '@/components/TrackSendsModule.vue'
import TrackLevelerModule from '@/components/TrackLevelerModule.vue'
import TrackPunchModule from '@/components/TrackPunchModule.vue'
import TrackSaturationModule from '@/components/TrackSaturationModule.vue'
import TrackBitCrusherModule from '@/components/TrackBitCrusherModule.vue'
import FxRack from '@/components/FxRack.vue'

const TRACK_FX_RACK_WIDTH_REM = 120

const project = useProjectStore()

const selectedTrackId = computed(() =>
  project.selectedTrackId && project.tracks.some((t) => t.id === project.selectedTrackId)
    ? project.selectedTrackId
    : null
)
</script>

<template>
  <FxRack
    v-if="selectedTrackId"
    assistive-label="Track effects"
    :columns="5"
    :max-rack-width-rem="TRACK_FX_RACK_WIDTH_REM"
    grid-template-areas="'tone filter compressor saturation crusher' 'tone reverb punch saturation crusher'"
  >
    <TrackToneModule
      :key="`tone-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="tone"
    />
    <TrackFilterModule
      :key="`filter-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="filter"
    />
    <TrackSendsModule
      :key="`sends-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="reverb"
    />
    <TrackLevelerModule
      :key="`leveler-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="compressor"
    />
    <TrackPunchModule
      :key="`punch-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="punch"
    />
    <TrackSaturationModule
      :key="`saturation-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="saturation"
    />
    <TrackBitCrusherModule
      :key="`bit-crusher-${selectedTrackId}`"
      :track-id="selectedTrackId"
      grid-area="crusher"
    />
  </FxRack>
  <div
    v-else
    class="flex h-full min-h-0 w-full items-center justify-center px-4 text-center text-xs text-zinc-500"
  >
    Select a track to edit its Tone, Filter, Compressor, Punch, Saturation, Bit Crusher, and Reverb &amp; Delay.
  </div>
</template>
