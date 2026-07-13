<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useScratchEditorSession } from '@/lib/scratch/useScratchEditorSession'
import { useScratchEditorDerived } from '@/lib/scratch/useScratchEditorDerived'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useUiStore } from '@/stores/uiStore'
import ScratchCrossfader from '@/components/ScratchCrossfader.vue'
import ScratchDeleteConfirmDialog from '@/components/ScratchDeleteConfirmDialog.vue'
import ScratchDirtyCloseDialog from '@/components/ScratchDirtyCloseDialog.vue'
import ScratchNotationEditor from '@/components/ScratchNotationEditor.vue'
import ScratchPersistencePanel from '@/components/ScratchPersistencePanel.vue'
import ScratchTransportBar from '@/components/ScratchTransportBar.vue'
import ScratchVinylDeck from '@/components/ScratchVinylDeck.vue'
import ScratchWaveformBar from '@/components/ScratchWaveformBar.vue'
import {
  buildCrossfaderPayload,
  buildPlatterMovePayload,
  buildPlatterTouchPayload,
  VIRTUAL_DECK
} from '@/lib/scratch/scratchControlHelpers'

const props = defineProps<{
  open: boolean
  clipId: string | null
}>()
const emit = defineEmits<{ (event: 'close'): void }>()

const ui = useUiStore()
const project = useProjectStore()
const scratchStore = useScratchSessionStore()
const dialogEl = ref<HTMLDivElement | null>(null)
const isDialogOpen = computed(() => props.open && props.clipId !== null)
useFocusTrap(dialogEl, isDialogOpen)

const session = useScratchEditorSession(
  computed(() => props.open),
  computed(() => props.clipId)
)

const derived = useScratchEditorDerived(computed(() => props.clipId), session)
const persistence = useScratchPatternPersistence(session.activeSessionId)

const canSave = computed(() => derived.hasPattern.value && persistence.isDirty.value)
const canUpdate = computed(
  () => derived.hasPattern.value && persistence.isDirty.value && scratchStore.savedPatternId !== null
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

// ── Delete confirmation ──────────────────────────────────────────────────────

const deleteConfirmId = ref<string | null>(null)

function confirmDelete(patternId: string): void {
  deleteConfirmId.value = patternId
}

function executeDelete(): void {
  if (deleteConfirmId.value) {
    persistence.deletePattern(deleteConfirmId.value)
  }
  deleteConfirmId.value = null
}

function cancelDelete(): void {
  deleteConfirmId.value = null
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
    session.togglePlayback()
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
      v-if="open && clipId"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scratch-editor-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card h-[min(900px,94vh)] w-[min(1400px,96vw)]"
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
            v-if="persistence.isSaved.value && !persistence.isDirty.value"
            class="ml-1 text-[10px] text-emerald-400"
          >Saved</span>
          <span
            v-else-if="persistence.isDirty.value"
            class="ml-1 text-[10px] text-amber-400"
          >Unsaved changes</span>
          <span
            v-if="persistence.isSavePending.value"
            class="ml-1 text-[10px] text-zinc-500"
          >Saving…</span>
        </header>

        <div class="dialog-body flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <ScratchWaveformBar
            :peaks="derived.peaks.value"
            :peaks-per-second="derived.peaksPerSecond.value"
            :duration-ms="derived.waveformDurationMs.value"
            :in-ms="derived.clipInMs.value"
            :reversed="derived.clipReversed.value"
            :position-ms="derived.positionMs.value"
          />

          <div class="flex min-h-0 flex-1 gap-4">
            <div class="flex min-h-0 flex-1 flex-col gap-2">
              <template v-if="derived.statusMessage.value">
                <div class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-800">
                  <p
                    class="text-xs"
                    :class="derived.isError.value ? 'text-red-400' : 'text-zinc-400'"
                    :role="derived.isError.value ? 'alert' : 'status'"
                  >
                    {{ derived.statusMessage.value }}
                  </p>
                </div>
              </template>
              <template v-else-if="derived.isRecording.value">
                <div class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-800">
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
                <ScratchNotationEditor :session-id="session.activeSessionId.value" />
              </template>
              <template v-else>
                <div class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-800">
                  <div class="text-center">
                    <p class="text-xs text-zinc-500">
                      No notation recorded
                    </p>
                    <p class="text-[10px] text-zinc-600">
                      Record a scratch performance to see it here.
                    </p>
                  </div>
                </div>
              </template>

              <ScratchPersistencePanel
                v-if="derived.hasPattern.value"
                :persistence="persistence"
                :can-save="canSave"
                :can-update="canUpdate"
                @confirm-delete="confirmDelete"
              />
            </div>

            <div class="flex h-full shrink-0 flex-row items-stretch gap-3 py-2">
              <ScratchCrossfader
                :value="derived.crossfaderValue.value"
                :disabled="!session.canControl.value"
                @change="onCrossfaderChange"
              />
              <div class="flex w-56 items-center justify-center">
                <ScratchVinylDeck
                  :platter-turns="derived.platterTurns.value"
                  :touched="derived.isTouched.value"
                  :disabled="!session.canControl.value"
                  @platter-touch="onPlatterTouch"
                  @platter-move="onPlatterMove"
                />
              </div>
            </div>
          </div>

          <ScratchTransportBar
            :position-us="session.state.value?.positionUs ?? 0"
            :duration-us="session.state.value?.durationUs ?? 0"
            :playback-rate="session.state.value?.playbackRate ?? 1"
            :is-touched="derived.isTouched.value"
          />
        </div>

        <footer class="dialog-footer justify-end gap-2">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="requestClose"
          >
            Close
          </button>
          <button
            type="button"
            class="rounded px-3 py-1 text-xs font-medium transition-colors"
            :class="derived.isRecording.value
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'"
            :disabled="!derived.canRecord.value"
            :aria-label="derived.isRecording.value ? 'Stop recording' : 'Record scratch'"
            @click="session.toggleRecording"
          >
            {{ derived.isRecording.value ? 'Stop Recording' : 'Record' }}
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!session.canControl.value"
            :aria-label="session.isPlaying.value ? 'Pause scratch preview' : 'Play scratch preview'"
            @click="session.togglePlayback"
          >
            {{ session.isPlaying.value ? 'Pause' : 'Play' }}
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

      <ScratchDeleteConfirmDialog
        :open="deleteConfirmId !== null"
        @confirm="executeDelete"
        @cancel="cancelDelete"
      />
    </div>
  </Transition>
</template>
