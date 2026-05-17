<script setup lang="ts">
// Preferences dialog. Currently exposes a single option — "Enable
// Debugging" — that gates the Debug menu and the cross-layer file
// logger. Changes are persisted immediately to `preferences.json` but
// only take effect on the next launch (the startup snapshot is what the
// rest of the UI reads from); the dialog surfaces that contract
// explicitly so the user isn't confused when the Debug menu doesn't
// appear immediately after toggling.

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)
const debugEnabled = ref(false)
const initialDebug = ref(false)

async function loadCurrent(): Promise<void> {
  try {
    const v = await window.silverdaw.getDebugEnabled()
    debugEnabled.value = v
    initialDebug.value = v
  } catch {
    debugEnabled.value = false
    initialDebug.value = false
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
    if (!isOpen) return
    await loadCurrent()
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

function toggleDebug(value: boolean): void {
  debugEnabled.value = value
  // Persist immediately; the value only takes effect on next launch but
  // we don't want the user to forget to save — the dialog acts as a
  // settings panel rather than a transactional form.
  window.silverdaw.setDebugEnabled(value)
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(460px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="prefs-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Preferences
          </h1>
        </div>

        <!-- Body -->
        <div class="px-6 py-5 text-xs leading-relaxed">
          <section>
            <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Developer
            </h2>
            <label class="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                :checked="debugEnabled"
                @change="toggleDebug(($event.target as HTMLInputElement).checked)"
              >
              <span class="flex-1">
                <span class="block font-medium text-zinc-200">Enable Debugging</span>
                <span class="mt-0.5 block text-zinc-500">
                  Shows the Debug menu (Toggle Developer Tools, …) and writes
                  per-session diagnostic logs under
                  <code class="text-zinc-400">.logs/&lt;timestamp&gt;/</code>.
                  Takes effect the next time Silverdaw is launched.
                </span>
              </span>
            </label>
          </section>

          <p
            v-if="debugEnabled !== initialDebug"
            class="mt-4 rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
          >
            Restart Silverdaw to apply changes.
          </p>
        </div>

        <!-- Footer -->
        <div class="flex justify-end border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-700 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
