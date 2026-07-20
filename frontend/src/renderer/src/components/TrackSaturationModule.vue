<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string; gridArea?: string }>()

const project = useProjectStore()
const gesture = useFxGesture('saturation')
const fxAuto = useFxAutomation(computed(() => props.trackId))

const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)
const drive = computed(() => track.value?.saturationDrive ?? 0)
const mix = computed(() => track.value?.saturationMix ?? 1)
const driveDisplay = computed(() => fxAuto.displayValue('saturationDrive', drive.value))
const mixDisplay = computed(() => fxAuto.displayValue('saturationMix', mix.value))
const drivePercent = computed(() => `${Math.round(driveDisplay.value * 100)}%`)
const mixPercent = computed(() => `${Math.round(mixDisplay.value * 100)}%`)

function setValue(param: 'drive' | 'mix', value: number, gestureEnd: boolean): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackSaturation(
    track.value.id,
    { [param]: value },
    {
      gestureId: gesture.ensureGesture(param),
      gestureEnd
    }
  )
}

function onChange(param: 'drive' | 'mix', value: number): void {
  try {
    setValue(param, value, true)
  } finally {
    gesture.endGesture()
  }
}

function onReset(param: 'drive' | 'mix'): void {
  try {
    setValue(param, param === 'drive' ? 0 : 1, true)
  } finally {
    gesture.endGesture()
  }
}

onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Saturation"
    help-text="Warmth first, grit near the top"
    :cols="1"
    :rows="2"
    :grid-area="props.gridArea"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        label="Drive"
        :display="drivePercent"
        :value="driveDisplay"
        :min="0"
        :max="1"
        :step="0.01"
        assistive-label="Saturation drive"
        title="Double-click to reset to 0%"
        automatable
        :automated="fxAuto.isAutomated('saturationDrive')"
        @input="setValue('drive', $event, false)"
        @change="onChange('drive', $event)"
        @reset="onReset('drive')"
        @automate="fxAuto.automate('saturationDrive')"
      />
      <FxRangeControl
        label="Mix"
        :display="mixPercent"
        :value="mixDisplay"
        :min="0"
        :max="1"
        :step="0.01"
        assistive-label="Saturation mix"
        title="Double-click to reset to 100%"
        automatable
        :automated="fxAuto.isAutomated('saturationMix')"
        @input="setValue('mix', $event, false)"
        @change="onChange('mix', $event)"
        @reset="onReset('mix')"
        @automate="fxAuto.automate('saturationMix')"
      />
    </div>
  </ClipEffectModule>
</template>
