<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectImportEntry } from '@shared/bridge-protocol'

type ProjectImportManifest = {
  sourceProjectPath: string
  name: string
  stems: readonly ProjectImportEntry[]
  samples: readonly ProjectImportEntry[]
}
const props = defineProps<{
  manifest: ProjectImportManifest
  importing: boolean
  selectedLibraryItemIds: ReadonlySet<string>
}>()
const emit = defineEmits<{ (event: 'toggle-library', id: string): void }>()

type AssetGroup = {
  label: string
  entries: readonly ProjectImportEntry[]
}

const assetGroups = computed<AssetGroup[]>(() => [
  { label: 'Stems', entries: props.manifest.stems },
  { label: 'Samples', entries: props.manifest.samples }
])

function isSelected(entry: ProjectImportEntry): boolean {
  return props.selectedLibraryItemIds.has(entry.id)
}
</script>

<template>
  <section
    class="flex min-h-0 flex-1 flex-col"
    aria-labelledby="project-import-assets-title"
  >
    <p
      id="project-import-assets-title"
      class="text-sm text-zinc-300"
    >
      Select files from
      <span class="font-medium text-zinc-100">{{ manifest.name }}</span>.
    </p>
    <div class="silverdaw-scroll mt-3 min-h-0 flex-1 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1">
      <section
        v-for="group in assetGroups"
        :key="group.label"
        class="mb-3 last:mb-0"
      >
        <h3 class="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          {{ group.label }}
        </h3>
        <p
          v-if="group.entries.length === 0"
          class="px-2 py-1 text-xs text-zinc-500"
        >
          None available.
        </p>
        <label
          v-for="entry in group.entries"
          :key="entry.id"
          class="flex min-h-9 cursor-pointer items-center gap-2 rounded border border-transparent px-2 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 focus-within:border-sky-500 focus-within:bg-sky-500/15"
          :class="[
            isSelected(entry) ? 'border-sky-500 bg-sky-500/15 text-sky-100' : '',
            importing ? 'cursor-not-allowed opacity-50' : ''
          ]"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-500 outline-none disabled:cursor-not-allowed"
            :checked="isSelected(entry)"
            :disabled="importing"
            @change="emit('toggle-library', entry.id)"
          >
          <span class="min-w-0 truncate">{{ entry.name }}</span>
        </label>
      </section>
    </div>
  </section>
</template>
