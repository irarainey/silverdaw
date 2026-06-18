<script setup lang="ts">
// Small type indicator overlaid on a library item's cover art (library tile + info
// dialog) so the file type — a separated stem or a saved sample — reads at a
// glance. The host element must be `position: relative`; the badge pins itself to the
// bottom-right corner. Pass `showLabel` where there is room for the word (the dialog);
// the dense library tiles use the icon alone.
defineProps<{
  kind: 'stem' | 'sample'
  showLabel?: boolean
}>()
</script>

<template>
  <span
    class="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-zinc-950/85 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-100"
    :title="kind === 'stem' ? 'This is a separated stem' : 'Saved from a clip'"
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
      v-else
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z" />
    </svg>
    <span v-if="showLabel">{{ kind === 'stem' ? 'Stem' : 'Sample' }}</span>
  </span>
</template>
