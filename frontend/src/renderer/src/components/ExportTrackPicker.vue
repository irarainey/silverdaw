<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'

const props = defineProps<{ tracks: ReadonlyArray<{ id: string; name: string }> }>()
const selected = defineModel<string[]>({ required: true })
const open = ref(false)
const picker = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const listId = useId()
const all = computed(() => props.tracks.length > 0 && selected.value.length === props.tracks.length)

function closeOnBlur(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && !picker.value?.contains(event.relatedTarget)) open.value = false
}

watch(open, (expanded, _, onCleanup) => {
  if (!expanded) return
  const outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && !picker.value?.contains(event.target)) open.value = false
  }
  document.addEventListener('pointerdown', outside, true)
  onCleanup(() => document.removeEventListener('pointerdown', outside, true))
})

function onEscape(event: KeyboardEvent): void {
  if (!open.value) return
  event.stopPropagation()
  open.value = false
  button.value?.focus()
}
</script>

<template>
  <div
    ref="picker"
    class="relative"
    @focusout="closeOnBlur"
    @keydown.esc="onEscape"
  >
    <button
      ref="button"
      type="button"
      class="app-select w-full text-left"
      :aria-expanded="open"
      :aria-controls="listId"
      @click="open = !open"
    >
      Tracks: {{ all ? `All ${tracks.length} selected` : `${selected.length} of ${tracks.length} selected` }}
    </button>
    <!-- Keep focus inside the picker while a label click is forwarded to its checkbox. -->
    <div
      v-if="open"
      :id="listId"
      role="group"
      aria-label="Tracks to export"
      tabindex="-1"
      class="silverdaw-scroll absolute z-10 mt-1 max-h-40 w-full select-none overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg outline-none"
    >
      <label class="flex cursor-pointer items-center gap-2 border-b border-zinc-800 px-2 py-1 hover:bg-zinc-800">
        <input
          type="checkbox"
          class="accent-sky-500"
          :checked="all"
          :indeterminate="!all && selected.length > 0"
          @change="selected = all ? [] : tracks.map(track => track.id)"
        >
        Select all tracks
      </label>
      <label
        v-for="track in tracks"
        :key="track.id"
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800"
      >
        <input
          v-model="selected"
          type="checkbox"
          class="accent-sky-500"
          :value="track.id"
        >
        <span
          class="truncate"
          :title="track.name"
        >{{ track.name }}</span>
      </label>
    </div>
  </div>
</template>
