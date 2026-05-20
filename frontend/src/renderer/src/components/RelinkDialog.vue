<script setup lang="ts">
// Dialog shown when a project loads with one or more clips whose
// source files are missing on disk. The list is derived from the
// store (clips where `unresolved === true`); each row offers a
// "Locate file…" button that opens an OS file picker and emits
// `CLIP_RELINK` to the backend. As clips are successfully relinked
// the backend re-broadcasts PROJECT_STATE; the corresponding row
// disappears from the dialog. When the list becomes empty the
// dialog auto-closes.
//
// The dialog is also reachable later (after closing without
// relinking everything) via the "Relink…" item on the right-click
// clip context menu — so dismissing this dialog isn't a one-shot.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore, type Clip } from '@/stores/projectStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()

const dialogEl = ref<HTMLDivElement | null>(null)

const unresolved = computed<Clip[]>(() =>
  Object.values(project.clips).filter((c) => c.unresolved)
)

// Auto-close when the last unresolved clip has been relinked.
watch(unresolved, (list) => {
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

async function relinkOne(clip: Clip): Promise<void> {
  // Default the picker to the directory the missing file claimed to
  // live in — the user has often just moved the project folder, so
  // the OS dialog opens close to the correct location anyway. If that
  // directory no longer exists the OS dialog quietly falls back to
  // the user's last-used folder.
  const slash = Math.max(clip.filePath.lastIndexOf('\\'), clip.filePath.lastIndexOf('/'))
  const defaultPath = slash > 0 ? clip.filePath.slice(0, slash) : undefined
  const picked = await window.silverdaw.chooseAudioFile({
    title: `Locate ${clip.fileName}`,
    defaultPath
  })
  if (!picked) return
  project.relinkLibraryItem(clip.libraryItemId, picked)
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="relink-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(640px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="relink-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Missing audio files
          </h1>
          <p class="mt-1 text-xs text-zinc-400">
            {{ unresolved.length }} {{ unresolved.length === 1 ? 'clip references a file' : 'clips reference files' }}
            that {{ unresolved.length === 1 ? "couldn't" : "couldn't" }} be found on disk.
            Locate each replacement file, or close this dialog and relink later via the
            clip's right-click menu.
          </p>
        </div>

        <!-- Body -->
        <div class="max-h-[60vh] overflow-y-auto px-6 py-4">
          <ul
            v-if="unresolved.length > 0"
            class="space-y-3"
          >
            <li
              v-for="clip in unresolved"
              :key="clip.id"
              class="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-medium text-zinc-100">{{ clip.fileName }}</span>
                <code
                  class="truncate text-[10px] text-zinc-500"
                  :title="clip.filePath"
                >{{ clip.filePath || '(no path)' }}</code>
              </div>
              <button
                type="button"
                class="shrink-0 rounded bg-sky-600 px-3 py-1 text-xs font-medium text-zinc-100 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
                @click="relinkOne(clip)"
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
        <div class="flex justify-end border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
