<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { useScratchEditorSession } from '@/lib/scratch/useScratchEditorSession'
import { useScratchKeyboardControls } from '@/lib/scratch/useScratchKeyboardControls'
import { useScratchEditorDerived } from '@/lib/scratch/useScratchEditorDerived'
import { useScratchBacking } from '@/lib/scratch/useScratchBacking'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useUiStore } from '@/stores/uiStore'
import ScratchCrossfader from '@/components/ScratchCrossfader.vue'
import ScratchDirtyCloseDialog from '@/components/ScratchDirtyCloseDialog.vue'
import ScratchNotationEditor from '@/components/ScratchNotationEditor.vue'
import ScratchBackingPanel from '@/components/ScratchBackingPanel.vue'
import ScratchVinylDeck from '@/components/ScratchVinylDeck.vue'
import ScratchWaveformBar from '@/components/ScratchWaveformBar.vue'
import {
  buildCrossfaderPayload,
  buildPlatterMovePayload,
  buildPlatterTouchPayload,
  buildSeekPayload,
  VIRTUAL_DECK
} from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  open: boolean
  clipId: string | null
  libraryItemId?: string | null
}>()
const emit = defineEmits<{ (event: 'close'): void }>()

const ui = useUiStore()
const project = useProjectStore()
const scratchStore = useScratchSessionStore()
const dialogEl = ref<HTMLDivElement | null>(null)
// A session edits either a timeline clip or a whole library item. The library
// item id doubles as the session identity, so both paths key on a single id.
const sourceId = computed(() => props.clipId ?? props.libraryItemId ?? null)
const source = computed(() =>
  sourceId.value === null
    ? null
    : { id: sourceId.value, isLibrary: props.clipId === null }
)
const isDialogOpen = computed(() => props.open && sourceId.value !== null)
useFocusTrap(dialogEl, isDialogOpen)

const session = useScratchEditorSession(
  computed(() => props.open),
  source
)

const derived = useScratchEditorDerived(sourceId, session)
const backing = useScratchBacking(
  session.activeSessionId,
  session.state,
  sourceId
)
const persistence = useScratchPatternPersistence(session.activeSessionId)

useScratchKeyboardControls({
  activeSessionId: session.activeSessionId,
  canControl: session.canControl,
  sendControl: session.sendControl
})

// Footer Save persists the recorded scratch notation: it updates the existing
// saved pattern when one is loaded, otherwise saves a new one. Only meaningful
// once a scratch has actually been recorded.
function onSave(): void {
  if (!derived.hasPattern.value) return
  if (scratchStore.savedPatternId !== null) persistence.updatePattern()
  else persistence.savePattern()
}
const preparationPercent = computed(() =>
  Math.round((session.state.value?.preparationProgress ?? 0) * 100)
)
const isPatternReplaying = ref(false)
let replayStopTimer: ReturnType<typeof setTimeout> | null = null

function clearReplayTimer(): void {
  if (replayStopTimer !== null) {
    clearTimeout(replayStopTimer)
    replayStopTimer = null
  }
}

function startReplay(pattern: string | ScratchPattern): void {
  const replayPattern = typeof pattern === 'string'
    ? project.savedScratchPatterns.find((saved) => saved.id === pattern)
    : pattern
  if (!replayPattern) return

  clearReplayTimer()
  project.startPatternReplay(pattern)
  isPatternReplaying.value = true
  const replayDurationMs = Math.max(
    1,
    Math.ceil((replayPattern.cropEndUs - replayPattern.cropStartUs) / 1000)
  )
  replayStopTimer = setTimeout(() => stopReplay(), replayDurationMs + 50)
}

function startDraftReplay(): void {
  if (scratchStore.completedPattern) startReplay(scratchStore.completedPattern)
}

// Discard the freshly recorded (unsaved) draft so the notation panel returns to
// its empty state, ready for a new take. Saved patterns are untouched.
function clearDraft(): void {
  stopReplay()
  persistence.reset()
  scratchStore.clearRecording()
}

function stopReplay(): void {
  clearReplayTimer()
  if (isPatternReplaying.value) project.stopPatternReplay()
  isPatternReplaying.value = false
}

// Notation playhead position (0..1 across the replayed crop window) while the
// draft/pattern is auditioning. Null hides the playhead the moment replay stops,
// independent of any trailing backend state.
const notationReplayPositionNormalized = computed<number | null>(() =>
  isPatternReplaying.value
    ? session.state.value?.replayPositionNormalized ?? null
    : null
)

// ── Dirty-close confirmation ─────────────────────────────────────────────────

const dirtyClosePromptOpen = ref(false)

function requestClose(): void {
  if (persistence.isDirty.value) {
    dirtyClosePromptOpen.value = true
    return
  }
  doClose()
}

function doClose(): void {
  dirtyClosePromptOpen.value = false
  stopReplay()
  persistence.reset()
  session.close()
  emit('close')
}

function onDirtyCloseSave(): void {
  dirtyClosePromptOpen.value = false
  persistence.saveAndClose()
}

watch(
  () => persistence.closeSaveAcknowledged.value,
  (acked) => {
    if (acked) doClose()
  }
)

function onDirtyCloseDiscard(): void {
  doClose()
}

function onDirtyCloseCancel(): void {
  dirtyClosePromptOpen.value = false
  persistence.dismissCloseSaveError()
}


// ── Reconcile authoritative ack from PROJECT_STATE ───────────────────────────

watch(
  () => project.savedScratchPatterns,
  () => persistence.reconcileSnapshot()
)

// ── Lifecycle ────────────────────────────────────────────────────────────────

watch(
  () => props.open,
  async (open) => {
    ui.clipEditorOpen = open
    if (open) {
      persistence.reset()
      await nextTick()
      dialogEl.value?.focus()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  stopReplay()
  ui.clipEditorOpen = false
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (dirtyClosePromptOpen.value) {
      onDirtyCloseCancel()
    } else {
      requestClose()
    }
  } else if ((event.key === ' ' || event.code === 'Space') && session.canControl.value && !dirtyClosePromptOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    if (isPatternReplaying.value) stopReplay()
    else if (transportEnabled.value) session.togglePlayback()
  } else if (
    (event.key === 'r' || event.key === 'R') &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !dirtyClosePromptOpen.value
  ) {
    event.preventDefault()
    event.stopPropagation()
    onRecordButton()
  }
}

function onPlatterTouch(touched: boolean): void {
  const sid = session.activeSessionId.value
  if (!sid || !session.canControl.value) return
  session.sendControl(buildPlatterTouchPayload(sid, VIRTUAL_DECK, touched))
}

function onPlatterMove(deltaTurns: number): void {
  const sid = session.activeSessionId.value
  if (!sid || !session.canControl.value) return
  session.sendControl(buildPlatterMovePayload(sid, VIRTUAL_DECK, deltaTurns))
}

function onCrossfaderChange(value: number): void {
  const sid = session.activeSessionId.value
  if (!sid || !session.canControl.value) return
  session.sendControl(buildCrossfaderPayload(sid, value))
}

// ── Backing transport (drives the backing channel only) ──────────────────────

// The play/pause and skip controls (and Space) run the prepared backing bed;
// they never spin the scratch clip, which is heard only when jogged. Disabled
// until a backing is prepared, and during recording (which owns playback).
const transportEnabled = computed(
  () => session.canControl.value
    && backing.isReady.value
    && !derived.isRecording.value
    && !isPatternReplaying.value
)

function onSkipToStart(): void {
  const sid = session.activeSessionId.value
  if (!sid || !transportEnabled.value) return
  session.sendControl(buildSeekPayload(sid, 0))
}

function onTogglePlay(): void {
  if (isPatternReplaying.value) stopReplay()
  else if (transportEnabled.value) session.togglePlayback()
}

// ── Single record control (arm → first-touch start → stop) ───────────────────

const recordPhase = computed<'idle' | 'armed' | 'recording'>(() => {
  if (derived.isRecording.value) return 'recording'
  if (derived.isArmed.value) return 'armed'
  return 'idle'
})

function onRecordButton(): void {
  if (!derived.canRecord.value && recordPhase.value === 'idle') return
  if (recordPhase.value === 'recording') session.stopRecording()
  else if (recordPhase.value === 'armed') session.disarmRecording()
  else session.armRecording()
}

const recordButtonLabel = computed(() => {
  if (recordPhase.value === 'recording') return 'Stop'
  if (recordPhase.value === 'armed') return 'Cancel'
  return 'Record'
})

const recordButtonClass = computed(() => {
  if (recordPhase.value === 'recording') return 'bg-red-600 text-white hover:bg-red-700'
  if (recordPhase.value === 'armed') return 'bg-amber-600 text-white hover:bg-amber-700'
  return 'bg-red-700 text-white hover:bg-red-600'
})

const recordButtonAriaLabel = computed(() => {
  if (recordPhase.value === 'recording') return 'Stop recording'
  if (recordPhase.value === 'armed') return 'Cancel record arming'
  return 'Arm scratch recording'
})

// Scratch monitor level lives with the deck it trims (not the backing panel).
// Monitor-only; never baked into the recorded pattern, mixdown, or export.
const scratchPct = computed(() => `${Math.round(backing.scratchGain.value * 100)}%`)

function onScratchGain(event: Event): void {
  backing.setScratchGain((event.target as HTMLInputElement).valueAsNumber)
}
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
        class="dialog-card h-[min(960px,96vh)] !max-h-[96vh] w-[min(1400px,96vw)]"
        @keydown="onKeydown"
      >
        <header class="dialog-header flex items-baseline gap-3">
          <h2
            id="scratch-editor-title"
            class="dialog-title"
          >
            Scratch Editor
          </h2>
          <span
            v-if="derived.clipName.value"
            class="text-xs text-zinc-400"
          >{{ derived.clipName.value }}</span>
          <span
            v-if="derived.deckLabel.value"
            class="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
          >{{ derived.deckLabel.value }}</span>
          <span
            v-if="persistence.isSaved.value && !persistence.isDirty.value"
            class="ml-1 text-[10px] text-emerald-400"
          >Saved</span>
          <span
            v-if="persistence.isSavePending.value"
            class="ml-1 text-[10px] text-zinc-500"
          >Saving…</span>
        </header>

        <div class="dialog-body flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <ScratchBackingPanel
            v-if="session.state.value && !derived.statusMessage.value"
            :backing="backing"
            :disabled="derived.isRecording.value || isPatternReplaying"
            :is-playing="session.isPlaying.value"
            :transport-enabled="transportEnabled"
            @skip-to-start="onSkipToStart"
            @toggle-play="onTogglePlay"
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
            <div class="flex min-w-0 min-h-0 flex-col gap-2 overflow-hidden">
              <template v-if="derived.statusMessage.value">
                <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
                  <div class="w-full max-w-sm px-6 text-center">
                    <p
                      class="text-xs"
                      :class="derived.isError.value ? 'text-red-400' : 'text-zinc-400'"
                      :role="derived.isError.value ? 'alert' : 'status'"
                    >
                      {{ derived.statusMessage.value }}
                    </p>
                    <div
                      v-if="session.state.value?.status === 'preparing'"
                      class="mt-3"
                    >
                      <div
                        class="h-1.5 overflow-hidden rounded-full bg-zinc-800"
                        role="progressbar"
                        aria-label="Preparing audio for scratching"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        :aria-valuenow="preparationPercent"
                      >
                        <div
                          class="h-full rounded-full bg-sky-500 transition-[width] duration-150"
                          :style="{ width: `${preparationPercent}%` }"
                        />
                      </div>
                      <p class="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
                        {{ preparationPercent }}%
                      </p>
                    </div>
                  </div>
                </div>
              </template>
              <template v-else>
                <!-- Notation content by phase -->
                <template v-if="derived.isRecording.value">
                  <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
                    <span
                      class="inline-flex items-center gap-1.5 text-xs text-red-400"
                      role="status"
                    >
                      <span
                        class="h-2 w-2 animate-pulse rounded-full bg-red-500"
                        aria-hidden="true"
                      />
                      Recording…
                    </span>
                  </div>
                </template>
                <template v-else-if="derived.recordingStatus.value === 'completed'">
                  <div class="flex min-h-0 flex-1 flex-col overflow-auto">
                    <ScratchNotationEditor
                      class="min-h-0 flex-1"
                      :session-id="session.activeSessionId.value"
                      :replay-position-normalized="notationReplayPositionNormalized"
                    />
                  </div>
                </template>
                <template v-else>
                  <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
                    <div class="text-center">
                      <template v-if="recordPhase === 'armed'">
                        <p
                          class="text-xs text-amber-400"
                          role="status"
                        >
                          Armed — touch the platter to start recording
                        </p>
                      </template>
                      <template v-else>
                        <p class="text-xs text-zinc-500">
                          No scratch recorded
                        </p>
                        <p class="text-[10px] text-zinc-600">
                          Press Record, then touch the platter to begin
                        </p>
                      </template>
                    </div>
                  </div>
                </template>
              </template>
            </div>

            <div class="flex min-h-0 min-w-0 flex-col items-stretch gap-3">
              <div class="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
                <span class="text-[11px] text-zinc-500">Scratch</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  class="h-1 flex-1 cursor-pointer accent-sky-500 outline-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  :value="backing.scratchGain.value"
                  :disabled="!session.canControl.value"
                  aria-label="Scratch monitor level"
                  @input="onScratchGain"
                >
                <span class="w-8 text-right font-mono text-[10px] tabular-nums text-zinc-400">{{ scratchPct }}</span>
              </div>
              <div class="flex items-center justify-center">
                <ScratchVinylDeck
                  :platter-turns="derived.platterTurns.value"
                  :touched="derived.isTouched.value"
                  :disabled="!session.canControl.value"
                  @platter-touch="onPlatterTouch"
                  @platter-move="onPlatterMove"
                />
              </div>
              <div class="flex justify-center">
                <div class="w-1/2">
                  <ScratchCrossfader
                    :value="derived.crossfaderValue.value"
                    :reversed="derived.crossfaderReversed.value"
                    :disabled="!session.canControl.value"
                    @change="onCrossfaderChange"
                  />
                </div>
              </div>

              <!-- Record + draft controls, pinned to the bottom so the row aligns
                   with the foot of the notation panel. Play and Clear act on the
                   recorded scratch draft and stay disabled until one exists. -->
              <div class="mt-auto mb-[3px] flex items-stretch gap-1">
                <button
                  type="button"
                  class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  :class="recordButtonClass"
                  :disabled="!derived.canRecord.value && recordPhase === 'idle'"
                  :aria-label="recordButtonAriaLabel"
                  title="Toggle record (R)"
                  @click="onRecordButton"
                >
                  <span
                    class="h-2 w-2 rounded-full"
                    :class="recordPhase === 'idle' ? 'bg-red-400' : 'animate-pulse bg-white'"
                    aria-hidden="true"
                  />
                  {{ recordButtonLabel }}
                </button>
                <button
                  type="button"
                  class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded bg-blue-600 px-2 py-1 text-xs font-medium text-zinc-50 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  :disabled="!derived.hasPattern.value"
                  :aria-label="isPatternReplaying ? 'Stop scratch playback' : 'Play scratch'"
                  @click="isPatternReplaying ? stopReplay() : startDraftReplay()"
                >
                  {{ isPatternReplaying ? 'Stop' : 'Play' }}
                </button>
                <button
                  type="button"
                  class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded bg-blue-600 px-2 py-1 text-xs font-medium text-zinc-50 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  :disabled="!derived.hasPattern.value"
                  aria-label="Clear recorded scratch"
                  title="Discard the recorded scratch"
                  @click="clearDraft"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer class="dialog-footer justify-end gap-2">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="requestClose"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!derived.hasPattern.value"
            @click="onSave"
          >
            Save
          </button>
        </footer>
      </div>

      <ScratchDirtyCloseDialog
        v-if="dirtyClosePromptOpen || persistence.isCloseSavePending.value || persistence.saveError.value"
        :persistence="persistence"
        @save="onDirtyCloseSave"
        @discard="onDirtyCloseDiscard"
        @cancel="onDirtyCloseCancel"
      />
    </div>
  </Transition>
</template>
