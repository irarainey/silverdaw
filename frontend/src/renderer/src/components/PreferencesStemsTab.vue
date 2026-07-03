<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useStemModelManager } from '@/lib/stems/useStemModelManager'
import StemCleanupSection from '@/components/StemCleanupSection.vue'
import type { StemEnhanceStrength } from '@shared/bridge-protocol'

const useGpu = defineModel<boolean>('useGpuForStems', { required: true })
const useBackupModel = defineModel<boolean>('useBackupModel', { required: true })
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

// One shared intensity scale for all four stems; each section's intro already
// explains what its cleanup does, so the options only convey how strong it is.
const STRENGTH_OPTIONS: ReadonlyArray<StrengthOption> = [
  { value: 'light', label: 'Light', hint: 'Gentlest cleanup' },
  { value: 'medium', label: 'Medium', hint: 'Balanced cleanup' },
  { value: 'strong', label: 'Strong', hint: 'Strongest cleanup' }
]

const { gpu, modelInfo, busy, error, installed, refresh, locate } = useStemModelManager()

// Combined "quality models" download state. Both RoFormer packs (vocals +
// drums/bass) are the primary engine and are needed together for full
// pack-quality separation, so they are presented and downloaded as one unit.
const vocalInstalled = ref(false)
const rhythmInstalled = ref(false)
const qualityBusy = ref(false)
const qualityPercent = ref(0)
const qualityError = ref<string | null>(null)
const qualityInstalled = computed(() => vocalInstalled.value && rhythmInstalled.value)
const qualityPartlyInstalled = computed(
  () => (vocalInstalled.value || rhythmInstalled.value) && !qualityInstalled.value
)

async function refreshQuality(): Promise<void> {
  try {
    const [v, r] = await Promise.all([
      window.silverdaw.getVocalPackState(),
      window.silverdaw.getRhythmPackState()
    ])
    vocalInstalled.value = v.installed
    rhythmInstalled.value = r.installed
  } catch {
    vocalInstalled.value = false
    rhythmInstalled.value = false
  }
}

// Download whichever packs are missing, reporting a single combined percentage
// weighted by each pack's total bytes (already-present packs count as done).
async function downloadQualityModels(): Promise<void> {
  if (qualityBusy.value) return
  qualityBusy.value = true
  qualityError.value = null
  qualityPercent.value = 0
  try {
    const [vState, rState] = await Promise.all([
      window.silverdaw.getVocalPackState(),
      window.silverdaw.getRhythmPackState()
    ])
    const vTotal = vState.totalBytes || 0
    const rTotal = rState.totalBytes || 0
    const grand = Math.max(1, vTotal + rTotal)
    let base = (vState.installed ? vTotal : 0) + (rState.installed ? rTotal : 0)
    const setPct = (received: number): void => {
      qualityPercent.value = Math.min(100, Math.round(((base + received) / grand) * 100))
    }
    setPct(0)

    if (!vState.installed) {
      const stop = window.silverdaw.onVocalPackDownloadProgress((p) => setPct(p.receivedBytes))
      try {
        const res = await window.silverdaw.ensureVocalPack()
        if (!res.ok) {
          qualityError.value = res.error ?? 'Download failed.'
          return
        }
      } finally {
        stop()
      }
      base += vTotal
    }

    if (!rState.installed) {
      const stop = window.silverdaw.onRhythmPackDownloadProgress((p) => setPct(p.receivedBytes))
      try {
        const res = await window.silverdaw.ensureRhythmPack()
        if (!res.ok) {
          qualityError.value = res.error ?? 'Download failed.'
          return
        }
      } finally {
        stop()
      }
      base += rTotal
    }
  } catch (e) {
    qualityError.value = e instanceof Error ? e.message : String(e)
  } finally {
    qualityBusy.value = false
    await refreshQuality()
  }
}

function cancelQualityDownload(): void {
  window.silverdaw.cancelVocalPackDownload()
  window.silverdaw.cancelRhythmPackDownload()
}

// Point Silverdaw at an existing / manually-placed copy of a pack instead of
// downloading it. The chosen folder is validated against the pack manifest
// (file present at the right size) and remembered as that pack's location.
async function locateVocalModel(): Promise<void> {
  const dir = await window.silverdaw.chooseDirectory({ title: 'Locate vocal model folder' })
  if (!dir) return
  qualityError.value = null
  const res = await window.silverdaw.locateVocalPack(dir)
  if (!res.ok) qualityError.value = res.error ?? 'Could not use that folder.'
  await refreshQuality()
}

async function locateRhythmModel(): Promise<void> {
  const dir = await window.silverdaw.chooseDirectory({ title: 'Locate drums & bass model folder' })
  if (!dir) return
  qualityError.value = null
  const res = await window.silverdaw.locateRhythmPack(dir)
  if (!res.ok) qualityError.value = res.error ?? 'Could not use that folder.'
  await refreshQuality()
}

onMounted(refresh)
onMounted(refreshQuality)
</script>

<template>
  <section class="space-y-6">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Separation models
      </h2>
      <p class="mb-2 text-zinc-500">
        Stem separation needs a one-time download (about&nbsp;1&nbsp;GB), stored
        on your computer and used automatically.
      </p>

      <div class="mb-2 flex items-center gap-2">
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
          :class="
            qualityInstalled
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-amber-500/15 text-amber-300'
          "
        >{{ qualityInstalled ? 'Installed' : qualityPartlyInstalled ? 'Partly installed' : 'Not downloaded' }}</span>
      </div>

      <div
        v-if="qualityBusy"
        class="mb-3"
      >
        <div class="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
          <span>Downloading models…</span>
          <span>{{ qualityPercent }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded bg-zinc-800">
          <div
            class="h-full bg-sky-500 transition-[width] duration-200"
            :style="{ width: `${qualityPercent}%` }"
          />
        </div>
      </div>

      <p
        v-if="qualityError"
        class="mb-2 text-[11px] text-red-400"
      >
        {{ qualityError }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="qualityBusy"
          type="button"
          class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
          @click="cancelQualityDownload"
        >
          Cancel download
        </button>
        <template v-else>
          <button
            v-if="!qualityInstalled"
            type="button"
            class="shrink-0 rounded bg-sky-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-sky-500 focus:ring-2 focus:ring-sky-400 focus:outline-none"
            @click="downloadQualityModels"
          >
            {{ qualityPartlyInstalled ? 'Download remaining model…' : 'Download models (~1 GB)' }}
          </button>
          <span
            v-else
            class="text-xs text-emerald-400"
          >Installed and used automatically</span>
        </template>
      </div>

      <div class="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
        <p class="text-[11px] text-zinc-500">
          Already have a model? Point Silverdaw at the folder that contains it
          instead of downloading it again.
        </p>
        <div class="flex items-center gap-2 text-[11px]">
          <span class="w-32 shrink-0 text-zinc-300">Vocal model</span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            :class="vocalInstalled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400'"
          >{{ vocalInstalled ? 'Installed' : 'Not installed' }}</span>
          <button
            type="button"
            :disabled="qualityBusy"
            class="ml-auto shrink-0 rounded bg-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:opacity-40"
            @click="locateVocalModel"
          >
            Locate…
          </button>
        </div>
        <div class="flex items-center gap-2 text-[11px]">
          <span class="w-32 shrink-0 text-zinc-300">Drums &amp; bass model</span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            :class="rhythmInstalled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400'"
          >{{ rhythmInstalled ? 'Installed' : 'Not installed' }}</span>
          <button
            type="button"
            :disabled="qualityBusy"
            class="ml-auto shrink-0 rounded bg-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:opacity-40"
            @click="locateRhythmModel"
          >
            Locate…
          </button>
        </div>
        <div class="flex items-center gap-2 text-[11px]">
          <span class="w-32 shrink-0 text-zinc-300">Backup model</span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            :class="installed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400'"
          >{{ installed ? (modelInfo?.located ? 'Located' : 'Installed') : 'Not installed' }}</span>
          <button
            type="button"
            :disabled="busy"
            class="ml-auto shrink-0 rounded bg-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:opacity-40"
            @click="locate"
          >
            Locate…
          </button>
        </div>
        <p class="text-[11px] text-zinc-500">
          The backup is a lower-quality model used automatically only if a
          RoFormer model above can't run on your hardware. You don't normally
          need it — it's fetched on first use if required.
        </p>
        <p
          v-if="error"
          class="text-[11px] text-red-400"
        >
          {{ error }}
        </p>
      </div>

      <label class="mt-4 flex cursor-pointer items-start gap-3">
        <input
          v-model="useBackupModel"
          type="checkbox"
          class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
        >
        <span class="flex-1">
          <span class="block font-medium text-zinc-200">
            Always use the backup model
          </span>
          <span class="mt-0.5 block text-zinc-500">
            Forces the lower-quality backup for every stem even when the RoFormer
            models above are installed (for example, for faster separation or
            troubleshooting). Off by default.
          </span>
        </span>
      </label>
    </div>

    <StemCleanupSection
      v-model:enabled="enhanceVocals"
      v-model:strength="vocalEnhanceStrength"
      title="Vocal cleanup"
      checkbox-label="Clean up the vocal stem after separation"
      description="Trims low-frequency rumble and quiet bleed between phrases. Vocals only; off by default."
      radio-name="vocal-enhance-strength"
      :options="STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceDrums"
      v-model:strength="drumEnhanceStrength"
      title="Drum cleanup"
      checkbox-label="Clean up the drum stem after separation"
      description="Trims rumble and bleed between hits and sharpens each hit's attack. Drums only; off by default."
      radio-name="drum-enhance-strength"
      :options="STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceBass"
      v-model:strength="bassEnhanceStrength"
      title="Bass cleanup"
      checkbox-label="Clean up the bass stem after separation"
      description="Trims sub rumble and bleed between notes and adds harmonics for small speakers. Bass only; off by default."
      radio-name="bass-enhance-strength"
      :options="STRENGTH_OPTIONS"
    />

    <StemCleanupSection
      v-model:enabled="enhanceOther"
      v-model:strength="otherEnhanceStrength"
      title="Other cleanup"
      checkbox-label="Clean up the other (residual) stem after separation"
      description="Eases residual noise and bleed and gently widens the stereo image. Residual stem only; off by default."
      radio-name="other-enhance-strength"
      :options="STRENGTH_OPTIONS"
    />

    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Hardware acceleration (experimental)
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
          <span class="block font-medium text-zinc-200">Use GPU acceleration for stem separation</span>
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
  </section>
</template>
