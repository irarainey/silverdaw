<script setup lang="ts">
defineProps<{
  isPlaying: boolean
  followPlayback: boolean
  skipBackTitle: string
  playButtonTitle: string
  playDisabled: boolean
  skipForwardTitle: string
}>()

const emit = defineEmits<{
  skipBack: []
  play: []
  skipForward: []
  toggleFollow: []
}>()
</script>

<template>
  <div class="flex items-center gap-1">
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
      :title="skipBackTitle"
      @click="emit('skipBack')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      >
        <path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" />
      </svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 hover:bg-blue-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-100"
      :class="isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
      :title="playButtonTitle"
      :disabled="playDisabled"
      @click="emit('play')"
    >
      <svg
        v-if="isPlaying"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-6 w-6"
      >
        <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
      </svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-6 w-6"
      >
        <path d="M8 5v14l11-7L8 5z" />
      </svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
      :title="skipForwardTitle"
      @click="emit('skipForward')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="h-5 w-5"
      >
        <path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" />
      </svg>
    </button>
    <div class="mx-1 h-7 w-px bg-zinc-800" />
    <button
      type="button"
      data-borderless-button="true"
      class="rounded p-2 hover:bg-zinc-800"
      :class="followPlayback ? 'text-blue-400 hover:text-blue-300' : 'text-zinc-500 hover:text-zinc-300'"
      :title="followPlayback ? 'Follow playback (on) — timeline scrolls with the playhead' : 'Follow playback (off) — timeline stays put during playback'"
      @click="emit('toggleFollow')"
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
      >
        <circle
          cx="12"
          cy="12"
          r="9"
        />
        <path d="M10 8l5 4-5 4V8z" />
      </svg>
    </button>
  </div>
</template>
