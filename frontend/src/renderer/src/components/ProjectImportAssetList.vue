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
  <div class="flex min-h-0 flex-1 flex-col">
    <p class="text-sm text-zinc-300">
      Select stems and samples from
      <span class="font-medium text-zinc-100">{{ manifest.name }}</span>.
    </p>
    <div class="silverdaw-scroll mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
      <section
        v-for="group in assetGroups"
        :key="group.label"
        class="mb-3 flex flex-col gap-1"
      >
        <h2 class="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          {{ group.label }}
        </h2>
        <p
          v-if="group.entries.length === 0"
          class="text-xs text-zinc-500"
        >
          None available.
        </p>
        <label
          v-for="entry in group.entries"
          :key="entry.id"
          class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          <input
            type="checkbox"
            class="accent-sky-500"
            :checked="isSelected(entry)"
            :disabled="importing"
            @change="emit('toggle-library', entry.id)"
          >
          <span class="min-w-0 truncate">{{ entry.name }}</span>
        </label>
      </section>
    </div>
  </div>
</template>
