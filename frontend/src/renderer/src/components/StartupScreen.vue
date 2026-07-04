<script setup lang="ts">
// Startup landing page with loading, ready, and bridge-failure modes.

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useTransportStore } from '@/stores/transportStore'
// 256 px renders crisply at 128 px on 2x DPI.
import logoUrl from '@resources/icons/256x256.png'
import { projectNameFromPath as projectName } from '@/lib/project/projectPath'

const props = defineProps<{
  open: boolean
  /** Recovery resolved and any cold-launch path has started. */
  startupFlowComplete: boolean
  /** Suppresses the recovery status while RecoveryDialog is visible. */
  recoveryOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'newProject'): void
  (e: 'openProject'): void
  (e: 'openRecent', filePath: string): void
  (e: 'removeRecent', filePath: string): void
}>()

const app = useAppStore()
const transport = useTransportStore()
const audioDevices = useAudioDeviceStore()

const MAX_STARTUP_RECENTS = 3
const recents = computed(() => app.recentProjects.slice(0, MAX_STARTUP_RECENTS))

// Initial-connect timeout swaps the screen to focused error mode.
const bridgeFailed = computed(() => transport.bridgeFailureMessage !== null)

function onClose(): void {
  // Same close path as the title-bar button.
  window.silverdaw.closeWindow()
}

// All startup gates resolved; phase dwell below still controls readiness. Uses the
// handshake (not the post-open PROJECT_STATE) so the picker appears while the audio
// device is still opening.
const allResolved = computed(
  () =>
    !bridgeFailed.value &&
    transport.handshakeReady &&
    props.startupFlowComplete &&
    !audioDevices.scanInProgress
)

const liveStatusText = computed(() => {
  if (bridgeFailed.value) return ''
  if (!transport.connected) return 'Waiting for the audio engine to start…'
  if (!transport.handshakeReady) return 'Connecting to the audio engine…'
  if (audioDevices.scanInProgress) return 'Scanning audio devices…'
  if (!props.startupFlowComplete && !props.recoveryOpen) {
    return 'Checking for recovered projects…'
  }
  return ''
})

// Minimum phase dwell keeps fast startup transitions readable.
const MIN_PHASE_MS = 500

// Queue phase changes so bursts remain readable.
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
    // Do not dwell on a blank terminal status.
    if (text === '') return
    const tail = phaseQueue.length > 0 ? phaseQueue[phaseQueue.length - 1] : statusText.value
    if (text === tail) return
    phaseQueue.push(text)
    phaseQueueLength.value = phaseQueue.length
    if (phaseTimer === null) showNextPhase()
  },
  { immediate: true }
)

// Ready only after all queued phases have completed their dwell.
const ready = computed(
  () => allResolved.value && phaseQueueLength.value === 0 && !phaseTimerActive.value
)

function newProject(): void {
  emit('newProject')
}

function openProject(): void {
  emit('openProject')
}

function openRecent(filePath: string): void {
  emit('openRecent', filePath)
}

function removeRecent(filePath: string): void {
  emit('removeRecent', filePath)
}

function quit(): void {
  // Same path as File > Exit.
  window.silverdaw.menuAction('file.exit')
}

// Focus the primary action for failure and ready states.
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
  // Preserve existing keyboard navigation inside the overlay.
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
      <!-- System-close button matching the title-bar affordance. -->
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
      <!-- Single boot surface until backend, device scan, and recovery resolve. -->
      <!-- Locked heights prevent 1-2 px spinner/text wobble between phases. -->
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
              v-for="(recent, idx) in recents"
              :key="recent.path"
              :class="[
                'group relative flex items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-800',
                idx === 0 ? '' : 'border-t border-zinc-800'
              ]"
            >
              <button
                type="button"
                data-borderless-button="true"
                class="flex min-w-0 flex-1 flex-col bg-transparent p-0 pr-7 text-left"
                :title="recent.path"
                @click="openRecent(recent.path)"
              >
                <span class="truncate text-zinc-100">{{ recent.name || projectName(recent.path) }}</span>
                <span class="truncate text-[11px] text-zinc-500">{{ recent.path }}</span>
              </button>
              <button
                type="button"
                data-borderless-button="true"
                class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-red-400 focus:opacity-100 focus:outline-none focus-visible:opacity-100 group-hover:opacity-100"
                :aria-label="`Remove ${recent.name || projectName(recent.path)} from recent projects`"
                title="Remove from recent projects"
                @click="removeRecent(recent.path)"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3"
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
            </li>
          </ul>
        </section>
      </div>
    </div>
  </Transition>
</template>
