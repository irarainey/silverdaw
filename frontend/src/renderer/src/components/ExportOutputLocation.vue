<script setup lang="ts">
const outputPath = defineModel<string>('outputPath', { required: true })

defineProps<Readonly<{
  onBrowseClick: () => void | Promise<void>
}>>()
</script>

<template>
  <section class="mb-5">
    <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
      Output file
    </label>
    <div class="flex gap-2">
      <input
        v-model="outputPath"
        type="text"
        spellcheck="false"
        class="flex-1 min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500"
      >
      <button
        type="button"
        class="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700"
        @click="onBrowseClick"
      >
        Browse…
      </button>
    </div>
  </section>
</template>
