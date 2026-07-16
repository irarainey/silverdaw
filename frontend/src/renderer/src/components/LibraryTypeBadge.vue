<script setup lang="ts">
// Small type indicator overlaid on a library item's cover art (library tile + info
// dialog) so the item type — an imported track, a separated stem, or a saved sample —
// reads at a glance even when the tile shows cover art. The host element must be
// `position: relative`; the badge pins itself to the bottom-right corner. Pass
// `showLabel` where there is room for the word (the dialog); the dense library tiles
// use the icon alone.
import { computed } from 'vue'

const props = defineProps<{
  kind: 'source' | 'stem' | 'sample' | 'scratch'
  showLabel?: boolean
}>()

const label = computed(() =>
  props.kind === 'stem'
    ? 'Stem'
    : props.kind === 'scratch'
      ? 'Scratch'
      : props.kind === 'sample'
        ? 'Sample'
        : 'Track'
)
const title = computed(() =>
  props.kind === 'stem'
    ? 'This is a separated stem'
    : props.kind === 'scratch'
      ? 'A saved scratch sample'
      : props.kind === 'sample'
        ? 'Saved as a sample'
        : 'An imported track'
)
</script>

<template>
  <span
    class="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-zinc-950/85 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-100"
    :title="title"
  >
    <svg
      v-if="kind === 'stem'"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
    </svg>
    <svg
      v-else-if="kind === 'scratch'"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 3.5a6.5 6.5 0 016.5 6.5 1 1 0 11-2 0 4.5 4.5 0 00-4.5-4.5 1 1 0 110-2zM12 10a2 2 0 100 4 2 2 0 000-4z"
      />
    </svg>
    <svg
      v-else-if="kind === 'sample'"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z" />
    </svg>
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
    </svg>
    <span v-if="showLabel">{{ label }}</span>
  </span>
</template>
