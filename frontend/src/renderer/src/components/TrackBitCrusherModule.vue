<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import type { AutomationParamId } from '@shared/bridge-protocol'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

type CrusherControl = 'rate' | 'bits' | 'boost' | 'mix'

const props = defineProps<{ trackId: string }>()

const project = useProjectStore()
const gesture = useFxGesture('bit-crusher')
const fxAuto = useFxAutomation(computed(() => props.trackId))
const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)

const controls: ReadonlyArray<{
  readonly key: CrusherControl
  readonly param: AutomationParamId
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly fallback: number
  readonly display: (value: number) => string
  readonly resetTitle: string
}> = [
  {
    key: 'rate',
    param: 'bitCrusherRate',
    label: 'Rate',
    min: 0.01,
    max: 1,
    step: 0.01,
    fallback: 1,
    display: (value) => `${Math.round(value * 100)}%`,
    resetTitle: 'Double-click to reset to 100%'
  },
  {
    key: 'bits',
    param: 'bitCrusherBits',
    label: 'Bits',
    min: 1,
    max: 16,
    step: 1,
    fallback: 16,
    display: (value) => `${Math.round(value)}-bit`,
    resetTitle: 'Double-click to reset to 16-bit'
  },
  {
    key: 'boost',
    param: 'bitCrusherBoost',
    label: 'Boost',
    min: 0,
    max: 1,
    step: 0.01,
    fallback: 0,
    display: (value) => `+${Math.round(value * 12)} dB`,
    resetTitle: 'Double-click to reset to +0 dB'
  },
  {
    key: 'mix',
    param: 'bitCrusherMix',
    label: 'Mix',
    min: 0,
    max: 1,
    step: 0.01,
    fallback: 0,
    display: (value) => `${Math.round(value * 100)}%`,
    resetTitle: 'Double-click to reset to 0%'
  }
]

function staticValue(control: typeof controls[number]): number {
  if (!track.value) return control.fallback
  switch (control.key) {
    case 'rate': return track.value.bitCrusherRate ?? control.fallback
    case 'bits': return track.value.bitCrusherBits ?? control.fallback
    case 'boost': return track.value.bitCrusherBoost ?? control.fallback
    case 'mix': return track.value.bitCrusherMix ?? control.fallback
  }
}

function displayValue(control: typeof controls[number]): number {
  return fxAuto.displayValue(control.param, staticValue(control))
}

function setValue(control: typeof controls[number], value: number, gestureEnd: boolean): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackBitCrusher(
    track.value.id,
    { [control.key]: value },
    { gestureId: gesture.ensureGesture(control.key), gestureEnd }
  )
}

function onChange(control: typeof controls[number], value: number): void {
  try {
    setValue(control, value, true)
  } finally {
    gesture.endGesture()
  }
}

function onReset(control: typeof controls[number]): void {
  try {
    setValue(control, control.fallback, true)
  } finally {
    gesture.endGesture()
  }
}

onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Bit Crusher"
    :cols="1"
    :rows="2"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        v-for="control in controls"
        :key="control.key"
        :label="control.label"
        :display="control.display(displayValue(control))"
        :value="displayValue(control)"
        :min="control.min"
        :max="control.max"
        :step="control.step"
        :assistive-label="'Bit crusher ' + control.label.toLowerCase()"
        :title="control.resetTitle"
        automatable
        :automated="fxAuto.isAutomated(control.param)"
        @input="setValue(control, $event, false)"
        @change="onChange(control, $event)"
        @reset="onReset(control)"
        @automate="fxAuto.automate(control.param)"
      />
    </div>
  </ClipEffectModule>
</template>
