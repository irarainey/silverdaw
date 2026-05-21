<script setup lang="ts">
// Empty-project start screen. Shown by App.vue when:
//   - the startup coordinator has finished (no recovery dialog pending),
//   - the user hasn't already dismissed the screen this session,
//   - the project is empty (no tracks, no library items, no path),
//   - and the bridge is ready.
//
// Acts as a friendly landing page in place of the empty timeline:
// "New Project", "Open Project…", and the Recent Projects MRU as
// clickable rows. The logo + dark backdrop mirror the loading screen
// (`BridgeReadyOverlay`) so the cross-fade between "connecting to
// audio engine…" and "pick a project" reads as one continuous boot
// sequence rather than two unrelated screens.
//
// The buttons are bound to a `bridgeReady` prop and visibly disabled
// when it's false. App.vue's `startScreenVisible` computed already
// gates the whole overlay on `transport.bridgeReady`, so in normal
// flow this prop is always `true` when the screen is on screen — the
// disable is defence-in-depth in case some future code path (e.g. an
// edge in the recovery → startup-complete handoff) re-mounts the
// overlay against a bridge that has dropped underneath it.

import { computed } from 'vue'
import { useAppStore } from '@/stores/appStore'
// 256-px source is the same asset the loading overlay uses so the two
// screens share a brand mark across the cross-fade.
import logoUrl from '@resources/icons/256x256.png'

const props = defineProps<{
  open: boolean
  /** True iff the bridge has delivered its initial PROJECT_STATE.
   *  When false, every action on this screen is disabled. */
  bridgeReady: boolean
}>()
const emit = defineEmits<{
  (e: 'newProject'): void
  (e: 'openProject'): void
  (e: 'openRecent', filePath: string): void
}>()

const app = useAppStore()

// Render the full MRU here (the File menu only surfaces the top 5).
const recents = computed(() => app.recentProjects)

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

function newProject(): void {
  if (!props.bridgeReady) return
  emit('newProject')
}

function openProject(): void {
  if (!props.bridgeReady) return
  emit('openProject')
}

function openRecent(filePath: string): void {
  if (!props.bridgeReady) return
  emit('openRecent', filePath)
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-150"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900"
      role="dialog"
      aria-modal="false"
      aria-labelledby="start-screen-title"
    >
      <div class="flex w-[min(560px,92vw)] flex-col items-stretch gap-6 px-8 py-10">
        <header class="flex flex-col items-center text-center">
          <!-- Same 128-px logo crop the loading overlay uses, so the
               handoff between "Connecting to audio engine…" and the
               start screen feels like a single continuous boot. -->
          <img
            :src="logoUrl"
            alt=""
            aria-hidden="true"
            class="h-24 w-24 select-none"
            draggable="false"
          >
          <h1
            id="start-screen-title"
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
            type="button"
            class="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-600"
            :disabled="!bridgeReady"
            @click="newProject"
          >
            New Project
          </button>
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800"
            :disabled="!bridgeReady"
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
          <ul class="max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/50">
            <li
              v-for="(path, idx) in recents"
              :key="path"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-800',
                idx === 0 ? '' : 'border-t border-zinc-800'
              ]"
            >
              <!-- `data-borderless-button` opts out of the App.vue
                   global `button` border + focus-ring styles so the
                   row reads as a plain text link rather than a framed
                   button. -->
              <button
                type="button"
                data-borderless-button="true"
                class="flex min-w-0 flex-1 flex-col bg-transparent p-0 text-left disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!bridgeReady"
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
