// Clipboard clip actions for the project store: copy, cut, paste.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { effectiveClipDurationMs, CLIP_FIT_EPSILON_MS } from '@/lib/clip/clipTiming'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { filePathToDisplayName } from './projectHelpers'
import type { Clip } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

export const clipClipboardActions = {
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
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
