<script setup lang="ts">
// Project Reverb — the one shared reverb "the whole song sits in". Four
// amount sliders in `[0, 1]` (Size, Decay, Tone, Mix), shown as a
// percentage. The Reverb is project-level (not per-track), so this is
// always reachable regardless of selection. Editing is live: each drag
// pushes `setProjectReverb` on every `input` (coalesced into one undo
// step via a per-control `gestureId`) and commits with `gestureEnd` on
// `change`. Double-click resets a control to 0. With Mix at 0 the Reverb is
// silent and exports stay bit-identical to a project with no reverb.

import { onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const project = useProjectStore()
const gesture = useFxGesture('room')

const CONTROLS = [
  { key: 'size', label: 'Size' },
  { key: 'decay', label: 'Decay' },
  { key: 'tone', label: 'Tone' },
  { key: 'mix', label: 'Mix' }
] as const

type Control = (typeof CONTROLS)[number]

function value(control: Control): number {
  return project.projectReverb[control.key]
}

function percent(control: Control): string {
  return `${Math.round(value(control) * 100)}%`
}

function onInput(control: Control, v: number): void {
  if (!Number.isFinite(v)) return
  project.setProjectReverb(
    { [control.key]: v },
    { gestureId: gesture.ensureGesture(control.key), gestureEnd: false }
  )
}

function onChange(control: Control, v: number): void {
  try {
    if (!Number.isFinite(v)) return
    project.setProjectReverb(
      { [control.key]: v },
      { gestureId: gesture.ensureGesture(control.key), gestureEnd: true }
    )
  } finally {
    gesture.endGesture()
  }
}

function onReset(control: Control): void {
  try {
    project.setProjectReverb({ [control.key]: 0 }, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

// Switching projects (load / new) ends any open gesture so the next
// interaction starts a clean undo step. The reverb object is now mutated
// in place on hydration, so we watch the project's file path (its stable
// identity) rather than the object reference.
watch(() => project.currentFilePath, gesture.endGesture)
onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Reverb"
    :cols="1"
    :rows="2"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        v-for="control in CONTROLS"
        :key="control.key"
        :label="control.label"
        :display="percent(control)"
        :value="value(control)"
        :min="0"
        :max="1"
        :step="0.01"
        :assistive-label="'Reverb ' + control.label"
        title="Double-click to reset to 0%"
        @input="onInput(control, $event)"
        @change="onChange(control, $event)"
        @reset="onReset(control)"
      />
    </div>
  </ClipEffectModule>
</template>
