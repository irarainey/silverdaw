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
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-title"
    >
      <div class="dialog-card w-[min(440px,92vw)]">
        <div class="dialog-header">
          <h1
            id="unsaved-title"
            class="dialog-title"
          >
            Save changes to {{ projectName }}?
          </h1>
        </div>
        <div class="dialog-body">
          <p class="text-zinc-400">
            This project has unsaved changes. If you continue without saving,
            your changes will be lost.
          </p>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="emit('discard')"
          >
            Don't Save
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
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
