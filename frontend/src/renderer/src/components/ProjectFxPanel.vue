<script setup lang="ts">
// Project FX surface, shown in the bottom panel beside the Library and
// Track FX tabs. Hosts the project-wide effects that are shared across the
// whole song (not tied to any one track):
//
//   • Reverb (shared) — "the song's space", a single reverb that every
//     track feeds via its per-track amount.
//   • Delay (shared, tempo-locked) — one project-wide delay, likewise
//     fed by each track's amount.
//
// These deliberately do not change with the selected track: they are the
// return buses that the Track FX panel's Reverb & Delay amounts route into.
// Each module owns its own live editing + undo-gesture wiring; this panel
// just lays them out.

import ProjectRoomModule from '@/components/ProjectRoomModule.vue'
import ProjectEchoModule from '@/components/ProjectEchoModule.vue'
import FxRack from '@/components/FxRack.vue'
</script>

<template>
  <FxRack assistive-label="Project effects">
    <ProjectRoomModule />
    <ProjectEchoModule />
  </FxRack>
</template>
