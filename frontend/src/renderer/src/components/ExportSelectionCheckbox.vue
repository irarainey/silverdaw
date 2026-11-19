<script setup lang="ts">
import { watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'

const checked = defineModel<boolean>({ required: true })
const ui = useUiStore()
watch(() => ui.timelineSelection, selection => {
  if (!selection) checked.value = false
})
</script>

<template>
  <label
    class="flex items-center gap-2"
    :class="{ 'text-zinc-500': !ui.timelineSelection }"
    :title="ui.timelineSelection ? 'Stop at the end of the range, without an extra tail.' : 'Drag across the timeline ruler to select a range.'"
  >
    <input
      v-model="checked"
      type="checkbox"
      class="accent-sky-500"
      :disabled="!ui.timelineSelection"
    >
    Export selected range only
  </label>
</template>
