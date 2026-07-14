<script setup lang="ts">
// Compact backing-transport cluster: skip-to-start, play/pause, skip-to-end.
// Purely presentational — the parent owns the scratch session and routes the
// emitted intents to the backing channel only (never the scratch clip, which is
// heard only when the platter is jogged).
defineProps<{
  isPlaying: boolean
  canControl: boolean
}>()

defineEmits<{
  (e: 'skip-to-start'): void
  (e: 'toggle-play'): void
  (e: 'skip-to-end'): void
}>()
</script>

<template>
  <div class="flex items-center gap-1">
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canControl"
      title="Skip backing to start"
      aria-label="Skip backing to start"
      @click="$emit('skip-to-start')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-4 w-4"
      ><path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" /></svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-1.5 hover:bg-blue-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      :class="isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
      :disabled="!canControl"
      :title="isPlaying ? 'Pause backing (Space)' : 'Play backing (Space)'"
      :aria-label="isPlaying ? 'Pause backing' : 'Play backing'"
      @click="$emit('toggle-play')"
    >
      <svg
        v-if="isPlaying"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      ><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" /></svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      ><path d="M8 5v14l11-7L8 5z" /></svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canControl"
      title="Skip backing to end"
      aria-label="Skip backing to end"
      @click="$emit('skip-to-end')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-4 w-4"
      ><path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" /></svg>
    </button>
  </div>
</template>
