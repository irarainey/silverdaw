<script setup lang="ts">
import { onMounted } from 'vue'
import { useStemModelManager } from '@/lib/stems/useStemModelManager'

const useGpu = defineModel<boolean>('useGpuForStems', { required: true })

const { gpu, modelInfo, busy, downloadPercent, error, installed, refresh, download, cancelDownload, locate } =
  useStemModelManager()

onMounted(refresh)
</script>

<template>
  <section class="space-y-6">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Hardware acceleration
      </h2>
      <label
        class="flex items-start gap-3"
        :class="gpu.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'"
      >
        <input
          v-model="useGpu"
          type="checkbox"
          :disabled="!gpu.available"
          class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500 disabled:cursor-not-allowed"
        >
        <span class="flex-1">
          <span class="block font-medium text-zinc-200">Use GPU acceleration for stem separation (experimental)</span>
          <span class="mt-0.5 block text-zinc-500">
            <template v-if="gpu.available">
              Detected GPU:
              <span class="text-zinc-400">{{ gpu.name ?? 'compatible adapter' }}</span>.
              Off by default. Separation runs on the CPU unless you enable this.
              The same model is used either way, so there is no separate GPU model
              to download.
              <span class="mt-1 block text-amber-400/90">
                Experimental: on some GPUs or drivers this can briefly reset the
                display. If separation fails or the screen misbehaves, turn this
                off and use the CPU.
              </span>
            </template>
            <template v-else>
              No compatible GPU was detected, so separation runs on the CPU.
            </template>
          </span>
        </span>
      </label>
    </div>

    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Separation model
      </h2>
      <p class="mb-1.5 text-zinc-500">
        The stem-separation model (~1.2&nbsp;GB) is downloaded once and reused.
        If you already have a copy, point Silverdaw at the folder instead of
        downloading it again.
      </p>

      <div class="mb-2 flex items-center gap-2">
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
          :class="
            installed
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-amber-500/15 text-amber-300'
          "
        >{{ installed ? (modelInfo?.located ? 'Located' : 'Installed') : 'Not downloaded' }}</span>
      </div>

      <div class="mb-3">
        <div class="mb-1 font-medium text-zinc-200">
          Model location
        </div>
        <code
          class="block truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
          :title="modelInfo?.directory"
        >{{ modelInfo?.directory || '…' }}</code>
      </div>

      <div
        v-if="busy && downloadPercent !== null"
        class="mb-3"
      >
        <div class="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
          <span>Downloading model…</span>
          <span>{{ downloadPercent }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded bg-zinc-800">
          <div
            class="h-full bg-sky-500 transition-[width] duration-200"
            :style="{ width: `${downloadPercent}%` }"
          />
        </div>
      </div>

      <p
        v-if="error"
        class="mb-2 text-[11px] text-red-400"
      >
        {{ error }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="busy && downloadPercent !== null"
          type="button"
          class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
          @click="cancelDownload"
        >
          Cancel download
        </button>
        <template v-else>
          <button
            v-if="!installed"
            type="button"
            :disabled="busy"
            class="shrink-0 rounded bg-sky-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none disabled:opacity-40"
            @click="download"
          >
            Download…
          </button>
          <button
            type="button"
            :disabled="busy"
            class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:opacity-40"
            @click="locate"
          >
            Locate existing model…
          </button>
        </template>
      </div>
    </div>
  </section>
</template>
