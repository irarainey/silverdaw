<script setup lang="ts">
// Missing-file relink dialog; rows are deduped by persisted library file path.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const library = useLibraryStore()

const dialogEl = ref<HTMLDivElement | null>(null)

/** One row per missing path; Locate relinks every library item using it. */
interface MissingFileRow {
  filePath: string
  fileName: string
  libraryItemIds: string[]
  /** Number of timeline clips affected by this missing file. */
  clipCount: number
}

const missingFiles = computed<MissingFileRow[]>(() => {
  const byPath = new Map<string, MissingFileRow>()
  const rowByItemId = new Map<string, MissingFileRow>()
  // Library items are the durable source of every persisted source path.
  for (const item of library.items) {
    if (!item.unresolved) continue
    const key = item.filePath
    let row = byPath.get(key)
    if (!row) {
      row = {
        filePath: item.filePath,
        fileName: item.fileName,
        libraryItemIds: [],
        clipCount: 0
      }
      byPath.set(key, row)
    }
    if (!row.libraryItemIds.includes(item.id)) row.libraryItemIds.push(item.id)
    rowByItemId.set(item.id, row)
  }
  // Tally timeline impact per missing source.
  for (const clip of Object.values(project.clips)) {
    if (!clip.unresolved) continue
    const row = rowByItemId.get(clip.libraryItemId)
    if (row) row.clipCount++
  }
  return Array.from(byPath.values())
})

watch(missingFiles, (list) => {
  if (props.open && list.length === 0) emit('close')
})

function onKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

async function relinkOne(row: MissingFileRow): Promise<void> {
  // Start near the missing path; OS falls back if that folder no longer exists.
  const slash = Math.max(row.filePath.lastIndexOf('\\'), row.filePath.lastIndexOf('/'))
  const defaultPath = slash > 0 ? row.filePath.slice(0, slash) : undefined
  const picked = await window.silverdaw.chooseAudioFile({
    title: `Locate ${row.fileName}`,
    defaultPath
  })
  if (!picked) return
  // Relink every library item that referenced this missing path.
  for (const itemId of row.libraryItemIds) {
    project.relinkLibraryItem(itemId, picked)
  }
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="relink-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(640px,92vw)]"
      >
        <div class="dialog-header">
          <h1
            id="relink-title"
            class="dialog-title"
          >
            Missing Audio Files
          </h1>
          <p class="mt-1 text-xs text-zinc-400">
            {{ missingFiles.length }}
            {{ missingFiles.length === 1 ? 'audio file is' : 'audio files are' }}
            referenced by this project but couldn't be found on disk. Locate each
            replacement file, or close this dialog and relink later via a clip's
            right-click menu.
          </p>
        </div>

        <div class="silverdaw-scroll max-h-[60vh] overflow-y-auto px-6 py-4">
          <ul
            v-if="missingFiles.length > 0"
            class="space-y-3"
          >
            <li
              v-for="row in missingFiles"
              :key="row.filePath"
              class="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-medium text-zinc-100">{{ row.fileName }}</span>
                <code
                  class="truncate text-[10px] text-zinc-500"
                  :title="row.filePath"
                >{{ row.filePath || '(no path)' }}</code>
                <span class="mt-0.5 text-[10px] text-zinc-600">
                  Used by {{ row.clipCount }} {{ row.clipCount === 1 ? 'clip' : 'clips' }}
                </span>
              </div>
              <button
                type="button"
                class="shrink-0 rounded bg-sky-600 px-3 py-1 text-xs font-medium text-zinc-100 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
                @click="relinkOne(row)"
              >
                Locate file…
              </button>
            </li>
          </ul>
          <p
            v-else
            class="text-xs text-zinc-500"
          >
            All clips are linked. You can close this dialog.
          </p>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-primary"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
