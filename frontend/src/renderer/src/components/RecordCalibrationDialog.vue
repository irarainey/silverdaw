<script setup lang="ts">
// Recording latency calibration (ADR 0030, Amendment 17).
//
// Windows does not report the real recording round trip: a microphone that does its own
// processing declares no latency at all, and a shared output reports little beyond its buffer.
// Takes are therefore trimmed by a figure that can be short by most of the true delay, which is
// heard as a take that sits late against the backing.
//
// This dialog plays a short run of clicks and listens for them, which is the only way to see the
// whole path. It is offered, never forced: recording works without it, and a user on headphones
// (where nothing can be heard by the microphone) types the figure in instead.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BusySpinner from '@/components/BusySpinner.vue'
import { MAX_CALIBRATION_ROUND_TRIP_MS } from '@shared/bridge-protocol'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useRecordingSessionStore()

const dialogEl = ref<HTMLDivElement | null>(null)
const manualValue = ref('')
const manualError = ref<string | null>(null)

const status = computed(() => store.calibrateStatus)
const isMeasuring = computed(() => status.value === 'measuring')
const stored = computed(() => store.activeCalibration)
const result = computed(() => store.calibrateResultMs)

const progressLabel = computed(() => {
  const total = store.calibrateClicksTotal
  if (total === 0) return 'Starting…'
  return `Playing click ${Math.min(store.calibrateClicksDetected + 1, total)} of ${total}…`
})

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      // A run left going would keep the input and the output to itself after the dialog is gone.
      if (isMeasuring.value) store.cancelCalibration()
      store.resetCalibrationRun()
      manualError.value = null
      return
    }
    manualValue.value = stored.value ? String(Math.round(stored.value.roundTripMs)) : ''
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

function onMeasure(): void {
  manualError.value = null
  store.startCalibration()
}

function onUseMeasurement(): void {
  if (result.value === null) return
  store.saveCalibration(result.value, false)
  emit('close')
}

function onApplyManual(): void {
  const parsed = Number(manualValue.value.trim())
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CALIBRATION_ROUND_TRIP_MS) {
    manualError.value = `Enter a delay between 0 and ${MAX_CALIBRATION_ROUND_TRIP_MS} ms.`
    return
  }
  manualError.value = null
  store.saveCalibration(parsed, true)
  emit('close')
}

function onClearCalibration(): void {
  store.clearCalibration()
  manualValue.value = ''
  emit('close')
}

function onClose(): void {
  emit('close')
}

// Bound in the capture phase and stopped there, so the Record dialog's own Escape / Space
// handling does not also fire while this dialog is the thing the user is looking at.
function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  onClose()
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) window.addEventListener('keydown', onKeydown, { capture: true })
    else window.removeEventListener('keydown', onKeydown, { capture: true })
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-calibration-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(520px,92vw)]"
      >
        <div class="dialog-header">
          <h1
            id="record-calibration-title"
            class="dialog-title"
          >
            Calibrate Recording Latency
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-4 text-xs leading-relaxed">
          <p class="text-zinc-400">
            Silverdaw plays a few clicks and listens for them, measuring the real round trip so
            recordings line up with the backing instead of landing late.
          </p>
          <p class="text-zinc-400">
            Turn the volume up a little, point the microphone at your speakers, and keep quiet
            for a few seconds. On headphones, hold one earpiece against the microphone
            instead — that works just as well.
          </p>

          <div class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <div
              v-if="isMeasuring"
              class="flex items-center gap-2 text-zinc-300"
            >
              <BusySpinner />
              {{ progressLabel }}
            </div>
            <div
              v-else-if="status === 'measured' && result !== null"
              class="flex flex-col gap-1"
            >
              <span class="text-zinc-200">Measured round trip: {{ Math.round(result) }} ms</span>
              <span class="text-zinc-500">
                Recordings will be shifted back by this much to sit where you played them.
              </span>
            </div>
            <div
              v-else-if="status === 'failed'"
              class="text-red-200"
            >
              {{ store.calibrateError ?? 'The measurement did not work.' }}
            </div>
            <div
              v-else-if="stored"
              class="flex flex-col gap-1"
            >
              <span class="text-zinc-200">
                Current: {{ Math.round(stored.roundTripMs) }} ms
                <span class="text-zinc-500">({{ stored.manual ? 'entered by hand' : 'measured' }})</span>
              </span>
              <span
                v-if="store.isCalibrationStale"
                class="text-amber-300"
              >
                Measured at a different sample rate — worth measuring again.
              </span>
            </div>
            <div
              v-else
              class="text-zinc-400"
            >
              Uncalibrated. Using the {{ Math.round(store.driverLatencyMs) }} ms your drivers
              report, usually far less than the real delay.
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="dialog-btn-cancel"
              :class="{ 'cursor-wait': isMeasuring }"
              :disabled="isMeasuring"
              @click="onMeasure"
            >
              {{ status === 'failed' ? 'Try Again' : 'Measure' }}
            </button>
            <button
              v-if="isMeasuring"
              type="button"
              class="dialog-btn-cancel"
              @click="store.cancelCalibration()"
            >
              Stop
            </button>
            <button
              v-if="stored && !isMeasuring"
              type="button"
              class="dialog-btn-cancel"
              @click="onClearCalibration"
            >
              Clear
            </button>
          </div>

          <div class="flex flex-col gap-1.5 border-t border-zinc-800 pt-3">
            <label
              class="flex items-center gap-3"
              for="record-calibration-manual"
            >
              <span class="w-24 shrink-0 text-zinc-400">Or enter it</span>
              <input
                id="record-calibration-manual"
                v-model="manualValue"
                type="number"
                min="0"
                :max="MAX_CALIBRATION_ROUND_TRIP_MS"
                step="1"
                inputmode="numeric"
                class="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none hover:border-zinc-600 focus:border-sky-500"
              >
              <span class="text-zinc-500">ms</span>
              <button
                type="button"
                class="dialog-btn-cancel"
                :disabled="manualValue.trim() === ''"
                @click="onApplyManual"
              >
                Apply
              </button>
            </label>
            <p
              v-if="manualError"
              class="text-red-300"
            >
              {{ manualError }}
            </p>
          </div>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onClose"
          >
            Close
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="status !== 'measured' || result === null"
            @click="onUseMeasurement"
          >
            Use Measurement
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
