<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import FxRangeControl from '@/components/FxRangeControl.vue'

const props = defineProps<{ trackId: string; gridArea?: string }>()

const project = useProjectStore()
const gesture = useFxGesture('punch')
const fxAuto = useFxAutomation(computed(() => props.trackId))
const track = computed(() => project.tracks.find((t) => t.id === props.trackId) ?? null)
const amount = computed(() => track.value?.punchAmount ?? 0)
const amountDisplay = computed(() => fxAuto.displayValue('punch', amount.value))
const percent = computed(() => `${Math.round(amountDisplay.value * 100)}%`)

function onInput(value: number): void {
  if (!track.value || !Number.isFinite(value)) return
  project.setTrackPunch(track.value.id, value, {
    gestureId: gesture.ensureGesture('amount'),
    gestureEnd: false
  })
}

function onChange(value: number): void {
  try {
    if (!track.value || !Number.isFinite(value)) return
    project.setTrackPunch(track.value.id, value, {
      gestureId: gesture.ensureGesture('amount'),
      gestureEnd: true
    })
  } finally {
    gesture.endGesture()
  }
}

function onReset(): void {
  try {
    if (track.value) project.setTrackPunch(track.value.id, 0, { gestureEnd: true })
  } finally {
    gesture.endGesture()
  }
}

onBeforeUnmount(gesture.endGesture)
</script>

<template>
  <ClipEffectModule
    title="Punch"
    help-text="Lift attacks without adding grit"
    :cols="1"
    :rows="1"
    :grid-area="props.gridArea"
  >
    <div class="flex w-full flex-col gap-3 text-xs">
      <FxRangeControl
        label="Amount"
        :display="percent"
        :value="amountDisplay"
        :min="0"
        :max="1"
        :step="0.01"
        assistive-label="Punch amount"
        title="Double-click to reset to 0%"
        automatable
        :automated="fxAuto.isAutomated('punch')"
        @input="onInput($event)"
        @change="onChange($event)"
        @reset="onReset"
        @automate="fxAuto.automate('punch')"
      />
    </div>
  </ClipEffectModule>
</template>
