// Single record button state machine (arm → first-touch start → stop). Pure
// derivation from session status plus the button label/class/aria text — no
// bridge or store access of its own.

import { computed, type ComputedRef, type Ref } from 'vue'

export type ScratchRecordPhase = 'idle' | 'armed' | 'recording'

export interface ScratchRecordControlOptions {
  isRecording: Ref<boolean>
  isArmed: Ref<boolean>
  canRecord: Ref<boolean>
  /** Whether an existing (unsaved) draft would be discarded by arming a fresh take. */
  hasDraft: Ref<boolean>
  armRecording(): void
  disarmRecording(): void
  stopRecording(): void
  /** Discards the existing draft (stops any audition, clears the recording) before arming. */
  discardDraft(): void
}

export interface ScratchRecordControl {
  recordPhase: ComputedRef<ScratchRecordPhase>
  recordButtonLabel: ComputedRef<string>
  recordButtonClass: ComputedRef<string>
  recordButtonAriaLabel: ComputedRef<string>
  onRecordButton(): void
}

export function useScratchRecordControl(
  options: ScratchRecordControlOptions
): ScratchRecordControl {
  const { isRecording, isArmed, canRecord, hasDraft, armRecording, disarmRecording, stopRecording, discardDraft } =
    options

  const recordPhase = computed<ScratchRecordPhase>(() => {
    if (isRecording.value) return 'recording'
    if (isArmed.value) return 'armed'
    return 'idle'
  })

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

  function onRecordButton(): void {
    if (!canRecord.value && recordPhase.value === 'idle') return
    if (recordPhase.value === 'recording') {
      stopRecording()
    } else if (recordPhase.value === 'armed') {
      disarmRecording()
    } else {
      // Starting a fresh take: discard any existing scratch first so the new
      // recording replaces it cleanly instead of leaving the old notation on screen.
      if (hasDraft.value) discardDraft()
      armRecording()
    }
  }

  return { recordPhase, recordButtonLabel, recordButtonClass, recordButtonAriaLabel, onRecordButton }
}
