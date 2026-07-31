// Beat snapping for Clip Editor volume-envelope breakpoints.
//
// Snaps a clip-local (post-warp) envelope time to the source-file beat grid —
// the same uniform `bpm + beatAnchorSec` grid the waveform draws — so a
// breakpoint lands exactly on a beat. Returns the input clamped to
// `[0, durationMs]` when the source has no usable tempo/anchor.

import { sourceMsToVolumeTime, volumeTimeToSourceMs } from '@/lib/clipEditor/volumeOverlay'
import type { SourceBeatGrid } from '@/lib/clip/sourceBeatGrid'

export interface BeatSnapContext {
  /** Clip start in source-file ms (the clip-local → source time origin). */
  baseSourceMs: number
  /** Effective tempo ratio (timeline ms → source ms). */
  ratio: number
  /** Resolved source beat grid; snapping is disabled when null. */
  grid: SourceBeatGrid | null
  /** Clip-local duration used to clamp the result. */
  durationMs: number
}

/** Snap a clip-local (post-warp) time to the nearest source beat. */
export function snapTimelineMsToBeat(timelineMs: number, ctx: BeatSnapContext): number {
  const clamped = Math.max(0, Math.min(ctx.durationMs, timelineMs))
  if (!ctx.grid) return clamped

  const { spacingMs, anchorMs } = ctx.grid
  const sourceMs = volumeTimeToSourceMs(clamped, ctx.baseSourceMs, ctx.ratio)
  const snappedSourceMs = anchorMs + Math.round((sourceMs - anchorMs) / spacingMs) * spacingMs
  const snappedTimelineMs = sourceMsToVolumeTime(snappedSourceMs, ctx.baseSourceMs, ctx.ratio)
  return Math.max(0, Math.min(ctx.durationMs, snappedTimelineMs))
}
