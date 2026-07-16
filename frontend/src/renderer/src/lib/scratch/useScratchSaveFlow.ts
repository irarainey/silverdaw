// Footer Save orchestration: persists the recorded scratch notation AND bakes
// it into a frozen library sample (a draggable timeline clip). Updates the
// existing saved pattern/library item when one is loaded, otherwise creates
// new ones. See ScratchEditorDialog for the surrounding open/close lifecycle.

import { ref, watch, type Ref } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'
import type { useProjectStore } from '@/stores/projectStore'
import type { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type { ScratchPatternPersistence } from './scratchPersistenceTypes'

export type ScratchSavePhase = 'idle' | 'saving' | 'error'

export interface ScratchSaveFlowOptions {
  sessionId: Ref<string | null>
  hasPattern: Ref<boolean>
  /** The opened clip id, when editing a timeline clip rather than a library item. */
  clipId: Ref<string | null>
  libraryItemId: Ref<string | null | undefined>
  /** Resolved source item that actually carries the displayed peaks, when known. */
  sourceItemId: Ref<string | null>
  clipInMs: Ref<number>
  waveformDurationMs: Ref<number>
  project: ReturnType<typeof useProjectStore>
  scratch: ReturnType<typeof useScratchSessionStore>
  persistence: ScratchPatternPersistence
  /** Invoked once the bake resolves successfully (closes the editor). */
  onSaved(): void
}

export interface ScratchSaveFlow {
  savePhase: Ref<ScratchSavePhase>
  saveErrorMsg: Ref<string | null>
  onSave(): void
  dismissSaveError(): void
  /** Resets to idle — called when the dialog (re)opens or closes. */
  reset(): void
}

export function useScratchSaveFlow(deps: ScratchSaveFlowOptions): ScratchSaveFlow {
  const savePhase = ref<ScratchSavePhase>('idle')
  const saveErrorMsg = ref<string | null>(null)

  // The baked sample's library id is derived from the notation pattern id so a
  // re-save of an edited scratch updates the same library item in place, and the
  // item stays linked to its notation for re-opening in the editor.
  function bakeScratchToLibrary(): void {
    const sid = deps.sessionId.value
    const pattern = deps.scratch.completedPattern
    if (sid === null || !pattern) {
      savePhase.value = 'idle'
      return
    }
    const targetId =
      deps.persistence.selectedSavedId.value ?? deps.scratch.savedPatternId ?? pattern.id
    const name = deps.persistence.patternName.value.trim() || pattern.name || 'Scratch'
    const saved: ScratchPattern = { ...pattern, id: targetId, name }
    const itemId = `scratch-${targetId}`
    // Inherit cover art from — and window/display on re-open — the resolved source
    // item the scratch was actually performed over (the peaks-bearing source, not an
    // intermediate clip item). Falls back to the opened item when unresolved.
    const sourceItemId =
      deps.sourceItemId.value ??
      (deps.clipId.value !== null
        ? deps.project.clips[deps.clipId.value]?.libraryItemId
        : deps.libraryItemId.value) ??
      null
    deps.scratch.beginScratchBake(itemId)
    deps.project.saveScratchAsSample(
      sid,
      itemId,
      name,
      saved,
      sourceItemId,
      deps.clipInMs.value,
      deps.waveformDurationMs.value
    )
  }

  function onSave(): void {
    if (!deps.hasPattern.value || savePhase.value === 'saving') return
    savePhase.value = 'saving'
    saveErrorMsg.value = null
    if (deps.scratch.savedPatternId !== null) deps.persistence.updatePattern()
    else deps.persistence.savePattern()
    bakeScratchToLibrary()
  }

  // Resolve the in-flight bake: close the editor on success, or surface the error
  // in the progress popover so the user can retry without losing their recording.
  watch(
    () => deps.scratch.bakeResultSeq,
    () => {
      if (savePhase.value !== 'saving') return
      const result = deps.scratch.bakeResult
      if (!result) return
      if (result.ok) {
        savePhase.value = 'idle'
        deps.onSaved()
      } else {
        savePhase.value = 'error'
        saveErrorMsg.value = result.error ?? 'Could not save the scratch to your library.'
      }
    }
  )

  function dismissSaveError(): void {
    savePhase.value = 'idle'
    saveErrorMsg.value = null
  }

  function reset(): void {
    savePhase.value = 'idle'
    saveErrorMsg.value = null
  }

  return { savePhase, saveErrorMsg, onSave, dismissSaveError, reset }
}
