<script setup lang="ts">
import type { ProjectImportSource } from '@shared/types'

defineProps<{
  sources: readonly ProjectImportSource[]
  selectedPath: string
  loading: boolean
  disabled: boolean
}>()

const emit = defineEmits<{ (event: 'select', sourcePath: string): void }>()
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-1.5">
    <span class="text-xs font-medium text-zinc-300">Source project</span>
    <div
      class="silverdaw-scroll min-h-0 flex-1 overflow-y-auto rounded border border-zinc-700 bg-zinc-950"
      role="list"
    >
      <p
        v-if="loading"
        class="px-2 py-1 text-sm text-zinc-400"
      >
        Loading projects…
      </p>
      <div class="divide-y divide-zinc-800">
        <div
          v-for="source in sources"
          :key="source.path"
          role="listitem"
        >
          <button
            type="button"
            :aria-pressed="selectedPath === source.path"
            :disabled="disabled"
            class="flex h-8 w-full items-center px-3 text-left text-sm text-zinc-200 outline-none hover:bg-zinc-800 focus:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            :class="selectedPath === source.path ? 'bg-sky-500/15 text-sky-200' : ''"
            @click="emit('select', source.path)"
          >
            {{ source.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
