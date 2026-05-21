<script setup lang="ts">
// Full-screen blocking overlay shown while the renderer is waiting for
// the JUCE backend bridge to come up and deliver its first
// `PROJECT_STATE` snapshot. The renderer's project model is a mirror of
// the backend's `ValueTree`, so until the snapshot has arrived any user
// action (Add Track, drop a clip, click play) would race the reconcile
// pass — at best a wasted command, at worst a stale-state divergence.
//
// Visibility is driven by `transportStore.bridgeReady`:
//
//   - false from process start until the first PROJECT_STATE arrives
//     (and any later disconnect / reconnect cycle)
//   - true once the bridge is up AND the snapshot has been applied
//
// We also enforce a **minimum dwell time** so the overlay always
// renders for at least `MIN_DWELL_MS` after mount, even when the
// backend is warm and PROJECT_STATE arrives in <100 ms. Without the
// dwell the cross-fade into the Start Screen happens so fast that the
// user perceives the boot as instantaneous and never sees the spinner
// confirming the audio engine is actually connecting.
//
// If `bridgeFailureMessage` is also set (initial-connection timeout
// fired in `App.vue`), the overlay flips from its spinner state into
// an error state with a "Quit" button — the only useful action when
// the backend never came up.
//
// Implementation is a fixed-position layer with `pointer-events: auto`
// so it swallows clicks; a non-zero z-index keeps it above PixiJS and
// any future modals. The transition fade-out is short to avoid feeling
// laggy on a healthy local connection.

import { computed, onMounted, ref } from 'vue'
import { useTransportStore } from '@/stores/transportStore'
// 256-px source is large enough to render crisply at 128 px on 2x DPI
// while staying small enough to inline as a hashed-URL static asset.
import logoUrl from '@resources/icons/256x256.png'

const transport = useTransportStore()

/** Minimum time (ms) the overlay stays on screen from first mount.
 *  Tuned to "you can read the status line at least once" — short
 *  enough not to feel sluggish on a fast warm backend, long enough
 *  to make the cross-fade legible. */
const MIN_DWELL_MS = 600

const dwellElapsed = ref(false)

onMounted(() => {
  setTimeout(() => {
    dwellElapsed.value = true
  }, MIN_DWELL_MS)
})

/** Effective "ready" signal that gates the overlay. Stays false until
 *  BOTH the bridge has delivered its first PROJECT_STATE AND the
 *  minimum dwell window has elapsed. */
const displayReady = computed(() => transport.bridgeReady && dwellElapsed.value)

function quit(): void {
  // Reuses the same File > Exit handler in main: destroys every window
  // and calls `app.exit(0)`. We funnel through the menu IPC rather than
  // adding a dedicated `app:quit` channel because there's only one
  // canonical way to quit the app from the renderer.
  window.silverdaw.menuAction('file.exit')
}
</script>

<template>
  <Transition
    appear
    enter-active-class="transition-opacity duration-100"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-200"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="!displayReady"
      class="fixed inset-0 z-1000 flex items-center justify-center bg-zinc-900"
      role="status"
      aria-live="polite"
      :aria-busy="transport.bridgeFailureMessage === null"
    >
      <!-- Failure state: bridge timed out / failed terminally -->
      <div
        v-if="transport.bridgeFailureMessage"
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
          <h1 class="text-base font-semibold text-zinc-100">
            Unable to start Silverdaw
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            {{ transport.bridgeFailureMessage }}
          </p>
        </div>
        <button
          type="button"
          class="rounded bg-red-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-red-600 focus:ring-2 focus:ring-red-400 focus:outline-none"
          @click="quit"
        >
          Quit Silverdaw
        </button>
      </div>

      <!-- Loading state: still waiting for the initial PROJECT_STATE -->
      <div
        v-else
        class="flex flex-col items-center gap-6 text-zinc-200"
      >
        <!-- Brand mark, centred above the status text. -->
        <img
          :src="logoUrl"
          alt=""
          aria-hidden="true"
          class="h-32 w-32 select-none"
          draggable="false"
        >
        <!-- Simple CSS spinner: a 32px ring with a brighter top arc -->
        <div
          class="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-100"
          aria-hidden="true"
        />
        <div class="text-center">
          <p class="text-sm font-medium">
            Connecting to audio engine…
          </p>
          <p class="mt-1 text-xs text-zinc-400">
            {{ transport.connected ? 'Loading project…' : 'Waiting for the backend to start.' }}
          </p>
        </div>
      </div>
    </div>
  </Transition>
</template>
