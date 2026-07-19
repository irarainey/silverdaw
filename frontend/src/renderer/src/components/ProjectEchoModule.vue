<script setup lang="ts">
// Project Delay — the one shared tempo-locked delay for the whole song.
// A Time control (beat division, locked to the project tempo) plus three
// amount sliders in `[0, 1]` (Feedback, Tone, Mix), shown as a
// percentage. Project-level, so always reachable regardless of selection.
// Editing is live: slider drags push `setProjectDelay` on every `input`
// (coalesced into one undo step via a per-control `gestureId`) and commit
// with `gestureEnd` on `change`; the Time select pushes a single
// non-coalesced update. With Mix at 0 the Delay is silent and exports stay
// bit-identical to a project with no delay.

import { computed, onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import type { DelayNoteValue } from '@shared/bridge-protocol'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const project = useProjectStore()
const gesture = useFxGesture('echo')

const NOTE_VALUES: readonly DelayNoteValue[] = ['1/4', '1/8', '1/8T', '1/16']

const CONTROLS = [
  { key: 'feedback', label: 'Feedback' },
  { key: 'tone', label: 'Tone' },
  { key: 'mix', label: 'Mix' }
] as const

type Control = (typeof CONTROLS)[number]

const noteValue = computed(() => project.projectDelay.noteValue)

function value(control: Control): number {
  return project.projectDelay[control.key]
}

function percent(control: Control): string {
  return `${Math.round(value(control) * 100)}%`
}

function onNoteChange(raw: string): void {
  const next = raw as DelayNoteValue
  if (!NOTE_VALUES.includes(next)) return
  project.setProjectDelay({ noteValue: next }, { gestureEnd: true })
}

function onInput(control: Control, v: number): void {
  if (!Number.isFinite(v)) return
  project.setProjectDelay(
    { [control.key]: v },
    { gestureId: gesture.ensureGesture(control.key), gestureEnd: false }
  )
}

function onChange(control: Control, v: number): void {
  try {
    if (!Number.isFinite(v)) return
    project.setProjectDelay(
      { [control.key]: v },
      { gestureId: gesture.ensureGesture(control.key), gestureEnd: true }
    )
  } finally {
    gesture.endGesture()
  }
}

function onReset(control: Control): void {
  try {
    project.setProjectDelay({ [control.key]: 0 }, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

// Switching projects (load / new) ends any open gesture so the next
// interaction starts a clean undo step. The delay object is now mutated
// in place on hydration, so we watch the project's file path (its stable
// identity) rather than the object reference.
watch(() => project.currentFilePath, gesture.endGesture)
onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Delay"
    help-text="Repeat sound in time with the beat"
    :cols="1"
    :rows="2"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <label class="flex flex-col gap-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">Time</span>
        <select
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-mono tabular-nums text-zinc-100 outline-none focus:border-sky-500"
          :value="noteValue"
          aria-label="Delay time, in beats"
          @change="onNoteChange(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="note in NOTE_VALUES"
            :key="note"
            :value="note"
          >
            {{ note }}
          </option>
        </select>
      </label>

      <FxRangeControl
        v-for="control in CONTROLS"
        :key="control.key"
        :label="control.label"
        :display="percent(control)"
        :value="value(control)"
        :min="0"
        :max="1"
        :step="0.01"
        :assistive-label="'Delay ' + control.label"
        title="Double-click to reset to 0%"
        @input="onInput(control, $event)"
        @change="onChange(control, $event)"
        @reset="onReset(control)"
      />
    </div>
  </ClipEffectModule>
</template>
