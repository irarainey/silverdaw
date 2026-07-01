<script setup lang="ts">
// Sample-rate mismatch prompt, shown by the import flow when a source file's
// rate differs from the project's `targetSampleRate`. Exit paths: switch the
// project to the source rate (only when it is a supported 44100/48000),
// convert on playback (keeping the project rate), or cancel the batch.
// Batched imports are summarised by rate bucket so the policy is set once.

import { computed, ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'

export type SampleRateMismatchChoice = 'switch-project' | 'convert' | 'cancel'

export interface RateBucket {
  /** Source-file sample rate in Hz. */
  sampleRate: number
  /** How many of the batch's files are at this rate. */
  fileCount: number
}

const props = defineProps<{
  open: boolean
  /** Current project `targetSampleRate` (Hz). The prompt always offers
   *  a "Convert to {projectRate} Hz" path that records the project
   *  rate as-is. */
  projectSampleRate: number
  /** Per-rate breakdown of the batch. Sorted high-to-low when rendered. */
  buckets: RateBucket[]
}>()

const emit = defineEmits<{ (e: 'choose', choice: SampleRateMismatchChoice): void }>()

const ui = useUiStore()
const dialogEl = ref<HTMLDivElement | null>(null)

const MAX_SUPPORTED_HZ = 48000

const sortedBuckets = computed(() =>
  [...props.buckets].sort((a, b) => b.sampleRate - a.sampleRate)
)
const highestRate = computed(() => sortedBuckets.value[0]?.sampleRate ?? props.projectSampleRate)

const exceedsCap = computed(() => highestRate.value > MAX_SUPPORTED_HZ)

// When the highest source rate is one of the supported project rates
// AND differs from the current project rate, offer to switch. When
// the highest rate is above the cap, the offer becomes "switch to
// 48 kHz (the max)" so the user has a one-click path to bump the
// project to the highest supported rate before the convert step.
const switchProjectTargetHz = computed(() => {
  if (highestRate.value === props.projectSampleRate) return null
  if (highestRate.value === 44100 || highestRate.value === 48000) return highestRate.value
  if (exceedsCap.value) {
    return props.projectSampleRate === MAX_SUPPORTED_HZ ? null : MAX_SUPPORTED_HZ
  }
  return null
})

function formatHz(hz: number): string {
  return `${hz.toLocaleString()} Hz`
}

function onSwitch(): void {
  emit('choose', 'switch-project')
}
function onConvert(): void {
  emit('choose', 'convert')
}
function onCancel(): void {
  emit('choose', 'cancel')
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    onCancel()
  }
}

watch(
  () => props.open,
  (now) => {
    ui.clipEditorOpen = now
    if (now) {
      void Promise.resolve().then(() => dialogEl.value?.focus())
    }
  }
)
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="dialog-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sample-rate-mismatch-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(520px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="sample-rate-mismatch-title"
            class="dialog-title"
          >
            Sample Rate Mismatch
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-3 text-zinc-300">
          <p>
            This project runs at <span class="font-medium text-zinc-100">{{ formatHz(projectSampleRate) }}</span>.
          </p>
          <p v-if="exceedsCap">
            One or more files are above Silverdaw's <span class="font-medium text-zinc-100">{{ formatHz(MAX_SUPPORTED_HZ) }}</span> maximum.
          </p>
          <p v-else>
            One or more files are at a different rate than the project.
          </p>
          <ul class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 font-mono text-xs">
            <li
              v-for="b in sortedBuckets"
              :key="b.sampleRate"
            >
              <span class="text-zinc-100">{{ b.fileCount }}</span> ×
              <span :class="b.sampleRate > MAX_SUPPORTED_HZ ? 'text-amber-300' : 'text-zinc-300'">
                {{ formatHz(b.sampleRate) }}
              </span>
              <span
                v-if="b.sampleRate > MAX_SUPPORTED_HZ"
                class="text-amber-400"
              > (above {{ formatHz(MAX_SUPPORTED_HZ) }} cap)</span>
            </li>
          </ul>
          <p class="text-[12px] text-zinc-400">
            <template v-if="switchProjectTargetHz !== null">
              Switch this project to <span class="text-zinc-200">{{ formatHz(switchProjectTargetHz) }}</span> to play these files at their native rate, or convert each file to the project's current rate.
            </template>
            <template v-else>
              The files will be converted to the project's current rate on import.
            </template>
          </p>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onConvert"
          >
            Convert to {{ formatHz(projectSampleRate) }}
          </button>
          <button
            v-if="switchProjectTargetHz !== null"
            type="button"
            class="dialog-btn-primary"
            @click="onSwitch"
          >
            Switch Project to {{ formatHz(switchProjectTargetHz) }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
