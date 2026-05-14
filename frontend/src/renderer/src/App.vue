<script setup lang="ts">
import { ref } from 'vue'

const tagline = ref('A remix-first DAW')
</script>

<template>
  <main class="flex h-screen flex-col items-center justify-center gap-3 select-none">
    <h1 class="text-5xl font-semibold tracking-tight">Jackdaw</h1>
    <p class="text-neutral-400">{{ tagline }}</p>
    <p class="mt-6 text-xs text-neutral-600">
      Scaffold ready · backend will start as a child process
    </p>
  </main>
</template>
