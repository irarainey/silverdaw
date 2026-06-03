<script setup lang="ts">
// Shared layout shell for the bottom-panel effects racks (Track FX and
// Project FX). Lays its slotted modules out as fixed-size, plugin-style
// cells that scroll horizontally, mirroring the Clip Editor's effects
// rack. The individual modules own their own editing / undo wiring; this
// shell only provides the scrolling grid and the group label.

defineProps<{
  /** Accessible name for the rack's module group. */
  assistiveLabel: string
}>()
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col">
    <div
      class="fx-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-auto p-3"
      role="group"
      :aria-label="assistiveLabel"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Modular grid — fixed-size base cells so each module keeps a consistent
   aspect ratio however the panel is sized; horizontal scroll reveals
   further modules. */
.fx-rack {
  --cell-w: 17rem; /* 272px */
  --cell-h: 13.25rem; /* 212px — full-height module; comfortably fits the tallest
                         content (Tone, Project Room/Echo) without an inner scrollbar */
  --cell-gap: 0.75rem; /* matches the Tailwind gap-3 row/column gap below */
  /* Two half-height row tracks: a full module spans both (= --cell-h), while two
     stacked half modules plus the gap between them also sum to --cell-h. */
  grid-template-rows: repeat(2, calc((var(--cell-h) - var(--cell-gap)) / 2));
  grid-auto-columns: var(--cell-w);
  grid-auto-flow: column dense;
  justify-content: start;
  align-content: start;
}
</style>
