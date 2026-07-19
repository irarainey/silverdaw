// Scalar/header reconciliation for PROJECT_STATE snapshots: project identity,
// transport, project settings, FX shape, and the reset/marker structure reset.
// Each helper mutates the shared SnapshotTarget in place; the orchestrator in
// projectSnapshot.ts calls them in the original order.

import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'
import { DEFAULT_PROJECT_NAME } from './projectTypes'
import { deriveProjectIdFromPath, freshUntitledProjectId } from './projectHelpers'
import type { SnapshotTarget } from './projectSnapshotTypes'

/** Adopt identity, dirty state, autosave id rotation, and view geometry. */
export function applyProjectIdentity(
  target: SnapshotTarget,
  snapshot: ProjectStatePayload,
  isSoftReplace: boolean
): void {
  // Adopt identity before other snapshot work so observers see post-load values.
  const previousFilePath = target.currentFilePath
  target.currentFilePath = snapshot.filePath
  target.projectName = snapshot.name?.trim() ? snapshot.name : DEFAULT_PROJECT_NAME
  // Trust the backend's authoritative dirty flag when present: incremental
  // PROJECT_STATE rebroadcasts (transition create, reconcile, reconnect)
  // must not silently clear unsaved-change state. Legacy backends without
  // the field fall back to the previous reset-on-replace behaviour.
  if (typeof snapshot.dirty === 'boolean') {
    target.isDirty = snapshot.dirty
  } else if (!isSoftReplace) {
    target.isDirty = false
  }
  // Rotate autosave buckets when load/new/save-as changes project identity.
  const pathChanged = snapshot.filePath !== previousFilePath
  const shouldRotateId = (snapshot.reset === true || pathChanged) && !isSoftReplace
  if (shouldRotateId) {
    target.previousProjectId = target.projectId
    if (snapshot.filePath) {
      // Async path hashing keeps autosave disabled until the id resolves.
      const targetPath = snapshot.filePath
      target.projectId = null
      void deriveProjectIdFromPath(targetPath).then((id) => {
        // A later load may race the hash result.
        if (target.currentFilePath === targetPath) target.projectId = id
      })
    } else {
      target.projectId = target.pendingRecoveredProjectId ?? freshUntitledProjectId()
    }
  }
  target.pendingRecoveredProjectId = null
  target.viewPxPerSecond =
    typeof snapshot.viewPxPerSecond === 'number' && snapshot.viewPxPerSecond > 0
      ? snapshot.viewPxPerSecond
      : null
  target.viewScrollX =
    typeof snapshot.viewScrollX === 'number' && snapshot.viewScrollX >= 0
      ? snapshot.viewScrollX
      : null
}

/**
 * Restore transport (bpm, playhead) and return the project length to apply once
 * tracks exist. Project length applies after tracks because the setter writes
 * each track length.
 */
export function applyProjectTransport(
  _target: SnapshotTarget,
  snapshot: ProjectStatePayload
): number | null {
  // PROJECT_STATE restores transport and project dimensions across stores.
  if (typeof snapshot.bpm === 'number' && snapshot.bpm > 0) {
    useTransportStore().setBpm(snapshot.bpm)
  }
  if (typeof snapshot.playheadMs === 'number' && snapshot.playheadMs >= 0) {
    useTransportStore().setPosition(snapshot.playheadMs)
  }
  if (typeof snapshot.projectLengthMs === 'number' && snapshot.projectLengthMs > 0) {
    return snapshot.projectLengthMs
  }
  return null
}

/** Reconcile audio output, sample rate, export settings, and bar/mixdown counters. */
export function applyProjectSettings(target: SnapshotTarget, snapshot: ProjectStatePayload): void {
  // Normalise audio-output preference to all-set or null/null.
  const nextAudioType = typeof snapshot.audioOutputTypeName === 'string' && snapshot.audioOutputTypeName.length > 0
    ? snapshot.audioOutputTypeName
    : null
  const nextAudioDevice = typeof snapshot.audioOutputDeviceName === 'string' && snapshot.audioOutputDeviceName.length > 0
    ? snapshot.audioOutputDeviceName
    : null
  if (nextAudioType !== null && nextAudioDevice !== null) {
    target.audioOutputTypeName = nextAudioType
    target.audioOutputDeviceName = nextAudioDevice
  } else {
    target.audioOutputTypeName = null
    target.audioOutputDeviceName = null
  }
  // Only supported rates survive; absent/invalid means no project override.
  const incomingRate = snapshot.targetSampleRate
  target.targetSampleRate =
    typeof incomingRate === 'number' && (incomingRate === 44100 || incomingRate === 48000)
      ? incomingRate
      : null
  // The dialog parses this opaque JSON defensively on open.
  const incomingExportSettings = snapshot.exportSettingsJson
  target.exportSettingsJson =
    typeof incomingExportSettings === 'string' && incomingExportSettings.length > 0
      ? incomingExportSettings
      : null
  // Missing means unity; the backend omits default master volume.
  const incomingMasterVolume = snapshot.masterVolume
  target.masterVolume =
    typeof incomingMasterVolume === 'number' && Number.isFinite(incomingMasterVolume)
      ? Math.min(1, Math.max(0, incomingMasterVolume))
      : 1.0
  // Absent means off so projects created before the safety limiter retain their sound.
  target.safetyLimiterEnabled = snapshot.safetyLimiterEnabled === true
  // Missing means default 1; the backend omits default bar settings.
  const incomingBarCounterStart = snapshot.barCounterStart
  target.barCounterStart =
    typeof incomingBarCounterStart === 'number' && Number.isFinite(incomingBarCounterStart)
      ? Math.min(1, Math.max(-64, Math.round(incomingBarCounterStart)))
      : 1
  const incomingMixdownStartBar = snapshot.mixdownStartBar
  target.mixdownStartBar =
    typeof incomingMixdownStartBar === 'number' && Number.isFinite(incomingMixdownStartBar)
      ? Math.min(4096, Math.max(-64, Math.round(incomingMixdownStartBar)))
      : 1
  // Absent/false means off; the backend omits the default-off metronome.
  target.metronomeEnabled = snapshot.metronomeEnabled === true
  target.clipEditorMetronomeEnabled = snapshot.clipEditorMetronomeEnabled === true
}

/** Mutate project FX (reverb/delay) objects in place so refreshes do not end drags. */
export function applyProjectFx(target: SnapshotTarget, snapshot: ProjectStatePayload): void {
  const unit = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
  target.projectReverb.size = unit(snapshot.reverbSize)
  target.projectReverb.decay = unit(snapshot.reverbDecay)
  target.projectReverb.tone = unit(snapshot.reverbTone)
  target.projectReverb.mix = unit(snapshot.reverbMix)
  target.projectDelay.noteValue = snapshot.delayNoteValue ?? '1/8'
  target.projectDelay.feedback = unit(snapshot.delayFeedback)
  target.projectDelay.tone = unit(snapshot.delayTone)
  target.projectDelay.mix = unit(snapshot.delayMix)
}

/** Reset/soft-replace wipe of ValueTree-backed mirrors, then hydrate markers. */
export function applyProjectStructureReset(
  target: SnapshotTarget,
  snapshot: ProjectStatePayload,
  isSoftReplace: boolean
): void {
  const library = useLibraryStore()
  // Reset/soft-replace wipe ValueTree-backed mirrors; undo/redo preserves view state.
  if (snapshot.reset === true || isSoftReplace) {
    target.tracks = []
    target.clips = {}
    target.markers = []
    if (!isSoftReplace) {
      target.selectedClipId = null
      target.selectedClipIds = new Set()
      target.selectedTrackId = null
      target.clipboardClip = null
      target.clipboardClips = null
    }
    target.duplicateTailBySource = {}
    target.timelineRevision++
    library.clear()
  }

  target.markers = Array.isArray(snapshot.markers)
    ? snapshot.markers
        .filter((marker) => marker.positionMs >= 0)
        .map((marker) => ({ id: marker.id, positionMs: marker.positionMs }))
        .sort((a, b) => a.positionMs - b.positionMs)
    : []
}
