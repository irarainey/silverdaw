<script setup lang="ts">
import type { LoudnessPreset } from '@/lib/export/useExportMixdownForm'

const loudnessPreset = defineModel<LoudnessPreset>('loudnessPreset', { required: true })
const customTargetText = defineModel<string>('customTargetText', { required: true })
const customCeilingText = defineModel<string>('customCeilingText', { required: true })

defineProps<Readonly<{
  loudnessAvailable: boolean
  customLoudnessActive: boolean
  customTargetValid: boolean
  customCeilingValid: boolean
}>>()
</script>

<template>
  <section
    class="mb-5"
    :title="loudnessAvailable ? '' : 'Loudness analysis requires 44.1 or 48 kHz output.'"
  >
    <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
      Loudness
    </label>
    <select
      v-model="loudnessPreset"
      :disabled="!loudnessAvailable"
      class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="off">
        None &ndash; export as-is
      </option>
      <option value="streaming-14">
        Streaming &minus;14 LUFS (Spotify, YouTube, SoundCloud, Tidal, Amazon)
      </option>
      <option value="apple-16">
        Apple Music &minus;16 LUFS
      </option>
      <option value="broadcast-23">
        EBU R128 / AES Broadcast &minus;23 LUFS
      </option>
      <option value="analyze">
        Analyse only (measure, no gain change)
      </option>
      <option value="custom">
        Custom target&hellip;
      </option>
    </select>
    <div class="flex flex-col gap-1.5 text-xs">
      <div
        v-if="customLoudnessActive"
        class="mt-2 flex flex-wrap items-center gap-3"
      >
        <label class="flex items-center gap-1.5">
          <span class="text-zinc-400">Target LUFS</span>
          <input
            v-model="customTargetText"
            type="number"
            step="0.1"
            min="-30"
            max="-6"
            class="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
            :class="{ 'border-red-500': !customTargetValid }"
          >
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-zinc-400">Ceiling dBTP</span>
          <input
            v-model="customCeilingText"
            type="number"
            step="0.1"
            min="-9"
            max="0"
            class="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
            :class="{ 'border-red-500': !customCeilingValid }"
          >
        </label>
        <span class="text-[10px] text-zinc-500">
          Range: target [-30, -6] LUFS, ceiling [-9, 0] dBTP.
        </span>
      </div>
    </div>
  </section>
</template>
