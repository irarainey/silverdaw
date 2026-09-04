<script setup lang="ts">
// Record Audio (ADR 0030). One modal, two states: set up and roll, then review
// what was captured. A recording never touches a track until it is committed, so
// closing this dialog at any point leaves the project exactly as it was.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import RecordAudioReview from '@/components/RecordAudioReview.vue'
import RecordAudioSetup from '@/components/RecordAudioSetup.vue'
import { recordingErrorMessage } from '@/lib/recording/recordingMessages'
import {
  releaseRecordingTrack,
  resolveRecordingTrackId,
  type RecordingDestination
} from '@/lib/recording/recordingPlacement'
import { useRecordingSession } from '@/lib/recording/useRecordingSession'
import { formatTime } from '@/lib/musicTime'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useRecordingSessionStore()
const notifications = useNotificationsStore()
const open = computed(() => props.open)
const session = useRecordingSession(open)

const dialogEl = ref<HTMLDivElement | null>(null)
const name = ref('')
const commitError = ref<string | null>(null)
/** Timeline destination held for the in-flight commit, so a failure can release it. */
const pendingTrack = ref<RecordingDestination | null>(null)

const status = computed(() => store.current?.status ?? 'idle')
const isRolling = computed(() => store.isRolling)
const isReviewing = computed(() => store.isReviewing)
const isFinalising = computed(() => status.value === 'finalising')
const isCommitting = computed(() => store.commitPendingItemId !== null)
const canRecord = computed(
  () =>
    session.ready.value &&
    !store.hasNoInput &&
    store.current?.input !== null &&
    (status.value === 'idle' || status.value === 'error')
)
const canCommit = computed(
  () => isReviewing.value && !isCommitting.value && name.value.trim() !== ''
)

const rollingReadout = computed(() => {
  const state = store.current
  if (!state) return ''
  if (state.status === 'countIn') {
    const bars = state.countInBarsRemaining ?? state.countInBars
    return bars > 0 ? `Counting in — ${bars} bar${bars === 1 ? '' : 's'}` : 'Counting in…'
  }
  if (state.status === 'recording') return `Recording — ${formatTime(state.recordedMs)}`
  if (state.status === 'finalising') return 'Finishing the recording…'
  return ''
})

// Seed the name from the backend's next free "Recording N"; the user can rename
// it here, and again later as a library item or a clip.
watch(
  () => store.ready?.recordingId,
  () => {
    const suggested = store.ready?.suggestedName
    if (suggested) name.value = suggested
  }
)

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      name.value = ''
      commitError.value = null
      pendingTrack.value = null
      return
    }
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

// A commit answers on SAMPLE_SAVED: close on success, keep the recording and say
// what happened on failure so the take is not lost to a transient write error.
watch(
  () => store.commitResultSeq,
  () => {
    const result = store.commitResult
    if (!result) return
    const target = pendingTrack.value
    pendingTrack.value = null
    if (result.ok) {
      notifications.pushInfo(`Saved recording "${name.value.trim()}".`)
      emit('close')
    } else {
      if (target) releaseRecordingTrack(target)
      commitError.value = result.error ?? 'The recording could not be saved.'
    }
  }
)

function onRecordOrStop(): void {
  if (isRolling.value) session.stop()
  else if (canRecord.value) session.start()
}

function onRecordAgain(): void {
  commitError.value = null
  session.discard()
}

function onCommit(destination: 'library' | 'timeline'): void {
  if (!canCommit.value) return
  commitError.value = null
  const target = destination === 'timeline' ? resolveRecordingTrackId() : null
  const itemId = session.commit({
    name: name.value.trim(),
    destination,
    ...(target ? { trackId: target.trackId } : {})
  })
  // A refused commit never gets an ack, so release the destination right away.
  if (itemId === null) {
    if (target) releaseRecordingTrack(target)
    return
  }
  pendingTrack.value = target
}

function onClose(): void {
  // Closing mid-commit would race the SAMPLE_SAVED ack and could lose the take.
  // Mid-roll is fine and is what Cancel means: closing the session stops the
  // transport, abandons the capture and deletes the part-written file.
  if (isCommitting.value) return
  emit('close')
}

// The commit is only answered by SAMPLE_SAVED, so a lost ack would leave every
// button disabled with no way out. Give up after a while and keep the take.
const COMMIT_TIMEOUT_MS = 30_000
let commitTimer: number | null = null

function clearCommitTimer(): void {
  if (commitTimer === null) return
  window.clearTimeout(commitTimer)
  commitTimer = null
}

watch(isCommitting, (committing) => {
  clearCommitTimer()
  if (!committing) return
  const itemId = store.commitPendingItemId
  if (itemId === null) return
  commitTimer = window.setTimeout(() => {
    commitTimer = null
    store.resolveCommit(
      itemId,
      false,
      'The audio engine did not answer. Your recording is still here — try saving it again.'
    )
  }, COMMIT_TIMEOUT_MS)
})

onBeforeUnmount(clearCommitTimer)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    onClose()
    return
  }
  // R records inside this dialog only — the same claim the Scratch Editor makes,
  // so there is no global record shortcut to collide with.
  const target = event.target as HTMLElement | null
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
  if (!typing && (event.key === 'r' || event.key === 'R') && !isReviewing.value) {
    event.preventDefault()
    onRecordOrStop()
  }
}

// The dialog is the one place recording problems are shown: a failed commit
// first, then whatever the session itself is complaining about.
const errorMessage = computed(() => {
  if (commitError.value !== null) return commitError.value
  if (store.hasNoInput) return recordingErrorMessage('noInput')
  const state = store.current
  if (state?.status !== 'error') return null
  return recordingErrorMessage(state.errorCode, state.error)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-audio-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(560px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="record-audio-title"
            class="dialog-title"
          >
            Record Audio
          </h1>
        </div>

        <div class="dialog-body silverdaw-scroll">
          <RecordAudioReview
            v-if="isReviewing"
            v-model:name="name"
          />
          <RecordAudioSetup
            v-else
            :session="session"
          />

          <p
            v-if="rollingReadout"
            class="mt-4 font-mono text-sm tabular-nums text-sky-200"
          >
            {{ rollingReadout }}
          </p>
          <p
            v-if="errorMessage"
            class="mt-4 rounded border border-red-700 bg-red-900/20 px-3 py-2 text-sm text-red-200"
          >
            {{ errorMessage }}
          </p>
        </div>

        <div
          v-if="isReviewing"
          class="dialog-footer"
        >
          <button
            type="button"
            class="dialog-btn-cancel"
            :disabled="isCommitting"
            @click="onClose"
          >
            Discard
          </button>
          <button
            type="button"
            class="dialog-btn-cancel"
            :disabled="isCommitting"
            @click="onRecordAgain"
          >
            Record Again
          </button>
          <button
            type="button"
            class="dialog-btn-cancel"
            :disabled="!canCommit"
            @click="onCommit('library')"
          >
            Add to Library
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!canCommit"
            @click="onCommit('timeline')"
          >
            Add to Timeline
          </button>
        </div>
        <div
          v-else
          class="dialog-footer"
        >
          <button
            type="button"
            class="dialog-btn-cancel"
            :title="isRolling ? 'Stop recording and discard the take' : undefined"
            @click="onClose"
          >
            Cancel
          </button>
          <button
            v-if="isRolling"
            type="button"
            class="dialog-btn-primary"
            @click="onRecordOrStop"
          >
            Stop
          </button>
          <button
            v-else
            type="button"
            class="dialog-btn-primary"
            :disabled="!canRecord || isFinalising"
            @click="onRecordOrStop"
          >
            Record
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
