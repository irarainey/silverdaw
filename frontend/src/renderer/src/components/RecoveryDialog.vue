<script setup lang="ts">
// Crash-recovery dialog, shown after the bridge is ready when
// `autosave:listRecoverable` returns entries (autosave newer than backing
// file, or backing file missing). Per row: Restore (PROJECT_LOAD_RECOVERY) or
// Discard (delete the autosave bucket); Skip closes without touching anything.
// At most one Restore in flight; Restore closes and lets App.vue finish startup.

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
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
  (e: 'discarded', projectId: string): void
  (e: 'close'): void
}>()

const project = useProjectStore()
const app = useAppStore()
const notifications = useNotificationsStore()
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
    // Preload the audio paths inside the autosave so the renderer's post-load metadata refresh
    // works (same allow-list seeding a normal File ▸ Open uses) — but trust the ORIGINAL project
    // folder's artifact roots (samples/stems/cover art + tags), which live beside the original
    // file, not in the autosave bucket. Otherwise restored sample/media links break.
    const prepared = await window.silverdaw.prepareProjectRecovery(
      entry.autosavePath,
      entry.originalPath
    )
    if (!prepared) {
      log.warn('recovery', `prepareProjectRecovery failed for ${entry.autosavePath}`)
    }
    const result = await project.requestLoadRecovery(
      entry.autosavePath,
      entry.originalPath,
      entry.projectId
    )
    if (!result.ok) {
      log.warn('recovery', `restore failed: ${result.error ?? 'unknown error'}`)
      if (result.error?.startsWith('Timed out') || result.error === 'The audio engine isn\'t connected') {
        notifications.pushError(`Could not restore project: ${result.error}`)
      }
      return
    }
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
    // The parent owns the entries list; tell it to drop this row so it vanishes
    // immediately. App.vue closes the dialog once the list empties.
    emit('discarded', entry.projectId)
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
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-title"
    >
      <div class="dialog-card w-[min(720px,94vw)]">
        <header class="dialog-header">
          <h1
            id="recovery-title"
            class="dialog-title"
          >
            Recover Unsaved Work
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            Silverdaw found {{ entries.length }} project{{ entries.length === 1 ? '' : 's' }} with
            unsaved changes from a previous session. Restore opens an autosave; the original
            file (if any) is left untouched until you explicitly Save.
          </p>
        </header>

        <ul class="silverdaw-scroll flex-1 overflow-y-auto divide-y divide-zinc-800">
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

        <footer class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            :disabled="busyId !== null"
            @click="skip"
          >
            Skip for Now
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
