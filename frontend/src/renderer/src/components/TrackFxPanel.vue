<script setup lang="ts">
// Track FX surface, shown in the bottom panel beside the Library and
// Project FX tabs. Hosts the per-track sound-shaping rack for the SELECTED
// track (GarageBand-style: click a track header to select it):
//
//   • Tone — 3-band EQ plus Low / High Cut.
//   • Pan — equal-power placement of the track's dry signal.
//   • Sends — how much this track feeds the project-wide Room and Echo
//     buses (the buses themselves live on the Project FX tab).
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
import FxRack from '@/components/FxRack.vue'

const project = useProjectStore()

const selectedTrackId = computed(() =>
  project.selectedTrackId && project.tracks.some((t) => t.id === project.selectedTrackId)
    ? project.selectedTrackId
    : null
)
</script>

<template>
  <FxRack assistive-label="Track effects">
    <template v-if="selectedTrackId">
      <TrackToneModule
        :key="`tone-${selectedTrackId}`"
        :track-id="selectedTrackId"
      />
      <TrackPanModule
        :key="`pan-${selectedTrackId}`"
        :track-id="selectedTrackId"
      />
      <TrackSendsModule
        :key="`sends-${selectedTrackId}`"
        :track-id="selectedTrackId"
      />
    </template>
    <div
      v-else
      class="flex items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-4 text-center text-xs text-zinc-500"
    >
      Select a track to edit its Tone, Pan, and Sends.
    </div>
  </FxRack>
</template>
