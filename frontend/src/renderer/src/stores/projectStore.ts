// Project state — source of truth for the timeline. Mirrors backend
// ValueTree state via PROJECT_STATE / TRACK_ADDED / etc. bridge messages.
//
// FILE-SIZE EXCEPTION (justified): the cleanly separable concerns are extracted —
// domain model (projectTypes.ts), pure helpers (projectHelpers.ts), the large
// PROJECT_STATE reconciliation (projectSnapshot.ts), and the save/load/autosave
// persistence handshakes + resolver state (projectPersistence.ts). The residual is
// the cohesive timeline-mutation core: clip/track/marker actions that densely call
// each other (trim, transitions, gain, overlap queries, clipboard) over shared
// `this` state. Extracting those into free functions would require threading a
// broad slice of the store (many sibling actions + getters) into each one, which
// shifts coupling rather than reducing it — so they stay together by design.

import { defineStore } from 'pinia'
import { PEAKS_PER_SECOND } from '@/lib/audio'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  findClipSlot
} from '@/lib/clip/clipTiming'
import { send as sendBridge } from '@/lib/bridgeService'
import { sanitizeEnvelopePoints, envelopesEqual } from '@/lib/envelope'
import {
  findTransitionCandidate,
  type ClipGeometry
} from '@/lib/transitions/transitionCandidates'
import { log } from '@/lib/log'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore, libraryItemIsSample } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import type {
  ClipEnvelopePoint,
  ClipWarpMode,
  DelayNoteValue,
  ProjectStatePayload,
  TransitionRecipe
} from '@shared/bridge-protocol'
import type { LibraryItem } from '@/stores/libraryStore'

// Facade re-export: these pure clip-timing helpers now live in
// `@/lib/clip/clipTiming` but are widely imported from this store
// (useTimelineDrawing, useDragHandlers, useTimelineContextMenu,
// lib/transitions). Re-export keeps that import surface stable.
export { effectiveClipDurationMs, effectiveClipTempoRatio, isClipTempoWarpActive }

import {
  DEFAULT_PROJECT_NAME,
  DEFAULT_TRACK_LENGTH_MS,
  MAX_TRACK_VOLUME,
  TRACK_PALETTE
} from './projectTypes'
import type {
  Clip,
  Marker,
  ProjectState,
  Track
} from './projectTypes'
import {
  fileStem,
  filePathToDisplayName,
  parentDir
} from './projectHelpers'
import { applyProjectStateSnapshot as applyProjectStateSnapshotImpl } from './projectSnapshot'
import * as persistence from './projectPersistence'

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
async function defaultSamplesDir(currentFilePath: string | null): Promise<string> {
  const projectDir = parentDir(currentFilePath)
  if (projectDir) return `${projectDir}\\Samples`
  const qol = await window.silverdaw.getQolPrefs().catch(() => null)
  const base = qol?.paths.defaultProjectDir || ''
  return base ? `${base}\\Samples` : 'Samples'
}


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
    addTrack(): string {
      // UUIDs stay stable across renderer reloads and save/load cycles.
      const trackId = crypto.randomUUID()
      const track: Track = {
        id: trackId,
        name: `Track ${this.tracks.length + 1}`,
        clipIds: [],
        muted: false,
        soloed: false,
        volume: 1.0,
        colorIndex: this.tracks.length % TRACK_PALETTE.length,
        lengthMs: DEFAULT_TRACK_LENGTH_MS
      }
      this.tracks.push(track)
      // Optimistic; TRACK_ADDED is diagnostic because the renderer already shows it.
      sendBridge('TRACK_ADD', { trackId, name: track.name })
      log.info('project', `addTrack id=${trackId}`)
      return trackId
    },

    addClipToTrack(
      trackId: string,
      audio: {
        libraryItemId: string
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
        peaksPerSecond?: number
        playbackFilePath?: string
        inMs?: number
      },
      startMs = 0
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null

      const clipId = crypto.randomUUID()
      const clip: Clip = {
        id: clipId,
        trackId,
        libraryItemId: audio.libraryItemId,
        filePath: audio.filePath,
        playbackFilePath: audio.playbackFilePath,
        fileName: audio.fileName,
        startMs,
        inMs: Math.max(0, audio.inMs ?? 0),
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        peaksPerSecond: audio.peaksPerSecond,
        unresolved: false
      }
      this.clips[clipId] = clip
      track.clipIds.push(clipId)

      const clipEnd = clip.startMs + effectiveClipDurationMs(clip)
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      if (track.clipIds.length === 1 && /^Track \d+$/.test(track.name)) {
        track.name = audio.fileName.replace(/\.[^.]+$/, '')
      }

      return clipId
    },

    /** Move a clip, gap-clamping in effective timeline time and optionally re-parenting tracks. */
    moveClip(clipId: string, startMs: number, targetTrackId?: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      // Store-level lock guard keeps every mutation path inert.
      if (clip.locked) return
      const destTrackId = targetTrackId ?? clip.trackId
      const destTrack = this.tracks.find((t) => t.id === destTrackId)
      if (!destTrack) return

      // Bump-clamp into the gap nearest the desired position.
      const target = findClipSlot(
        this,
        destTrack.id,
        clipId,
        startMs,
        effectiveClipDurationMs(clip),
        effectiveClipDurationMs
      )
      if (target === null) return // no gap big enough — keep current position

      const trackChanged = destTrackId !== clip.trackId
      const positionChanged = clip.startMs !== target
      if (!trackChanged && !positionChanged) return

      if (trackChanged) {
        const oldTrack = this.tracks.find((t) => t.id === clip.trackId)
        if (oldTrack) {
          const idx = oldTrack.clipIds.indexOf(clipId)
          if (idx >= 0) oldTrack.clipIds.splice(idx, 1)
        }
        destTrack.clipIds.push(clipId)
        clip.trackId = destTrackId
      }
      clip.startMs = target

      const clipEnd = target + effectiveClipDurationMs(clip)
      if (clipEnd > destTrack.lengthMs) destTrack.lengthMs = clipEnd

      // One CLIP_MOVE keeps backend position and optional re-parenting atomic.
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: target,
        ...(trackChanged ? { trackId: destTrackId } : {})
      })
      if (trackChanged) this.pushTrackGain(destTrack)
      this.peaksRevision++ // force redraw after track/position change
      log.debug(
        'project',
        `moveClip id=${clipId} -> ${target}ms${trackChanged ? ' track=' + destTrackId : ''}`
      )
    },

    commitClipMove(clipId: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: clip.startMs,
        commit: true
      })
      log.debug('project', `commitClipMove id=${clipId} at=${clip.startMs}ms`)
    },

    /** Fire-and-forget transition create; PROJECT_STATE is the ack. */
    createTransition(
      trackId: string,
      leftClipId: string,
      rightClipId: string,
      recipe?: TransitionRecipe
    ): void {
      sendBridge('TRANSITION_CREATE', {
        trackId,
        leftClipId,
        rightClipId,
        ...(recipe ? { recipe } : {})
      })
      log.debug(
        'project',
        `createTransition track=${trackId} left=${leftClipId} right=${rightClipId}`
      )
    },

    deleteTransition(trackId: string, transitionId: string): void {
      sendBridge('TRANSITION_DELETE', { trackId, transitionId })
      log.debug('project', `deleteTransition track=${trackId} id=${transitionId}`)
    },

    setTransitionRecipe(
      trackId: string,
      transitionId: string,
      recipe: TransitionRecipe
    ): void {
      sendBridge('TRANSITION_SET_RECIPE', { trackId, transitionId, recipe })
      log.debug(
        'project',
        `setTransitionRecipe track=${trackId} id=${transitionId} kind=${recipe.kind}`
      )
    },

    /** Request a transition after a trim if the backend-valid overlap exists. */
    maybeCreateTransitionAfterTrim(clipId: string, edge: 'left' | 'right'): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return

      const toGeometry = (c: Clip): ClipGeometry => ({
        id: c.id,
        startMs: c.startMs,
        endMs: c.startMs + effectiveClipDurationMs(c)
      })
      const others: ClipGeometry[] = []
      for (const id of track.clipIds) {
        if (id === clipId) continue
        const c = this.clips[id]
        if (c) others.push(toGeometry(c))
      }

      const candidate = findTransitionCandidate(
        toGeometry(clip),
        edge,
        others,
        track.transitions ?? []
      )
      if (!candidate) return
      this.createTransition(track.id, candidate.leftClipId, candidate.rightClipId)
    },

    /** Trim source-window fields atomically in one CLIP_TRIM envelope. */
    trimClip(clipId: string, startMs: number, inMs: number, durationMs: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      // Store-level lock guard keeps trim inert too.
      if (clip.locked) return
      const safeStart = Math.max(0, startMs)
      const safeIn = Math.max(0, inMs)
      const safeDur = Math.max(0, durationMs)
      if (clip.startMs === safeStart && clip.inMs === safeIn && clip.durationMs === safeDur) return
      clip.startMs = safeStart
      clip.inMs = safeIn
      clip.durationMs = safeDur
      // CLIP_TRIM is not echoed, so update the effective timeline footprint here.
      const trimRatio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
      clip.effectiveDurationMs = trimRatio > 0 ? safeDur / trimRatio : safeDur

      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (track) {
        const clipEnd = clip.startMs + effectiveClipDurationMs(clip)
        if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      }

      sendBridge('CLIP_TRIM', {
        clipId: clip.id,
        startMs: safeStart,
        inMs: safeIn,
        durationMs: safeDur
      })
      log.debug(
        'project',
        `trimClip id=${clipId} start=${safeStart} in=${safeIn} dur=${safeDur}`
      )
    },

    /** Split a clip at timeline time while preserving source-time trim math. */
    splitClipAt(clipId: string, atMs: number): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      // Refuse locked splits; minting a new half would make lock semantics ambiguous.
      if (clip.locked) {
        useNotificationsStore().pushError('Locked clips cannot be split. Unlock the clip first.')
        log.info('project', `splitClipAt rejected locked clip id=${clipId}`)
        return null
      }
      const library = useLibraryStore()
      const libItem = library.byId[clip.libraryItemId]
      if (libItem?.kind === 'saved-clip') {
        useNotificationsStore().pushError('Linked clips must be edited in the Clip Editor.')
        log.info('project', `splitClipAt rejected linked clip id=${clipId}`)
        return null
      }
      // Timeline split offsets map to source-time offsets via the tempo ratio.
      const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
      const effectiveDurMs = clip.durationMs / ratio
      const clipEnd = clip.startMs + effectiveDurMs
      // Require a strict interior split to avoid zero-length siblings.
      if (atMs <= clip.startMs + 1 || atMs >= clipEnd - 1) return null

      const splitOffsetTimelineMs = atMs - clip.startMs
      const splitOffsetSourceMs = splitOffsetTimelineMs * ratio
      const newClipDurationMs = clip.durationMs - splitOffsetSourceMs
      const newClipInMs = clip.inMs + splitOffsetSourceMs
      const newClipStartMs = atMs

      this.trimClip(clipId, clip.startMs, clip.inMs, splitOffsetSourceMs)

      // Reuse peaks and carry warp settings so both halves stay in time.
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null
      const newId = crypto.randomUUID()
      const right: Clip = {
        id: newId,
        trackId: clip.trackId,
        libraryItemId: clip.libraryItemId,
        filePath: clip.filePath,
        playbackFilePath: clip.playbackFilePath,
        fileName: clip.fileName,
        startMs: newClipStartMs,
        inMs: newClipInMs,
        durationMs: newClipDurationMs,
        sampleRate: clip.sampleRate,
        channelCount: clip.channelCount,
        peaks: clip.peaks,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp,
        effectiveDurationMs: clip.effectiveDurationMs,
        effectiveTempoRatio: clip.effectiveTempoRatio,
        effectiveWarpActive: clip.effectiveWarpActive
      }
      this.clips[newId] = right
      const insertAt = track.clipIds.indexOf(clipId)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }

      sendBridge('CLIP_ADD', {
        trackId: clip.trackId,
        clipId: newId,
        libraryItemId: clip.libraryItemId,
        positionMs: newClipStartMs,
        inMs: newClipInMs,
        durationMs: newClipDurationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (clip.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: clip.name })
      }
      // Replay active warp so the backend builds the right-half processor.
      if (clip.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: clip.warpMode,
          tempoRatio: clip.tempoRatio,
          semitones: clip.semitones,
          cents: clip.cents
        })
      }
      log.info(
        'project',
        `splitClipAt id=${clipId} at=${atMs} -> newId=${newId} (in=${newClipInMs} dur=${newClipDurationMs})`
      )
      return newId
    },

    /** Duplicate appends after the last copy while leaving the source selected. */
    duplicateClip(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null
      const trackedTailId = this.duplicateTailBySource[clipId]
      const trackedTail = trackedTailId ? this.clips[trackedTailId] : null
      const tail =
        trackedTail && trackedTail.trackId === clip.trackId && track.clipIds.includes(trackedTail.id)
          ? trackedTail
          : clip
      // Use effective duration for timeline placement and overlap.
      const tailEffDur = effectiveClipDurationMs(tail)
      const newStartMs = tail.startMs + tailEffDur
      const clipEffDur = effectiveClipDurationMs(clip)
      // Duplicate is an append gesture; reject instead of searching other gaps.
      for (const id of track.clipIds) {
        if (id === clipId || id === tail.id) continue
        const c = this.clips[id]
        if (!c) continue
        const cEffDur = effectiveClipDurationMs(c)
        const cEnd = c.startMs + cEffDur
        if (newStartMs < cEnd && newStartMs + clipEffDur > c.startMs) {
          useNotificationsStore().pushError('Not enough space to duplicate clip after the last duplicate.')
          log.info('project', `duplicateClip rejected: source=${clipId} tail=${tail.id} overlaps clip ${id}`)
          return null
        }
      }
      const newId = crypto.randomUUID()
      const copy: Clip = {
        id: newId,
        trackId: clip.trackId,
        libraryItemId: clip.libraryItemId,
        filePath: clip.filePath,
        playbackFilePath: clip.playbackFilePath,
        fileName: clip.fileName,
        startMs: newStartMs,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        sampleRate: clip.sampleRate,
        channelCount: clip.channelCount,
        peaks: clip.peaks,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp
      }
      this.clips[newId] = copy
      const insertAt = track.clipIds.indexOf(tail.id)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }
      this.duplicateTailBySource[clipId] = newId
      const clipEnd = copy.startMs + clipEffDur
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      sendBridge('CLIP_ADD', {
        trackId: clip.trackId,
        clipId: newId,
        libraryItemId: clip.libraryItemId,
        positionMs: newStartMs,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (clip.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: clip.name })
      }
      // Replay active warp so the backend builds the duplicate processor.
      if (clip.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: clip.warpMode,
          tempoRatio: clip.tempoRatio,
          semitones: clip.semitones,
          cents: clip.cents
        })
      }
      log.info('project', `duplicateClip id=${clipId} -> newId=${newId} @${newStartMs}ms`)
      return newId
    },

    /** Optimistically remove a clip; keep track length stable after deletion. */
    removeClip(clipId: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (track) {
        const idx = track.clipIds.indexOf(clipId)
        if (idx >= 0) track.clipIds.splice(idx, 1)
      }
      delete this.clips[clipId]
      delete this.duplicateTailBySource[clipId]
      for (const [sourceId, tailId] of Object.entries(this.duplicateTailBySource)) {
        if (tailId === clipId) delete this.duplicateTailBySource[sourceId]
      }
      if (this.selectedClipId === clipId) this.selectedClipId = null
      this.peaksRevision++
      sendBridge('CLIP_REMOVE', { clipId })
      log.info('project', `removeClip id=${clipId}`)
    },

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

    copySelectedClip(): boolean {
      const id = this.selectedClipId
      if (!id) return false
      const clip = this.clips[id]
      if (!clip) return false
      this.clipboardClip = {
        sourceTrackId: clip.trackId,
        sourceStartMs: clip.startMs,
        sourceDurationMs: clip.durationMs,
        libraryItemId: clip.libraryItemId,
        filePath: clip.filePath,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        effectiveDurationMs: clip.effectiveDurationMs,
        effectiveTempoRatio: clip.effectiveTempoRatio,
        effectiveWarpActive: clip.effectiveWarpActive
      }
      log.info('project', `copySelectedClip id=${id}`)
      return true
    },

    cutSelectedClip(): boolean {
      const id = this.selectedClipId
      if (!id) return false
      if (!this.copySelectedClip()) return false
      this.removeClip(id)
      log.info('project', `cutSelectedClip id=${id}`)
      return true
    },

    /** Paste only into a free slot; never overwrite or push clips. */
    pasteClipAtPlayhead(positionMs?: number): string | null {
      const cb = this.clipboardClip
      if (!cb) return null
      const targetTrackId = this.selectedTrackId
      if (!targetTrackId) {
        log.warn('project', 'pasteClip: no selected target track')
        useNotificationsStore().pushError("Can't paste — select a target track first.")
        return null
      }
      const track = this.tracks.find((t) => t.id === targetTrackId)
      if (!track) {
        log.warn('project', `pasteClip: target track ${targetTrackId} no longer exists`)
        useNotificationsStore().pushError("Can't paste — target track has been removed.")
        return null
      }
      // Overlap checks use the clipboard clip's effective timeline footprint.
      const cbEffDur =
        typeof cb.effectiveDurationMs === 'number' && cb.effectiveDurationMs > 0
          ? cb.effectiveDurationMs
          : cb.durationMs

      const targetStartMs = Math.max(0, positionMs ?? 0)
      for (const id of track.clipIds) {
        const c = this.clips[id]
        if (!c) continue
        const cEffDur = effectiveClipDurationMs(c)
        const cEnd = c.startMs + cEffDur
        if (targetStartMs < cEnd && targetStartMs + cbEffDur > c.startMs) {
          useNotificationsStore().pushError('Not enough space to paste clip on this track.')
          log.info(
            'project',
            `pasteClip rejected: target=${targetStartMs} dur=${cbEffDur} overlaps clip ${id} on ${targetTrackId}`
          )
          return null
        }
      }
      const newId = crypto.randomUUID()
      const startMs = targetStartMs
      const fileName = filePathToDisplayName(cb.filePath)
      const placeholder: Clip = {
        id: newId,
        trackId: track.id,
        libraryItemId: cb.libraryItemId,
        filePath: cb.filePath,
        playbackFilePath: cb.filePath,
        fileName,
        startMs,
        inMs: cb.inMs,
        durationMs: cb.durationMs,
        sampleRate: 0,
        channelCount: 0,
        peaks: new Float32Array(0),
        unresolved: false,
        colorIndex: cb.colorIndex,
        name: cb.name,
        warpEnabled: cb.warpEnabled,
        warpMode: cb.warpMode,
        tempoRatio: cb.tempoRatio,
        semitones: cb.semitones,
        cents: cb.cents,
        effectiveDurationMs: cb.effectiveDurationMs,
        effectiveTempoRatio: cb.effectiveTempoRatio,
        effectiveWarpActive: cb.effectiveWarpActive
      }
      const peakSource = Object.values(this.clips).find(
        (c) => c.libraryItemId === cb.libraryItemId && c.peaks.length > 0
      )
      if (peakSource) {
        placeholder.peaks = peakSource.peaks
        placeholder.sampleRate = peakSource.sampleRate
      }
      this.clips[newId] = placeholder
      track.clipIds.push(newId)
      const clipEnd = startMs + cbEffDur
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      this.selectedClipId = newId
      this.peaksRevision++

      sendBridge('CLIP_ADD', {
        trackId: track.id,
        clipId: newId,
        libraryItemId: cb.libraryItemId,
        positionMs: startMs,
        inMs: cb.inMs,
        durationMs: cb.durationMs,
        ...(cb.colorIndex !== undefined ? { colorIndex: cb.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (cb.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: cb.name })
      }
      // Replay active warp so the backend builds the pasted processor.
      if (cb.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: cb.warpMode,
          tempoRatio: cb.tempoRatio,
          semitones: cb.semitones,
          cents: cb.cents
        })
      }
      log.info('project', `pasteClip newId=${newId} @${startMs}ms`)
      return newId
    },

    /** Set or clear a persisted per-clip colour override. */
    setClipColor(clipId: string, colorIndex: number | null): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (colorIndex === null) {
        if (clip.colorIndex === undefined) return
        clip.colorIndex = undefined
        // Historical redraw counter for non-positional visual changes.
        this.peaksRevision++
        sendBridge('CLIP_COLOR', { clipId, colorIndex: -1 })
        log.info('project', `setClipColor id=${clipId} -> inherit`)
        return
      }
      const clamped = Math.max(0, Math.min(TRACK_PALETTE.length - 1, Math.round(colorIndex)))
      if (clip.colorIndex === clamped) return
      clip.colorIndex = clamped
      this.peaksRevision++
      sendBridge('CLIP_COLOR', { clipId, colorIndex: clamped })
      log.info('project', `setClipColor id=${clipId} -> ${clamped}`)
    },

    /** Persist per-clip lock state; project mutation actions honor it locally. */
    setClipLocked(clipId: string, locked: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = locked === true
      const current = clip.locked === true
      if (next === current) return
      clip.locked = next ? true : undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_LOCKED', { clipId, locked: next })
      log.info('project', `setClipLocked id=${clipId} -> ${next ? 'locked' : 'unlocked'}`)
    },

    /** Relink once per library item; referenced clips follow that binding. */
    relinkLibraryItem(itemId: string, filePath: string): void {
      sendBridge('LIBRARY_ITEM_RELINK', { itemId, filePath })
      log.info('project', `relinkLibraryItem id=${itemId} -> ${filePath}`)
    },

    /** Set or clear a persisted clip display-name override. */
    renameClip(clipId: string, name: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (clip.name === nextName) return false
      clip.name = nextName
      this.peaksRevision++
      sendBridge('CLIP_RENAME', { clipId, name: nextName ?? '' })
      log.info('project', `renameClip id=${clipId} -> ${nextName ?? '<cleared>'}`)
      return true
    },

    saveClipToLibrary(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const itemId = useLibraryStore().addSavedClipFromTimelineClip(clip)
      if (itemId) {
        // Rebind so saved-clip usage views see the originating timeline clip.
        if (clip.libraryItemId !== itemId) {
          clip.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId, libraryItemId: itemId })
        }
        log.info('project', `saveClipToLibrary clip=${clipId} item=${itemId}`)
      }
      return itemId
    },

    async saveClipAsSample(clipId: string): Promise<void> {
      const clip = this.clips[clipId]
      if (!clip) return
      const itemId = `sample-${crypto.randomUUID()}`
      sendBridge('CLIP_SAVE_AS_SAMPLE', {
        clipId,
        itemId,
        sampleName: clip.name?.trim() || fileStem(clip.fileName),
        outputDir: await defaultSamplesDir(this.currentFilePath)
      })
      useNotificationsStore().pushInfo('Saving sample…')
    },

    /** Rebind a saved-clip instance to its source item while preserving its trim window. */
    unlinkClipFromLibrary(clipId: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const library = useLibraryStore()
      const parent = library.byId[clip.libraryItemId]
      if (!parent || parent.kind !== 'saved-clip') return false
      const fallbackParentId = parent.derivedFrom?.sourceItemId
      if (!fallbackParentId) return false
      clip.libraryItemId = fallbackParentId
      sendBridge('CLIP_REBIND', { clipId, libraryItemId: fallbackParentId })
      // Library binding changes need an explicit redraw for the link badge.
      this.peaksRevision++
      log.info('project', `unlinkClipFromLibrary clip=${clipId} -> source=${fallbackParentId}`)
      return true
    },

    /** Patch warp/pitch settings; `tempoRatio: null` clears a pinned ratio. */
    setClipWarp(
      clipId: string,
      patch: {
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        /** `null` clears the pinned override; `number` pins it. */
        tempoRatio?: number | null
        semitones?: number
        cents?: number
        pendingAutoWarp?: boolean
        effectiveDurationMs?: number
        effectiveTempoRatio?: number
        effectiveWarpActive?: boolean
      },
      opts?: { localOnly?: boolean }
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (patch.warpEnabled !== undefined) clip.warpEnabled = patch.warpEnabled
      if (patch.warpMode !== undefined) clip.warpMode = patch.warpMode
      if (patch.tempoRatio !== undefined) {
        clip.tempoRatio = patch.tempoRatio === null ? undefined : patch.tempoRatio
      }
      if (patch.semitones !== undefined) clip.semitones = patch.semitones
      if (patch.cents !== undefined) clip.cents = patch.cents
      if (patch.pendingAutoWarp !== undefined) {
        clip.pendingAutoWarp = patch.pendingAutoWarp ? true : undefined
      }
      if (patch.effectiveDurationMs !== undefined) clip.effectiveDurationMs = patch.effectiveDurationMs
      if (patch.effectiveTempoRatio !== undefined) clip.effectiveTempoRatio = patch.effectiveTempoRatio
      if (patch.effectiveWarpActive !== undefined) clip.effectiveWarpActive = patch.effectiveWarpActive
      // Explicit warp edits block late analysis from overriding user intent.
      if (
        patch.warpEnabled !== undefined ||
        patch.warpMode !== undefined ||
        patch.tempoRatio !== undefined ||
        patch.semitones !== undefined ||
        patch.cents !== undefined
      ) {
        clip.pendingAutoWarp = undefined
      }
      this.peaksRevision++
      if (!opts?.localOnly && patch.warpEnabled === true) {
        useLibraryStore().markItemWarping(clip.libraryItemId)
      }
      if (!opts?.localOnly) {
        sendBridge('CLIP_SET_WARP', {
          clipId,
          warpEnabled: patch.warpEnabled,
          warpMode: patch.warpMode,
          // Omit to preserve; send null to clear the pinned override.
          tempoRatio: patch.tempoRatio === undefined ? undefined : patch.tempoRatio,
          semitones: patch.semitones,
          cents: patch.cents,
          pendingAutoWarp: patch.pendingAutoWarp
        })
      }
    },

    /** Replace a clip envelope; local sanitising mirrors backend normalisation. */
    setClipEnvelope(
      clipId: string,
      points: ClipEnvelopePoint[],
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const cleaned = sanitizeEnvelopePoints(points)
      // Fewer than two breakpoints means no shape.
      const next = cleaned.length >= 2 ? cleaned : undefined
      if (!envelopesEqual(clip.envelopePoints, next)) {
        clip.envelopePoints = next
        this.peaksRevision++
      }
      if (!opts?.localOnly) {
        sendBridge('CLIP_SET_ENVELOPE', {
          clipId,
          points: cleaned,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update Tone EQ; localOnly reconciles backend acks without echoing gestures. */
    setTrackTone(
      trackId: string,
      patch: { bassDb?: number; midDb?: number; trebleDb?: number; lowCut?: boolean; highCut?: boolean },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampDb = (v: number): number =>
        Math.max(-15, Math.min(15, Number.isFinite(v) ? v : 0))
      if (patch.bassDb !== undefined) {
        const v = clampDb(patch.bassDb)
        track.toneBassDb = v !== 0 ? v : undefined
      }
      if (patch.midDb !== undefined) {
        const v = clampDb(patch.midDb)
        track.toneMidDb = v !== 0 ? v : undefined
      }
      if (patch.trebleDb !== undefined) {
        const v = clampDb(patch.trebleDb)
        track.toneTrebleDb = v !== 0 ? v : undefined
      }
      if (patch.lowCut !== undefined) {
        track.toneLowCut = patch.lowCut ? true : undefined
      }
      if (patch.highCut !== undefined) {
        track.toneHighCut = patch.highCut ? true : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_TONE', {
          trackId,
          bassDb: patch.bassDb,
          midDb: patch.midDb,
          trebleDb: patch.trebleDb,
          lowCut: patch.lowCut,
          highCut: patch.highCut,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update sends; undefined patch fields fall back to the current track value. */
    setTrackSends(
      trackId: string,
      patch: { reverbSend?: number; delaySend?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampUnit = (v: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      if (patch.reverbSend !== undefined) {
        const v = clampUnit(patch.reverbSend)
        track.reverbSend = v !== 0 ? v : undefined
      }
      if (patch.delaySend !== undefined) {
        const v = clampUnit(patch.delaySend)
        track.delaySend = v !== 0 ? v : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_SENDS', {
          trackId,
          reverbSend: patch.reverbSend ?? track.reverbSend ?? 0,
          delaySend: patch.delaySend ?? track.delaySend ?? 0,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update pan; localOnly reconciles backend acks without echoing gestures. */
    setTrackPan(
      trackId: string,
      pan: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
      track.pan = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_PAN', {
          trackId,
          pan: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update Leveler amount; localOnly reconciles backend acks. */
    setTrackLeveler(
      trackId: string,
      amount: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0))
      track.levelerAmount = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_LEVELER', {
          trackId,
          amount: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
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

    /** Check overlap in effective timeline time, not source duration. */
    wouldClipOverlap(trackId: string, startMs: number, durationMs: number): boolean {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return false
      const newStart = Math.max(0, startMs)
      const newEnd = newStart + durationMs
      for (const otherId of track.clipIds) {
        const other = this.clips[otherId]
        if (!other) continue
        const otherEffDur = effectiveClipDurationMs(other)
        const otherEnd = other.startMs + otherEffDur
        // Touching edges are allowed.
        if (newStart < otherEnd && newEnd > other.startMs) return true
      }
      return false
    },

    /** Drop a library item onto a track using its decoded peaks. */
    addClipFromLibrary(
      trackId: string,
      libraryItem: {
        id: string
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
        peaksPerSecond?: number
        playbackFilePath?: string
        kind?: LibraryItem['kind']
        name?: string
        derivedFrom?: LibraryItem['derivedFrom']
        /** Source BPM for auto-warp; variable-tempo files expose their median. */
        bpm?: number
        /** Auto-warp skips unstable-tempo sources. */
        variableTempo?: boolean
        /** Saved-clip warp defaults copy on drop. */
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
      },
      startMs: number
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null
      const snapped = Math.max(0, Math.floor(startMs))
      const clipInMs =
        libraryItem.kind === 'saved-clip' ? Math.max(0, libraryItem.derivedFrom?.inMs ?? 0) : 0
      const clipDurationMs =
        libraryItem.kind === 'saved-clip'
          ? Math.max(0, libraryItem.derivedFrom?.durationMs ?? libraryItem.durationMs)
          : libraryItem.durationMs
      // Predict post-drop effective duration so collision checks match auto-warp.
      const projectBpm = useTransportStore().bpm
      const autoWarpPref = useUiStore().matchProjectTempoOnDrop
      const projectHasOtherClips = Object.keys(this.clips).length > 0
      const willAutoWarp =
        libraryItem.warpEnabled === true ||
        (autoWarpPref &&
          projectHasOtherClips &&
          libraryItem.kind !== 'saved-clip' &&
          libraryItem.variableTempo !== true &&
          typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 &&
          typeof projectBpm === 'number' && projectBpm > 0)
      let effectiveClipDurationMs = clipDurationMs
      if (willAutoWarp) {
        const pinned = libraryItem.tempoRatio
        const ratio = typeof pinned === 'number' && pinned > 0
          ? pinned
          : (typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 && projectBpm > 0
              ? projectBpm / libraryItem.bpm
              : 1)
        if (ratio > 0 && Math.abs(ratio - 1) > 1e-4) {
          effectiveClipDurationMs = clipDurationMs / ratio
        }
      }
      if (this.wouldClipOverlap(trackId, snapped, effectiveClipDurationMs)) return null

      const inheritedName = libraryItem.name?.trim() || ''
      const clipId = this.addClipToTrack(
        trackId,
        {
          libraryItemId: libraryItem.id,
          filePath: libraryItem.filePath,
          fileName: inheritedName || libraryItem.fileName,
          durationMs: clipDurationMs,
          sampleRate: libraryItem.sampleRate,
          channelCount: libraryItem.channelCount,
          peaks: libraryItem.peaks,
          peaksPerSecond: libraryItem.peaksPerSecond,
          playbackFilePath: libraryItem.playbackFilePath,
          inMs: clipInMs
        },
        snapped
      )
      if (!clipId) return null

      sendBridge('CLIP_ADD', {
        trackId,
        clipId,
        libraryItemId: libraryItem.id,
        positionMs: snapped,
        ...(clipInMs > 0 || libraryItem.kind === 'saved-clip' ? { inMs: clipInMs } : {}),
        ...(libraryItem.kind === 'saved-clip' ? { durationMs: clipDurationMs } : {})
      })
      if (inheritedName) {
        const newClip = this.clips[clipId]
        if (newClip) newClip.name = inheritedName
        sendBridge('CLIP_RENAME', { clipId, name: inheritedName })
      }

      // Drop-time warp copies saved defaults or marks eligible audio for auto-warp.
      this.applyDropTimeWarp(clipId, libraryItem)

      this.pushTrackGain(track)
      log.info('project', `addClipFromLibrary track=${trackId} clip=${clipId} pos=${snapped}ms`)
      return clipId
    },

    /** Apply the single drop-time warp policy before notifying the backend. */
    applyDropTimeWarp(
      clipId: string,
      src: {
        id?: string
        kind?: LibraryItem['kind']
        bpm?: number
        variableTempo?: boolean
        lowConfidence?: boolean
        sampleMode?: 'sample' | 'music'
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
        derivedFrom?: LibraryItem['derivedFrom']
      }
    ): void {
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} kind=${src.kind ?? 'audio'} ` +
          `srcBpm=${src.bpm ?? 'undef'} variableTempo=${src.variableTempo ?? false} ` +
          `lowConfidence=${src.lowConfidence ?? false} sampleMode=${src.sampleMode ?? 'auto'} ` +
          `inheritedWarpEnabled=${src.warpEnabled ?? 'undef'} ` +
          `inheritedTempoRatio=${src.tempoRatio ?? 'undef'}`
      )
      // Saved-clip warp defaults are explicit user choices, not auto-match.
      if (src.kind === 'saved-clip' && (
        src.warpEnabled !== undefined ||
        src.warpMode !== undefined ||
        src.tempoRatio !== undefined ||
        src.semitones !== undefined ||
        src.cents !== undefined
      )) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → saved-clip inheritance branch`)
        this.setClipWarp(clipId, {
          warpEnabled: src.warpEnabled,
          warpMode: src.warpMode,
          tempoRatio: src.tempoRatio,
          semitones: src.semitones,
          cents: src.cents
        })
        return
      }
      // Sample-classified sources skip tempo auto-match; manual warp still works.
      const sampleClassified = libraryItemIsSample(
        {
          sampleMode: src.sampleMode,
          lowConfidence: src.lowConfidence,
          derivedFrom: src.derivedFrom
        },
        useLibraryStore().byId
      )
      if (sampleClassified) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (library item classified as sample)`
        )
        return
      }
      const ui = useUiStore()
      if (!ui.matchProjectTempoOnDrop) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (matchProjectTempoOnDrop pref OFF)`)
        return
      }
      // First audio clip seeds project BPM, so auto-warp would target a transient default.
      const otherClipExists = Object.values(this.clips).some((c) => c.id !== clipId)
      if (!otherClipExists) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (first clip on project)`)
        return
      }
      // Need stable source BPM and project BPM to target.
      const projectBpm = useTransportStore().bpm
      if (src.variableTempo === true || typeof src.bpm !== 'number' || src.bpm <= 0) {
        // Unknown source BPM: let later analysis opt in unless the user edits warp.
        if (src.kind !== 'saved-clip' && src.variableTempo !== true) {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → pendingAutoWarp (source BPM not yet known)`
          )
          this.setClipWarp(clipId, { pendingAutoWarp: true })
        } else {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → skip (variableTempo or no BPM, not pending)`
          )
        }
        return
      }
      if (typeof projectBpm !== 'number' || projectBpm <= 0) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (project BPM unknown: ${projectBpm})`
        )
        return
      }
      const ratio = projectBpm / src.bpm
      // Ratio ≈ 1 is inaudible and should not burn an undo step.
      if (Math.abs(ratio - 1) < 1e-3) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (ratio ≈ 1: project=${projectBpm} src=${src.bpm})`
        )
        return
      }
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} → ENGAGE warp (project=${projectBpm} src=${src.bpm} ratio=${ratio.toFixed(4)})`
      )
      this.setClipWarp(clipId, {
        warpEnabled: true,
        warpMode: 'rhythmic',
        // Undefined keeps the clip following project BPM; pinning is user-driven.
      })
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

    removeTrack(trackId: string): void {
      const idx = this.tracks.findIndex((t) => t.id === trackId)
      if (idx < 0) return

      const track = this.tracks[idx]
      if (!track) return
      for (const clipId of track.clipIds) {
        delete this.clips[clipId]
        delete this.duplicateTailBySource[clipId]
        for (const [sourceId, tailId] of Object.entries(this.duplicateTailBySource)) {
          if (tailId === clipId) delete this.duplicateTailBySource[sourceId]
        }
        if (this.selectedClipId === clipId) this.selectedClipId = null
      }
      if (this.selectedTrackId === trackId) this.selectedTrackId = null
      this.tracks.splice(idx, 1)

      sendBridge('TRACK_REMOVE', { trackId })

      if (track.soloed) this.pushAllGains()
      log.info('project', `removeTrack id=${trackId}`)
    },

    /** Toggle persisted mute; backend derives effective gain. */
    toggleMute(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.muted = !t.muted
      log.info('project', `toggleMute id=${trackId} muted=${t.muted}`)
      sendBridge('TRACK_MUTE', { trackId, muted: t.muted })
    },

    /** Toggle solo; backend re-pushes project-wide effective gain. */
    toggleSolo(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.soloed = !t.soloed
      log.info('project', `toggleSolo id=${trackId} soloed=${t.soloed}`)
      sendBridge('TRACK_SOLO', { trackId, soloed: t.soloed })
    },

    /** Re-push user volume; backend folds in mute/solo. */
    pushTrackGain(track: Track): void {
      sendBridge('TRACK_GAIN', { trackId: track.id, gain: track.volume })
    },

    /** Re-push all user volumes after reconnect; mute/solo ride PROJECT_STATE. */
    pushAllGains(): void {
      for (const t of this.tracks) {
        sendBridge('TRACK_GAIN', { trackId: t.id, gain: t.volume })
      }
    },

    /** Commit track volume; live drags use setTrackVolumeLocal to avoid bridge flood. */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
      log.debug('project', `setTrackVolume id=${trackId} volume=${t.volume}`)
      sendBridge('TRACK_GAIN', { trackId, gain: t.volume })
    },

    setTrackVolumeLocal(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
    },

    /** Local-only row resize preview; commit once on pointerup. */
    setTrackHeightLocal(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
    },

    /** Commit row height; PROJECT_STATE ack returns any backend clamp. */
    setTrackHeight(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
      sendBridge('TRACK_SET_HEIGHT', { trackId, heightPx })
    },

    /** Optimistically reorder tracks; soft-replace PROJECT_STATE restores undo/redo order. */
    reorderTrack(trackId: string, newIndex: number): void {
      const currentIndex = this.tracks.findIndex((t) => t.id === trackId)
      if (currentIndex < 0) return
      const clamped = Math.max(0, Math.min(this.tracks.length - 1, Math.floor(newIndex)))
      if (clamped === currentIndex) return
      const [moved] = this.tracks.splice(currentIndex, 1)
      if (!moved) return
      this.tracks.splice(clamped, 0, moved)
      sendBridge('TRACK_REORDER', { trackId, newIndex: clamped })
    },

    /** Match CLIP_ADD acks by renderer-assigned clipId; failures roll back. */
    confirmClipAdd(trackId: string, clipId: string, ok: boolean, error?: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (ok) {
        return
      }
      const track = this.tracks.find((t) => t.id === trackId)
      delete this.clips[clipId]
      if (track) {
        track.clipIds = track.clipIds.filter((id) => id !== clipId)
      }
      const message = error
        ? `Couldn't add clip: ${error}`
        : 'Couldn\'t add clip (the audio engine rejected the file).'
      useNotificationsStore().pushError(message)
    },

    setTrackColor(trackId: string, colorIndex: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      if (colorIndex < 0 || colorIndex >= TRACK_PALETTE.length) return
      t.colorIndex = colorIndex
      log.info('project', `setTrackColor id=${trackId} colorIndex=${colorIndex}`)
    },

    setTrackName(trackId: string, name: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      const trimmed = name.trim()
      if (trimmed.length === 0) return
      if (t.name === trimmed) return
      t.name = trimmed
      sendBridge('TRACK_RENAME', { trackId, name: trimmed })
      log.info('project', `setTrackName id=${trackId} name="${trimmed}"`)
    },

    /** Apply WAVEFORM_DATA peaks; unknown clips may have been removed. */
    setClipPeaks(
      clipId: string,
      peaks: Float32Array,
      sampleRate: number,
      peaksPerSecond?: number,
      channels?: Float32Array[]
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      clip.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) clip.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) clip.sampleRate = sampleRate
      // A revision counter avoids deep-watching clips for waveform redraws.
      this.peaksRevision++
      // Prefer the whole-file library row; saved clips can share its filePath.
      const lib = useLibraryStore()
      const item =
        lib.items.find((i) => i.kind === 'audio-file' && i.filePath === clip.filePath) ??
        lib.items.find((i) => i.filePath === clip.filePath)
      if (item && item.peaks.length === 0) {
        lib.setItemPeaks(item.id, peaks, sampleRate, peaksPerSecond)
      }
      // Empty channel lanes clear stale stereo peaks for summary-only sources.
      if (item && typeof peaksPerSecond === 'number' && peaksPerSecond > 0) {
        lib.setItemChannelPeaks(item.id, channels ?? [], peaksPerSecond)
      }
      log.debug('project', `setClipPeaks id=${clipId} peaks=${peaks.length / 2} sr=${sampleRate} pps=${clip.peaksPerSecond ?? 'undef'}`)
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

    addMarkerAt(positionMs: number): boolean {
      const safePositionMs = Math.max(0, Math.floor(positionMs))
      const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
      if (existing) return false

      const marker: Marker = {
        id: crypto.randomUUID(),
        positionMs: safePositionMs
      }
      this.markers.push(marker)
      this.markers.sort((a, b) => a.positionMs - b.positionMs)

      const sent = sendBridge('PROJECT_MARKER_ADD', {
        markerId: marker.id,
        positionMs: marker.positionMs
      })
      if (!sent) {
        useNotificationsStore().pushError('Marker was added locally, but the audio engine isn\'t connected.')
      }
      log.info('project', `addMarkerAt id=${marker.id} position=${marker.positionMs}`)
      return true
    },

    toggleMarkerAt(positionMs: number): boolean {
      const safePositionMs = Math.max(0, Math.round(positionMs))
      const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
      if (existing) return this.removeMarker(existing.id)
      return this.addMarkerAt(safePositionMs)
    },

    removeMarker(markerId: string): boolean {
      const index = this.markers.findIndex((marker) => marker.id === markerId)
      if (index < 0) return false
      const [marker] = this.markers.splice(index, 1)
      const sent = sendBridge('PROJECT_MARKER_REMOVE', { markerId })
      if (!sent) {
        useNotificationsStore().pushError('Marker was removed locally, but the audio engine isn\'t connected.')
      }
      log.info('project', `removeMarker id=${markerId} position=${marker?.positionMs ?? '?'}`)
      return true
    },

    moveMarker(markerId: string, positionMs: number): boolean {
      const marker = this.markers.find((m) => m.id === markerId)
      if (!marker) return false
      const safePositionMs = Math.max(0, Math.round(positionMs))
      if (Math.abs(marker.positionMs - safePositionMs) < 1) return true
      const existing = this.markers.find((m) => m.id !== markerId && Math.abs(m.positionMs - safePositionMs) < 1)
      if (existing) return false
      marker.positionMs = safePositionMs
      this.markers.sort((a, b) => a.positionMs - b.positionMs)
      const sent = sendBridge('PROJECT_MARKER_MOVE', {
        markerId,
        positionMs: safePositionMs
      })
      if (!sent) {
        useNotificationsStore().pushError('Marker was moved locally, but the audio engine isn\'t connected.')
      }
      return true
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
