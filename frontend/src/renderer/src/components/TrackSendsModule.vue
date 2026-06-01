<script setup lang="ts">
// Per-track Sends — how much of the selected track feeds the two
// project-shared FX buses, the Room (reverb) and the Echo (delay). Two
// amount sliders in `[0, 1]`, shown as a percentage. Editing is live:
// each drag pushes `setTrackSends` on every `input` (coalesced into one
// undo step via a per-control `gestureId`) and commits with `gestureEnd`
// on `change`. Double-click resets an amount to 0 (no send).

import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('send')

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

// `key` is the `setTrackSends` patch field; `prop` is the (default-
// suppressed) store property holding the persisted amount.
const SENDS = [
  { key: 'reverbSend', prop: 'reverbSend', label: 'Room' },
  { key: 'delaySend', prop: 'delaySend', label: 'Echo' }
] as const

type Send = (typeof SENDS)[number]

function sendValue(send: Send): number {
  const v = track.value?.[send.prop]
  return typeof v === 'number' ? v : 0
}

function percent(send: Send): string {
  return `${Math.round(sendValue(send) * 100)}%`
}

function onInput(send: Send, value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackSends(
    track.value.id,
    { [send.key]: value },
    { gestureId: gesture.ensureGesture(send.key), gestureEnd: false }
  )
}

function onChange(send: Send, value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackSends(
      track.value.id,
      { [send.key]: value },
      { gestureId: gesture.ensureGesture(send.key), gestureEnd: true }
    )
  } finally {
    gesture.endGesture()
  }
}

function onReset(send: Send): void {
  try {
    if (!track.value) return
    project.setTrackSends(track.value.id, { [send.key]: 0 }, { gestureEnd: true })
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
    title="Sends"
    :cols="1"
    :rows="1"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        v-for="send in SENDS"
        :key="send.key"
        :label="send.label"
        :display="percent(send)"
        :value="sendValue(send)"
        :min="0"
        :max="1"
        :step="0.01"
        :assistive-label="send.label + ' send amount'"
        title="Double-click to reset to 0%"
        @input="onInput(send, $event)"
        @change="onChange(send, $event)"
        @reset="onReset(send)"
      />
    </div>
  </ClipEffectModule>
</template>
