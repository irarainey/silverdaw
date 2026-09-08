<script setup lang="ts">
// The app's one spinner. The same twelve-line SVG had been pasted into every
// panel that waits on something, so a spinner could drift in size or opacity
// from one dialog to the next; this is the single copy to reach for.
//
// It inherits `currentColor` and carries no margin, so it sits inside a button
// or a label without the caller having to undo anything.

withDefaults(defineProps<{ size?: 'sm' | 'md' }>(), { size: 'sm' })
</script>

<template>
  <svg
    :class="['animate-spin', size === 'md' ? 'h-4 w-4' : 'h-3 w-3']"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle
      class="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      stroke-width="4"
    />
    <path
      class="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
</template>
