<script setup lang="ts">
// In-app "About Silverdaw" dialog, opened from Help > About (main forwards
// `help.about`; the renderer toggles `open`). Shows the brand mark, runtime
// version, and the AGPL-3.0 + "Made with JUCE" legal notices.

import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import logoUrl from '@resources/icons/256x256.png'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface AppInfo {
  appVersion: string
  electron: string
  chromium: string
  node: string
}

const info = ref<AppInfo | null>(null)
const dialogEl = ref<HTMLDivElement | null>(null)

async function loadInfo(): Promise<void> {
  try {
    info.value = await window.silverdaw.getAppInfo()
  } catch {
    info.value = null
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      if (!info.value) await loadInfo()
      // Focus the dialog so the Escape handler picks up keys reliably.
      requestAnimationFrame(() => dialogEl.value?.focus())
    }
  },
  { immediate: true }
)

function openExternal(url: string): void {
  window.silverdaw.openExternal(url)
}
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
      aria-labelledby="about-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(420px,92vw)]"
      >
        <!-- Header: logo + title + version -->
        <div class="flex flex-col items-center gap-1 border-b border-zinc-800 px-6 pt-5 pb-4">
          <img
            :src="logoUrl"
            alt=""
            aria-hidden="true"
            class="h-14 w-14 select-none"
            draggable="false"
          >
          <h1
            id="about-title"
            class="dialog-title"
          >
            Silverdaw
          </h1>
          <p class="text-xs text-zinc-400">
            <span v-if="info">Version {{ info.appVersion }}</span>
            <span v-else>&nbsp;</span>
          </p>
        </div>

        <!-- Body: legal minimum -->
        <div class="px-6 py-4 text-xs leading-snug text-zinc-300">
          <p>Copyright © 2026 Ira Rainey.</p>
          <p class="mt-2">
            Licensed under the
            <button
              type="button"
              class="text-sky-400 underline-offset-2 hover:underline"
              @click="openExternal('https://www.gnu.org/licenses/agpl-3.0.html')"
            >
              GNU Affero GPL v3.0 or later
            </button>.
            This program comes with <strong>ABSOLUTELY NO WARRANTY</strong>.
            You are free to redistribute it under the terms of that licence.
          </p>
          <p class="mt-2">
            Audio engine made with <strong>JUCE</strong>.
          </p>
          <p class="mt-2">
            Support:
            <button
              type="button"
              class="text-sky-400 underline-offset-2 hover:underline"
              @click="openExternal('mailto:support@silverdaw.com')"
            >
              support@silverdaw.com
            </button>
          </p>
          <p class="mt-3 text-zinc-500">
            <button
              type="button"
              class="text-sky-400 underline-offset-2 hover:underline"
              @click="openExternal('https://www.silverdaw.com')"
            >
              Website
            </button>
            ·
            <button
              type="button"
              class="text-sky-400 underline-offset-2 hover:underline"
              @click="openExternal('https://github.com/irarainey/silverdaw')"
            >
              Source code
            </button>
            ·
            <button
              type="button"
              class="text-sky-400 underline-offset-2 hover:underline"
              @click="openExternal('https://github.com/irarainey/silverdaw/blob/main/THIRD_PARTY_LICENSES.md')"
            >
              Third-party licences
            </button>
          </p>
        </div>

        <!-- Footer -->
        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-primary"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
