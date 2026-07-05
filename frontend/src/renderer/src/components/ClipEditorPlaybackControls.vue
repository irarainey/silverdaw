<script setup lang="ts">
// Clip Editor header transport cluster: skip-to-start, play/pause, skip-to-end,
// and loop toggle. Purely presentational — the parent owns playback state and
// handles the emitted intents.
defineProps<{
  isPlaying: boolean
  isLoaded: boolean
  loopEnabled: boolean
  metronomeEnabled: boolean
  /** Hidden in the read-only source preview, where a beat click serves no purpose. */
  showMetronome?: boolean
}>()

defineEmits<{
  (e: 'skip-to-start'): void
  (e: 'toggle-play'): void
  (e: 'skip-to-end'): void
  (e: 'toggle-loop'): void
  (e: 'toggle-metronome'): void
}>()
</script>

<template>
  <div class="flex items-center gap-1 justify-self-center">
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
      title="Skip to start"
      @click="$emit('skip-to-start')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      ><path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" /></svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 hover:bg-blue-600 hover:text-white"
      :class="isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
      :disabled="!isLoaded"
      :title="!isLoaded ? 'Preparing preview…' : isPlaying ? 'Pause (Space)' : 'Play (Space)'"
      @click="$emit('toggle-play')"
    >
      <svg
        v-if="isPlaying"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-6 w-6"
      ><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" /></svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-6 w-6"
      ><path d="M8 5v14l11-7L8 5z" /></svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
      title="Skip to end"
      @click="$emit('skip-to-end')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      ><path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" /></svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="ml-1 rounded p-2 hover:bg-zinc-800"
      :class="loopEnabled ? 'bg-blue-600 text-white hover:bg-blue-500' : 'text-zinc-300 hover:text-zinc-100'"
      :title="loopEnabled ? 'Loop on (L)' : 'Loop off (L)'"
      @click="$emit('toggle-loop')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      ><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></svg>
    </button>
    <button
      v-if="showMetronome"
      type="button"
      data-borderless-button="true"
      role="switch"
      :aria-checked="metronomeEnabled"
      aria-label="Clip metronome click"
      class="ml-1 rounded p-2 hover:bg-zinc-800"
      :class="metronomeEnabled ? 'bg-blue-600 text-white hover:bg-blue-500' : 'text-zinc-300 hover:text-zinc-100'"
      :title="metronomeEnabled ? 'Clip metronome on — click plays in time with the clip\'s tempo. Click to turn off.' : 'Clip metronome off — click plays an audible tick in time with the clip\'s tempo. Click to turn on.'"
      @click="$emit('toggle-metronome')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-5 w-5"
        aria-hidden="true"
      >
        <path d="M8 3h8l3 18H5L8 3z" />
        <path d="M9 9l7-4" />
        <path d="M7 16h10" />
      </svg>
    </button>
  </div>
</template>
