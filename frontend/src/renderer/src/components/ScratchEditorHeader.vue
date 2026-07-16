<script setup lang="ts">
defineProps<{
  clipName: string
  deckLabel: string | null
  isDirty: boolean
}>()
</script>

<template>
  <header class="dialog-header flex items-baseline gap-3">
    <h2
      id="scratch-editor-title"
      class="dialog-title"
    >
      Scratch Editor
    </h2>
    <span
      v-if="clipName"
      class="text-xs text-zinc-400"
    >{{ clipName }}</span>
    <span
      v-if="isDirty"
      class="text-zinc-400"
      aria-label="Unsaved changes"
      title="Unsaved changes"
    >•</span>
    <span
      v-if="deckLabel"
      class="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
    >{{ deckLabel }}</span>
  </header>
</template>
