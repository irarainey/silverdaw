<script setup lang="ts">
// Project FX surface in the bottom panel beside the Library and Track FX tabs.
// Hosts the song-wide return buses (shared Reverb and tempo-locked Delay) that
// each track feeds via its per-track amount; these do not change with track
// selection. Each module owns its live editing + undo wiring; this panel only
// lays them out.

import ProjectRoomModule from '@/components/ProjectRoomModule.vue'
import ProjectEchoModule from '@/components/ProjectEchoModule.vue'
import ProjectSafetyLimiterModule from '@/components/ProjectSafetyLimiterModule.vue'
import FxRack from '@/components/FxRack.vue'
</script>

<template>
  <FxRack assistive-label="Project effects">
    <ProjectRoomModule />
    <ProjectEchoModule />
    <ProjectSafetyLimiterModule />
  </FxRack>
</template>
