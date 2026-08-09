<script setup lang="ts">
const props = defineProps<{
  placeholder: string
  inputLabel: string
  clearLabel: string
}>()

// Optional: a panel that owns a keyboard-navigable list can drive it from the
// filter box, so searching never parks the keyboard in a dead end.
const emit = defineEmits<{
  (e: 'navigate', delta: 1 | -1): void
  (e: 'activate'): void
  (e: 'cleared'): void
}>()

const query = defineModel<string>({ required: true })

function clearFilter(): void {
  query.value = ''
  emit('cleared')
}
</script>

<template>
  <div class="relative">
    <input
      v-model="query"
      type="text"
      :placeholder="props.placeholder"
      :aria-label="props.inputLabel"
      class="w-48 rounded border border-zinc-700 bg-zinc-950 py-0.5 pl-2 pr-7 text-xs normal-case tracking-normal text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
      @keydown.escape.prevent.stop="clearFilter"
      @keydown.down.prevent="emit('navigate', 1)"
      @keydown.up.prevent="emit('navigate', -1)"
      @keydown.enter.prevent="emit('activate')"
    >
    <button
      v-if="query.length > 0"
      type="button"
      data-borderless-button="true"
      class="absolute right-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-700 text-zinc-300 hover:bg-zinc-600 hover:text-zinc-100 focus:bg-zinc-600 focus:outline-none"
      :aria-label="props.clearLabel"
      title="Clear filter"
      @click="clearFilter"
    >
      <svg
        viewBox="0 0 16 16"
        class="h-3 w-3"
        aria-hidden="true"
      >
        <path
          d="M5 5l6 6m0-6l-6 6"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>
