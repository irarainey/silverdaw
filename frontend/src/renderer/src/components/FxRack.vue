<script setup lang="ts">
// Shared layout shell for the bottom-panel effects racks (Track FX and
// Project FX). Lays its slotted modules out as fixed-size, plugin-style
// cells that wrap within the panel. The individual modules own their own
// editing / undo wiring; this shell only provides the scrolling grid and
// group label.

defineProps<{
  /** Accessible name for the rack's module group. */
  assistiveLabel: string
}>()
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col">
    <div
      class="fx-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-x-hidden overflow-y-auto p-3"
      role="group"
      :aria-label="assistiveLabel"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Modules wrap at the panel width. A cell may shrink only on very narrow
   panels, so Track FX never gains a horizontal scrollbar. */
.fx-rack {
  --cell-w: 17rem; /* 272px */
  --cell-h: 13.25rem; /* 212px — full-height module; comfortably fits the tallest
                         content (Tone, Project Room/Echo) without an inner scrollbar */
  --cell-gap: 0.75rem; /* matches the Tailwind gap-3 row/column gap below */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--cell-w)), 1fr));
  grid-auto-rows: calc((var(--cell-h) - var(--cell-gap)) / 2);
  grid-auto-flow: row dense;
  align-content: start;
}
</style>
