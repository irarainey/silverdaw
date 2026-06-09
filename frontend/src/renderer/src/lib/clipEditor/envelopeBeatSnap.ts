// Beat snapping for Clip Editor volume-envelope breakpoints.
//
// Snaps a clip-local (post-warp) envelope time to the source-file beat grid —
// the same uniform `bpm + beatAnchorSec` grid the waveform draws — so a
// breakpoint lands exactly on a beat. Returns the input clamped to
// `[0, durationMs]` when the source has no usable tempo/anchor.

import { sourceMsToVolumeTime, volumeTimeToSourceMs } from '@/lib/clipEditor/volumeOverlay'

export interface BeatSnapContext {
  /** Clip start in source-file ms (the clip-local → source time origin). */
  baseSourceMs: number
  /** Effective tempo ratio (timeline ms → source ms). */
  ratio: number
  /** Source-file tempo; snapping is disabled when missing or non-positive. */
  sourceBpm: number | undefined
  /** Beat-grid anchor in seconds; snapping is disabled when undefined. */
  anchorSec: number | undefined
  /** Clip-local duration used to clamp the result. */
  durationMs: number
}

/** Snap a clip-local (post-warp) time to the nearest source beat. */
export function snapTimelineMsToBeat(timelineMs: number, ctx: BeatSnapContext): number {
  const clamped = Math.max(0, Math.min(ctx.durationMs, timelineMs))
  if (!ctx.sourceBpm || ctx.sourceBpm <= 0 || ctx.anchorSec === undefined) return clamped

  const beatSpacingMs = (60 / ctx.sourceBpm) * 1000
  if (beatSpacingMs <= 0) return clamped

  const sourceMs = volumeTimeToSourceMs(clamped, ctx.baseSourceMs, ctx.ratio)
  const anchorMs = ctx.anchorSec * 1000
  const snappedSourceMs =
    anchorMs + Math.round((sourceMs - anchorMs) / beatSpacingMs) * beatSpacingMs
  const snappedTimelineMs = sourceMsToVolumeTime(snappedSourceMs, ctx.baseSourceMs, ctx.ratio)
  return Math.max(0, Math.min(ctx.durationMs, snappedTimelineMs))
}
