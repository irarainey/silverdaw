<script setup lang="ts">
import { ref } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'

const tagline = ref('A remix-first DAW')
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-900 text-zinc-100">
    <AppTitleBar />

    <main class="flex flex-1 flex-col items-center justify-center gap-3 select-none">
      <h1 class="text-5xl font-semibold tracking-tight">
        Jackdaw
      </h1>
      <p class="text-zinc-400">
        {{ tagline }}
      </p>
      <p class="mt-6 text-xs text-zinc-600">
        Scaffold ready - backend runs as a child process
      </p>
    </main>
  </div>
</template>
