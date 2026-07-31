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
// the beat-aware clip drag/nudge snap, the library drop snap, and bar-grid
// alignment. They previously each re-derived it and disagreed on two points —
// whether an inherited source BPM counted, and whether a "simple" one-shot has a
// grid at all — which let a clip snap to a grid that was never drawn.
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
 * source is still in the library.
 *
 * Simple (one-shot) items never have a grid: markers are not drawn for them, so
 * nothing may snap to one either.
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

/** The first grid beat at or after `fromMs`, in source-time milliseconds. */
export function firstSourceBeatMsAtOrAfter(grid: SourceBeatGrid, fromMs: number): number {
  let beatMs =
    grid.anchorMs + Math.ceil((fromMs - grid.anchorMs) / grid.spacingMs) * grid.spacingMs
  // `ceil` on a value that is already an exact multiple can land a hair short.
  while (beatMs < fromMs) beatMs += grid.spacingMs
  return beatMs
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
