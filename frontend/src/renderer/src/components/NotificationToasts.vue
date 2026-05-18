<script setup lang="ts">
// Bottom-right toast stack. Reads from `notificationsStore` and renders
// one card per active notification, newest on top of the visible stack.
// Each card auto-dismisses on a timer set up by the store; clicking the
// X button dismisses early.
//
// Pinned to the viewport with `fixed` so it overlays everything (timeline,
// library panel, etc.) without affecting layout. Bottom-right keeps the
// stack clear of the title bar's window-controls overlay (min/max/close)
// on the top-right edge.

import { useNotificationsStore } from '@/stores/notificationsStore'

const notifications = useNotificationsStore()
</script>

<template>
  <div
    class="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-md flex-col-reverse gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    <transition-group name="toast">
      <div
        v-for="n in notifications.items"
        :key="n.id"
        class="pointer-events-auto flex items-start gap-3 rounded-lg border bg-zinc-950/95 px-4 py-3 shadow-lg backdrop-blur"
        :class="n.kind === 'error'
          ? 'border-red-500/60 text-red-100'
          : 'border-zinc-700 text-zinc-100'
        "
        role="status"
      >
        <!-- Coloured leading dot mirrors the kind so screen-reader users
                 also get a visual hint without an icon font dependency. -->
        <span
          class="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          :class="n.kind === 'error' ? 'bg-red-500' : 'bg-blue-500'"
          aria-hidden="true"
        />
        <span class="flex-1 wrap-break-word text-sm leading-snug">{{ n.message }}</span>
        <button
          type="button"
          class="-mt-0.5 -mr-1 ml-1 shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          title="Dismiss"
          @click="notifications.dismiss(n.id)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            class="h-4 w-4"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: transform 150ms ease-out, opacity 150ms ease-out;
}

.toast-enter-from,
.toast-leave-to {
  transform: translateY(12px);
  opacity: 0;
}
</style>
