// Clip placement actions for the project store: add, move, trim, overlap, ack.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  clipFirstBeatOffsetMs,
  findClipSlot,
  CLIP_FIT_EPSILON_MS
} from '@/lib/clip/clipTiming'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { TIME_SIG_NUM } from '@/lib/timeline/constants'
import type { Clip } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

export const clipPlacementActions = {
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
        // Touching edges are allowed. Tolerate sub-millisecond float drift so a
        // clip that exactly fills a gap isn't rejected as a phantom overlap.
        if (newStart < otherEnd - CLIP_FIT_EPSILON_MS && newEnd > other.startMs + CLIP_FIT_EPSILON_MS) {
          return true
        }
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

    /** Snap a clip so its beat grid lines up with the project BAR grid: the clip's
     *  first in-window grid beat is moved to the nearest project bar line (bumping a
     *  bar forward when that would land before the timeline origin, i.e. a clean
     *  leading bar of silence). Aligning the beat grid (what the timeline markers
     *  use) rather than the raw clip edge is why a clip that starts with silence
     *  ends up on the bar rather than a beat off it.
     *
     *  No-op unless the clip's effective (warp-adjusted) tempo matches the project
     *  tempo — a clip whose beats are spaced differently from the grid can't align,
     *  and simple samples (no beat grid) and locked clips are never moved. Callers
     *  run this AFTER the project tempo has settled (e.g. after the first-clip BPM
     *  seed), so `transport.bpm` reflects the grid the clip will sit on. */
    alignClipToBarGrid(clipId: string): void {
      const clip = this.clips[clipId]
      if (!clip || clip.locked) return
      const projectBpm = useTransportStore().bpm
      if (!Number.isFinite(projectBpm) || projectBpm <= 0) return
      const library = useLibraryStore()
      const offsetMs = clipFirstBeatOffsetMs(clip, library)
      if (offsetMs === null) return // no beat grid — leave simple samples untouched

      // The clip's beats must share the project grid spacing, or aligning one beat
      // is meaningless (the rest drift). Compare the clip's effective (warp-adjusted)
      // timeline beat spacing to the project's.
      const item = clip.libraryItemId ? library.byId[clip.libraryItemId] : undefined
      const sourceBpm = item ? libraryItemSourceBpm(item, library.byId) : undefined
      if (!sourceBpm || sourceBpm <= 0) return
      const warpRatio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
      const clipBeatMs = 60_000 / sourceBpm / warpRatio
      const projectBeatMs = 60_000 / projectBpm
      if (Math.abs(clipBeatMs - projectBeatMs) / projectBeatMs > 0.01) return // tempo mismatch

      const barSpacingMs = projectBeatMs * TIME_SIG_NUM
      const firstBeatMs = clip.startMs + offsetMs
      // Nearest bar line, then back out the offset. Bump a whole bar forward if that
      // would put the clip before the origin, so the downbeat stays bar-aligned with
      // a single leading bar of silence.
      let target = Math.round(firstBeatMs / barSpacingMs) * barSpacingMs - offsetMs
      while (target < -1e-6) target += barSpacingMs
      target = Math.max(0, target)
      if (Math.abs(target - clip.startMs) < 0.5) return // already aligned
      this.moveClip(clipId, target)
      log.debug('project', `alignClipToBarGrid ${clipId} ${clip.startMs.toFixed(1)} -> ${target.toFixed(1)}ms`)
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
