<script setup lang="ts">
import type { ExportFormat } from '@/lib/export/useExportMixdownForm'

type ExportSampleRate = 44100 | 48000
type ExportBitDepth = 16 | 24 | 32
type ExportBitrate = 128 | 192 | 320

const format = defineModel<ExportFormat>('format', { required: true })
const sampleRate = defineModel<ExportSampleRate>('sampleRate', { required: true })
const bitrate = defineModel<ExportBitrate>('bitrate', { required: true })
const bitDepth = defineModel<ExportBitDepth>('bitDepth', { required: true })
const dither = defineModel<boolean>('dither', { required: true })

defineProps<Readonly<{
  effectiveProjectRate: ExportSampleRate
  availableBitDepths: readonly ExportBitDepth[]
  ditherApplies: boolean
}>>()
</script>

<template>
  <section class="mb-5 grid grid-cols-3 gap-3">
    <div>
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Format
      </label>
      <select
        v-model="format"
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
      >
        <option value="wav">
          WAV (PCM / float)
        </option>
        <option value="flac">
          FLAC (lossless)
        </option>
        <option value="aiff">
          AIFF (lossless)
        </option>
        <option value="mp3">
          MP3 (lossy, 16-bit)
        </option>
      </select>
    </div>
    <div>
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Sample rate
      </label>
      <select
        v-model.number="sampleRate"
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
      >
        <option :value="44100">
          44.1 kHz
        </option>
        <option :value="48000">
          48 kHz
        </option>
      </select>
      <p class="mt-1 text-[10px] text-zinc-500">
        Project rate: {{ (effectiveProjectRate / 1000).toFixed(1) }} kHz
      </p>
    </div>
    <div v-if="format === 'mp3'">
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Bitrate
      </label>
      <select
        v-model.number="bitrate"
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
      >
        <option
          v-for="kbps in [128, 192, 320] as const"
          :key="kbps"
          :value="kbps"
        >
          {{ kbps }} kbps
        </option>
      </select>
    </div>
    <div v-else>
      <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
        Bit depth
      </label>
      <select
        v-model.number="bitDepth"
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
      >
        <option
          v-for="bd in availableBitDepths"
          :key="bd"
          :value="bd"
        >
          {{ bd }}-bit{{ bd === 32 && format === 'wav' ? ' float' : '' }}
        </option>
      </select>
      <label
        v-if="ditherApplies"
        class="mt-1 flex cursor-pointer items-center gap-1.5"
        title="TPDF dither randomises the quantisation error to remove harmonic distortion at 16-bit. Recommended ON."
      >
        <input
          v-model="dither"
          type="checkbox"
          class="accent-cyan-500"
        >
        <span class="text-[10px] text-zinc-400">Dither</span>
      </label>
    </div>
  </section>
</template>
