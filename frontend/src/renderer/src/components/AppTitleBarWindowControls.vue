<script setup lang="ts">
const props = defineProps<{
  disabled?: boolean
}>()

const emit = defineEmits<{
  minimize: []
  toggleMaximize: []
  close: []
}>()
</script>

<template>
  <div
    class="flex h-full items-stretch"
    style="-webkit-app-region: no-drag"
  >
    <button
      type="button"
      data-borderless-button="true"
      class="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-0"
      :disabled="props.disabled"
      aria-label="Minimise"
      title="Minimise"
      @click="emit('minimize')"
    >
      <svg
        viewBox="0 0 16 16"
        class="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path
          d="M3 8h10"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-0"
      :disabled="props.disabled"
      aria-label="Maximise or restore"
      title="Maximise / Restore"
      @click="emit('toggleMaximize')"
    >
      <svg
        viewBox="0 0 16 16"
        class="h-3.5 w-3.5"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="4"
          y="4"
          width="8"
          height="8"
          rx="0.75"
          stroke="currentColor"
          stroke-width="1.4"
        />
      </svg>
    </button>
    <button
      type="button"
      data-borderless-button="true"
      class="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white disabled:pointer-events-none disabled:opacity-0"
      :disabled="props.disabled"
      aria-label="Close"
      title="Close"
      @click="emit('close')"
    >
      <svg
        viewBox="0 0 16 16"
        class="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path
          d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>
