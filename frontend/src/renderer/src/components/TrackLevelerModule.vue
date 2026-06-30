<script setup lang="ts">
// Per-track Leveler — a single "Amount" knob driving a curated soft-knee
// compressor on the selected track. Amount is `[0, 1]`, shown as a
// percentage; `0` bypasses the Leveler entirely. Editing is live: each
// drag pushes `setTrackLeveler` on every `input` (coalesced into one undo
// step via a `gestureId`) and commits with `gestureEnd` on `change`.
// Double-click resets the Amount to 0 (off).

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('leveler')
const fxAuto = useFxAutomation(computed(() => props.trackId))

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

const amount = computed(() =>
  typeof track.value?.levelerAmount === 'number' ? track.value.levelerAmount : 0
)

// While automated, the slider + readout follow the curve at the playhead.
const amountDisplay = computed(() => fxAuto.displayValue('leveler', amount.value))
const percent = computed(() => `${Math.round(amountDisplay.value * 100)}%`)

function onInput(value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackLeveler(track.value.id, value, {
    gestureId: gesture.ensureGesture('amount'),
    gestureEnd: false
  })
}

function onChange(value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackLeveler(track.value.id, value, {
      gestureId: gesture.ensureGesture('amount'),
      gestureEnd: true
    })
  } finally {
    gesture.endGesture()
  }
}

function onReset(): void {
  try {
    if (!track.value) return
    project.setTrackLeveler(track.value.id, 0, { gestureEnd: true })
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
    :title="'Compressor'"
    :cols="1"
    :rows="1"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        label="Amount"
        :display="percent"
        :value="amountDisplay"
        :min="0"
        :max="1"
        :step="0.01"
        assistive-label="Compressor amount"
        title="Double-click to reset to 0%"
        automatable
        :automated="fxAuto.isAutomated('leveler')"
        @input="onInput($event)"
        @change="onChange($event)"
        @reset="onReset"
        @automate="fxAuto.automate('leveler')"
      />
    </div>
  </ClipEffectModule>
</template>
