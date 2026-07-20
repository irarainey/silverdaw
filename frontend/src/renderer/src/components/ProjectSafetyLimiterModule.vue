<script setup lang="ts">
import { useProjectStore } from '@/stores/projectStore'
import ClipEffectModule from '@/components/ClipEffectModule.vue'

const project = useProjectStore()

function onChange(event: Event): void {
  if (!(event.currentTarget instanceof HTMLInputElement)) return
  project.setSafetyLimiterEnabled(event.currentTarget.checked)
}
</script>

<template>
  <ClipEffectModule
    title="Safety Limiter"
    help-text="Prevents final peaks exceeding -1 dBFS when the mix gets too loud; normal playback stays unchanged."
    :cols="1"
    :rows="1"
  >
    <label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-200">
      <input
        type="checkbox"
        class="h-3.5 w-3.5 cursor-pointer accent-sky-500 outline-none"
        :checked="project.safetyLimiterEnabled"
        aria-label="Enable safety limiter"
        @change="onChange"
      >
      <span>Protect final output</span>
      <span class="ml-auto font-mono text-[10px] tabular-nums text-zinc-500">-1 dBFS</span>
    </label>
  </ClipEffectModule>
</template>
