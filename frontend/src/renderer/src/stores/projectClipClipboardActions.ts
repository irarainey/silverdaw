// Clipboard clip actions for the project store: copy, cut, paste (single + multi-clip).
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { effectiveClipDurationMs, CLIP_FIT_EPSILON_MS } from '@/lib/clip/clipTiming'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { filePathToDisplayName } from './projectHelpers'
import { waveformReusePayload } from './project-waveform-state'
import type { Clip, ClipboardEntry, ClipboardGroupItem, Track } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

/** Snapshot a clip into a clipboard entry (source position + all replayable clip fields). */
function clipToClipboardEntry(clip: Clip): ClipboardEntry {
  return {
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
}

/** A clipboard entry's effective timeline footprint (warp-aware), falling back to raw duration. */
function clipboardEntryEffDur(entry: ClipboardEntry): number {
  return typeof entry.effectiveDurationMs === 'number' && entry.effectiveDurationMs > 0
    ? entry.effectiveDurationMs
    : entry.durationMs
}

/** Effective-time overlap test with the shared fit tolerance (grid vs sample-derived ms). */
function overlaps(aStart: number, aDur: number, bStart: number, bDur: number): boolean {
  return aStart < bStart + bDur - CLIP_FIT_EPSILON_MS && aStart + aDur > bStart + CLIP_FIT_EPSILON_MS
}

/** Build and insert a placeholder clip from a clipboard entry at (track, startMs), reusing decoded
 *  peaks from any live instance of the same library item. Mutates store state and returns the new
 *  clip id. Bridge replay is separate (`replayPastedClipBridge`) so callers can batch it. */
function insertPastedClip(
  self: ProjectClipThis,
  entry: ClipboardEntry,
  track: Track,
  startMs: number
): string {
  const newId = crypto.randomUUID()
  const fileName = filePathToDisplayName(entry.filePath)
  // Best-effort hydration only; the outbound gate rechecks the placeholder.
  const peakSource = Object.values(self.clips).find(
    (clip) => clip.libraryItemId === entry.libraryItemId && clip.peaks.length > 0
  )
  const placeholder: Clip = {
    id: newId,
    trackId: track.id,
    libraryItemId: entry.libraryItemId,
    filePath: entry.filePath,
    playbackFilePath: entry.filePath,
    fileName,
    startMs,
    inMs: entry.inMs,
    durationMs: entry.durationMs,
    sampleRate: peakSource?.sampleRate ?? 0,
    channelCount: peakSource?.channelCount ?? 0,
    peaks: peakSource?.peaks ?? new Float32Array(0),
    peaksPerSecond: peakSource?.peaksPerSecond,
    unresolved: false,
    colorIndex: entry.colorIndex,
    name: entry.name,
    warpEnabled: entry.warpEnabled,
    warpMode: entry.warpMode,
    tempoRatio: entry.tempoRatio,
    semitones: entry.semitones,
    cents: entry.cents,
    effectiveDurationMs: entry.effectiveDurationMs,
    effectiveTempoRatio: entry.effectiveTempoRatio,
    effectiveWarpActive: entry.effectiveWarpActive
  }
  self.clips[newId] = placeholder
  track.clipIds.push(newId)
  const clipEnd = startMs + clipboardEntryEffDur(entry)
  if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
  return newId
}

/** Replay the bridge messages that recreate a pasted clip on the backend (CLIP_ADD plus its
 *  name/warp state). Call inside a `runInUndoGroup` so the whole paste is one undo step. */
function replayPastedClipBridge(
  self: ProjectClipThis,
  entry: ClipboardEntry,
  newId: string,
  track: Track,
  startMs: number
): void {
  const pastedClip = self.clips[newId]
  sendBridge('CLIP_ADD', {
    trackId: track.id,
    clipId: newId,
    libraryItemId: entry.libraryItemId,
    positionMs: startMs,
    inMs: entry.inMs,
    durationMs: entry.durationMs,
    ...(entry.colorIndex !== undefined ? { colorIndex: entry.colorIndex } : {}),
    ...(pastedClip ? waveformReusePayload(pastedClip, useLibraryStore()) : {})
  })
  self.pushTrackGain(track)
  if (entry.name) {
    sendBridge('CLIP_RENAME', { clipId: newId, name: entry.name })
  }
  // Replay active warp so the backend builds the pasted processor.
  if (entry.warpEnabled === true) {
    sendBridge('CLIP_SET_WARP', {
      clipId: newId,
      warpEnabled: true,
      warpMode: entry.warpMode,
      tempoRatio: entry.tempoRatio,
      semitones: entry.semitones,
      cents: entry.cents
    })
  }
}

export const clipClipboardActions = {
    copySelectedClip(): boolean {
      const id = this.selectedClipId
      if (!id) return false
      const clip = this.clips[id]
      if (!clip) return false
      this.clipboardClip = clipToClipboardEntry(clip)
      this.clipboardClips = null // single copy supersedes any multi-clip buffer
      log.info('project', `copySelectedClip id=${id}`)
      return true
    },

    /** Copy the whole multi-selection, storing each clip's offset from the group anchor (the
     *  earliest start and top-most track) so paste can re-anchor the group at the playhead. */
    copySelectedClips(): boolean {
      const clips = Array.from(this.selectedClipIds)
        .map((id) => this.clips[id])
        .filter((c): c is Clip => c != null)
      if (clips.length === 0) return false
      const anchorStartMs = Math.min(...clips.map((c) => c.startMs))
      const trackIndexOf = (clip: Clip): number => this.tracks.findIndex((t) => t.id === clip.trackId)
      const anchorTrackIndex = Math.min(...clips.map((c) => trackIndexOf(c)))
      const items: ClipboardGroupItem[] = clips
        .map((clip) => ({
          ...clipToClipboardEntry(clip),
          relStartMs: clip.startMs - anchorStartMs,
          relTrackIndex: trackIndexOf(clip) - anchorTrackIndex
        }))
        .sort((a, b) => a.relTrackIndex - b.relTrackIndex || a.relStartMs - b.relStartMs)
      this.clipboardClips = { items }
      this.clipboardClip = null // multi copy supersedes any single-clip buffer
      log.info('project', `copySelectedClips count=${items.length}`)
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

    /** Copy the multi-selection, then delete every selected clip as one undo step. */
    cutSelectedClips(): boolean {
      if (!this.copySelectedClips()) return false
      const ids = Array.from(this.selectedClipIds)
      runInUndoGroup('Cut clips', () => {
        for (const id of ids) this.removeClip(id)
      })
      this.selectedClipId = null
      this.selectedClipIds = new Set()
      this.timelineRevision++
      log.info('project', `cutSelectedClips count=${ids.length}`)
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
      const cbEffDur = clipboardEntryEffDur(cb)
      const targetStartMs = Math.max(0, positionMs ?? 0)
      for (const id of track.clipIds) {
        const c = this.clips[id]
        if (!c) continue
        if (overlaps(targetStartMs, cbEffDur, c.startMs, effectiveClipDurationMs(c))) {
          useNotificationsStore().pushError('Not enough space to paste clip on this track.')
          log.info(
            'project',
            `pasteClip rejected: target=${targetStartMs} dur=${cbEffDur} overlaps clip ${id} on ${targetTrackId}`
          )
          return null
        }
      }
      const newId = insertPastedClip(this, cb, track, targetStartMs)
      this.selectedClipId = newId
      this.selectedClipIds = new Set([newId])
      this.timelineRevision++

      // One undo step for the paste: CLIP_ADD plus its name/warp replay.
      runInUndoGroup('Paste clip', () => {
        replayPastedClipBridge(this, cb, newId, track, targetStartMs)
      })
      log.info('project', `pasteClip newId=${newId} @${targetStartMs}ms`)
      return newId
    },

    /** Paste a copied multi-clip group, anchored at the playhead on the selected track. Each clip
     *  keeps its captured time/track offset from the group anchor; tracks below the last real track
     *  clamp onto it (no auto-create). Atomic: if ANY clip would overlap an existing clip or another
     *  pasted clip, the whole paste is rejected. Selects the pasted clips. Returns the primary
     *  pasted id (top-most, earliest) or null. */
    pasteClipsAtPlayhead(positionMs?: number): string | null {
      const cb = this.clipboardClips
      if (!cb || cb.items.length === 0) return null
      const targetTrackId = this.selectedTrackId
      if (!targetTrackId) {
        log.warn('project', 'pasteClips: no selected target track')
        useNotificationsStore().pushError("Can't paste — select a target track first.")
        return null
      }
      const anchorTrackIndex = this.tracks.findIndex((t) => t.id === targetTrackId)
      if (anchorTrackIndex < 0) {
        log.warn('project', `pasteClips: target track ${targetTrackId} no longer exists`)
        useNotificationsStore().pushError("Can't paste — target track has been removed.")
        return null
      }
      const lastTrackIndex = this.tracks.length - 1
      const anchorStartMs = Math.max(0, positionMs ?? 0)

      // Resolve every clip's destination up front so validation and application share one layout.
      const placements = cb.items.map((entry) => {
        const trackIndex = Math.min(lastTrackIndex, anchorTrackIndex + entry.relTrackIndex)
        return {
          entry,
          track: this.tracks[trackIndex]!,
          startMs: anchorStartMs + entry.relStartMs,
          effDur: clipboardEntryEffDur(entry)
        }
      })

      // Atomic validation against existing clips AND earlier placements on the same track (track
      // clamping can land clips from different source tracks onto the last track).
      const accepted: typeof placements = []
      for (const p of placements) {
        for (const id of p.track.clipIds) {
          const c = this.clips[id]
          if (!c) continue
          if (overlaps(p.startMs, p.effDur, c.startMs, effectiveClipDurationMs(c))) {
            useNotificationsStore().pushError(
              "The copied clips don't fit here — they'd overlap clips already on the timeline. Move the playhead to a clearer spot and paste again."
            )
            log.info('project', `pasteClips rejected: overlaps existing clip ${id} on ${p.track.id}`)
            return null
          }
        }
        for (const q of accepted) {
          if (q.track.id === p.track.id && overlaps(p.startMs, p.effDur, q.startMs, q.effDur)) {
            useNotificationsStore().pushError(
              'The copied clips span more tracks than there are below the selected track, so they overlap. Select a higher track and paste again.'
            )
            log.info('project', `pasteClips rejected: pasted clips overlap on ${p.track.id}`)
            return null
          }
        }
        accepted.push(p)
      }

      const newIds = placements.map((p) => insertPastedClip(this, p.entry, p.track, p.startMs))
      this.selectedClipId = newIds[0] ?? null
      this.selectedClipIds = new Set(newIds)
      this.timelineRevision++

      // One undo step for the whole group.
      runInUndoGroup('Paste clips', () => {
        placements.forEach((p, i) => {
          replayPastedClipBridge(this, p.entry, newIds[i]!, p.track, p.startMs)
        })
      })
      log.info('project', `pasteClips count=${newIds.length} @${anchorStartMs}ms`)
      return newIds[0] ?? null
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
