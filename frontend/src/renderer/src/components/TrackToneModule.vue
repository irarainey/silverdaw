<script setup lang="ts">
// Per-track Tone — a fixed 3-band shelving/peak EQ (Bass / Mid / Treble,
// dB in `[-15, +15]`) plus one-button Low Cut and High Cut. Editing is
// live: slider drags push `setTrackTone` on every `input` (coalesced into
// one undo step via a per-band `gestureId`) and commit with `gestureEnd`
// on `change`. Discrete edits (Low Cut, High Cut, double-click reset)
// push a single non-coalesced update.

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('tone')

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

// `key` is the `setTrackTone` patch field; `prop` is the (default-
// suppressed) store property holding the persisted dB value.
const TONE_BANDS = [
  { key: 'bassDb', prop: 'toneBassDb', label: 'Bass' },
  { key: 'midDb', prop: 'toneMidDb', label: 'Mid' },
  { key: 'trebleDb', prop: 'toneTrebleDb', label: 'Treble' }
] as const

type ToneBand = (typeof TONE_BANDS)[number]

function bandValue(band: ToneBand): number {
  const v = track.value?.[band.prop]
  return typeof v === 'number' ? v : 0
}

function bandDisplay(band: ToneBand): string {
  const v = bandValue(band)
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

const lowCutOn = computed(() => track.value?.toneLowCut === true)
const highCutOn = computed(() => track.value?.toneHighCut === true)

function onInput(band: ToneBand, value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackTone(
    track.value.id,
    { [band.key]: value },
    { gestureId: gesture.ensureGesture(band.key), gestureEnd: false }
  )
}

function onChange(band: ToneBand, value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackTone(
      track.value.id,
      { [band.key]: value },
      { gestureId: gesture.ensureGesture(band.key), gestureEnd: true }
    )
  } finally {
    gesture.endGesture()
  }
}

function onReset(band: ToneBand): void {
  try {
    if (!track.value) return
    project.setTrackTone(track.value.id, { [band.key]: 0 }, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

function onToggleLowCut(): void {
  if (!track.value) return
  project.setTrackTone(track.value.id, { lowCut: !lowCutOn.value }, { gestureEnd: true })
}

function onToggleHighCut(): void {
  if (!track.value) return
  project.setTrackTone(track.value.id, { highCut: !highCutOn.value }, { gestureEnd: true })
}

// The panel keys this module by track id, so a track switch remounts it
// (no in-instance trackId change to watch). Tear down any open gesture when
// that remount — or a panel close — unmounts us, so the next interaction
// starts a clean undo step.
onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Tone"
    :cols="1"
    :rows="2"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        v-for="band in TONE_BANDS"
        :key="band.key"
        :label="band.label"
        :display="bandDisplay(band)"
        :value="bandValue(band)"
        :min="-15"
        :max="15"
        :step="0.5"
        :assistive-label="band.label + ' gain in decibels'"
        title="Double-click to reset to 0 dB"
        @input="onInput(band, $event)"
        @change="onChange(band, $event)"
        @reset="onReset(band)"
      />

      <div class="mt-2 grid grid-cols-2 gap-3">
        <button
          type="button"
          class="flex items-center justify-between rounded border px-2 py-1.5 text-[11px] transition-colors"
          :class="
            lowCutOn
              ? 'border-sky-500 bg-sky-500/15 text-sky-200'
              : 'border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
          "
          :aria-pressed="lowCutOn"
          @click="onToggleLowCut"
        >
          <span class="uppercase tracking-wider">Low Cut</span>
          <span class="font-mono text-[10px]">{{ lowCutOn ? 'ON' : 'OFF' }}</span>
        </button>

        <button
          type="button"
          class="flex items-center justify-between rounded border px-2 py-1.5 text-[11px] transition-colors"
          :class="
            highCutOn
              ? 'border-sky-500 bg-sky-500/15 text-sky-200'
              : 'border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
          "
          :aria-pressed="highCutOn"
          @click="onToggleHighCut"
        >
          <span class="uppercase tracking-wider">High Cut</span>
          <span class="font-mono text-[10px]">{{ highCutOn ? 'ON' : 'OFF' }}</span>
        </button>
      </div>
    </div>
  </ClipEffectModule>
</template>
