<script setup lang="ts">
// Mid-session audio-engine recovery overlay.
//
// The audio engine runs as a separate process. If it crashes, hangs, or is
// killed by an OS sleep/resume fault, Electron's main supervisor respawns it
// and `engineRecovery` re-loads the user's project into the fresh engine.
// While that happens the app must not accept edits or transport commands —
// the engine is empty or mid-restore, so any action would race the recovery
// or hit a project that isn't there yet.
//
// This overlay is the visible + interactive gate for that window. It covers
// the whole viewport (blocking pointer input) and is paired with keyboard
// gating in `menuShortcuts.ts` + `App.vue` so accelerators are swallowed too.
// It only appears once the engine has been healthy at least once, so a
// cold-start failure stays on the StartupScreen path instead.
//
//   • recovering / restoring → indeterminate "reconnecting" state, no actions.
//   • unavailable            → terminal: Try Again (force another respawn) or
//                              Quit. Recovery exhausted its automatic budget.

import { computed, nextTick, ref, watch } from 'vue'
import { useTransportStore } from '@/stores/transportStore'
import { retryRecovery } from '@/lib/engineRecovery'

const transport = useTransportStore()

const phase = computed(() => transport.engineRecovery)
const visible = computed(() => phase.value !== 'ok')
const isUnavailable = computed(() => phase.value === 'unavailable')

function onTryAgain(): void {
  retryRecovery()
}

function onQuit(): void {
  // Same path as the title-bar × — main tears every window down. There is
  // no unsaved-changes prompt here: the engine is gone, so there is nothing
  // left to save through it.
  window.silverdaw.closeWindow()
}

// Keep keyboard focus trapped on the actionable button while the terminal
// state is shown, so Enter / Space land on Try Again rather than leaking to
// whatever was focused before the engine died.
const tryAgainEl = ref<HTMLButtonElement | null>(null)
watch(isUnavailable, async (now) => {
  if (!now) return
  await nextTick()
  tryAgainEl.value?.focus()
})
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-150"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="engine-recovery-title"
      :aria-busy="!isUnavailable"
    >
      <!-- ─── Reconnecting (recovering / restoring) ───────────────── -->
      <div
        v-if="!isUnavailable"
        class="flex w-[min(420px,90vw)] flex-col items-center gap-5 rounded-lg bg-zinc-900 px-8 py-8 text-center text-zinc-200 shadow-2xl"
      >
        <div
          class="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-100"
          aria-hidden="true"
        />
        <div>
          <h1
            id="engine-recovery-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Reconnecting to the audio engine…
          </h1>
          <p
            class="mt-2 text-xs leading-relaxed text-zinc-400"
            aria-live="polite"
          >
            Your project is being restored. This should only take a moment.
          </p>
        </div>
      </div>

      <!-- ─── Terminal failure (unavailable) ──────────────────────── -->
      <div
        v-else
        class="flex w-[min(460px,92vw)] flex-col items-center gap-5 rounded-lg border border-red-900/60 bg-zinc-900 px-8 py-7 text-center text-zinc-200 shadow-2xl"
      >
        <div>
          <h1
            id="engine-recovery-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            The audio engine stopped responding
          </h1>
          <p class="mt-2 text-xs leading-relaxed text-zinc-400">
            Silverdaw couldn't bring the audio engine back automatically. You
            can try again, or quit and reopen the app. Your most recent work was
            saved and will be offered for recovery next time.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:outline-none"
            @click="onQuit"
          >
            Quit Silverdaw
          </button>
          <button
            ref="tryAgainEl"
            type="button"
            class="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
            @click="onTryAgain"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
