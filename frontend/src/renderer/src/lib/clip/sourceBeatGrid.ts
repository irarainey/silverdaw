// Single source of truth for a clip's *source* beat grid.
//
// The grid is synthetic and source-global: a constant `bpm` spacing phase-locked to
// `beatAnchorSec`, rather than the detected `beats` timestamps themselves. That is
// deliberate — two clips split from the same take stay phase-aligned, and a
// low-confidence detection still gives the user a rigid grid to correct against.
// `beats` is only consulted for presence (an item with no detected beats has no
// grid) and as the legacy anchor fallback for projects saved before
// `beatAnchorSec` existed.
//
// Every consumer must resolve the grid through here: the timeline beat markers,
// the beat-aware clip drag/nudge snap, the library drop snap, bar-grid alignment,
// Chop to Grid, and the Clip Editor / Scratch grids. They previously each
// re-derived it and disagreed on two points — whether an inherited source BPM
// counted, and whether a "simple" one-shot has a grid at all — which let a clip
// snap to a grid that was never drawn, and let Chop to Grid do nothing on a stem
// that visibly had one. Both are now settled here: inheritance is unconditional,
// and a one-shot never has a grid.
import { libraryItemIsSimple, libraryItemSourceBpm } from '@/stores/libraryItemHelpers'
import type { LibraryItem } from '@/stores/libraryTypes'
import { effectiveClipTempoRatio, isClipTempoWarpActive } from './clipTiming'

/** A resolved source beat grid, in source-time milliseconds. */
export interface SourceBeatGrid {
  /** Source BPM the grid is spaced on (own or inherited from the source item). */
  bpm: number
  /** Source-time spacing between beats. */
  spacingMs: number
  /** Source-time position of the universal grid anchor. */
  anchorMs: number
}

/** Library lookup shape the grid resolution needs (the Pinia store satisfies it). */
export interface SourceBeatGridLibrary {
  byId: Readonly<Record<string, LibraryItem>>
  items: readonly LibraryItem[]
}

/**
 * Resolve the source beat grid for a library item, or null when it has none.
 *
 * Derived items (stems, saved clips) inherit BPM, beats, and anchor from the item
 * they came from, matching how a stem inherits the rest of its identity while its
 * source is still in the library. This is unconditional: an item that visibly has
 * a grid drawn on it must be usable by every operation that reads a grid.
 *
 * Simple (one-shot) items never have a grid — they have no musical pulse, so beat
 * markers over them are noise, and nothing may snap or slice to lines that were
 * never drawn.
 */
export function resolveSourceBeatGrid(
  item: LibraryItem,
  byId: Readonly<Record<string, LibraryItem>>
): SourceBeatGrid | null {
  if (libraryItemIsSimple(item, byId)) return null

  const bpm = libraryItemSourceBpm(item, byId)
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null

  const sourceId = item.derivedFrom?.sourceItemId
  const source = sourceId ? byId[sourceId] : undefined
  const beats = item.beats ?? source?.beats
  if (!beats || beats.length === 0) return null

  // Prefer the regression-derived anchor; older projects fall back to the first beat.
  const anchorSec =
    item.beatAnchorSec ?? item.beats?.[0] ?? source?.beatAnchorSec ?? source?.beats?.[0]
  if (typeof anchorSec !== 'number' || !Number.isFinite(anchorSec)) return null

  const spacingMs = (60 / bpm) * 1000
  if (!Number.isFinite(spacingMs) || spacingMs <= 0) return null

  return { bpm, spacingMs, anchorMs: anchorSec * 1000 }
}

/**
 * Timeline-time spacing between a clip's beat markers.
 *
 * A clip warped to follow the project tempo *is* at the project tempo, so its markers
 * must land on the project's own beat lines whatever the source BPM was — that is the
 * whole point of warping it. Deriving the spacing as `sourceSpacing / effectiveRatio`
 * gets the same answer only while the ratio and the grid are built from the identical
 * source BPM; when a reanalysis moved the source tempo, the grid picked up the new BPM
 * immediately while the clip still carried the ratio derived from the old one, and the
 * markers came out spaced a few percent off the project grid — line one up and the rest
 * walk away. Asking the project for its own spacing removes the chance to disagree.
 *
 * A pinned ratio is different: the user has explicitly stretched the clip to something
 * other than the project tempo, so its beats genuinely do not sit on the project grid
 * and the markers must say so.
 */
export function clipTimelineBeatSpacingMs(
  clip: { tempoRatio?: number; effectiveTempoRatio?: number; effectiveWarpActive?: boolean },
  sourceSpacingMs: number,
  projectBpm: number
): number {
  if (!isClipTempoWarpActive(clip)) return sourceSpacingMs
  const pinned = typeof clip.tempoRatio === 'number' && clip.tempoRatio > 0
  if (!pinned && Number.isFinite(projectBpm) && projectBpm > 0) return 60000 / projectBpm
  return sourceSpacingMs / effectiveClipTempoRatio(clip)
}

/** A beat this close (in beat indices) to `fromMs` counts as landing exactly on it.
 *  Well below one float ULP of a beat index at any realistic clip length, and far too
 *  small to reclassify a beat the user genuinely trimmed away. */
const BEAT_INDEX_EPSILON = 1e-6

/** The first grid beat at or after `fromMs`, in source-time milliseconds.
 *
 *  A clip edge produced by split or trim arithmetic lands a fraction of a nanosecond
 *  either side of the beat it was cut on. A bare `ceil` turns "a hair above the beat"
 *  into the NEXT beat, so the clip's first-beat offset jumps from ~0 to a full beat:
 *  the leading marker vanishes and, on a bar snap grid (where a one-beat translation is
 *  not invariant), the clip snaps a beat early or three beats late. Selecting the
 *  nearest beat index when it is within epsilon keeps that boundary continuous. */
export function firstSourceBeatMsAtOrAfter(grid: SourceBeatGrid, fromMs: number): number {
  const relative = (fromMs - grid.anchorMs) / grid.spacingMs
  const nearest = Math.round(relative)
  const index = Math.abs(relative - nearest) <= BEAT_INDEX_EPSILON ? nearest : Math.ceil(relative)
  return grid.anchorMs + index * grid.spacingMs
}

/** Minimal clip shape needed to project a clip's first in-window source beat. */
export interface ClipBeatGridClip {
  libraryItemId?: string
  filePath: string
  inMs: number
  durationMs: number
  effectiveTempoRatio?: number
  effectiveWarpActive?: boolean
}

/**
 * Timeline-time offset from a clip's left edge to the first source-grid beat inside
 * its trim window, or null when the source has no usable grid (or no beat falls
 * within the window). Shared by clip drag, keyboard nudge, and bar-grid alignment,
 * and matched by the timeline's beat markers.
 */
export function clipFirstBeatOffsetMs(
  clip: ClipBeatGridClip,
  library: SourceBeatGridLibrary
): number | null {
  // Prefer libraryItemId; library-clip siblings can share file paths.
  const itemById = clip.libraryItemId ? library.byId[clip.libraryItemId] : undefined
  const item = itemById ?? library.items.find((i) => i.filePath === clip.filePath)
  if (!item) return null
  const grid = resolveSourceBeatGrid(item, library.byId)
  if (!grid) return null

  const inMs = clip.inMs
  const firstBeatMs = firstSourceBeatMsAtOrAfter(grid, inMs)
  if (firstBeatMs > inMs + clip.durationMs) return null

  // Convert the source-time offset to timeline time for warped clips.
  const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
  return (firstBeatMs - inMs) / ratio
}
