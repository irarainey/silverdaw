<script setup lang="ts">
defineProps<{
  initialLoggingEnabled: boolean
  initialDevToolsEnabled: boolean
  initialLogDirectory: string
  chooseLogDir: () => Promise<void>
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
          Shows the Debug menu and allows DevTools shortcuts in
          packaged builds. Enable only when diagnosing the app.
        </span>
      </span>
    </label>

    <p
      v-if="loggingEnabled !== initialLoggingEnabled || devToolsEnabled !== initialDevToolsEnabled || logDirectory !== initialLogDirectory"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
    >
      Restart Silverdaw to apply changes.
    </p>
  </section>
</template>
