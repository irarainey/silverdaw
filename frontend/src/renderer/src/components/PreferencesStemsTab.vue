<script setup lang="ts">
import { onMounted } from 'vue'
import { useStemModelManager } from '@/lib/stems/useStemModelManager'
import StemCleanupSection from '@/components/StemCleanupSection.vue'
import type { StemEnhanceStrength } from '@shared/bridge-protocol'

const useGpu = defineModel<boolean>('useGpuForStems', { required: true })
const enhanceVocals = defineModel<boolean>('enhanceVocals', { required: true })
const vocalEnhanceStrength = defineModel<StemEnhanceStrength>('vocalEnhanceStrength', {
  required: true
})
const enhanceDrums = defineModel<boolean>('enhanceDrums', { required: true })
const drumEnhanceStrength = defineModel<StemEnhanceStrength>('drumEnhanceStrength', {
  required: true
})
const enhanceBass = defineModel<boolean>('enhanceBass', { required: true })
const bassEnhanceStrength = defineModel<StemEnhanceStrength>('bassEnhanceStrength', {
  required: true
})
const enhanceOther = defineModel<boolean>('enhanceOther', { required: true })
const otherEnhanceStrength = defineModel<StemEnhanceStrength>('otherEnhanceStrength', {
  required: true
})

interface StrengthOption {
  readonly value: StemEnhanceStrength
  readonly label: string
  readonly hint: string
}

const VOCAL_STRENGTH_OPTIONS: ReadonlyArray<StrengthOption> = [
  {
    value: 'light',
    label: 'Light',
    hint: 'A gentle 60 Hz high-pass and the softest expander. Safest for delicate or breathy vocals.'
  },
  {
    value: 'medium',
    label: 'Medium',
    hint: 'An 80 Hz high-pass with a moderate expander. A balanced starting point for most vocals.'
  },
  {
    value: 'strong',
    label: 'Strong',
    hint: 'A 100 Hz high-pass and the firmest expander. Best when there is noticeable bleed between phrases.'
  }
]

const DRUM_STRENGTH_OPTIONS: ReadonlyArray<StrengthOption> = [
  {
    value: 'light',
    label: 'Light',
    hint: 'The softest expander with a small attenuation range. Safest for busy or roomy kits.'
  },
  {
    value: 'medium',
    label: 'Medium',
    hint: 'A moderate expander. A balanced starting point that tidies the gaps between hits.'
  },
  {
    value: 'strong',
    label: 'Strong',
    hint: 'The firmest expander. Best when there is noticeable bleed between hits, on punchy material.'
  }
]

const BASS_STRENGTH_OPTIONS: ReadonlyArray<StrengthOption> = [
  {
    value: 'light',
    label: 'Light',
    hint: 'A 20 Hz high-pass and the softest expander. Safest for sustained or sub-heavy bass.'
  },
  {
    value: 'medium',
    label: 'Medium',
    hint: 'A 24 Hz high-pass with a moderate expander. A balanced starting point for most basslines.'
  },
  {
    value: 'strong',
    label: 'Strong',
    hint: 'A 28 Hz high-pass and the firmest expander. Best when there is noticeable bleed between notes.'
  }
]

const OTHER_STRENGTH_OPTIONS: ReadonlyArray<StrengthOption> = [
  {
    value: 'light',
    label: 'Light',
    hint: 'A 20 Hz high-pass and the gentlest spectral cleanup. Barely touches the stem.'
  },
  {
    value: 'medium',
    label: 'Medium',
    hint: 'A 24 Hz high-pass with a moderate spectral cleanup. A balanced starting point for the residual mix.'
  },
  {
    value: 'strong',
    label: 'Strong',
    hint: 'A 28 Hz high-pass and the firmest spectral cleanup. Best when the residual has noticeable swirl or hiss.'
  }
]

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

    <StemCleanupSection
      v-model:enabled="enhanceVocals"
      v-model:strength="vocalEnhanceStrength"
      title="Vocal cleanup"
      checkbox-label="Clean up the vocal stem after separation"
      description="Applies a sub-bass high-pass and a gentle expander to the vocal stem only, reducing low-frequency rumble and quiet bleed between phrases. Off by default. Other stems are always written untouched, and your original files are never changed."
      radio-name="vocal-enhance-strength"
      :options="VOCAL_STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceDrums"
      v-model:strength="drumEnhanceStrength"
      title="Drum cleanup"
      checkbox-label="Clean up the drum stem after separation"
      description="Applies a subsonic high-pass and a gentle expander to the drum stem only, trimming rumble and quiet bleed in the gaps between hits while leaving the hits untouched, then gently sharpens the attack of each hit so the drums punch a little harder. The cleanup eases off automatically on dense or continuous material. Off by default. Other stems are always written untouched, and your original files are never changed."
      radio-name="drum-enhance-strength"
      :options="DRUM_STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceBass"
      v-model:strength="bassEnhanceStrength"
      title="Bass cleanup"
      checkbox-label="Clean up the bass stem after separation"
      description="Applies a subsonic high-pass and a gentle expander to the bass stem only, trimming sub-sonic rumble and the high-frequency bleed that leaks into the gaps between notes while leaving the notes untouched, then gently adds harmonics so the bass stays clearer on small speakers. The cleanup eases off automatically on sustained material. Off by default. Other stems are always written untouched, and your original files are never changed."
      radio-name="bass-enhance-strength"
      :options="BASS_STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceOther"
      v-model:strength="otherEnhanceStrength"
      title="Other cleanup"
      checkbox-label="Clean up the other (residual) stem after separation"
      description="Applies a subsonic high-pass and a shallow spectral cleanup to the other/residual stem only, easing the low-level musical-noise and bleed the separation leaves behind while protecting sustained instruments, then gently widens the stereo image for a little more space. The cleanup eases off automatically when the change would be inaudible. Off by default. The remaining stems are always written untouched, and your original files are never changed."
      radio-name="other-enhance-strength"
      :options="OTHER_STRENGTH_OPTIONS"
    />

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
