<script setup lang="ts">
// Per-track Tone — a fixed 3-band shelving/peak EQ (Bass / Mid / Treble,
// dB in `[-15, +15]`). The DJ-style Filter sweep lives in its own rack
// module (TrackFilterModule). Editing is live: slider drags push
// `setTrackTone` on every `input` (coalesced into one undo step via a
// per-band `gestureId`) and commit with `gestureEnd` on `change`.
// Double-click resets a band to 0 dB as a single non-coalesced update.

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'
import type { AutomationParamId } from '@shared/bridge-protocol'

const props = defineProps<{ trackId: string; gridArea?: string }>()

const project = useProjectStore()
const gesture = useFxGesture('tone')
const fxAuto = useFxAutomation(computed(() => props.trackId))

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

// `key` is the `setTrackTone` patch field; `prop` is the (default-
// suppressed) store property holding the persisted dB value; `param` is the
// automation lane id for the same band.
const TONE_BANDS = [
  { key: 'bassDb', prop: 'toneBassDb', label: 'Bass', param: 'toneBass' },
  { key: 'midDb', prop: 'toneMidDb', label: 'Mid', param: 'toneMid' },
  { key: 'trebleDb', prop: 'toneTrebleDb', label: 'Treble', param: 'toneTreble' }
] as const

type ToneBand = (typeof TONE_BANDS)[number]

function bandValue(band: ToneBand): number {
  const v = track.value?.[band.prop]
  const staticV = typeof v === 'number' ? v : 0
  // While automated, follow the curve at the playhead; else the static value.
  return fxAuto.displayValue(band.param as AutomationParamId, staticV)
}

function bandDisplay(band: ToneBand): string {
  const v = bandValue(band)
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

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
    :grid-area="props.gridArea"
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
        :detent="0"
        :assistive-label="band.label + ' gain in decibels'"
        title="Double-click to reset to 0 dB"
        automatable
        :automated="fxAuto.isAutomated(band.param as AutomationParamId)"
        @input="onInput(band, $event)"
        @change="onChange(band, $event)"
        @reset="onReset(band)"
        @automate="fxAuto.automate(band.param as AutomationParamId)"
      />
    </div>
  </ClipEffectModule>
</template>
