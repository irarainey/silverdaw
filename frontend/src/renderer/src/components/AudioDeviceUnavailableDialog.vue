<script setup lang="ts">
// "Audio device unavailable" warning, shown when a loaded project's saved
// output preference matches no current OS device. Informational only: the
// engine already opened the system default, and the stored preference is kept
// so the project stays portable to a machine that has the device.

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps<{
  open: boolean
  /** The device the project asked for (saved on the project file). */
  savedTypeName: string | null
  savedDeviceName: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const ui = useUiStore()
const dialogEl = ref<HTMLDivElement | null>(null)

function onAcknowledge(): void {
  emit('close')
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' || ev.key === 'Enter') {
    ev.preventDefault()
    onAcknowledge()
  }
}

watch(
  () => props.open,
  (now) => {
    ui.clipEditorOpen = now
    if (now) {
      void Promise.resolve().then(() => dialogEl.value?.focus())
    }
  }
)

onMounted(() => {
  if (props.open) ui.clipEditorOpen = true
})

onBeforeUnmount(() => {
  if (props.open) ui.clipEditorOpen = false
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
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="audio-unavailable-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(480px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="audio-unavailable-title"
            class="dialog-title"
          >
            Saved Audio Device Not Available
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-2 text-zinc-300">
          <p>
            This project asks for an audio output device that isn't
            available on this machine:
          </p>
          <p class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 font-mono text-xs">
            <span class="text-zinc-100">{{ savedDeviceName ?? '(unknown device)' }}</span>
            <span
              v-if="savedTypeName"
              class="text-zinc-500"
            > — {{ savedTypeName }}</span>
          </p>
          <p>
            Playback continues on your default audio device. The
            project's preferred device is unchanged, so it will be
            used again if you reopen the project on a machine that
            has it. To pick a different preferred device, open
            <span class="font-medium text-zinc-100">File ▸ Project
              Properties…</span> and Save your choice.
          </p>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-primary"
            @click="onAcknowledge"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
