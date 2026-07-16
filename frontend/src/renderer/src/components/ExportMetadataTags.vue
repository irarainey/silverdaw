<script setup lang="ts">
const title = defineModel<string>('title', { required: true })
const artist = defineModel<string>('artist', { required: true })
const album = defineModel<string>('album', { required: true })
const year = defineModel<string>('year', { required: true })
const genre = defineModel<string>('genre', { required: true })
const comment = defineModel<string>('comment', { required: true })
</script>

<template>
  <section class="mb-2 rounded border border-zinc-800 bg-zinc-950/60">
    <header
      class="flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500"
    >
      <span>Tags (optional)</span>
    </header>
    <div class="grid grid-cols-2 gap-2 px-3 pb-3 text-xs">
      <label class="flex flex-col gap-0.5">
        <span class="text-zinc-500">Title</span>
        <input
          v-model="title"
          type="text"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-zinc-500">Artist</span>
        <input
          v-model="artist"
          type="text"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-zinc-500">Album</span>
        <input
          v-model="album"
          type="text"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-zinc-500">Year</span>
        <input
          v-model="year"
          type="text"
          inputmode="numeric"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-zinc-500">Genre</span>
        <input
          v-model="genre"
          type="text"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
      <label class="col-span-2 flex flex-col gap-0.5">
        <span class="text-zinc-500">Comment</span>
        <input
          v-model="comment"
          type="text"
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500"
        >
      </label>
    </div>
  </section>
</template>
