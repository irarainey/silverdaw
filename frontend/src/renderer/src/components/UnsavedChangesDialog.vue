<script setup lang="ts">
// Modal shown when the user is about to discard unsaved work
// (File > New, File > Open, app close). Three outcomes:
//
//   - "Save"        — caller saves first, THEN proceeds.
//   - "Don't save"  — caller proceeds immediately, discarding changes.
//   - "Cancel"      — caller bails.
//
// The dialog itself is presentational. The caller passes the project
// name (shown in the prompt) and a callback per outcome; the modal
// only fires the matching callback, leaving the actual save / open /
// close orchestration in `App.vue` where the IPC context lives.

const props = defineProps<{
  open: boolean
  projectName: string
}>()
const emit = defineEmits<{
  (e: 'save'): void
  (e: 'discard'): void
  (e: 'cancel'): void
}>()

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

import { onMounted, onBeforeUnmount } from 'vue'

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-title"
    >
      <div
        class="flex w-[min(440px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl"
      >
        <div class="px-6 pt-5 pb-4">
          <h1
            id="unsaved-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Save changes to {{ projectName }}?
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            This project has unsaved changes. If you continue without saving,
            your changes will be lost.
          </p>
        </div>

        <div class="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-3">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none"
            @click="emit('discard')"
          >
            Don't save
          </button>
          <button
            type="button"
            class="rounded bg-sky-600 px-4 py-1.5 text-xs font-medium text-zinc-50 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
            autofocus
            @click="emit('save')"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
