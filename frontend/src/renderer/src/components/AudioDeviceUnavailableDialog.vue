<script setup lang="ts">
// "Audio device unavailable" warning dialog. Shown when a loaded
// project's saved audio-output preference does not match any device
// currently exposed by the OS. Purely informational: the live
// `juce::AudioDeviceManager` has already opened the system default
// (or the user-scope `preferences.json` fallback). The project's
// stored preference is left intact so the project remains portable
// to a machine that does have the device.

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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="audio-unavailable-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(480px,92vw)] flex-col overflow-hidden rounded-lg border border-amber-700 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
        @keydown="onKeydown"
      >
        <div class="border-b border-amber-700 bg-amber-700/10 px-6 py-4">
          <h1
            id="audio-unavailable-title"
            class="text-base font-semibold tracking-tight text-amber-200"
          >
            Saved audio device not available
          </h1>
        </div>

        <div class="flex flex-col gap-2 px-6 py-5 text-sm text-zinc-300">
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

        <div class="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-sky-600 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-sky-500 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="onAcknowledge"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
