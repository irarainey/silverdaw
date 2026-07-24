<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useProjectImportState } from '@/lib/projectImportState'
import ProjectImportSourceList from '@/components/ProjectImportSourceList.vue'
import ProjectImportAssetList from '@/components/ProjectImportAssetList.vue'
import type { ProjectImportSource } from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const project = useProjectStore()
const transport = useTransportStore()
const {
  manifest,
  inspecting,
  importing,
  error,
  completed,
  inspect,
  importAssets,
  reset
} = useProjectImportState()
const sources = ref<ProjectImportSource[]>([])
const sourcesLoading = ref(false)
const sourcesError = ref<string | null>(null)
const selectedSourcePath = ref('')
const selectedLibraryItemIds = ref(new Set<string>())
const visibleSources = computed(() => {
  const currentPath = project.currentFilePath?.toLocaleLowerCase()
  return sources.value.filter((source) => source.path.toLocaleLowerCase() !== currentPath)
})
const selectionCount = computed(() => selectedLibraryItemIds.value.size)
const canImport = computed(
  () => manifest.value !== null && selectionCount.value > 0 && !importing.value
)
async function loadSources(): Promise<void> {
  sourcesLoading.value = true
  sourcesError.value = null
  try {
    sources.value = await window.silverdaw.listProjectImportSources()
  } catch {
    sources.value = []
    sourcesError.value = 'Could not list saved projects. Check the configured project folder and try again.'
  } finally {
    sourcesLoading.value = false
  }
}

function selectSource(sourcePath: string): void {
  selectedLibraryItemIds.value = new Set()
  selectedSourcePath.value = sourcePath
  if (transport.bridgeReady) inspect(sourcePath)
}

function toggleLibraryItem(id: string): void {
  const next = new Set(selectedLibraryItemIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedLibraryItemIds.value = next
}

function onImport(): void {
  if (!canImport.value || !selectedSourcePath.value) return
  importAssets(
    selectedSourcePath.value,
    [...selectedLibraryItemIds.value]
  )
}

function close(): void {
  if (importing.value) return
  reset()
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    reset()
    selectedSourcePath.value = ''
    selectedLibraryItemIds.value = new Set()
    void loadSources()
  },
  { immediate: true }
)
watch(
  () => completed.value,
  (completed) => {
    if (completed) close()
  }
)
watch(
  () => transport.bridgeReady,
  (bridgeReady) => {
    if (bridgeReady && selectedSourcePath.value && manifest.value === null && !importing.value) {
      inspect(selectedSourcePath.value)
    }
  }
)
</script>

<template>
  <div
    v-if="open"
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="project-import-title"
    @keydown.esc.prevent="close"
  >
    <div
      tabindex="-1"
      class="dialog-card h-[560px] w-[780px] max-h-[82vh] max-w-[92vw]"
    >
      <div class="dialog-header">
        <h1
          id="project-import-title"
          class="dialog-title"
        >
          Import from Project
        </h1>
      </div>

      <div class="dialog-body grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-5 overflow-hidden">
        <ProjectImportSourceList
          :sources="visibleSources"
          :selected-path="selectedSourcePath"
          :loading="sourcesLoading"
          :disabled="importing"
          @select="selectSource"
        />

        <div class="min-h-0 flex flex-col border-l border-zinc-800 pl-5">
          <h2 class="text-xs font-medium text-zinc-300">
            Files
          </h2>
          <p
            v-if="sourcesError"
            class="mt-3 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-400"
          >
            {{ sourcesError }}
          </p>
          <p
            v-else-if="!sourcesLoading && visibleSources.length === 0"
            class="mt-3 text-sm text-zinc-400"
          >
            No other saved projects were found in the configured project folder.
          </p>
          <p
            v-else-if="!selectedSourcePath"
            class="mt-3 text-sm text-zinc-400"
          >
            Select a project to see its importable files.
          </p>
          <p
            v-else-if="!transport.bridgeReady"
            class="mt-3 text-sm text-zinc-400"
          >
            Waiting for the audio engine to read project assets…
          </p>
          <p
            v-else-if="inspecting"
            class="mt-3 text-sm text-zinc-400"
          >
            Reading project assets…
          </p>
          <ProjectImportAssetList
            v-if="manifest"
            class="mt-3"
            :manifest="manifest"
            :importing="importing"
            :selected-library-item-ids="selectedLibraryItemIds"
            @toggle-library="toggleLibraryItem"
          />

          <p
            v-if="error"
            class="mt-3 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-400"
          >
            {{ error }}
          </p>
        </div>
      </div>

      <div class="dialog-footer">
        <button
          type="button"
          class="dialog-btn-cancel"
          :disabled="importing"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="button"
          class="dialog-btn-primary"
          :disabled="!canImport"
          @click="onImport"
        >
          {{ importing ? 'Importing…' : `Import${selectionCount ? ` (${selectionCount})` : ''}` }}
        </button>
      </div>
    </div>
  </div>
</template>
