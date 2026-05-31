<script setup lang="ts">
// Unified startup landing page.
//
// Two distinct visual states, never on screen at the same time:
//
//   1. **Loading state** — centred logo + spinner + the current
//      boot phase ("Waiting for the backend to start" → "Connecting
//      to audio engine" → "Scanning audio devices" → "Checking for
//      recovered projects"). No buttons. This continues the inline
//      splash inside `index.html`; they share the same logo crop and
//      backdrop so the hand-off is seamless.
//
//   2. **Ready state** — the project picker: logo + title + New
//      Project / Open Project… / Recent Projects. Only mounts once
//      the backend, the device scan, and the recovery flow have all
//      resolved, so the buttons never render disabled. The user
//      knows the app is ready the moment they see them.
//
// On terminal bridge failure the whole screen swaps to a focused
// error view with a single Quit action; the loading + ready surfaces
// are both hidden because they cannot recover the app.
//
// Visibility (from App.vue) only requires that the project is empty
// and the user hasn't dismissed the screen — it mounts BEFORE the
// bridge is up so there's no cross-fade between two splashes.
// RecoveryDialog stacks above this overlay via z-index.

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
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

const MAX_STARTUP_RECENTS = 3
const recents = computed(() => app.recentProjects.slice(0, MAX_STARTUP_RECENTS))

// True when the bridge initial-connect timer expired and the backend
// never showed up. The whole screen swaps to a focused error mode.
const bridgeFailed = computed(() => transport.bridgeFailureMessage !== null)

function onClose(): void {
  // Quit the entire app — same path as the title-bar × button.
  // Goes through main's `window:close` IPC, which fans out an
  // `app.requestClose` menu action; App.vue routes it through the
  // unsaved-changes guard (a no-op on the startup screen, since by
  // definition no project is loaded) and then exits cleanly.
  window.silverdaw.closeWindow()
}

// "All systems resolved" — every gate is green and the loading
// screen could exit. We deliberately wait for the async device
// scan AND a stable-display window (below) before treating this as
// truly ready.
const allResolved = computed(
  () =>
    !bridgeFailed.value &&
    transport.bridgeReady &&
    props.startupFlowComplete &&
    !audioDevices.scanInProgress
)

const liveStatusText = computed(() => {
  if (bridgeFailed.value) return ''
  if (!transport.connected) return 'Waiting for the audio engine to start…'
  if (!transport.bridgeReady) return 'Connecting to the audio engine…'
  if (audioDevices.scanInProgress) return 'Scanning audio devices…'
  if (!props.startupFlowComplete && !props.recoveryOpen) {
    return 'Checking for recovered projects…'
  }
  return ''
})

// Minimum time each phase must remain on screen before the next is
// allowed to overwrite it. Without this, on a fast machine the boot
// resolves in <100 ms and the user sees only "Waiting…" before the
// picker appears — they never get to see what actually happened.
const MIN_PHASE_MS = 500

// Pump that displays each distinct phase for at least MIN_PHASE_MS,
// queueing successive changes so a burst of phase transitions plays
// out as a readable sequence rather than collapsing to the latest.
const statusText = ref('')
const phaseQueue: string[] = []
const phaseQueueLength = ref(0)
const phaseTimerActive = ref(false)
let phaseTimer: ReturnType<typeof setTimeout> | null = null

function showNextPhase(): void {
  const next = phaseQueue.shift()
  phaseQueueLength.value = phaseQueue.length
  if (next === undefined) {
    phaseTimer = null
    phaseTimerActive.value = false
    return
  }
  statusText.value = next
  phaseTimerActive.value = true
  phaseTimer = setTimeout(showNextPhase, MIN_PHASE_MS)
}

watch(
  liveStatusText,
  (text) => {
    // Skip the terminal empty status — once everything has resolved
    // we want to switch to the picker as soon as the last real phase
    // has had its display dwell, not hold an extra MIN_PHASE_MS on
    // a blank message.
    if (text === '') return
    const tail = phaseQueue.length > 0 ? phaseQueue[phaseQueue.length - 1] : statusText.value
    if (text === tail) return
    phaseQueue.push(text)
    phaseQueueLength.value = phaseQueue.length
    if (phaseTimer === null) showNextPhase()
  },
  { immediate: true }
)

// "Ready" = all gates resolved AND the phase pump has finished
// showing every queued message for its minimum dwell.
const ready = computed(
  () => allResolved.value && phaseQueueLength.value === 0 && !phaseTimerActive.value
)

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

function newProject(): void {
  emit('newProject')
}

function openProject(): void {
  emit('openProject')
}

function openRecent(filePath: string): void {
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

onBeforeUnmount(() => {
  if (phaseTimer !== null) {
    clearTimeout(phaseTimer)
    phaseTimer = null
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
      <!-- System-close button. Quits the app entirely (same path as
           the title bar's × — goes through the unsaved-changes guard
           in App.vue, but the startup screen by definition only
           shows when the project is empty, so the guard is a no-op).
           Matches the title-bar close in size, icon and hover
           treatment so the user gets the same affordance they'd
           expect on the main window. Top-right of the viewport. -->
      <button
        type="button"
        data-borderless-button="true"
        class="absolute right-0 top-0 flex h-9 w-11 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white focus:outline-none"
        aria-label="Close Silverdaw"
        title="Close"
        @click="onClose"
      >
        <svg
          viewBox="0 0 16 16"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path
            d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>

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

      <!-- ─── Loading mode ──────────────────────────────────────── -->
      <!-- Single boot surface: logo + spinner + the current loading
           phase. No buttons here — the project picker only appears
           once the backend, device scan and recovery flow have all
           resolved. Matches the inline splash in `index.html` so the
           hand-off between the static HTML splash and this Vue
           component is invisible. -->
      <!-- Every child has a locked height and the column has a fixed
           total height so flex centring is byte-identical regardless
           of the text content. Without this lockdown, font-metrics
           reflow + the spinner's compositor layer can wobble the
           text vertically by 1-2 px between status changes. -->
      <div
        v-else-if="!ready"
        class="flex h-[228px] flex-col items-center justify-between text-zinc-200"
      >
        <img
          :src="logoUrl"
          alt=""
          aria-hidden="true"
          class="h-32 w-32 shrink-0 select-none"
          draggable="false"
        >
        <div
          class="h-8 w-8 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-100"
          aria-hidden="true"
        />
        <p
          id="startup-title"
          class="m-0 flex h-5 shrink-0 items-center whitespace-nowrap text-[13px] font-medium leading-[20px]"
          aria-live="polite"
        >
          {{ statusText || 'Loading Silverdaw…' }}
        </p>
      </div>

      <!-- ─── Ready mode: project picker ────────────────────────── -->
      <!-- Only mounted once everything is ready, so the buttons never
           render in a disabled state. Closing happens by picking an
           action (or the user opens a project from elsewhere). -->
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
        </header>

        <div class="flex flex-col gap-2">
          <button
            ref="newButtonEl"
            type="button"
            class="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
            @click="newProject"
          >
            New Project
          </button>
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none"
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
          <ul class="rounded border border-zinc-800 bg-zinc-900/50">
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
                class="flex min-w-0 flex-1 flex-col bg-transparent p-0 text-left"
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
