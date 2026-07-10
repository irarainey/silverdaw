// Structural clip-edit actions for the project store: split, duplicate, remove.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  CLIP_FIT_EPSILON_MS
} from '@/lib/clip/clipTiming'
import { MAX_SLICES } from '@/lib/clipEditor/loopSlice'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import type { Clip } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'
import { waveformReusePayload } from './project-waveform-state'

export const clipEditActions = {
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
      if (libItem?.kind === 'clip') {
        useNotificationsStore().pushInfo('Linked clips cannot be split on the timeline and must be edited in the Clip Editor.')
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

      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null

      // One undo step for the whole split: the left-half trim and the new right-half clip (plus its
      // name/warp replay) fold into a single transaction.
      return runInUndoGroup('Split clip', () => {
        this.trimClip(clipId, clip.startMs, clip.inMs, splitOffsetSourceMs)

        // Reuse peaks and carry warp settings so both halves stay in time.
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
        this.timelineRevision++

        sendBridge('CLIP_ADD', {
          trackId: clip.trackId,
          clipId: newId,
          libraryItemId: clip.libraryItemId,
          positionMs: newClipStartMs,
          inMs: newClipInMs,
          durationMs: newClipDurationMs,
          ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {}),
          ...waveformReusePayload(clip, library)
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
      })
    },

    /** Slice a clip into adjacent timeline clips at the given source-ms markers. */
    sliceClipToTimeline(clipId: string, markersSourceMs: readonly number[]): number {
      const clip = this.clips[clipId]
      if (!clip) return 0
      const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
      const clipEnd = clip.startMs + clip.durationMs / ratio
      // Convert source-ms markers to timeline positions using the ORIGINAL clip's
      // fixed origin, keep strict-interior cuts, and split right→left so each peel
      // leaves the remaining left coordinates valid (O(N), not the O(N²) / N file
      // open storm a left→right roll would cause). One undo step for the whole chop.
      const positions = markersSourceMs
        .map((m) => clip.startMs + (m - clip.inMs) / ratio)
        .filter((t) => t > clip.startMs + 1 && t < clipEnd - 1)
        .sort((a, b) => b - a)
        .slice(0, MAX_SLICES)
      if (positions.length === 0) return 0
      let made = 0
      runInUndoGroup('Slice clip', () => {
        for (const atMs of positions) {
          // splitClipAt already rejects locked/linked clips with a toast; stop on
          // the first refusal so we never leave a half-sliced clip behind.
          if (this.splitClipAt(clipId, atMs) === null) return
          made++
        }
      })
      return made
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
        reversed: clip.reversed,
        locked: clip.locked,
        // Carry the source's exact rendered footprint and volume shape so the
        // duplicate is a true copy from the first frame, before the warp /
        // envelope acks land.
        effectiveDurationMs: clip.effectiveDurationMs,
        effectiveTempoRatio: clip.effectiveTempoRatio,
        effectiveWarpActive: clip.effectiveWarpActive,
        envelopePoints: clip.envelopePoints
          ? clip.envelopePoints.map((p) => ({ ...p }))
          : undefined
      }
      this.clips[newId] = copy
      const insertAt = track.clipIds.indexOf(tail.id)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }
      this.duplicateTailBySource[clipId] = newId
      this.timelineRevision++
      const clipEnd = copy.startMs + clipEffDur
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      // One undo step for the duplicate: CLIP_ADD plus its name / warp / reverse /
      // envelope / lock replay.
      runInUndoGroup('Duplicate clip', () => {
        sendBridge('CLIP_ADD', {
          trackId: clip.trackId,
          clipId: newId,
          libraryItemId: clip.libraryItemId,
          positionMs: newStartMs,
          inMs: clip.inMs,
          durationMs: clip.durationMs,
          ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {}),
          ...waveformReusePayload(clip, useLibraryStore())
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
        // Replay the volume shape so the duplicate keeps the source's fades.
        if (copy.envelopePoints && copy.envelopePoints.length >= 2) {
          this.setClipEnvelope(newId, copy.envelopePoints)
        }
        // Replay the lock so the duplicate inherits the source's lock state.
        if (clip.locked === true) {
          sendBridge('CLIP_SET_LOCKED', { clipId: newId, locked: true })
        }
      })
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
      this.timelineRevision++
      sendBridge('CLIP_REMOVE', { clipId })
      log.info('project', `removeClip id=${clipId}`)
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
