<script setup lang="ts">
// Track FX surface, shown in the bottom panel beside the Library and
// Project FX tabs. Hosts the per-track sound-shaping rack for the SELECTED
// track (GarageBand-style: click a track header to select it):
//
//   • Tone — 3-band EQ plus Low / High Cut.
//   • Pan — equal-power placement of the track's dry signal.
//   • Leveler — a single-knob soft-knee compressor that evens out the
//     track's dynamics.
//   • Reverb & Delay — how much this track feeds the project-wide Reverb
//     and Delay buses (the buses themselves live on the Project FX tab).
//
// All modules are keyed by track id so switching selection remounts them:
// the native range inputs are recreated with the new track's values rather
// than relying on in-place reuse, and any open edit gesture is torn down
// with the old instance. Each module owns its own live editing + undo
// wiring; this panel just lays them out and shows a hint when no track is
// selected.

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
