<script setup lang="ts">
// Record Audio, once a recording exists: hear it back, name it, and decide what
// happens to it. Nothing has been added to the project at this point, so leaving
// without committing leaves the project untouched.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import RecordAudioWaveform from '@/components/RecordAudioWaveform.vue'
import { droppedSamplesMessage } from '@/lib/recording/recordingMessages'
import { formatTime } from '@/lib/musicTime'
import { send as sendBridge } from '@/lib/bridgeService'
import { usePreviewStore } from '@/stores/previewStore'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'

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
let pendingArrangement = false

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
  // the transport — so the arrangement can only be started once the take rolls.
  pendingArrangement = withArrangement.value
  preview.loadFile(payload.filePath, true)
}

/** Roll the project from where the take was recorded, alongside the audition. */
function startArrangement(): void {
  const payload = ready.value
  if (!payload) return
  sendBridge('TRANSPORT_SEEK', { positionMs: payload.anchorMs })
  sendBridge('TRANSPORT_PLAY')
  arrangementRolling = true
}

function onStop(): void {
  preview.stop()
  stopArrangement()
}

/** Leave the timeline as the take found it: stopped, back at the record anchor. */
function stopArrangement(): void {
  pendingArrangement = false
  if (!arrangementRolling) return
  arrangementRolling = false
  sendBridge('TRANSPORT_PAUSE')
  const payload = ready.value
  if (payload) sendBridge('TRANSPORT_SEEK', { positionMs: payload.anchorMs })
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
// than leaving it running under a dialog that looks stopped.
watch(isPlayingThis, (playing) => {
  if (playing) {
    if (!pendingArrangement) return
    pendingArrangement = false
    startArrangement()
    return
  }
  stopArrangement()
})

watch(withArrangement, (on) => {
  const payload = ready.value
  // Park the playhead where the take starts so the arrangement is primed there.
  if (on && payload && !isPlayingThis.value)
    sendBridge('TRANSPORT_SEEK', { positionMs: payload.anchorMs })
  if (!on) stopArrangement()
})

onBeforeUnmount(() => releaseAudition(ready.value?.filePath ?? null))
</script>

<template>
  <div
    v-if="ready"
    class="flex flex-col gap-4"
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
      <span class="min-w-0 flex-1 truncate text-sm leading-tight">
        <span class="text-zinc-200">Play With the Arrangement</span>
        <span class="text-zinc-500"> — hear it against what you recorded over</span>
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

    <p class="text-sm text-zinc-400">
      Adding this to the timeline places it where you recorded it — on the selected track when
      that track is empty, otherwise on a new track of its own.
    </p>

    <p
      v-if="droppedWarning"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-sm text-amber-200"
    >
      {{ droppedWarning }}
    </p>
  </div>
</template>
