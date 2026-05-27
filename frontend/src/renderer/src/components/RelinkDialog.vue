<script setup lang="ts">
// Dialog shown when a project loads with one or more clips whose
// source files are missing on disk. The list is derived from the
// store (clips where `unresolved === true`), then **deduplicated by
// file path** — if the same broken path is referenced by 10 clips
// (or by several library items), the dialog shows it once. Locating
// the replacement file fans the relink out to every library item
// that referenced the missing path, so a single dialog interaction
// fixes every clip that pointed at it.
//
// As clips are successfully relinked the backend re-broadcasts
// PROJECT_STATE; the corresponding row disappears from the dialog.
// When the list becomes empty the dialog auto-closes.
//
// The dialog is also reachable later (after closing without
// relinking everything) via the "Relink" item on the right-click
// clip context menu — so dismissing this dialog isn't a one-shot.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()

const dialogEl = ref<HTMLDivElement | null>(null)

/** One row per unique missing file path. `libraryItemIds` carries
 *  every library item id that points at that path — Locate fans the
 *  relink out to all of them in one user action. `fileName` is the
 *  display name (basename) from the first clip we saw with that path. */
interface MissingFileRow {
  filePath: string
  fileName: string
  libraryItemIds: string[]
  /** Number of timeline clips that reference this missing file.
   *  Surfaced in the row so the user understands the impact of the
   *  relink ("3 clips on the timeline use this file"). */
  clipCount: number
}

const missingFiles = computed<MissingFileRow[]>(() => {
  const byPath = new Map<string, MissingFileRow>()
  for (const clip of Object.values(project.clips)) {
    if (!clip.unresolved) continue
    const key = clip.filePath
    let row = byPath.get(key)
    if (!row) {
      row = {
        filePath: clip.filePath,
        fileName: clip.fileName,
        libraryItemIds: [],
        clipCount: 0
      }
      byPath.set(key, row)
    }
    if (!row.libraryItemIds.includes(clip.libraryItemId)) {
      row.libraryItemIds.push(clip.libraryItemId)
    }
    row.clipCount++
  }
  return Array.from(byPath.values())
})

// Auto-close when the last unresolved file has been relinked.
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
  // Default the picker to the directory the missing file claimed to
  // live in — the user has often just moved the project folder, so
  // the OS dialog opens close to the correct location anyway. If that
  // directory no longer exists the OS dialog quietly falls back to
  // the user's last-used folder.
  const slash = Math.max(row.filePath.lastIndexOf('\\'), row.filePath.lastIndexOf('/'))
  const defaultPath = slash > 0 ? row.filePath.slice(0, slash) : undefined
  const picked = await window.silverdaw.chooseAudioFile({
    title: `Locate ${row.fileName}`,
    defaultPath
  })
  if (!picked) return
  // Fan the relink out to every library item that referenced the
  // missing path. The backend processes each LIBRARY_ITEM_RELINK
  // independently; the renderer's PROJECT_STATE update will clear
  // the `unresolved` flag on every affected clip in one snapshot.
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
        <!-- Header -->
        <div class="dialog-header">
          <h1
            id="relink-title"
            class="dialog-title"
          >
            Missing audio files
          </h1>
          <p class="mt-1 text-xs text-zinc-400">
            {{ missingFiles.length }}
            {{ missingFiles.length === 1 ? 'audio file is' : 'audio files are' }}
            referenced by this project but couldn't be found on disk. Locate each
            replacement file, or close this dialog and relink later via a clip's
            right-click menu.
          </p>
        </div>

        <!-- Body -->
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

        <!-- Footer -->
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
