<script setup lang="ts">
// Per-track Filter — a single bipolar DJ-style sweep on the selected track.
// The slider runs low-pass (High Cut) at the left, through the off centre,
// to high-pass (Low Cut) at the right, so a continuous drag performs the
// classic LPF→HPF filter transition. The value is `[-1, +1]` (0 = off),
// stored as the track's `toneFilter`. Editing is live: each drag pushes
// `setTrackTone` on every `input` (coalesced into one undo step via a
// `gestureId`) and commits with `gestureEnd` on `change`. Double-click
// recentres the slider to off.

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('filter')
const fxAuto = useFxAutomation(computed(() => props.trackId))

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

const filter = computed(() =>
  typeof track.value?.toneFilter === 'number' ? track.value.toneFilter : 0
)

// While automated, the slider + readout follow the curve at the playhead.
const filterDisplay = computed(() => fxAuto.displayValue('filter', filter.value))

// Negative drives the low-pass (High Cut); positive the high-pass (Low Cut).
const display = computed(() => {
  const v = filterDisplay.value
  if (Math.abs(v) < 0.005) return 'Off'
  return v < 0 ? `LPF ${Math.round(-v * 100)}%` : `HPF ${Math.round(v * 100)}%`
})

function onInput(value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackTone(
    track.value.id,
    { filter: value },
    { gestureId: gesture.ensureGesture('filter'), gestureEnd: false }
  )
}

function onChange(value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackTone(
      track.value.id,
      { filter: value },
      { gestureId: gesture.ensureGesture('filter'), gestureEnd: true }
    )
  } finally {
    gesture.endGesture()
  }
}

function onReset(): void {
  try {
    if (!track.value) return
    project.setTrackTone(track.value.id, { filter: 0 }, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

// The panel keys this module by track id, so a track switch remounts it.
// Tear down any open gesture on unmount so the next interaction starts a
// clean undo step.
onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Filter"
    :cols="1"
    :rows="1"
  >
    <div class="flex w-full flex-col gap-1 text-xs">
      <FxRangeControl
        label="Filter"
        :display="display"
        :value="filterDisplay"
        :min="-1"
        :max="1"
        :step="0.01"
        assistive-label="Filter sweep, low-pass left to high-pass right"
        title="Double-click to recentre (off)"
        automatable
        :automated="fxAuto.isAutomated('filter')"
        @input="onInput($event)"
        @change="onChange($event)"
        @reset="onReset"
        @automate="fxAuto.automate('filter')"
      />
      <div class="flex justify-between px-0.5 text-[9px] uppercase tracking-wider text-zinc-600">
        <span>LPF</span>
        <span>HPF</span>
      </div>
    </div>
  </ClipEffectModule>
</template>
