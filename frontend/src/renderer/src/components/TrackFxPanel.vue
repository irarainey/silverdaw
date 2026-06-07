<script setup lang="ts">
// Track FX surface in the bottom panel beside the Library and Project FX tabs.
// Hosts the selected track's rack: Tone (3-band EQ + cuts), Pan, Leveler, and
// Reverb/Delay send amounts into the project buses.
//
// Modules are keyed by track id so changing selection remounts them (fresh
// inputs, torn-down gestures). Each module owns its live editing + undo wiring;
// this panel only lays them out and shows the no-selection hint.

import { computed } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import TrackToneModule from '@/components/TrackToneModule.vue'
import TrackSendsModule from '@/components/TrackSendsModule.vue'
import TrackPanModule from '@/components/TrackPanModule.vue'
import TrackLevelerModule from '@/components/TrackLevelerModule.vue'
import FxRack from '@/components/FxRack.vue'

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
  >
    <TrackToneModule
      :key="`tone-${selectedTrackId}`"
      :track-id="selectedTrackId"
    />
    <TrackPanModule
      :key="`pan-${selectedTrackId}`"
      :track-id="selectedTrackId"
    />
    <TrackLevelerModule
      :key="`leveler-${selectedTrackId}`"
      :track-id="selectedTrackId"
    />
    <TrackSendsModule
      :key="`sends-${selectedTrackId}`"
      :track-id="selectedTrackId"
    />
  </FxRack>
  <div
    v-else
    class="flex h-full min-h-0 w-full items-center justify-center px-4 text-center text-xs text-zinc-500"
  >
    Select a track to edit its Tone, Pan, Leveler, and Reverb &amp; Delay.
  </div>
</template>
