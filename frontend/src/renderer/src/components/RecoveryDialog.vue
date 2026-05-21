<script setup lang="ts">
// Crash-recovery dialog. Shown by App.vue's startup coordinator after
// the bridge becomes ready iff `autosave:listRecoverable` returns one
// or more entries. Each entry corresponds to a project whose autosave
// file is newer than its backing file (or whose backing file is
// missing) — i.e. a session that ended without an explicit save.
//
// Per-row actions:
//   - Restore: send PROJECT_LOAD_RECOVERY for that entry, then close.
//   - Discard: delete the autosave bucket for that entry (no restore).
//
// Overall action:
//   - Skip: close without touching anything. The entries stay on disk
//     so the user can decide again next launch.
//
// At most one Restore can be in flight at a time; after Restore the
// dialog closes immediately and lets App.vue finish the startup flow.

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'
import { log } from '@/lib/log'

export interface RecoverableEntry {
  projectId: string
  originalPath: string | null
  projectName: string
  autosavePath: string
  savedAtIso: string
  originalExists: boolean
}

const props = defineProps<{
  open: boolean
  entries: RecoverableEntry[]
}>()
const emit = defineEmits<{
  (e: 'restored', entry: RecoverableEntry): void
  (e: 'close'): void
}>()

const project = useProjectStore()
const app = useAppStore()
const busyId = ref<string | null>(null)

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.valueOf())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function originalLabel(entry: RecoverableEntry): string {
  if (entry.originalPath === null) return 'Untitled (never saved)'
  if (!entry.originalExists) return `${entry.originalPath} (file missing)`
  return entry.originalPath
}

async function restore(entry: RecoverableEntry): Promise<void> {
  if (busyId.value) return
  busyId.value = entry.projectId
  try {
    // Preload the audio paths inside the autosave so the renderer's
    // post-load metadata refresh works (same allow-list seeding that
    // a normal File > Open uses).
    await window.silverdaw.prepareProjectOpen(entry.autosavePath)
    project.requestLoadRecovery(entry.autosavePath, entry.originalPath)
    log.info('recovery', `restored projectId=${entry.projectId} from ${entry.autosavePath}`)
    app.dismissStartScreen()
    emit('restored', entry)
    emit('close')
  } catch (err) {
    log.warn('recovery', `restore failed: ${String(err)}`)
  } finally {
    busyId.value = null
  }
}

async function discard(entry: RecoverableEntry): Promise<void> {
  if (busyId.value) return
  busyId.value = entry.projectId
  try {
    await window.silverdaw.clearAutosave(entry.projectId)
    log.info('recovery', `discarded projectId=${entry.projectId}`)
    // Locally narrow the visible list so the row vanishes immediately.
    // App.vue will refresh on dialog close.
    const next = props.entries.filter((e) => e.projectId !== entry.projectId)
    if (next.length === 0) emit('close')
  } finally {
    busyId.value = null
  }
}

function skip(): void {
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    skip()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-title"
    >
      <div
        class="flex max-h-[80vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl"
      >
        <header class="border-b border-zinc-800 px-6 pt-5 pb-4">
          <h1
            id="recovery-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Recover unsaved work
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            Silverdaw found {{ entries.length }} project{{ entries.length === 1 ? '' : 's' }} with
            unsaved changes from a previous session. Restore opens an autosave; the original
            file (if any) is left untouched until you explicitly Save.
          </p>
        </header>

        <ul class="flex-1 overflow-y-auto divide-y divide-zinc-800">
          <li
            v-for="entry in entries"
            :key="entry.projectId"
            class="flex items-start justify-between gap-4 px-6 py-3"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-zinc-100">
                {{ entry.projectName || 'Untitled' }}
              </div>
              <div
                class="mt-0.5 truncate text-xs text-zinc-500"
                :title="originalLabel(entry)"
              >
                {{ originalLabel(entry) }}
              </div>
              <div class="mt-0.5 text-[11px] text-zinc-600">
                Autosaved {{ formatTimestamp(entry.savedAtIso) }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="rounded bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="busyId !== null"
                @click="discard(entry)"
              >
                Discard
              </button>
              <button
                type="button"
                class="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="busyId !== null"
                @click="restore(entry)"
              >
                Restore
              </button>
            </div>
          </li>
        </ul>

        <footer class="flex justify-end border-t border-zinc-800 bg-zinc-900/60 px-5 py-3">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none"
            :disabled="busyId !== null"
            @click="skip"
          >
            Skip for now
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
