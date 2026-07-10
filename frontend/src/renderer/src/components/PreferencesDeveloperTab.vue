<script setup lang="ts">
defineProps<{
  initialLoggingEnabled: boolean
  initialDevToolsEnabled: boolean
  initialLogDirectory: string
  chooseLogDir: () => Promise<void>
  openMidiMonitor: () => void
}>()

const loggingEnabled = defineModel<boolean>('loggingEnabled', { required: true })
const devToolsEnabled = defineModel<boolean>('devToolsEnabled', { required: true })
const logDirectory = defineModel<string>('logDirectory', { required: true })
</script>

<template>
  <section class="space-y-4">
    <label class="flex cursor-pointer items-start gap-3">
      <input
        v-model="loggingEnabled"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Write diagnostic logs</span>
        <span class="mt-0.5 block text-zinc-500">
          Writes main, renderer, and backend logs for each session.
          Takes effect the next time Silverdaw is launched.
        </span>
      </span>
    </label>

    <div class="space-y-1">
      <label class="block text-xs font-medium text-zinc-300">Log folder</label>
      <div class="flex gap-2">
        <input
          v-model="logDirectory"
          type="text"
          spellcheck="false"
          :disabled="!loggingEnabled"
          placeholder="Default Silverdaw logs folder"
          class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-500"
        >
        <button
          type="button"
          :disabled="!loggingEnabled"
          class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          @click="chooseLogDir"
        >
          Browse…
        </button>
      </div>
      <p class="text-[11px] text-zinc-500">
        Silverdaw creates a timestamped subfolder here for each
        session. By default this is a <span class="font-mono">Silverdaw\Logs</span>
        folder in your user folder.
      </p>
    </div>

    <label class="flex cursor-pointer items-start gap-3">
      <input
        v-model="devToolsEnabled"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">Show Developer Tools</span>
        <span class="mt-0.5 block text-zinc-500">
          Allows the Chromium DevTools window and its shortcuts in packaged
          builds. Enable only when diagnosing the app.
        </span>
      </span>
    </label>

    <div class="border-t border-zinc-800 pt-4">
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        MIDI diagnostics
      </h2>
      <p class="mb-3 text-zinc-500">
        Inspect the control codes and values sent by enabled MIDI input devices.
      </p>
      <button
        type="button"
        class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:outline-none"
        @click="openMidiMonitor"
      >
        Open MIDI Monitor…
      </button>
    </div>

    <p
      v-if="loggingEnabled !== initialLoggingEnabled || devToolsEnabled !== initialDevToolsEnabled || logDirectory !== initialLogDirectory"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
    >
      Restart Silverdaw to apply changes.
    </p>
  </section>
</template>
