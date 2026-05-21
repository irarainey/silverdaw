<script setup lang="ts">
// Unified startup landing page.
//
// Replaces the older two-overlay pattern (BridgeReadyOverlay during
// boot then StartScreenOverlay once the bridge was up). The boundary
// between "connecting" and "pick a project" used to cross-fade between
// two separate components with identical logos, which the user
// experienced as multiple flashing screens. This component is the
// single splash surface, with an internal status row that updates as
// the boot progresses:
//
//   1. Waiting for the backend to start.
//   2. Connecting to audio engine…
//   3. Scanning audio devices…
//   4. Checking for recovered projects…
//   5. (idle — buttons enabled)
//
// On terminal bridge failure the whole screen swaps to a focused
// error view with a single Quit action; project actions are hidden
// because they cannot recover the app.
//
// Visibility (from App.vue) only requires that the project is empty
// and the user hasn't dismissed the screen — it mounts BEFORE the
// bridge is up so there's no cross-fade between two splashes.
// RecoveryDialog stacks above this overlay via z-index.

import { computed, nextTick, ref, watch } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useTransportStore } from '@/stores/transportStore'
// 256-px source is large enough to render crisply at 128 px on 2x DPI
// while staying small enough to inline as a hashed-URL static asset.
import logoUrl from '@resources/icons/256x256.png'

const props = defineProps<{
  open: boolean
  /** True iff the startup recovery flow has finished (recovery dialog
   *  resolved + any cold-launch path has been kicked off). Project
   *  actions stay disabled until this is true so a click can't race
   *  the recovery / cold-launch hand-off. */
  startupFlowComplete: boolean
  /** True while RecoveryDialog is open on top of this screen. We use
   *  this only to suppress the "Checking for recovered projects…"
   *  status line — the dialog itself communicates the state. */
  recoveryOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'newProject'): void
  (e: 'openProject'): void
  (e: 'openRecent', filePath: string): void
}>()

const app = useAppStore()
const transport = useTransportStore()
const audioDevices = useAudioDeviceStore()

const recents = computed(() => app.recentProjects)

// True when the bridge initial-connect timer expired and the backend
// never showed up. The whole screen swaps to a focused error mode.
const bridgeFailed = computed(() => transport.bridgeFailureMessage !== null)

// "Ready" gating for the action buttons. `scanInProgress` is
// intentionally NOT included — opening a project doesn't need the
// full device list, and a slow / stuck scan shouldn't block the user.
const ready = computed(
  () => !bridgeFailed.value && transport.bridgeReady && props.startupFlowComplete
)

const statusText = computed(() => {
  if (bridgeFailed.value) return ''
  if (!transport.connected) return 'Waiting for the backend to start…'
  if (!transport.bridgeReady) return 'Connecting to audio engine…'
  if (audioDevices.scanInProgress) return 'Scanning audio devices…'
  if (!props.startupFlowComplete && !props.recoveryOpen) {
    return 'Checking for recovered projects…'
  }
  return ''
})

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

function newProject(): void {
  if (!ready.value) return
  emit('newProject')
}

function openProject(): void {
  if (!ready.value) return
  emit('openProject')
}

function openRecent(filePath: string): void {
  if (!ready.value) return
  emit('openRecent', filePath)
}

function quit(): void {
  // Same as File > Exit. The menu action funnels through main and
  // destroys every window.
  window.silverdaw.menuAction('file.exit')
}

// Focus management. On bridge failure we move focus to the Quit
// button so Enter / Space immediately quits. When the screen
// becomes "ready", focus the New Project button so the user can
// hit Enter to get going.
const quitButtonEl = ref<HTMLButtonElement | null>(null)
const newButtonEl = ref<HTMLButtonElement | null>(null)

watch(bridgeFailed, async (failed) => {
  if (!failed) return
  await nextTick()
  quitButtonEl.value?.focus()
})

watch(ready, async (now) => {
  if (!now) return
  await nextTick()
  // Only steal focus if nothing inside the overlay is focused yet
  // — preserves the user's keyboard nav if they had tabbed into the
  // recents list.
  const active = document.activeElement
  if (!active || active === document.body) {
    newButtonEl.value?.focus()
  }
})
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-150"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-center justify-center bg-zinc-900"
      role="dialog"
      aria-modal="false"
      aria-labelledby="startup-title"
      :aria-busy="!ready && !bridgeFailed"
    >
      <!-- ─── Bridge-failure mode ───────────────────────────────── -->
      <!-- Dominates the whole screen. Project actions are hidden
           because they cannot recover the app. -->
      <div
        v-if="bridgeFailed"
        class="flex w-[min(520px,92vw)] flex-col items-center gap-5 rounded-lg border border-red-900/60 bg-zinc-900 px-8 py-7 text-center text-zinc-200 shadow-2xl"
      >
        <img
          :src="logoUrl"
          alt=""
          aria-hidden="true"
          class="h-20 w-20 select-none opacity-60 grayscale"
          draggable="false"
        >
        <div>
          <h1
            id="startup-title"
            class="text-base font-semibold text-zinc-100"
          >
            Unable to start Silverdaw
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            {{ transport.bridgeFailureMessage }}
          </p>
        </div>
        <button
          ref="quitButtonEl"
          type="button"
          class="rounded bg-red-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-red-600 focus:ring-2 focus:ring-red-400 focus:outline-none"
          @click="quit"
        >
          Quit Silverdaw
        </button>
      </div>

      <!-- ─── Normal mode ──────────────────────────────────────── -->
      <div
        v-else
        class="flex w-[min(560px,92vw)] flex-col items-stretch gap-6 px-8 py-10"
      >
        <header class="flex flex-col items-center text-center">
          <img
            :src="logoUrl"
            alt=""
            aria-hidden="true"
            class="h-24 w-24 select-none"
            draggable="false"
          >
          <h1
            id="startup-title"
            class="mt-4 text-2xl font-semibold tracking-tight text-zinc-100"
          >
            Silverdaw
          </h1>
          <p class="mt-1 text-xs text-zinc-500">
            Start a new project or open an existing one.
          </p>

          <!-- Inline status row: visible only while something is still
               loading. The spinner + text are constrained to a fixed
               height so the layout doesn't jump when the row hides. -->
          <div
            class="mt-3 flex h-5 items-center gap-2 text-xs text-zinc-400"
            aria-live="polite"
          >
            <template v-if="statusText">
              <span
                class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200"
                aria-hidden="true"
              />
              <span>{{ statusText }}</span>
            </template>
          </div>
        </header>

        <div class="flex flex-col gap-2">
          <button
            ref="newButtonEl"
            type="button"
            class="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-600"
            :disabled="!ready"
            @click="newProject"
          >
            New Project
          </button>
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800"
            :disabled="!ready"
            @click="openProject"
          >
            Open Project…
          </button>
        </div>

        <section
          v-if="recents.length > 0"
          class="flex flex-col gap-2"
        >
          <div class="px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Recent Projects
          </div>
          <ul class="silverdaw-scroll max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/50">
            <li
              v-for="(path, idx) in recents"
              :key="path"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-800',
                idx === 0 ? '' : 'border-t border-zinc-800'
              ]"
            >
              <button
                type="button"
                data-borderless-button="true"
                class="flex min-w-0 flex-1 flex-col bg-transparent p-0 text-left disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!ready"
                :title="path"
                @click="openRecent(path)"
              >
                <span class="truncate text-zinc-100">{{ basename(path) }}</span>
                <span class="truncate text-[11px] text-zinc-500">{{ path }}</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </Transition>
</template>
