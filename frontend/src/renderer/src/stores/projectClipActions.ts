// Clip editing domain actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  findClipSlot,
  CLIP_FIT_EPSILON_MS
} from '@/lib/clip/clipTiming'
import { sanitizeEnvelopePoints, envelopesEqual } from '@/lib/envelope'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { filePathToDisplayName } from './projectHelpers'
import { TRACK_PALETTE } from './projectTypes'
import type { Clip } from './projectTypes'
import type { ClipEnvelopePoint, ClipWarpMode } from '@shared/bridge-protocol'
import type { ProjectClipThis } from './projectClipContract'

export const clipActions = {
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
      // Derive the right half's own timeline footprint from its source length.
      // Must be captured before trimClip(), which mutates clip.effectiveDurationMs
      // in place to the LEFT half's value — copying it afterwards would size the
      // new clip's rectangle to the left half and mis-stretch its waveform.
      const newClipEffectiveDurationMs = ratio > 0 ? newClipDurationMs / ratio : newClipDurationMs

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
        // Carry the source peak-bucket rate; the renderer maps the waveform
        // window via peaksPerSecond, so without it the new half falls back to
        // the library default rate and mis-renders (notably stem clips).
        peaksPerSecond: clip.peaksPerSecond,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp,
        effectiveDurationMs: newClipEffectiveDurationMs,
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
        // Tolerance keeps an exact-size gap (grid vs sample-derived ms) from
        // reading as a sub-millisecond overlap.
        if (newStartMs < cEnd - CLIP_FIT_EPSILON_MS && newStartMs + clipEffDur > c.startMs + CLIP_FIT_EPSILON_MS) {
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
        // Carry the source peak-bucket rate so the duplicate renders its
        // waveform window correctly (stem clips use a non-default rate).
        peaksPerSecond: clip.peaksPerSecond,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp,
        reversed: clip.reversed
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
      // Replay reverse so the duplicate plays backwards like its source.
      if (clip.reversed === true) {
        sendBridge('CLIP_SET_REVERSED', { clipId: newId, reversed: true })
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
        // Tolerance keeps an exact-size gap (grid vs sample-derived ms) from
        // reading as a sub-millisecond overlap.
        if (targetStartMs < cEnd - CLIP_FIT_EPSILON_MS && targetStartMs + cbEffDur > c.startMs + CLIP_FIT_EPSILON_MS) {
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

    /** Persist per-clip reverse state; non-destructive, plays the clip window backwards. */
    setClipReversed(clipId: string, reversed: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = reversed === true
      const current = clip.reversed === true
      if (next === current) return
      clip.reversed = next ? true : undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_REVERSED', { clipId, reversed: next })
      log.info('project', `setClipReversed id=${clipId} -> ${next ? 'reversed' : 'forward'}`)
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
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
