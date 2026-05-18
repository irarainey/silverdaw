<script setup lang="ts">
// Preferences dialog. Transactional: changes are held locally until the
// user clicks Save. Cancel (and Esc) discard pending edits.
//
// Sections:
//   - Interface  → toast notification visibility (applied immediately on Save).
//   - Paths      → default project / clip directories used by the OS
//                  open / save dialogs (applied immediately on Save).
//   - Developer  → cross-layer debug logging + Debug menu (next launch).

import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const appStore = useAppStore()
const ui = useUiStore()

const dialogEl = ref<HTMLDivElement | null>(null)

// Working copies — edited freely; not persisted until Save.
const debugEnabled = ref(false)
const toastsEnabled = ref(true)
const followPlayback = ref(true)
const defaultProjectDir = ref('')
const defaultClipDir = ref('')

// Snapshot of the values when the dialog opened, used to:
//   1. Detect whether anything actually changed (Save no-ops if not).
//   2. Show the "Restart required" notice when debug differs.
const initialDebug = ref(false)
const initialToasts = ref(true)
const initialFollow = ref(true)
const initialProjectDir = ref('')
const initialClipDir = ref('')

const hasChanges = computed(
  () =>
    debugEnabled.value !== initialDebug.value ||
    toastsEnabled.value !== initialToasts.value ||
    followPlayback.value !== initialFollow.value ||
    defaultProjectDir.value !== initialProjectDir.value ||
    defaultClipDir.value !== initialClipDir.value
)

async function loadCurrent(): Promise<void> {
  try {
    const [debugVal, qol] = await Promise.all([
      window.silverdaw.getDebugEnabled(),
      window.silverdaw.getQolPrefs()
    ])
    debugEnabled.value = debugVal
    toastsEnabled.value = qol.toasts.enabled
    defaultProjectDir.value = qol.paths.defaultProjectDir
    defaultClipDir.value = qol.paths.defaultClipDir
  } catch {
    debugEnabled.value = false
    toastsEnabled.value = true
    defaultProjectDir.value = ''
    defaultClipDir.value = ''
  }
  // `followPlayback` lives in the UI prefs sub-tree (alongside panel
  // sizes) and is mirrored into the uiStore on startup — read it from
  // there directly so we don't need a second IPC round-trip.
  followPlayback.value = ui.followPlayback
  initialDebug.value = debugEnabled.value
  initialToasts.value = toastsEnabled.value
  initialFollow.value = followPlayback.value
  initialProjectDir.value = defaultProjectDir.value
  initialClipDir.value = defaultClipDir.value
}

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    await loadCurrent()
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

async function chooseProjectDir(): Promise<void> {
  const picked = await window.silverdaw.chooseDirectory({
    title: 'Default project folder',
    defaultPath: defaultProjectDir.value || undefined
  })
  if (picked) defaultProjectDir.value = picked
}

async function chooseClipDir(): Promise<void> {
  const picked = await window.silverdaw.chooseDirectory({
    title: 'Default clip folder',
    defaultPath: defaultClipDir.value || undefined
  })
  if (picked) defaultClipDir.value = picked
}

function onCancel(): void {
  // Discard pending edits — `loadCurrent` will repopulate the refs the
  // next time the dialog opens.
  emit('close')
}

function onSave(): void {
  // Only push the deltas main needs to know about. The toast toggle is
  // also mirrored into the appStore so the change is visible to
  // `notificationsStore.push` without a re-hydrate.
  const qolPatch: {
    toasts?: { enabled: boolean }
    paths?: { defaultProjectDir?: string; defaultClipDir?: string }
  } = {}
  if (toastsEnabled.value !== initialToasts.value) {
    qolPatch.toasts = { enabled: toastsEnabled.value }
    appStore.setToastsEnabled(toastsEnabled.value)
  }
  const pathsPatch: { defaultProjectDir?: string; defaultClipDir?: string } = {}
  if (defaultProjectDir.value !== initialProjectDir.value && defaultProjectDir.value.length > 0) {
    pathsPatch.defaultProjectDir = defaultProjectDir.value
  }
  if (defaultClipDir.value !== initialClipDir.value && defaultClipDir.value.length > 0) {
    pathsPatch.defaultClipDir = defaultClipDir.value
  }
  if (Object.keys(pathsPatch).length > 0) {
    qolPatch.paths = pathsPatch
  }
  if (Object.keys(qolPatch).length > 0) {
    window.silverdaw.setQolPrefs(qolPatch)
  }
  if (debugEnabled.value !== initialDebug.value) {
    window.silverdaw.setDebugEnabled(debugEnabled.value)
  }
  if (followPlayback.value !== initialFollow.value) {
    // Goes through the uiStore so the transport-bar toggle stays in
    // sync and the new value is persisted via the usual UI prefs path.
    ui.setFollowPlayback(followPlayback.value)
  }
  emit('close')
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
      aria-labelledby="prefs-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(520px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="prefs-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Preferences
          </h1>
        </div>

        <!-- Body -->
        <div class="space-y-6 px-6 py-5 text-xs leading-relaxed">
          <!-- Interface -->
          <section>
            <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Interface
            </h2>
            <label class="flex cursor-pointer items-start gap-3">
              <input
                v-model="toastsEnabled"
                type="checkbox"
                class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
              >
              <span class="flex-1">
                <span class="block font-medium text-zinc-200">Show toast notifications</span>
                <span class="mt-0.5 block text-zinc-500">
                  Pop transient feedback (errors, save confirmations) in the
                  bottom-right corner. Turn off for a quieter UI; events are
                  still written to the log when debugging is enabled.
                </span>
              </span>
            </label>
            <label class="mt-3 flex cursor-pointer items-start gap-3">
              <input
                v-model="followPlayback"
                type="checkbox"
                class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
              >
              <span class="flex-1">
                <span class="block font-medium text-zinc-200">Follow playback</span>
                <span class="mt-0.5 block text-zinc-500">
                  Scroll the timeline during playback so the playhead stays
                  centred in the viewport. Turn off if you want the view to
                  stay still while playing. Can also be toggled from the
                  transport bar.
                </span>
              </span>
            </label>
          </section>

          <!-- Paths -->
          <section>
            <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Default paths
            </h2>
            <div class="space-y-3">
              <div>
                <div class="mb-1 font-medium text-zinc-200">
                  Project folder
                </div>
                <p class="mb-1.5 text-zinc-500">
                  Used by Save, Save As, and Open for every project file.
                </p>
                <div class="flex items-center gap-2">
                  <code
                    class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
                    :title="defaultProjectDir"
                  >{{ defaultProjectDir || '(home)' }}</code>
                  <button
                    type="button"
                    class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    @click="chooseProjectDir"
                  >
                    Change…
                  </button>
                </div>
              </div>
              <div>
                <div class="mb-1 font-medium text-zinc-200">
                  Clip folder
                </div>
                <p class="mb-1.5 text-zinc-500">
                  Starting folder for "Add Track from File" and library
                  import. The most recent folder you browsed to is reused
                  for the rest of the session.
                </p>
                <div class="flex items-center gap-2">
                  <code
                    class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
                    :title="defaultClipDir"
                  >{{ defaultClipDir || '(home)' }}</code>
                  <button
                    type="button"
                    class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    @click="chooseClipDir"
                  >
                    Change…
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- Developer -->
          <section>
            <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Developer
            </h2>
            <label class="flex cursor-pointer items-start gap-3">
              <input
                v-model="debugEnabled"
                type="checkbox"
                class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
              >
              <span class="flex-1">
                <span class="block font-medium text-zinc-200">Enable Debugging</span>
                <span class="mt-0.5 block text-zinc-500">
                  Shows the Debug menu (Toggle Developer Tools, …) and writes
                  per-session diagnostic logs under
                  <code class="text-zinc-400">.logs/&lt;timestamp&gt;/</code>.
                  Takes effect the next time Silverdaw is launched.
                </span>
              </span>
            </label>

            <p
              v-if="debugEnabled !== initialDebug"
              class="mt-3 rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
            >
              Restart Silverdaw to apply changes.
            </p>
          </section>
        </div>

        <!-- Footer -->
        <div class="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-sky-600 px-4 py-1 text-xs font-medium text-zinc-100 enabled:hover:bg-sky-500 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hasChanges"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
