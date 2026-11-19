<script setup lang="ts">
import { useId } from 'vue'
import { exportBitrates, type ExportBitDepth, type ExportFormat } from '@shared/bridge-protocol'

type ExportSampleRate = 44100 | 48000
type ExportBitrate = typeof exportBitrates[number]
const id = useId()

const format = defineModel<ExportFormat>('format', { required: true })
const sampleRate = defineModel<ExportSampleRate>('sampleRate', { required: true })
const bitrate = defineModel<ExportBitrate>('bitrate', { required: true })
const bitDepth = defineModel<ExportBitDepth>('bitDepth', { required: true })
const dither = defineModel<boolean>('dither')

defineProps<Readonly<{
  effectiveProjectRate?: ExportSampleRate
  availableBitDepths: readonly ExportBitDepth[]
  ditherApplies?: boolean
}>>()
</script>

<template>
  <section
    class="grid gap-3"
    :class="$slots.default ? 'grid-cols-[repeat(3,minmax(0,1fr))_5rem]' : 'mb-5 grid-cols-3'"
  >
    <div>
      <label
        :for="`${id}-format`"
        class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
      >
        Format
      </label>
      <select
        :id="`${id}-format`"
        v-model="format"
        class="app-select w-full"
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
      <label
        :for="`${id}-rate`"
        class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
      >
        Sample rate
      </label>
      <select
        :id="`${id}-rate`"
        v-model.number="sampleRate"
        class="app-select w-full"
      >
        <option :value="44100">
          44.1 kHz
        </option>
        <option :value="48000">
          48 kHz
        </option>
      </select>
      <p
        v-if="effectiveProjectRate"
        class="mt-1 text-[10px] text-zinc-500"
      >
        Project rate: {{ (effectiveProjectRate / 1000).toFixed(1) }} kHz
      </p>
    </div>
    <div v-if="format === 'mp3'">
      <label
        :for="`${id}-bitrate`"
        class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
      >
        Bitrate
      </label>
      <select
        :id="`${id}-bitrate`"
        v-model.number="bitrate"
        class="app-select w-full"
      >
        <option
          v-for="kbps in exportBitrates"
          :key="kbps"
          :value="kbps"
        >
          {{ kbps }} kbps
        </option>
      </select>
    </div>
    <div v-else>
      <label
        :for="`${id}-depth`"
        class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
      >
        Bit depth
      </label>
      <select
        :id="`${id}-depth`"
        v-model.number="bitDepth"
        class="app-select w-full"
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
        title="        TPDF dither randomises the quantisation error to remove harmonic distortion at 16-bit. Recommended on."
      >
        <input
          v-model="dither"
          type="checkbox"
          class="accent-sky-500"
        >
        <span class="text-[10px] text-zinc-400">Dither</span>
      </label>
    </div>
    <slot />
  </section>
</template>
