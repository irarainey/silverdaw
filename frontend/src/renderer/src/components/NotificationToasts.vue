<script setup lang="ts">
// Top-right toast stack. Reads from `notificationsStore` and renders one
// card per active notification. Each card auto-dismisses on a timer set
// up by the store; clicking the X button dismisses early.
//
// Pinned to the viewport with `fixed` so it overlays everything (timeline,
// library panel, etc.) without affecting layout.

import { useNotificationsStore } from '@/stores/notificationsStore'

const notifications = useNotificationsStore()
</script>

<template>
  <div
    class="pointer-events-none fixed right-4 top-4 z-50 flex max-w-sm flex-col gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    <transition-group name="toast">
      <div
        v-for="n in notifications.items"
        :key="n.id"
        class="pointer-events-auto flex items-start gap-2 rounded border bg-zinc-950/95 px-3 py-2 shadow-lg backdrop-blur"
        :class="n.kind === 'error'
          ? 'border-red-500/60 text-red-100'
          : 'border-zinc-700 text-zinc-100'
        "
        role="status"
      >
        <!-- Coloured leading dot mirrors the kind so screen-reader users
                 also get a visual hint without an icon font dependency. -->
        <span
          class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
          :class="n.kind === 'error' ? 'bg-red-500' : 'bg-blue-500'"
          aria-hidden="true"
        />
        <span class="flex-1 wrap-break-word text-xs leading-snug">{{ n.message }}</span>
        <button
          type="button"
          class="ml-1 -mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
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
            class="h-3.5 w-3.5"
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
  transform: translateX(12px);
  opacity: 0;
}
</style>
