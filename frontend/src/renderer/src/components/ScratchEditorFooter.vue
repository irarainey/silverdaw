<script setup lang="ts">
defineProps<{
  saving: boolean
  hasPattern: boolean
}>()

const emit = defineEmits<{
  (event: 'cancel'): void
  (event: 'save'): void
}>()
</script>

<template>
  <footer class="dialog-footer justify-end gap-2">
    <button
      type="button"
      class="dialog-btn-cancel"
      :disabled="saving"
      @click="emit('cancel')"
    >
      Cancel
    </button>
    <button
      type="button"
      class="dialog-btn-primary"
      :disabled="!hasPattern || saving"
      @click="emit('save')"
    >
      Save
    </button>
  </footer>
</template>
