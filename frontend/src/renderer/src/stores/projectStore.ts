// Project state — source of truth for the timeline. Mirrors backend
// ValueTree state via PROJECT_STATE / TRACK_ADDED / etc. bridge messages.
//
// Composed from focused domain modules spread into `actions`, each typed so
// `this` is the store instance:
//   - projectMarkerActions    marker add/move/remove
//   - projectTrackActions     track add/remove/tone/sends/pan/gain/order
//   - projectClipActions      clip editing (add/move/trim/split/duplicate/...)
//   - projectClipLibraryActions  clip<->library linking + save-to-library
//   - projectTransitionActions   crossfade lifecycle
// Cross-module action calls (e.g. clip-library -> setClipWarp) resolve at
// runtime via the spread store instance; their types live in the shared
// ProjectClipThis contract (projectClipContract.ts). Snapshot reconciliation
// (projectSnapshot.ts) and persistence handshakes (projectPersistence.ts) are
// separate modules. The store itself keeps state, getters, selection/project
// settings, and thin persistence/snapshot wrappers.

import { defineStore } from 'pinia'
import { PEAKS_PER_SECOND } from '@/lib/audioDecode'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive
} from '@/lib/clip/clipTiming'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type {
  DelayNoteValue,
  ProjectStatePayload
} from '@shared/bridge-protocol'

// Facade re-export: these pure clip-timing helpers now live in
// `@/lib/clip/clipTiming` but are widely imported from this store
// (useTimelineDrawing, useDragHandlers, useTimelineContextMenu,
// lib/transitions). Re-export keeps that import surface stable.
export { effectiveClipDurationMs, effectiveClipTempoRatio, isClipTempoWarpActive }

import {
  DEFAULT_PROJECT_NAME
} from './projectTypes'
import type {
  ProjectState
} from './projectTypes'
import { applyProjectStateSnapshot as applyProjectStateSnapshotImpl } from './projectSnapshot'
import * as persistence from './projectPersistence'
import { markerActions } from './projectMarkerActions'
import { trackActions } from './projectTrackActions'
import { clipActions } from './projectClipActions'
import { clipLibraryActions } from './projectClipLibraryActions'
import { transitionActions } from './projectTransitionActions'

// Re-export domain types/constants so existing `@/stores/projectStore` imports stay stable.
export type {
  Clip,
  ClipboardEntry,
  Marker,
  ProjectDelayState,
  ProjectReverbState,
  Track,
  TrackPaletteEntry,
  Transition
} from './projectTypes'
export {
  DEFAULT_PROJECT_NAME,
  DEFAULT_TRACK_LENGTH_MS,
  MAX_TRACK_VOLUME,
  TRACK_PALETTE
} from './projectTypes'

export const useProjectStore = defineStore('project', {
  state: (): ProjectState => ({
    tracks: [],
    clips: {},
    markers: [],
    peaksRevision: 0,
    currentFilePath: null,
    projectName: DEFAULT_PROJECT_NAME,
    isDirty: false,
    projectId: null,
    pendingRecoveredProjectId: null,
    previousProjectId: null,
    recoveryInFlight: false,
    viewPxPerSecond: null,
    viewScrollX: null,
    fxPanelOpen: false,
    fxTab: 'track',
    selectedClipId: null,
    selectedTrackId: null,
    clipboardClip: null,
    duplicateTailBySource: {},
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    audioOutputTypeName: null,
    audioOutputDeviceName: null,
    targetSampleRate: null,
    exportSettingsJson: null,
    masterVolume: 1.0,
    barCounterStart: 0,
    mixdownStartBar: 0,
    projectReverb: { size: 0, decay: 0, tone: 0, mix: 0 },
    projectDelay: { noteValue: '1/8', feedback: 0, tone: 0, mix: 0 }
  }),

  getters: {
    /** Project duration in ms, including clip tails past track lengths. */
    durationMs(state): number {
      // Compare clip ends in effective timeline time, not source duration.
      let max = 0
      for (const t of state.tracks) {
        if (t.lengthMs > max) max = t.lengthMs
      }
      for (const id in state.clips) {
        const c = state.clips[id]
        if (!c) continue
        const effDur = effectiveClipDurationMs(c)
        const end = c.startMs + effDur
        if (end > max) max = end
      }
      return max
    },

    /** Minimum legal project length: never below the latest effective clip end. */
    longestClipEndMs(state): number {
      let max = 0
      for (const id in state.clips) {
        const c = state.clips[id]
        if (!c) continue
        const effDur = effectiveClipDurationMs(c)
        const end = c.startMs + effDur
        if (end > max) max = end
      }
      return max
    },

    anySoloed(state): boolean {
      return state.tracks.some((t) => t.soloed)
    }
  },

  actions: {
    ...markerActions,
    ...trackActions,
    ...clipActions,
    ...clipLibraryActions,
    ...transitionActions,

    selectClip(clipId: string | null): void {
      if (this.selectedClipId === clipId) return
      this.selectedClipId = clipId
      this.peaksRevision++
    },

    /** Persist selected track as non-dirty view state. */
    selectTrack(trackId: string | null): void {
      if (this.selectedTrackId === trackId) return
      this.selectedTrackId = trackId
      this.peaksRevision++
      sendBridge('PROJECT_SET_VIEW', { selectedTrackId: trackId })
    },

    setFxPanelOpen(open: boolean): void {
      if (this.fxPanelOpen === open) return
      this.fxPanelOpen = open
      sendBridge('PROJECT_SET_VIEW', { fxPanelOpen: open })
    },

    /** UI-only FX tab; never touches bridge or dirty state. */
    setFxTab(tab: 'track' | 'project'): void {
      this.fxTab = tab
    },

    /** Update project Reverb; localOnly reconciles backend acks. */
    setProjectReverb(
      patch: { size?: number; decay?: number; tone?: number; mix?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const clampUnit = (v: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      if (patch.size !== undefined) this.projectReverb.size = clampUnit(patch.size)
      if (patch.decay !== undefined) this.projectReverb.decay = clampUnit(patch.decay)
      if (patch.tone !== undefined) this.projectReverb.tone = clampUnit(patch.tone)
      if (patch.mix !== undefined) this.projectReverb.mix = clampUnit(patch.mix)
      if (!opts?.localOnly) {
        sendBridge('PROJECT_SET_REVERB', {
          size: patch.size,
          decay: patch.decay,
          tone: patch.tone,
          mix: patch.mix,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update tempo-locked project Delay; localOnly reconciles backend acks. */
    setProjectDelay(
      patch: { noteValue?: DelayNoteValue; feedback?: number; tone?: number; mix?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const clampUnit = (v: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      if (patch.noteValue !== undefined) this.projectDelay.noteValue = patch.noteValue
      if (patch.feedback !== undefined) this.projectDelay.feedback = clampUnit(patch.feedback)
      if (patch.tone !== undefined) this.projectDelay.tone = clampUnit(patch.tone)
      if (patch.mix !== undefined) this.projectDelay.mix = clampUnit(patch.mix)
      if (!opts?.localOnly) {
        sendBridge('PROJECT_SET_DELAY', {
          noteValue: patch.noteValue,
          feedback: patch.feedback,
          tone: patch.tone,
          mix: patch.mix,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Set visible project length, clamped to every track's latest clip end. */
    setProjectLengthMs(lengthMs: number): void {
      if (this.tracks.length === 0) return
      const target = Math.max(this.longestClipEndMs, Math.max(0, Math.floor(lengthMs)))
      for (const track of this.tracks) {
        let minLength = 0
        for (const clipId of track.clipIds) {
          const clip = this.clips[clipId]
          if (!clip) continue
          // Clamp against effective timeline footprint, not source duration.
          const effDur = effectiveClipDurationMs(clip)
          const end = clip.startMs + effDur
          if (end > minLength) minLength = end
        }
        track.lengthMs = Math.max(target, minLength)
      }
    },

    /** Store project audio-output preference atomically; does not switch the live device. */
    setProjectAudioOutput(typeName: string | null, deviceName: string | null): void {
      const normType =
        typeof typeName === 'string' && typeName.length > 0 ? typeName : null
      const normDevice =
        typeof deviceName === 'string' && deviceName.length > 0 ? deviceName : null
      const nextType = normType !== null && normDevice !== null ? normType : null
      const nextDevice = normType !== null && normDevice !== null ? normDevice : null
      if (this.audioOutputTypeName === nextType && this.audioOutputDeviceName === nextDevice) {
        return
      }
      this.audioOutputTypeName = nextType
      this.audioOutputDeviceName = nextDevice
      sendBridge('PROJECT_SET_AUDIO_OUTPUT', {
        typeName: nextType,
        deviceName: nextDevice
      })
    },

    /** Persist 44.1/48 kHz only; other values clear the project override. */
    setTargetSampleRate(sampleRate: number | null): void {
      const next = sampleRate === 44100 || sampleRate === 48000 ? sampleRate : null
      if (next === this.targetSampleRate) return
      const prev = this.targetSampleRate
      this.targetSampleRate = next
      log.info(
        'project',
        `setTargetSampleRate ${prev ?? 'null'} -> ${next ?? 'null'} Hz`
      )
      sendBridge('PROJECT_SET_TARGET_SAMPLE_RATE', { sampleRate: next ?? 0 })
    },

    /** Persist opaque export-dialog settings; not part of edit history. */
    setExportSettingsJson(json: string | null): void {
      const next = typeof json === 'string' && json.length > 0 ? json : null
      if (next === this.exportSettingsJson) return
      this.exportSettingsJson = next
      sendBridge('PROJECT_SET_EXPORT_SETTINGS', { json: next ?? '' })
    },

    /** Set master volume; backend coalesces drag streams into one undo step. */
    setMasterVolume(gain: number): void {
      const next = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1
      if (next === this.masterVolume) return
      this.masterVolume = next
      sendBridge('PROJECT_SET_MASTER_VOLUME', { gain: next })
    },

    /** Set the ruler bar-label offset (0 or negative; default 0 labels the first bar "1"). */
    setBarCounterStart(barCounterStart: number): void {
      const next = Number.isFinite(barCounterStart)
        ? Math.min(0, Math.max(-64, Math.round(barCounterStart)))
        : 0
      if (next === this.barCounterStart) return
      this.barCounterStart = next
      sendBridge('PROJECT_SET_BAR_COUNTER_START', { barCounterStart: next })
    },

    /** Set the displayed bar marker a mixdown begins from (default 0 = project origin). */
    setMixdownStartBar(mixdownStartBar: number): void {
      const next = Number.isFinite(mixdownStartBar)
        ? Math.min(4096, Math.max(-64, Math.round(mixdownStartBar)))
        : 0
      if (next === this.mixdownStartBar) return
      this.mixdownStartBar = next
      sendBridge('PROJECT_SET_MIXDOWN_START_BAR', { mixdownStartBar: next })
    },

    applyProjectStateSnapshot(snapshot: ProjectStatePayload): void {
      applyProjectStateSnapshotImpl(this, snapshot)
      persistence.resolvePendingRecoveryLoad()
    },

    // ─── Project file lifecycle ────────────────────────────────────────────

    requestNewProject(): void {
      log.info('project', 'requestNewProject')
      sendBridge('PROJECT_NEW')
    },

    /** Mirror backend undo head for menu enablement and labels. */
    applyEditUndoState(payload: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string }): void {
      this.canUndo = payload.canUndo
      this.canRedo = payload.canRedo
      this.undoLabel = payload.canUndo && payload.undoLabel ? payload.undoLabel : null
      this.redoLabel = payload.canRedo && payload.redoLabel ? payload.redoLabel : null
    },

    requestUndo(): void {
      log.info('project', 'requestUndo')
      sendBridge('EDIT_UNDO')
    },

    requestRedo(): void {
      log.info('project', 'requestRedo')
      sendBridge('EDIT_REDO')
    },

    /** Save current path; caller owns Save As dialog fallback. */
    requestSave(): boolean {
      return persistence.requestSave(this)
    },

    requestSaveAs(filePath: string): void {
      persistence.requestSaveAs(this, filePath)
    },

    /** Await PROJECT_SAVED so unsaved-change flows can continue deterministically. */
    saveAndWait(filePath: string, isSaveAs: boolean): Promise<{ ok: boolean; error?: string }> {
      return persistence.saveAndWait(this, filePath, isSaveAs)
    },

    /** Resolve any pending saveAndWait on PROJECT_SAVED. */
    notifySaveAck(ok: boolean, error?: string): void {
      persistence.notifySaveAck(ok, error)
    },

    saveViewStateAndWait(): Promise<{ ok: boolean; error?: string }> {
      return persistence.saveViewStateAndWait(this)
    },

    notifyViewStateSaveAck(ok: boolean, error?: string): void {
      persistence.notifyViewStateSaveAck(ok, error)
    },

    autosaveAndWait(filePath: string): Promise<{ ok: boolean; error?: string }> {
      return persistence.autosaveAndWait(this, filePath)
    },

    notifyAutosaveAck(filePath: string, ok: boolean, error?: string): void {
      persistence.notifyAutosaveAck(filePath, ok, error)
    },

    requestLoad(filePath: string): void {
      persistence.requestLoad(filePath)
    },

    /** Recovery loads autosave content but keeps the original path dirty. */
    requestLoadRecovery(
      autosavePath: string,
      originalPath: string | null,
      projectId?: string
    ): Promise<{ ok: boolean; error?: string }> {
      return persistence.requestLoadRecovery(this, autosavePath, originalPath, projectId)
    },

    notifyProjectLoadFailed(error?: string): void {
      persistence.notifyProjectLoadFailed(this, error)
    },

    requestRename(name: string): void {
      const trimmed = name.trim()
      const finalName = trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_NAME
      this.projectName = finalName
      sendBridge('PROJECT_RENAME', { name: finalName })
      log.info('project', `requestRename name=${finalName}`)
    }
  }
})

// Re-export the constant for components that need to know the peaks resolution.
export { PEAKS_PER_SECOND }
