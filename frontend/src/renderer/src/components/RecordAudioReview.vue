<script setup lang="ts">
// Record Audio, once a recording exists: hear it back, name it, and decide what
// happens to it. Nothing has been added to the project at this point, so leaving
// without committing leaves the project untouched.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RecordAudioWaveform from '@/components/RecordAudioWaveform.vue'
import { droppedSamplesMessage } from '@/lib/recording/recordingMessages'
import { formatTime } from '@/lib/musicTime'
import { send as sendBridge } from '@/lib/bridgeService'
import type { RecordingSession } from '@/lib/recording/useRecordingSession'
import { usePreviewStore } from '@/stores/previewStore'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'

const props = defineProps<{ session: RecordingSession }>()

const name = defineModel<string>('name', { required: true })


const store = useRecordingSessionStore()
const preview = usePreviewStore()

const ready = computed(() => store.ready)
const peaks = computed(() => store.readyPeaks?.peaks ?? new Float32Array())
const isAuditioning = computed(
  () => preview.filePath !== null && preview.filePath === ready.value?.filePath
)
const positionMs = computed(() => (isAuditioning.value ? preview.positionMs : 0))
const isPlayingThis = computed(() => isAuditioning.value && preview.isPlaying)

// Hearing the take against what was playing under it is the point of the review,
// so the arrangement can roll with it rather than only in isolation.
const withArrangement = ref(false)
let arrangementRolling = false

// The review has its own backing level: a guide mix kept quiet under the
// performer is not how the take wants to be heard back. Applied while this pane
// is up and handed back to the setup's level when it goes.
const backingGainPercent = computed(() => Math.round(store.rememberedReviewBackingGain * 100))

function onBackingGainChange(event: Event): void {
  props.session.setReviewBackingGain(Number((event.target as HTMLInputElement).value) / 100)
}

function onBackingGainReset(): void {
  props.session.setReviewBackingGain(1)
}

onMounted(() => props.session.setReviewBackingGain(store.rememberedReviewBackingGain))

// Saving a mono take as stereo. It rewrites the take, not the commit, so the
// audition below plays the file that will be kept — a mono capture heard on both
// sides rather than one. Only offered for a capture that was mono in the first
// place.
const stereoDuplicated = computed(() => ready.value?.stereoDuplicated === true)
const canDuplicateToStereo = computed(
  () => ready.value !== null && (ready.value.channelCount === 1 || stereoDuplicated.value)
)

function onStereoChange(event: Event): void {
  props.session.setStereoDuplicated((event.target as HTMLInputElement).checked)
}

/**
 * The take this pane is auditioning, held outside the store.
 *
 * Closing the dialog clears the recording session *before* this component
 * unmounts, so by the time the audition has to be let go there is no longer a
 * `ready` payload to read the file path off — and the preview voice would be
 * left playing under a dialog that is no longer there.
 */
let audition: { filePath: string; anchorMs: number } | null = null

watch(
  ready,
  (next) => {
    // Deliberately keeps the last take when `ready` goes null: that is the close
    // path, and the file path is exactly what is needed to release the voice.
    if (next) audition = { filePath: next.filePath, anchorMs: next.anchorMs }
    // A retake arrives as a fresh mono file, so the choice made on the last one is
    // re-applied rather than quietly forgotten between takes.
    if (
      next &&
      store.rememberedStereoDuplicated &&
      next.channelCount === 1 &&
      next.stereoDuplicated !== true
    )
      props.session.setStereoDuplicated(true)
  },
  { immediate: true }
)

const summary = computed(() => {
  const payload = ready.value
  if (!payload) return ''
  const channels = payload.channelCount === 2 ? 'stereo' : 'mono'
  return `${formatTime(payload.durationMs)} · ${channels} · ${Math.round(payload.bpm)} BPM`
})

const droppedWarning = computed(() => {
  const payload = ready.value
  if (!payload || payload.droppedSamples <= 0) return null
  return droppedSamplesMessage(payload.droppedSamples, payload.sampleRate)
})

function onPlay(): void {
  const payload = ready.value
  if (!payload) return
  if (isAuditioning.value && preview.isLoaded) {
    preview.play()
    if (withArrangement.value) startArrangement()
    return
  }
  // Loading defers PREVIEW_PLAY until the file is open, and that command pauses
  // the transport — so the arrangement is left to the `isPlayingThis` watch,
  // which starts it once the take is actually rolling.
  preview.loadFile(payload.filePath, true)
}

/**
 * Roll the project alongside the audition, from `fromTakeMs` into the take.
 *
 * Guarded against a double start: the play path and the `withArrangement` watch
 * can both reach here for the same take, and a second SEEK would jerk the
 * arrangement back.
 */
function startArrangement(fromTakeMs = 0): void {
  const payload = ready.value
  if (!payload || arrangementRolling) return
  sendBridge('TRANSPORT_SEEK', { positionMs: payload.anchorMs + fromTakeMs })
  sendBridge('TRANSPORT_PLAY')
  arrangementRolling = true
}

function onStop(): void {
  preview.stop()
  stopArrangement()
}

/** Leave the timeline as the take found it: stopped, back at the record anchor. */
function stopArrangement(): void {
  if (!arrangementRolling) return
  arrangementRolling = false
  sendBridge('TRANSPORT_PAUSE')
  if (audition) sendBridge('TRANSPORT_SEEK', { positionMs: audition.anchorMs })
}

/** Release the shared preview voice; the Clip Editor and file browser use it too. */
function releaseAudition(filePath: string | null): void {
  stopArrangement()
  if (filePath !== null && preview.filePath === filePath) preview.unload()
}

// A retake replaces the file the audition is playing, so let go of the old one.
watch(
  () => ready.value?.filePath ?? null,
  (_next, previous) => releaseAudition(previous ?? null)
)

// The take runs out before the arrangement does; stop the timeline with it rather
// than leaving it running under a dialog that looks stopped. Starting is handled
// here too, rather than at the click: the checkbox is read at the moment the take
// actually rolls, so toggling it while the file is still loading is honoured.
watch(isPlayingThis, (playing) => {
  if (playing) {
    if (withArrangement.value) startArrangement()
    return
  }
  stopArrangement()
})

// The backing can be brought in and dropped again while the take is rolling —
// hearing it against the arrangement is the question being asked, and having to
// stop and start to answer it loses your place.
watch(withArrangement, (on) => {
  const payload = ready.value
  if (!on) {
    stopArrangement()
    return
  }
  if (!payload) return
  // Join a take that is already playing where it has got to, so the arrangement
  // lines up with it instead of restarting from the top of the take.
  if (isPlayingThis.value) startArrangement(positionMs.value)
  // Otherwise park the playhead where the take starts so it is primed there.
  else sendBridge('TRANSPORT_SEEK', { positionMs: payload.anchorMs })
})

onBeforeUnmount(() => {
  releaseAudition(audition?.filePath ?? null)
  props.session.restoreBackingGain()
})
</script>

<template>
  <div
    v-if="ready"
    class="flex flex-col gap-4 text-xs leading-relaxed"
  >
    <RecordAudioWaveform
      :peaks="peaks"
      :duration-ms="ready.durationMs"
      :position-ms="positionMs"
      @seek="preview.seek($event)"
    />

    <div class="flex items-center gap-3">
      <button
        v-if="!isPlayingThis"
        type="button"
        class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
        @click="onPlay"
      >
        Play
      </button>
      <button
        v-else
        type="button"
        class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
        @click="onStop"
      >
        Stop
      </button>
      <span class="font-mono text-xs tabular-nums text-zinc-400">{{ summary }}</span>
    </div>

    <label class="flex cursor-pointer items-center gap-3">
      <input
        v-model="withArrangement"
        type="checkbox"
        class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
      >
      <span class="min-w-0 flex-1 truncate leading-tight">
        <span class="font-medium text-zinc-200">Play With the Arrangement</span>
        <span class="text-zinc-500"> — hear it against what you recorded over</span>
      </span>
    </label>

    <label class="flex items-center gap-3">
      <span class="w-28 shrink-0 text-zinc-400">Backing volume</span>
      <input
        type="range"
        class="app-range min-w-0 flex-1"
        aria-label="Backing volume"
        min="0"
        max="100"
        step="1"
        :disabled="!withArrangement"
        :value="backingGainPercent"
        title="Double-click to reset to 100%"
        @input="onBackingGainChange"
        @dblclick="onBackingGainReset"
      >
      <span class="w-14 shrink-0 text-right font-mono text-xs text-zinc-400">
        {{ backingGainPercent }}%
      </span>
    </label>

    <label
      v-if="canDuplicateToStereo"
      class="flex cursor-pointer items-center gap-3"
    >
      <input
        type="checkbox"
        class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        :checked="stereoDuplicated"
        @change="onStereoChange"
      >
      <span class="min-w-0 flex-1 truncate leading-tight">
        <span class="font-medium text-zinc-200">Save as Stereo</span>
        <span class="text-zinc-500"> — the mono take on both channels</span>
      </span>
    </label>

    <label class="flex items-center gap-3">
      <span class="text-[11px] uppercase tracking-wider text-zinc-500">Name</span>
      <input
        v-model="name"
        type="text"
        class="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
      >
    </label>

    <p class="text-zinc-400">
      Adding this to the timeline places it where you recorded it — on the selected track when
      that track is empty, otherwise on a new track of its own.
    </p>

    <p
      v-if="droppedWarning"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
    >
      {{ droppedWarning }}
    </p>
  </div>
</template>
