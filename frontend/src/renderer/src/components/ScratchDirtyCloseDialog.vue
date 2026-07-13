<script setup lang="ts">
import type { ScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'

defineProps<{
  persistence: ScratchPatternPersistence
}>()

const emit = defineEmits<{
  (event: 'save'): void
  (event: 'discard'): void
  (event: 'cancel'): void
}>()
</script>

<template>
  <div
    class="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="scratch-dirty-close-title"
  >
    <div class="dialog-card w-[min(400px,90vw)]">
      <div class="dialog-header">
        <h3
          id="scratch-dirty-close-title"
          class="dialog-title"
        >
          Unsaved Scratch Pattern
        </h3>
      </div>
      <div class="dialog-body">
        <p class="text-xs text-zinc-400">
          You have unsaved changes to your scratch pattern.
          Would you like to save before closing?
        </p>
        <p
          v-if="persistence.saveError.value"
          class="mt-2 text-xs text-red-400"
        >
          {{ persistence.saveError.value }}
        </p>
        <p
          v-if="persistence.isCloseSavePending.value"
          class="mt-2 text-xs text-zinc-500"
        >
          Saving…
        </p>
      </div>
      <div class="dialog-footer">
        <button
          type="button"
          class="dialog-btn-cancel"
          :disabled="persistence.isCloseSavePending.value"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="dialog-btn-cancel"
          :disabled="persistence.isCloseSavePending.value"
          @click="emit('discard')"
        >
          Don't Save
        </button>
        <button
          type="button"
          class="dialog-btn-primary"
          autofocus
          :disabled="persistence.isCloseSavePending.value"
          @click="emit('save')"
        >
          {{ persistence.saveError.value ? 'Retry' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>
