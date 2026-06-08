<script setup lang="ts">
defineProps<{
  defaultProjectDir: string
  defaultClipDir: string
  chooseProjectDir: () => Promise<void>
  chooseClipDir: () => Promise<void>
}>()

const autosaveEnabled = defineModel<boolean>('autosaveEnabled', { required: true })
const autosaveIntervalSeconds = defineModel<number>('autosaveIntervalSeconds', { required: true })
</script>

<template>
  <section class="space-y-6">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Default paths
      </h2>
      <div class="space-y-3">
        <div>
          <div class="mb-1 font-medium text-zinc-200">
            Project folder
          </div>
          <p class="mb-1.5 text-zinc-500">
            Used by Save, Save As, and Open for every project file.
          </p>
          <div class="flex items-center gap-2">
            <code
              class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
              :title="defaultProjectDir"
            >{{ defaultProjectDir || '(home)' }}</code>
            <button
              type="button"
              class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
              @click="chooseProjectDir"
            >
              Change…
            </button>
          </div>
        </div>
        <div>
          <div class="mb-1 font-medium text-zinc-200">
            Clip folder
          </div>
          <p class="mb-1.5 text-zinc-500">
            Starting folder for "Add Track from File" and library
            import. The most recent folder you browsed to is reused
            for the rest of the session.
          </p>
          <div class="flex items-center gap-2">
            <code
              class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
              :title="defaultClipDir"
            >{{ defaultClipDir || '(home)' }}</code>
            <button
              type="button"
              class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
              @click="chooseClipDir"
            >
              Change…
            </button>
          </div>
        </div>
      </div>
    </div>

    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Autosave
      </h2>
      <label class="flex cursor-pointer items-start gap-3">
        <input
          v-model="autosaveEnabled"
          type="checkbox"
          class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
        >
        <span class="flex-1">
          <span class="block font-medium text-zinc-200">Auto-save dirty projects in the background</span>
          <span class="mt-0.5 block text-zinc-500">
            Periodically writes a recovery copy of any project with
            unsaved changes into
            <code class="text-zinc-400">%APPDATA%/Silverdaw/autosave/</code>.
            The next launch offers to restore anything left behind
            by a crash or unclean shutdown.
          </span>
        </span>
      </label>
      <div class="mt-3 flex items-center gap-2 pl-7">
        <label
          for="autosave-interval"
          class="text-zinc-400"
        >Tick interval</label>
        <input
          id="autosave-interval"
          v-model.number="autosaveIntervalSeconds"
          type="number"
          min="5"
          max="600"
          step="5"
          :disabled="!autosaveEnabled"
          class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-zinc-200 focus:border-sky-500 focus:outline-none disabled:opacity-40"
        >
        <span class="text-zinc-500">seconds (5..600)</span>
      </div>
    </div>
  </section>
</template>
