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
  <section
    class="flex h-full min-h-0 flex-col"
    aria-labelledby="project-import-sources-title"
  >
    <h2
      id="project-import-sources-title"
      class="text-[11px] font-medium uppercase tracking-wider text-zinc-400"
    >
      Projects
    </h2>
    <div
      class="silverdaw-scroll mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1"
      role="list"
    >
      <p
        v-if="loading"
        class="px-2 py-2 text-xs text-zinc-400"
      >
        Loading projects…
      </p>
      <p
        v-else-if="sources.length === 0"
        class="px-2 py-2 text-xs leading-relaxed text-zinc-500"
      >
        No saved projects found.
      </p>
      <div
        v-else
        class="space-y-1"
      >
        <div
          v-for="source in sources"
          :key="source.path"
          role="listitem"
        >
          <button
            type="button"
            :aria-pressed="selectedPath === source.path"
            :disabled="disabled"
            class="flex h-9 w-full items-center rounded border border-transparent px-2 text-left text-sm text-zinc-200 outline-none transition-colors hover:bg-zinc-800 focus-visible:border-sky-500 focus-visible:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            :class="selectedPath === source.path ? 'border-sky-500 bg-sky-500/15 font-medium text-sky-200' : ''"
            @click="emit('select', source.path)"
          >
            <span class="truncate">{{ source.name }}</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
