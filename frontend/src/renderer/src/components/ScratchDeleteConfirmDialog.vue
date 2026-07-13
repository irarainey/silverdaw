<script setup lang="ts">
defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (event: 'confirm'): void
  (event: 'cancel'): void
}>()
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-100"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-75"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="scratch-delete-title"
    >
      <div class="dialog-card w-[min(360px,90vw)]">
        <div class="dialog-header">
          <h3
            id="scratch-delete-title"
            class="dialog-title"
          >
            Delete Scratch Pattern?
          </h3>
        </div>
        <div class="dialog-body">
          <p class="text-xs text-zinc-400">
            This action cannot be undone from within the Scratch Editor.
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
            class="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700"
            @click="emit('confirm')"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
