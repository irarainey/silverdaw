<script setup lang="ts">
// Full-screen blocking overlay shown while the renderer is waiting for
// the JUCE backend bridge to come up and deliver its first
// `PROJECT_STATE` snapshot. The renderer's project model is a mirror of
// the backend's `ValueTree`, so until the snapshot has arrived any user
// action (Add Track, drop a clip, click play) would race the reconcile
// pass — at best a wasted command, at worst a stale-state divergence.
//
// Visibility is driven entirely by `transportStore.bridgeReady`:
//
//   - false from process start until the first PROJECT_STATE arrives
//     (and any later disconnect / reconnect cycle)
//   - true once the bridge is up AND the snapshot has been applied
//
// Implementation is a fixed-position layer with `pointer-events: auto`
// so it swallows clicks; a non-zero z-index keeps it above PixiJS and
// any future modals. The transition fade-out is short to avoid feeling
// laggy on a healthy local connection.

import { useTransportStore } from '@/stores/transportStore'
// 256-px source is large enough to render crisply at 128 px on 2x DPI
// while staying small enough to inline as a hashed-URL static asset.
import logoUrl from '@resources/icons/256x256.png'

const transport = useTransportStore()
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-100"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-200"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="!transport.bridgeReady"
      class="fixed inset-0 z-[1000] flex items-center justify-center bg-zinc-950/85 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div class="flex flex-col items-center gap-6 text-zinc-200">
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
