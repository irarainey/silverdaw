<script setup lang="ts">
// Per-track equal-power pan — places the selected track's dry signal in the
// stereo field. A single bipolar slider in `[-1, 1]` (centre = 0), shown as
// `C` / `L<n>` / `R<n>`. Editing is live: each drag pushes `setTrackPan` on
// every `input` (coalesced into one undo step via a `gestureId`) and commits
// with `gestureEnd` on `change`. Double-click resets to centre.

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('pan')

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

const panValue = computed(() => {
  const v = track.value?.pan
  return typeof v === 'number' ? v : 0
})

const display = computed(() => {
  const pct = Math.round(Math.abs(panValue.value) * 100)
  if (pct === 0) return 'C'
  return panValue.value < 0 ? `L${pct}` : `R${pct}`
})

function onInput(value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackPan(track.value.id, value, {
    gestureId: gesture.ensureGesture('pan'),
    gestureEnd: false
  })
}

function onChange(value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackPan(track.value.id, value, {
      gestureId: gesture.ensureGesture('pan'),
      gestureEnd: true
    })
  } finally {
    gesture.endGesture()
  }
}

function onReset(): void {
  try {
    if (!track.value) return
    project.setTrackPan(track.value.id, 0, { gestureEnd: true })
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
    title="Pan"
    :cols="1"
    :rows="1"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        label="Pan"
        :display="display"
        :value="panValue"
        :min="-1"
        :max="1"
        :step="0.01"
        assistive-label="Track pan"
        title="Double-click to reset to centre"
        @input="onInput($event)"
        @change="onChange($event)"
        @reset="onReset"
      />
    </div>
  </ClipEffectModule>
</template>
