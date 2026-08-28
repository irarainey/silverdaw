// Clip placement actions for the project store: add, move, trim, overlap, ack.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  sourceDeltaMsFromTimeline,
  findClipSlot,
  CLIP_FIT_EPSILON_MS
} from '@/lib/clip/clipTiming'
import { clipFirstBeatOffsetMs } from '@/lib/clip/sourceBeatGrid'
import { warpChangesTiming } from '@/lib/warp'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import type { Clip } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

/** Below this a clip's first beat is already on the line; moving it would be churn.
 *  Half a millisecond is ~22 samples at 44.1 kHz and well under a pixel at any zoom. */
const GRID_ALIGNED_EPSILON_MS = 0.5

/** A clip's beat-grid alignment against the project grid, or null when it has none.
 *
 *  Resolved once and shared by both align actions — the one that moves the clip and the
 *  one that moves the audio inside it — so the two can never disagree about which beat
 *  is being aligned or how far off it is. `shiftMs` is the timeline distance the clip's
 *  first in-window source beat must travel to reach the NEAREST project beat line: the
 *  smallest possible correction (at most half a beat), forward or back, rather than the
 *  nearest bar, which could shove it up to two beats away. Aligning the beat grid (what
 *  the timeline markers use) rather than the raw clip edge is why a clip that opens with
 *  silence lands on the grid rather than a fraction of a beat off it. */
function resolveClipBeatAlignment(
  store: ProjectClipThis,
  clipId: string
): {
  clip: Clip
  beatOffsetMs: number
  shiftMs: number
  ratio: number
  projectBeatMs: number
  sourceSpacingMs: number
} | null {
  const clip = store.clips[clipId]
  if (!clip || clip.locked) return null
  const projectBpm = useTransportStore().bpm
  if (!Number.isFinite(projectBpm) || projectBpm <= 0) return null
  const library = useLibraryStore()
  const beatOffsetMs = clipFirstBeatOffsetMs(clip, library)
  if (beatOffsetMs === null) return null // no beat grid — leave simple samples untouched

  // The clip's beats must share the project grid spacing, or aligning one beat is
  // meaningless (the rest drift). Compare the clip's effective (warp-adjusted)
  // timeline beat spacing to the project's.
  const item = clip.libraryItemId ? library.byId[clip.libraryItemId] : undefined
  const sourceBpm = item ? libraryItemSourceBpm(item, library.byId) : undefined
  if (!sourceBpm || sourceBpm <= 0) return null
  const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
  const sourceSpacingMs = 60_000 / sourceBpm
  const clipBeatMs = sourceSpacingMs / ratio
  const projectBeatMs = 60_000 / projectBpm
  if (Math.abs(clipBeatMs - projectBeatMs) / projectBeatMs > 0.01) return null // tempo mismatch

  const firstBeatMs = clip.startMs + beatOffsetMs
  const shiftMs = Math.round(firstBeatMs / projectBeatMs) * projectBeatMs - firstBeatMs
  return { clip, beatOffsetMs, shiftMs, ratio, projectBeatMs, sourceSpacingMs }
}

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
      this.timelineRevision++

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

      // One CLIP_MOVE keeps backend position and optional re-parenting atomic; the
      // backend re-applies the destination track's effective gain on re-parent.
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: target,
        ...(trackChanged ? { trackId: destTrackId } : {})
      })
      this.timelineRevision++
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

    /** Move a group of clips by a uniform (deltaMs, deltaTrackIndex) from captured `origins`, as
     *  ONE atomic operation: validate the entire target configuration first (each target in bounds
     *  and not overlapping a clip OUTSIDE the group — group members shift together so never block
     *  each other) and apply only if the whole group fits, otherwise make no change. Rejects when
     *  any group clip is missing or locked. Because a uniform track delta maps distinct source
     *  tracks to distinct target tracks and preserves per-track gaps, group members can't collide
     *  with one another, so only non-group clips are checked. Callers bracket a drag/nudge gesture
     *  in `EDIT_GROUP_BEGIN`/`END` so the whole move is a single undo step. Returns true when the
     *  group was valid (applied); false when rejected. */
    moveClipGroup(
      origins: readonly { clipId: string; startMs: number; trackIndex: number }[],
      deltaMs: number,
      deltaTrackIndex: number
    ): boolean {
      if (origins.length === 0) return false
      const groupIds = new Set(origins.map((o) => o.clipId))
      const trackCount = this.tracks.length

      type GroupTarget = { clip: Clip; startMs: number; destTrackId: string; trackChanged: boolean }
      const targets: GroupTarget[] = []
      for (const o of origins) {
        const clip = this.clips[o.clipId]
        if (!clip || clip.locked) return false
        const startMs = o.startMs + deltaMs
        if (startMs < 0) return false
        const trackIndex = o.trackIndex + deltaTrackIndex
        if (trackIndex < 0 || trackIndex >= trackCount) return false
        const destTrack = this.tracks[trackIndex]
        if (!destTrack) return false
        targets.push({
          clip,
          startMs,
          destTrackId: destTrack.id,
          trackChanged: destTrack.id !== clip.trackId
        })
      }

      // Validate every target against the clips OUTSIDE the group on its destination track.
      for (const t of targets) {
        const newEnd = t.startMs + effectiveClipDurationMs(t.clip)
        const destTrack = this.tracks.find((tr) => tr.id === t.destTrackId)
        if (!destTrack) return false
        for (const otherId of destTrack.clipIds) {
          if (groupIds.has(otherId)) continue
          const other = this.clips[otherId]
          if (!other) continue
          const otherEnd = other.startMs + effectiveClipDurationMs(other)
          if (t.startMs < otherEnd - CLIP_FIT_EPSILON_MS && newEnd > other.startMs + CLIP_FIT_EPSILON_MS) {
            return false
          }
        }
      }

      // Whole group fits — apply. Reparent cross-track moves, set positions, and send one CLIP_MOVE
      // per clip that actually changed (so a still gesture frame is free of bridge chatter).
      let changed = false
      for (const t of targets) {
        const clip = t.clip
        const posChanged = clip.startMs !== t.startMs
        if (!t.trackChanged && !posChanged) continue
        if (t.trackChanged) {
          const oldTrack = this.tracks.find((tr) => tr.id === clip.trackId)
          if (oldTrack) {
            const idx = oldTrack.clipIds.indexOf(clip.id)
            if (idx >= 0) oldTrack.clipIds.splice(idx, 1)
          }
          const destTrack = this.tracks.find((tr) => tr.id === t.destTrackId)
          destTrack?.clipIds.push(clip.id)
          clip.trackId = t.destTrackId
        }
        clip.startMs = t.startMs
        const destTrack = this.tracks.find((tr) => tr.id === t.destTrackId)
        if (destTrack) {
          const clipEnd = t.startMs + effectiveClipDurationMs(clip)
          if (clipEnd > destTrack.lengthMs) destTrack.lengthMs = clipEnd
        }
        sendBridge('CLIP_MOVE', {
          clipId: clip.id,
          positionMs: t.startMs,
          ...(t.trackChanged ? { trackId: t.destTrackId } : {})
        })
        changed = true
      }
      if (changed) this.timelineRevision++
      return true
    },

    /** Largest in-direction time delta (≤ the requested one, same sign) that keeps every group
     *  member in bounds and clear of the clips OUTSIDE the group on its destination track. Used by
     *  the group DRAG so the group slides right up to a boundary — the timeline start or a
     *  neighbouring clip — instead of snapping back when the full delta won't fit, mirroring the
     *  single-clip bump-clamp (`findClipSlot`). Track delta is taken as given; if a member would
     *  land out of the track range, or a member/clip is missing, the requested delta is returned
     *  unchanged so `moveClipGroup` makes the final (reject) call. A valid origin config means no
     *  external clip overlaps a member at delta 0, so each external neighbour is strictly to the
     *  left (limits leftward travel) or right (limits rightward travel) of that member. */
    clampGroupDeltaMs(
      origins: readonly { clipId: string; startMs: number; trackIndex: number }[],
      deltaMs: number,
      deltaTrackIndex: number
    ): number {
      if (origins.length === 0) return deltaMs
      const groupIds = new Set(origins.map((o) => o.clipId))
      const trackCount = this.tracks.length
      let lo = -Infinity // most-negative (leftward) delta the whole group can take
      let hi = Infinity // most-positive (rightward) delta the whole group can take
      for (const o of origins) {
        const clip = this.clips[o.clipId]
        if (!clip) return deltaMs
        const trackIndex = o.trackIndex + deltaTrackIndex
        if (trackIndex < 0 || trackIndex >= trackCount) return deltaMs
        const destTrack = this.tracks[trackIndex]
        if (!destTrack) return deltaMs
        const origStart = o.startMs
        const origEnd = origStart + effectiveClipDurationMs(clip)
        lo = Math.max(lo, -origStart) // can't move the earliest member before the timeline start
        for (const otherId of destTrack.clipIds) {
          if (groupIds.has(otherId)) continue
          const other = this.clips[otherId]
          if (!other) continue
          const otherEnd = other.startMs + effectiveClipDurationMs(other)
          if (otherEnd <= origStart + CLIP_FIT_EPSILON_MS) {
            lo = Math.max(lo, otherEnd - origStart) // external neighbour to the left
          } else if (other.startMs >= origEnd - CLIP_FIT_EPSILON_MS) {
            hi = Math.min(hi, other.startMs - origEnd) // external neighbour to the right
          }
        }
      }
      if (lo > hi) return deltaMs // no feasible uniform delta — let moveClipGroup reject
      return Math.max(lo, Math.min(hi, deltaMs))
    },

    /** Trim source-window fields atomically in one CLIP_TRIM envelope. */
    trimClip(clipId: string, startMs: number, inMs: number, durationMs: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      // Store-level lock guard keeps trim inert too.
      if (clip.locked) return
      const safeStart = Math.max(0, startMs)
      // `inMs` is deliberately NOT clamped: a window that starts before the file is how a
      // clip holds its place on the timeline when its audio slides off the head, and the
      // overhang plays as silence.
      const safeIn = inMs
      const safeDur = Math.max(0, durationMs)
      if (clip.startMs === safeStart && clip.inMs === safeIn && clip.durationMs === safeDur) return
      clip.startMs = safeStart
      clip.inMs = safeIn
      clip.durationMs = safeDur
      // CLIP_TRIM is not echoed, so recompute the derived timing fields here — all three
      // together. `effectiveWarpActive` is duration-dependent (a warp that moves the end
      // by less than a millisecond is not applied, ADR 0024), so a trim can switch it,
      // and leaving the flag stale while updating the duration would make the renderer's
      // ratio disagree with the engine's.
      const trimRatio = effectiveClipTempoRatio(clip)
      const trimWarpActive = warpChangesTiming(safeDur, trimRatio)
      clip.effectiveWarpActive = trimWarpActive
      clip.effectiveDurationMs = trimWarpActive ? safeDur / trimRatio : safeDur
      this.timelineRevision++

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
    wouldClipOverlap(trackId: string, startMs: number, durationMs: number, excludeClipId?: string): boolean {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return false
      const newStart = Math.max(0, startMs)
      const newEnd = newStart + durationMs
      for (const otherId of track.clipIds) {
        if (otherId === excludeClipId) continue
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
      this.timelineRevision++
      const message = error
        ? `Couldn't add clip: ${error}`
        : 'Couldn\'t add clip (the audio engine rejected the file).'
      useNotificationsStore().pushError(message)
    },

    /** Snap a clip onto the project beat grid by MOVING the clip: its first in-window
     *  grid beat travels the smallest distance to a project beat line (see
     *  `resolveClipBeatAlignment`). If that would land before the timeline origin it
     *  bumps forward one beat so the clip stays on the grid at t >= 0.
     *
     *  This is the drop / first-analysis correction, where the clip's placement is what
     *  was provisional. For a clip already sitting in an arrangement — a grid edit in
     *  the Clip Editor — use `alignClipAudioToBarGrid` instead, which holds the clip
     *  still. No-op unless the clip's effective (warp-adjusted) tempo matches the
     *  project tempo; simple samples (no beat grid) and locked clips are never moved.
     *  Callers run this AFTER the project tempo has settled (e.g. after the first-clip
     *  BPM seed), so `transport.bpm` reflects the grid the clip will sit on. */
    alignClipToBarGrid(clipId: string): 'moved' | 'blocked' | 'skip' {
      const aligned = resolveClipBeatAlignment(this, clipId)
      if (!aligned) return 'skip'
      const { clip, beatOffsetMs, shiftMs, projectBeatMs } = aligned
      if (Math.abs(shiftMs) < GRID_ALIGNED_EPSILON_MS) return 'skip' // already aligned
      // Bump one beat forward if aligning would put the clip before the origin.
      let target = clip.startMs + shiftMs
      while (target < -1e-6) target += projectBeatMs
      target = Math.max(0, target)
      if (Math.abs(target - clip.startMs) < GRID_ALIGNED_EPSILON_MS) return 'skip'
      // Only align when the target position is clear. Never bump into a nearby gap
      // (that would misalign the grid) or overlap a neighbour — report it as blocked so
      // the caller can leave the clip put and tell the user to move it by hand.
      if (this.wouldClipOverlap(clip.trackId, target, effectiveClipDurationMs(clip), clipId)) return 'blocked'
      this.moveClip(clipId, target)
      log.debug(
        'project',
        `alignClipToBarGrid ${clipId} ${clip.startMs.toFixed(1)} -> ${target.toFixed(1)}ms (beatOffset=${beatOffsetMs.toFixed(1)})`
      )
      return 'moved'
    },

    /** Set this clip's beat-grid phase, in source ms, relative to the library item's grid.
     *  Clip-local by design: the source grid, and so every other clip cut from the same
     *  file, is left exactly as it was. Applied optimistically. */
    setClipBeatOffset(clipId: string, beatOffsetMs: number): void {
      const clip = this.clips[clipId]
      if (!clip || !Number.isFinite(beatOffsetMs)) return
      const next = beatOffsetMs === 0 ? undefined : beatOffsetMs
      if ((clip.beatOffsetMs ?? 0) === (next ?? 0)) return
      clip.beatOffsetMs = next
      this.timelineRevision++
      sendBridge('CLIP_SET_BEAT_OFFSET', { clipId, beatOffsetMs })
      log.debug('project', `setClipBeatOffset ${clipId} beatOffsetMs=${beatOffsetMs.toFixed(3)}`)
    },

    /** Align a clip to the project beat grid by sliding the AUDIO inside a clip that
     *  does not move — the counterpart to `alignClipToBarGrid`, which moves the clip.
     *
     *  Editing a source's beat grid re-answers "where is beat one in this audio?", so the
     *  clip's placement on the timeline is not what was wrong and moving it is the wrong
     *  correction: a clip in a finished arrangement has neighbours, and shifting it by up
     *  to half a beat leaves it overhanging the bar it was cut to, with no room to sit
     *  back down and no room to duplicate it. Re-cutting the source window instead keeps
     *  `startMs` and the timeline footprint byte-for-byte identical — so the volume shape
     *  stays valid, no neighbour can be in the way, and the arrangement the user built
     *  survives a grid correction — while the audio moves under the new beat lines.
     *
     *  A window that runs off either end of the source is allowed: the engine renders the
     *  overhang as silence, so the audio always lands on the beat rather than the edit
     *  being refused. Whole-beat steps are preferred first, since they buy the same
     *  alignment while keeping real audio. */
    alignClipAudioToBarGrid(clipId: string): 'moved' | 'skip' {
      const aligned = resolveClipBeatAlignment(this, clipId)
      if (!aligned) return 'skip'
      const { clip, shiftMs, ratio, sourceSpacingMs } = aligned
      if (Math.abs(shiftMs) < GRID_ALIGNED_EPSILON_MS) return 'skip' // already aligned

      // Audio at source time `s` renders at `startMs + (s - inMs) / ratio`, so moving the
      // audio LATER by `shiftMs` means cutting in EARLIER by that much in source time.
      const library = useLibraryStore()
      const item = clip.libraryItemId ? library.byId[clip.libraryItemId] : undefined
      const sourceDurationMs =
        item && item.durationMs > 0 ? item.durationMs : clip.inMs + clip.durationMs
      const origInMs = clip.inMs
      let newInMs = origInMs - sourceDeltaMsFromTimeline(shiftMs, ratio)
      // A whole source beat either way lands on the same grid, so stepping by one buys
      // room at the head or tail of the file without losing the alignment. Only step when
      // it actually helps — otherwise the overhang is unavoidable and silence is better
      // than trading one end's overhang for the other's.
      if (newInMs < 0 && newInMs + sourceSpacingMs + clip.durationMs <= sourceDurationMs) {
        newInMs += sourceSpacingMs
      }
      if (newInMs + clip.durationMs > sourceDurationMs && newInMs - sourceSpacingMs >= 0) {
        newInMs -= sourceSpacingMs
      }
      if (Math.abs(newInMs - origInMs) < GRID_ALIGNED_EPSILON_MS) return 'skip'

      this.trimClip(clipId, clip.startMs, newInMs, clip.durationMs)
      log.debug(
        'project',
        `alignClipAudioToBarGrid ${clipId} in ${origInMs.toFixed(1)} -> ${newInMs.toFixed(1)}ms (shift=${shiftMs.toFixed(1)}ms, clip held at ${clip.startMs.toFixed(1)}ms)`
      )
      return 'moved'
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
