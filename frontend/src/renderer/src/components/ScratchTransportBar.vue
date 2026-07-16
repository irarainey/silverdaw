<script setup lang="ts">
// Compact backing-transport cluster: skip-to-start, play/pause, loop toggle.
// Purely presentational — the parent owns the scratch session and routes the
// emitted intents to the backing channel only (never the scratch clip, which is
// heard only when the platter is jogged).
defineProps<{
  isPlaying: boolean
  canControl: boolean
  loopEnabled: boolean
  loopDisabled: boolean
}>()

defineEmits<{
  (e: 'skip-to-start'): void
  (e: 'toggle-play'): void
  (e: 'toggle-loop'): void
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
      class="rounded p-1.5 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      :class="loopEnabled ? 'bg-blue-600 text-white hover:bg-blue-500' : 'text-zinc-300 hover:text-zinc-100'"
      :disabled="loopDisabled"
      :title="loopEnabled ? 'Loop backing on' : 'Loop backing off'"
      :aria-label="loopEnabled ? 'Loop backing on' : 'Loop backing off'"
      role="switch"
      :aria-checked="loopEnabled"
      @click="$emit('toggle-loop')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-4 w-4"
      ><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></svg>
    </button>
  </div>
</template>
