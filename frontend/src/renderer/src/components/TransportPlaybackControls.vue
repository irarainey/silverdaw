<script setup lang="ts">
defineProps<{
  isPlaying: boolean
  isPlaybackHeld: boolean
  followPlayback: boolean
  hasTimelineSelection: boolean
  loopTimelineSelection: boolean
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
  toggleLoopSelection: []
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
      :class="
        isPlaybackHeld
          ? 'animate-pulse bg-sky-600 text-white'
          : isPlaying
            ? 'bg-blue-600 text-white'
            : 'text-zinc-100'
      "
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
      class="rounded p-2 outline-none disabled:cursor-not-allowed disabled:opacity-40"
      :class="loopTimelineSelection ? 'bg-sky-600/30 text-sky-200 hover:bg-sky-600/40' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'"
      :title="loopTimelineSelection ? 'Loop Selection (on)' : 'Loop Selection (off)'"
      :disabled="!hasTimelineSelection"
      @click="emit('toggleLoopSelection')"
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
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v2a3 3 0 0 1-3 3H3" />
      </svg>
    </button>
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
