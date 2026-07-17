<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useScratchEditorSession } from '@/lib/scratch/useScratchEditorSession'
import { useScratchKeyboardControls } from '@/lib/scratch/useScratchKeyboardControls'
import { useScratchEditorDerived } from '@/lib/scratch/useScratchEditorDerived'
import { useScratchBacking } from '@/lib/scratch/useScratchBacking'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
import { useScratchReplay } from '@/lib/scratch/useScratchReplay'
import { useScratchRecordControl } from '@/lib/scratch/useScratchRecordControl'
import { useScratchSaveFlow } from '@/lib/scratch/useScratchSaveFlow'
import { useScratchDialogClose } from '@/lib/scratch/useScratchDialogClose'
import { useScratchReopenLifecycle } from '@/lib/scratch/useScratchReopenLifecycle'
import { useScratchPointerDispatch } from '@/lib/scratch/useScratchPointerDispatch'
import { useScratchTransportControls } from '@/lib/scratch/useScratchTransportControls'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useUiStore } from '@/stores/uiStore'
import ScratchDirtyCloseDialog from '@/components/ScratchDirtyCloseDialog.vue'
import ScratchEditorHeader from '@/components/ScratchEditorHeader.vue'
import ScratchBackingPanel from '@/components/ScratchBackingPanel.vue'
import ScratchWaveformBar from '@/components/ScratchWaveformBar.vue'
import ScratchStagePanel from '@/components/ScratchStagePanel.vue'
import ScratchControlRail from '@/components/ScratchControlRail.vue'
import ScratchEditorFooter from '@/components/ScratchEditorFooter.vue'
import ScratchSaveProgressOverlay from '@/components/ScratchSaveProgressOverlay.vue'

const props = defineProps<{
  open: boolean
  clipId: string | null
  libraryItemId?: string | null
}>()
const emit = defineEmits<{ (event: 'close'): void }>()

const ui = useUiStore()
const project = useProjectStore()
const library = useLibraryStore()
const scratchStore = useScratchSessionStore()
const dialogEl = ref<HTMLDivElement | null>(null)
// A session edits either a timeline clip or a whole library item. The library
// item id doubles as the session identity, so both paths key on a single id.
const sourceId = computed(() => props.clipId ?? props.libraryItemId ?? null)
const source = computed(() =>
  sourceId.value === null ? null : { id: sourceId.value, isLibrary: props.clipId === null }
)
const isDialogOpen = computed(() => props.open && sourceId.value !== null)
useFocusTrap(dialogEl, isDialogOpen)

const session = useScratchEditorSession(computed(() => props.open), source)
const derived = useScratchEditorDerived(sourceId, session)
const backing = useScratchBacking(session.activeSessionId, session.state, sourceId)
const persistence = useScratchPatternPersistence(session.activeSessionId)

const replay = useScratchReplay({
  canControl: session.canControl,
  sessionState: session.state,
  savedPatterns: computed(() => project.savedScratchPatterns),
  startPatternReplay: (pattern) => project.startPatternReplay(pattern),
  stopPatternReplay: () => project.stopPatternReplay()
})
const keyboardCutVisualValue = ref<number | null>(null)
const usesVirtualCrossfader = computed(() => {
  const selectedDeck = session.state.value?.selectedDeck
  return selectedDeck !== 1 && selectedDeck !== 2
})
const virtualCutControlsEnabled = computed(
  () => replay.controlsEnabled.value && usesVirtualCrossfader.value
)
const displayCrossfaderValue = computed(
  () => keyboardCutVisualValue.value ?? derived.crossfaderValue.value
)

watch(
  () => replay.controlsEnabled.value,
  (enabled) => {
    if (!enabled) keyboardCutVisualValue.value = null
  }
)
watch(
  () => session.state.value?.crossfader,
  (value) => {
    if (
      value !== undefined
      && keyboardCutVisualValue.value !== null
      && Math.abs(value - keyboardCutVisualValue.value) <= 0.001
    ) {
      keyboardCutVisualValue.value = null
    }
  }
)
watch(usesVirtualCrossfader, () => {
  keyboardCutVisualValue.value = null
})

useScratchKeyboardControls({
  activeSessionId: session.activeSessionId,
  canControl: virtualCutControlsEnabled,
  selectedDeck: computed(() => session.state.value?.selectedDeck),
  sendControl: session.sendControl,
  buildBacking: backing.prepare,
  onCrossfaderCutValueChange: (value) => {
    keyboardCutVisualValue.value = value
  }
})

const saveFlow = useScratchSaveFlow({
  sessionId: session.activeSessionId,
  hasPattern: derived.hasPattern,
  clipId: computed(() => props.clipId),
  libraryItemId: computed(() => props.libraryItemId),
  sourceItemId: derived.sourceItemId,
  clipInMs: derived.clipInMs,
  waveformDurationMs: derived.waveformDurationMs,
  project,
  scratch: scratchStore,
  persistence,
  // Bypasses the dirty-close prompt — a successful bake always closes immediately.
  onSaved: () => performClose()
})

const preparationPercent = computed(() =>
  Math.round((session.state.value?.preparationProgress ?? 0) * 100)
)

function startDraftReplay(): void {
  if (scratchStore.completedPattern) replay.startReplay(scratchStore.completedPattern)
}

// Stop any audition and drop the in-memory recording, without touching the
// notation-persistence state (used both to arm a fresh take and by Clear).
function discardRecordingAudio(): void {
  replay.stopReplay()
  scratchStore.clearRecording()
}

// Discard the freshly recorded (unsaved) draft so the notation panel returns to
// its empty state, ready for a new take. Saved patterns are untouched.
function clearDraft(): void {
  discardRecordingAudio()
  persistence.reset()
}

const recordControl = useScratchRecordControl({
  isRecording: derived.isRecording,
  isArmed: derived.isArmed,
  canRecord: derived.canRecord,
  isPatternReplaying: replay.isPatternReplaying,
  hasDraft: computed(() => derived.hasPattern.value || Boolean(scratchStore.completedPattern)),
  armRecording: () => session.armRecording(),
  disarmRecording: () => session.disarmRecording(),
  stopRecording: () => session.stopRecording(),
  discardDraft: discardRecordingAudio
})

const pointerDispatch = useScratchPointerDispatch({
  activeSessionId: session.activeSessionId,
  controlsEnabled: replay.controlsEnabled,
  sendControl: session.sendControl
})

function onCrossfaderChange(value: number): void {
  pointerDispatch.onCrossfaderChange(value)
}

const transport = useScratchTransportControls({
  activeSessionId: session.activeSessionId,
  canControl: session.canControl,
  backingReady: backing.isReady,
  isRecording: derived.isRecording,
  isPatternReplaying: replay.isPatternReplaying,
  togglePlayback: session.togglePlayback,
  sendControl: session.sendControl
})

// ── Reconcile authoritative ack from PROJECT_STATE ───────────────────────────
watch(
  () => project.savedScratchPatterns,
  () => persistence.reconcileSnapshot()
)

// ── Saved-scratch re-open (loads once the backend session is ready) ─────────
const reopen = useScratchReopenLifecycle({
  open: computed(() => props.open),
  libraryItemId: computed(() => props.libraryItemId),
  activeSessionId: session.activeSessionId,
  savedPatterns: computed(() => project.savedScratchPatterns),
  getSavedScratchPatternId: (itemId) => library.byId[itemId]?.scratchPatternId ?? null,
  selectAndLoad: (patternId) => persistence.selectAndLoad(patternId)
})

// ── Dialog close orchestration ───────────────────────────────────────────────
function resetLocalDialogState(): void {
  saveFlow.reset()
  reopen.clearPending()
  replay.stopReplay()
  persistence.reset()
}

function performClose(): void {
  resetLocalDialogState()
  session.close()
  emit('close')
}

const close = useScratchDialogClose({
  isDirty: persistence.isDirty,
  isCloseSavePending: persistence.isCloseSavePending,
  saveError: persistence.saveError,
  closeSaveAcknowledged: persistence.closeSaveAcknowledged,
  saveAndClose: () => persistence.saveAndClose(),
  dismissCloseSaveError: () => persistence.dismissCloseSaveError(),
  performClose
})

// ── Focus/open lifecycle ─────────────────────────────────────────────────────
watch(
  () => props.open,
  async (open) => {
    ui.clipEditorOpen = open
    if (open) {
      persistence.reset()
      saveFlow.reset()
      await nextTick()
      dialogEl.value?.focus()
    } else {
      // Project replacement can close the store externally rather than through
      // performClose(); keep replay/save/reopen state clean for the next session.
      resetLocalDialogState()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
  replay.stopReplay()
  ui.clipEditorOpen = false
})

function onKeydown(event: KeyboardEvent): void {
  if (!isDialogOpen.value) return

  const target = event.target
  const editingText = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
  const canUseScratchShortcut = !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !editingText
    && !close.dirtyClosePromptOpen.value
  const scratchShortcut = !event.repeat
    && canUseScratchShortcut

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (saveFlow.savePhase.value === 'saving') return
    if (saveFlow.savePhase.value === 'error') {
      saveFlow.dismissSaveError()
    } else if (close.dirtyClosePromptOpen.value) {
      close.onDirtyCloseCancel()
    } else {
      close.requestClose()
    }
  } else if ((event.key === ' ' || event.code === 'Space') && session.canControl.value && !close.dirtyClosePromptOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    transport.onTogglePlay()
  } else if ((event.key === 'r' || event.key === 'R') && scratchShortcut) {
    event.preventDefault()
    event.stopPropagation()
    recordControl.onRecordButton()
  } else if ((event.key === 'p' || event.key === 'P') && scratchShortcut && derived.hasPattern.value) {
    event.preventDefault()
    event.stopPropagation()
    if (replay.isPatternReplaying.value) {
      replay.stopReplay()
    } else {
      startDraftReplay()
    }
  } else if (
    (event.key === 'c' || event.key === 'C')
    && scratchShortcut
    && derived.hasPattern.value
    && !replay.isPatternReplaying.value
  ) {
    event.preventDefault()
    event.stopPropagation()
    clearDraft()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, { capture: true })
})
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
      v-if="open && sourceId"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scratch-editor-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card h-[min(960px,96vh)] max-h-[96vh]! w-[min(1400px,96vw)]"
      >
        <ScratchEditorHeader
          :clip-name="derived.clipName.value"
          :deck-label="derived.deckLabel.value"
          :is-dirty="persistence.isDirty.value"
        />

        <div class="dialog-body flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <ScratchBackingPanel
            v-if="session.state.value && !derived.statusMessage.value"
            :backing="backing"
            :disabled="derived.isRecording.value || replay.isPatternReplaying.value"
            :monitor-disabled="replay.isPatternReplaying.value"
            :is-playing="session.isPlaying.value"
            :transport-enabled="transport.transportEnabled.value"
            @skip-to-start="transport.onSkipToStart"
            @toggle-play="transport.onTogglePlay"
          />
          <div class="w-full">
            <ScratchWaveformBar
              :peaks="derived.peaks.value"
              :peaks-per-second="derived.peaksPerSecond.value"
              :channel-peaks="derived.channelPeaks.value"
              :channel-peaks-per-second="derived.channelPeaksPerSecond.value"
              :source-duration-ms="derived.waveformDurationMs.value"
              :prepared-duration-ms="session.state.value?.durationUs
                ? session.state.value.durationUs / 1000
                : derived.waveformDurationMs.value"
              :in-ms="derived.clipInMs.value"
              :reversed="derived.clipReversed.value"
              :source-bpm="derived.sourceBpm.value"
              :beat-anchor-sec="derived.beatAnchorSec.value"
              :position-ms="derived.positionMs.value"
              :is-playing="session.isPlaying.value"
              :playback-rate="session.state.value?.playbackRate ?? 0"
            />
          </div>

          <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_14rem] gap-4">
            <ScratchStagePanel
              :status-message="derived.statusMessage.value"
              :is-error="derived.isError.value"
              :is-preparing="session.state.value?.status === 'preparing'"
              :preparation-percent="preparationPercent"
              :is-recording="derived.isRecording.value"
              :has-completed-recording="derived.recordingStatus.value === 'completed'"
              :is-armed="recordControl.recordPhase.value === 'armed'"
              :session-id="session.activeSessionId.value"
              :notation-replay-position-normalized="replay.notationReplayPositionNormalized.value"
            />

            <ScratchControlRail
              :scratch-gain="backing.scratchGain.value"
              :scratch-gain-disabled="!session.canControl.value"
              :platter-turns="derived.platterTurns.value"
              :platter-touched="derived.isTouched.value"
              :platter-disabled="!replay.controlsEnabled.value"
              :crossfader-value="displayCrossfaderValue"
              :crossfader-reversed="derived.crossfaderReversed.value"
              :crossfader-disabled="!replay.controlsEnabled.value"
              :record-phase="recordControl.recordPhase.value"
              :record-button-label="recordControl.recordButtonLabel.value"
              :record-button-class="recordControl.recordButtonClass.value"
              :record-button-aria-label="recordControl.recordButtonAriaLabel.value"
              :record-disabled="recordControl.recordButtonDisabled.value"
              :has-pattern="derived.hasPattern.value"
              :is-pattern-replaying="replay.isPatternReplaying.value"
              @scratch-gain="backing.setScratchGain"
              @platter-touch="pointerDispatch.onPlatterTouch"
              @platter-move="pointerDispatch.onPlatterMove"
              @crossfader-change="onCrossfaderChange"
              @record="recordControl.onRecordButton"
              @play-toggle="replay.isPatternReplaying.value ? replay.stopReplay() : startDraftReplay()"
              @clear="clearDraft"
            />
          </div>
        </div>

        <ScratchEditorFooter
          :saving="saveFlow.savePhase.value === 'saving'"
          :has-pattern="derived.hasPattern.value"
          @cancel="close.requestClose"
          @save="saveFlow.onSave"
        />
      </div>

      <ScratchDirtyCloseDialog
        v-if="close.showDirtyCloseDialog.value"
        :persistence="persistence"
        @save="close.onDirtyCloseSave"
        @discard="close.onDirtyCloseDiscard"
        @cancel="close.onDirtyCloseCancel"
      />

      <ScratchSaveProgressOverlay
        :phase="saveFlow.savePhase.value"
        :error-message="saveFlow.saveErrorMsg.value"
        @dismiss="saveFlow.dismissSaveError"
        @retry="saveFlow.onSave"
      />
    </div>
  </Transition>
</template>
