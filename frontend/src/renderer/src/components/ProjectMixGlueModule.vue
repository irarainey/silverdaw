<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const project = useProjectStore()
const gesture = useFxGesture('mix-glue')

function setAmount(value: number, gestureEnd: boolean): void {
  if (!Number.isFinite(value)) return
  project.setProjectMixGlueAmount(value, {
    gestureId: gesture.ensureGesture('amount'),
    gestureEnd
  })
}

function onChange(value: number): void {
  try {
    setAmount(value, true)
  } finally {
    gesture.endGesture()
  }
}

function onReset(): void {
  try {
    project.setProjectMixGlueAmount(0, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

watch(() => project.currentFilePath, gesture.endGesture)
onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Glue Compressor"
    help-text="Gently bring the mix together"
    :cols="1"
    :rows="1"
  >
    <FxRangeControl
      label="Amount"
      :display="`${Math.round(project.mixGlueAmount * 100)}%`"
      :value="project.mixGlueAmount"
      :min="0"
      :max="1"
      :step="0.01"
      assistive-label="Glue Compressor amount"
      title="Double-click to reset to 0%"
      @input="setAmount($event, false)"
      @change="onChange"
      @reset="onReset"
    />
  </ClipEffectModule>
</template>
