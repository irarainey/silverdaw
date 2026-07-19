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
import { runInUndoGroup } from '@/lib/undo/undoGroup'
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
  Clip,
  ProjectState
} from './projectTypes'
import { applyProjectStateSnapshot as applyProjectStateSnapshotImpl } from './projectSnapshot'
import * as persistence from './projectPersistence'
import { markerActions } from './projectMarkerActions'
import { trackActions } from './projectTrackActions'
import { clipActions } from './projectClipActions'
import { clipLibraryActions } from './projectClipLibraryActions'
import { transitionActions } from './projectTransitionActions'
import { beatRepeatActions } from './projectBeatRepeatActions'
import { scratchPatternActions } from './scratchPatternActions'

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
    timelineRevision: 0,
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
    selectedClipIds: new Set(),
    selectedTrackId: null,
    clipboardClip: null,
    clipboardClips: null,
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
    safetyLimiterEnabled: false,
    barCounterStart: 1,
    mixdownStartBar: 1,
    metronomeEnabled: false,
    clipEditorMetronomeEnabled: false,
    projectReverb: { size: 0, decay: 0, tone: 0, mix: 0 },
    projectDelay: { noteValue: '1/8', feedback: 0, tone: 0, mix: 0 },
    savedScratchPatterns: []
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
    },

    /** Membership test for the multi-selection (used by the renderer highlight). */
    isClipSelected: (state) => (clipId: string): boolean => state.selectedClipIds.has(clipId),

    /** How many clips are currently selected. */
    selectedClipCount: (state): number => state.selectedClipIds.size
  },

  actions: {
    ...markerActions,
    ...trackActions,
    ...clipActions,
    ...clipLibraryActions,
    ...transitionActions,
    ...beatRepeatActions,
    ...scratchPatternActions,

    selectClip(clipId: string | null): void {
      if (this.selectedClipId === clipId && this.selectedClipIds.size === (clipId ? 1 : 0)) return
      this.selectedClipId = clipId
      this.selectedClipIds = clipId ? new Set([clipId]) : new Set()
      this.timelineRevision++
    },

    /** Ctrl-click: toggle a clip in/out of the multi-selection, keeping a sensible anchor. */
    toggleClipSelection(clipId: string): void {
      if (!this.clips[clipId]) return
      const next = new Set(this.selectedClipIds)
      if (next.has(clipId)) {
        next.delete(clipId)
        if (this.selectedClipId === clipId) {
          this.selectedClipId = next.values().next().value ?? null
        }
      } else {
        next.add(clipId)
        this.selectedClipId = clipId
      }
      this.selectedClipIds = next
      this.timelineRevision++
    },

    /** Shift-click: select every clip on the anchor's track between the anchor and `clipId`
     *  (inclusive), ordered by start time. Falls back to a singleton when there's no same-track
     *  anchor (e.g. the anchor is on another track or absent). */
    selectClipRange(clipId: string): void {
      const clicked = this.clips[clipId]
      const anchorId = this.selectedClipId
      const anchor = anchorId ? this.clips[anchorId] : null
      if (!clicked || !anchor || anchor.trackId !== clicked.trackId) {
        this.selectClip(clipId)
        return
      }
      const track = this.tracks.find((t) => t.id === clicked.trackId)
      if (!track) {
        this.selectClip(clipId)
        return
      }
      const ordered = track.clipIds
        .map((id) => this.clips[id])
        .filter((c): c is Clip => c != null)
        .sort((a, b) => a.startMs - b.startMs)
      const iA = ordered.findIndex((c) => c.id === anchorId)
      const iB = ordered.findIndex((c) => c.id === clipId)
      if (iA < 0 || iB < 0) {
        this.selectClip(clipId)
        return
      }
      const [lo, hi] = iA <= iB ? [iA, iB] : [iB, iA]
      const next = new Set<string>()
      for (let i = lo; i <= hi; i++) next.add(ordered[i]!.id)
      this.selectedClipIds = next
      // Keep the original anchor so a second Shift-click pivots on the same clip.
      this.selectedClipId = anchorId
      this.timelineRevision++
    },

    /** Clear the whole clip selection. */
    clearClipSelection(): void {
      if (this.selectedClipId === null && this.selectedClipIds.size === 0) return
      this.selectedClipId = null
      this.selectedClipIds = new Set()
      this.timelineRevision++
    },

    /** Drop any selected ids that no longer exist (e.g. after an undo/redo removed clips) so a
     *  stale id can't corrupt a later multi-clip operation. */
    reconcileClipSelection(): void {
      let changed = false
      const next = new Set<string>()
      for (const id of this.selectedClipIds) {
        if (this.clips[id]) next.add(id)
        else changed = true
      }
      if (this.selectedClipId !== null && !this.clips[this.selectedClipId]) {
        this.selectedClipId = next.values().next().value ?? null
        changed = true
      }
      if (changed) {
        this.selectedClipIds = next
        this.timelineRevision++
      }
    },

    /** Delete every selected clip as one undo step, then clear the selection. */
    deleteSelectedClips(): void {
      const ids = Array.from(this.selectedClipIds)
      if (ids.length === 0) return
      runInUndoGroup('Delete clips', () => {
        for (const id of ids) this.removeClip(id)
      })
      this.clearClipSelection()
    },

    /** Lock or unlock every selected clip as one undo step. */
    setSelectedClipsLocked(locked: boolean): void {
      const ids = Array.from(this.selectedClipIds)
      if (ids.length === 0) return
      runInUndoGroup(locked ? 'Lock clips' : 'Unlock clips', () => {
        for (const id of ids) this.setClipLocked(id, locked)
      })
    },

    /** Recolour every selected clip as one undo step. */
    setSelectedClipsColor(colorIndex: number): void {
      const ids = Array.from(this.selectedClipIds)
      if (ids.length === 0) return
      runInUndoGroup('Recolour clips', () => {
        for (const id of ids) this.setClipColor(id, colorIndex)
      })
    },

    /** Duplicate every selected clip as one undo step, selecting the new clips. */
    duplicateSelectedClips(): void {
      const ids = Array.from(this.selectedClipIds)
      if (ids.length === 0) return
      const newIds: string[] = []
      runInUndoGroup('Duplicate clips', () => {
        for (const id of ids) {
          const newId = this.duplicateClip(id)
          if (newId) newIds.push(newId)
        }
      })
      if (newIds.length > 0) {
        this.selectedClipIds = new Set(newIds)
        this.selectedClipId = newIds[0] ?? null
        this.timelineRevision++
      }
    },

    /** Persist selected track as non-dirty view state. */
    selectTrack(trackId: string | null): void {
      if (this.selectedTrackId === trackId) return
      this.selectedTrackId = trackId
      this.timelineRevision++
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

    /** Toggle the project-wide fixed-ceiling output protection. */
    setSafetyLimiterEnabled(enabled: boolean): void {
      if (enabled === this.safetyLimiterEnabled) return
      this.safetyLimiterEnabled = enabled
      sendBridge('PROJECT_SET_SAFETY_LIMITER', { enabled })
    },

    /** Set the first bar number shown on the ruler (default 1; 0 or lower adds lead-in bars). */
    setBarCounterStart(barCounterStart: number): void {
      const next = Number.isFinite(barCounterStart)
        ? Math.min(1, Math.max(-64, Math.round(barCounterStart)))
        : 1
      if (next === this.barCounterStart) return
      this.barCounterStart = next
      sendBridge('PROJECT_SET_BAR_COUNTER_START', { barCounterStart: next })
    },

    /** Set the displayed bar number a mixdown begins from (default 1 = first bar). */
    setMixdownStartBar(mixdownStartBar: number): void {
      const next = Number.isFinite(mixdownStartBar)
        ? Math.min(4096, Math.max(-64, Math.round(mixdownStartBar)))
        : 1
      if (next === this.mixdownStartBar) return
      this.mixdownStartBar = next
      sendBridge('PROJECT_SET_MIXDOWN_START_BAR', { mixdownStartBar: next })
    },

    /** Toggle the monitoring metronome click. A per-project setting persisted silently (no undo,
     *  no dirty) — the backend generates the click in time with the project BPM. On a clean, saved
     *  project the toggle is flushed to the project file immediately (via the targeted view-state
     *  write) so it survives closing the project; on a dirty project it rides along with the user's
     *  next save. */
    setMetronomeEnabled(enabled: boolean): void {
      if (enabled === this.metronomeEnabled) return
      this.metronomeEnabled = enabled
      sendBridge('PROJECT_SET_METRONOME', { enabled })
      if (!this.isDirty && this.currentFilePath) {
        void this.saveViewStateAndWait()
      }
    },

    /** Toggle the Clip Editor metronome. Independent of the main metronome, persisted with the
     *  same silent per-project mechanism. `bpm`/`beatAnchorSec` are the clip's own beat grid the
     *  click aligns to (supplied by the Clip Editor); only the enabled flag persists. */
    setClipEditorMetronomeEnabled(enabled: boolean, bpm: number, beatAnchorSec: number): void {
      this.clipEditorMetronomeEnabled = enabled
      sendBridge('PREVIEW_SET_METRONOME', { enabled, bpm, beatAnchorSec })
      if (!this.isDirty && this.currentFilePath) {
        void this.saveViewStateAndWait()
      }
    },

    /** Re-send the current enabled state with a fresh beat grid (on preview load or when the
     *  clip's BPM/anchor changes). Transient — does not persist. */
    pushClipEditorMetronomeGrid(bpm: number, beatAnchorSec: number): void {
      sendBridge('PREVIEW_SET_METRONOME', {
        enabled: this.clipEditorMetronomeEnabled,
        bpm,
        beatAnchorSec
      })
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
