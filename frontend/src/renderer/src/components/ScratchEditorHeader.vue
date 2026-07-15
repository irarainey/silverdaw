<script setup lang="ts">
defineProps<{
  clipName: string
  deckLabel: string | null
  showSavedBadge: boolean
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
      v-if="deckLabel"
      class="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
    >{{ deckLabel }}</span>
    <span
      v-if="showSavedBadge"
      class="ml-1 text-[10px] text-emerald-400"
    >Saved</span>
  </header>
</template>
