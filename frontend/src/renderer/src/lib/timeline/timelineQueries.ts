// Read-only spatial queries for the timeline canvas.
//
// Pure "where is the pointer / what's under it" helpers used by the drag
// state machine in `useDragHandlers`: pixel <-> timeline-ms conversion (snapped
// and raw), clip / marker / clip-edge hit-testing, library-derived lookups, and
// the track-row + auto-scroll-pressure geometry. None of these mutate gesture
// state — they only read the host element, Pixi app, scroll offsets and project
// geometry at call time — so they live apart from the stateful pointer handlers.
//
// `createTimelineQueries` is a composable-style factory: call it during timeline
// setup (active Pinia required) and destructure the returned helpers. They close
// over the passed `Ref`s/getter so live values are always read.

import { type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { RULER_HEIGHT, SCROLLBAR_WIDTH } from './constants'
import { trackIndexAtWorldY } from './trackLayout'
import type { GridGeometry } from './useGridGeometry'
import type { ClipHitRegion } from './useDragHandlers'

/** Edge-zone width in PIXELS for trim-vs-move hit detection. A click
 *  within this many pixels of a clip's left/right edge enters trim
 *  mode; anything further in is a move drag. Chosen so a careful user
 *  can still grab the body of a narrow clip without accidentally
 *  trimming. */
const TRIM_EDGE_PX = 8

/** Horizontal edge zone used to auto-scroll while dragging a clip. */
const CLIP_AUTOSCROLL_EDGE_PX = 72
/** Maximum horizontal auto-scroll speed, in pixels per animation frame. */
const CLIP_AUTOSCROLL_MAX_PX_PER_FRAME = 42

export interface TimelineQueriesContext {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  scrollY: Ref<number>
  maxScrollX: ComputedRef<number>
  geometry: GridGeometry
  /** Returns the latest clip-hit-regions array (populated by drawClip). */
  getClipHitRegions: () => readonly ClipHitRegion[]
}

export function createTimelineQueries(ctx: TimelineQueriesContext) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const { host, app, scrollX, scrollY, maxScrollX, geometry, getClipHitRegions } = ctx

  /**
   * Convert a pointer client-x to a timeline-ms position, either snapped
   * to the sub-beat grid (Alt key NOT held — default behaviour for
   * click-to-seek and playhead drag) or rounded to the nearest whole
   * millisecond when the user is holding Alt. The latter is the
   * finest meaningful resolution for seeking and future clip-split
   * operations — at the maximum zoom of 480 px/sec, 1 ms ≈ 0.5 px,
   * which is sub-pixel and below human-perception threshold either
   * way. Returns null when the pointer is outside the track-content
   * area.
   */
  function pointerToMs(clientX: number, fineMode: boolean): number | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < geometry.headerWidth() || x > rightEdge) return null
    const trackLocalX = x - geometry.headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / geometry.pxPerSecond.value) * 1000
    if (fineMode) {
      // Whole-millisecond resolution. Caller (Alt-modifier seek) wants
      // sample-accurate placement, not grid-snap.
      return Math.max(0, Math.round(rawMs))
    }
    const snap = geometry.msPerSubBeat()
    return Math.max(0, Math.round(rawMs / snap) * snap)
  }

  /**
   * Unsnapped pointer-X → timeline ms. Used by clip drag where we want raw
   * ms (so we can subtract the grab offset before snapping the clip's
   * leading edge). Returns null outside the track-content area.
   */
  function pointerToRawMs(clientX: number): number | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < geometry.headerWidth() || x > rightEdge) return null
    return ((scrollX.value + x - geometry.headerWidth()) / geometry.pxPerSecond.value) * 1000
  }

  function pointerToRawMsClamped(clientX: number): number | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const leftEdge = geometry.headerWidth()
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    const clampedX = Math.max(leftEdge, Math.min(rightEdge, x))
    return ((scrollX.value + clampedX - geometry.headerWidth()) / geometry.pxPerSecond.value) * 1000
  }

  function snapTimelineMs(ms: number, fineMode: boolean): number {
    if (fineMode) return Math.max(0, Math.round(ms))
    const snap = geometry.msPerSubBeat()
    return Math.max(0, Math.round(ms / snap) * snap)
  }

  function clipAutoScrollDelta(clientX: number): number {
    const a = app.value
    if (!host.value || !a || maxScrollX.value <= 0) return 0
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const leftEdge = geometry.headerWidth()
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < leftEdge + CLIP_AUTOSCROLL_EDGE_PX) {
      const pressure = Math.min(1, (leftEdge + CLIP_AUTOSCROLL_EDGE_PX - x) / CLIP_AUTOSCROLL_EDGE_PX)
      return -Math.ceil(CLIP_AUTOSCROLL_MAX_PX_PER_FRAME * pressure)
    }
    if (x > rightEdge - CLIP_AUTOSCROLL_EDGE_PX) {
      const pressure = Math.min(1, (x - (rightEdge - CLIP_AUTOSCROLL_EDGE_PX)) / CLIP_AUTOSCROLL_EDGE_PX)
      return Math.ceil(CLIP_AUTOSCROLL_MAX_PX_PER_FRAME * pressure)
    }
    return 0
  }

  function hitTestClip(clientX: number, clientY: number): ClipHitRegion | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    // Convert pointer to WORLD coordinates by adding the current scroll.
    // The hit regions are stored in world coords by `drawClip`.
    const worldX = (clientX - rect.left) + scrollX.value
    const worldY = (clientY - rect.top) + scrollY.value
    const regions = getClipHitRegions()
    // Iterate in reverse so the top-most drawn clip wins if any overlap.
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]
      if (!r) continue
      if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) return r
    }
    return null
  }

  function hitTestMarker(clientX: number, clientY: number): string | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (y < 0 || y > RULER_HEIGHT || x < geometry.headerWidth() || x > rightEdge) return null

    const worldX = x + scrollX.value
    const hitHalfWidth = 7
    for (let i = project.markers.length - 1; i >= 0; i--) {
      const marker = project.markers[i]
      if (!marker) continue
      const markerX = geometry.headerWidth() + (marker.positionMs / 1000) * geometry.pxPerSecond.value
      if (Math.abs(worldX - markerX) <= hitHalfWidth) return marker.id
    }
    return null
  }

  /**
   * Returns 'left' or 'right' if the pointer is within `TRIM_EDGE_PX`
   * of the clip's corresponding edge in screen-space; null otherwise.
   * Edge zones are computed in pixels (not ms) so they stay
   * comfortable to hit regardless of clip duration / zoom level.
   * Very narrow clips degrade gracefully: if the body would be less
   * than 2 px wide, the right edge wins (you can still trim a tiny
   * clip, but moving it requires zooming in first).
   */
  function hitTestClipEdge(clientX: number, region: ClipHitRegion): 'left' | 'right' | null {
    if (!host.value) return null
    // Clips linked to a saved-clip library entry are locked against
    // edge-resize on the timeline: resizing one would have to resize
    // every linked sibling, which is the clip-editor's job (or the
    // user can right-click → "Unlink from library" to free this
    // instance). Suppressing the edge hit-region here transparently
    // makes both the hover cursor and the pointer-down handler treat
    // the whole clip as a move target.
    const clip = project.clips[region.clipId]
    if (clip && isClipLinkedToSavedClip(clip)) return null
    // Locked clips suppress the edge hit-region so the hover cursor
    // stays `default` and pending-drag promotion can never enter trim
    // mode. The store-level guard in `trimClip` is the correctness
    // backstop; this is the UX layer.
    if (clip?.locked) return null
    const rect = host.value.getBoundingClientRect()
    const worldX = (clientX - rect.left) + scrollX.value
    const leftDist = worldX - region.x
    const rightDist = region.x + region.w - worldX
    // Cap the edge zone at a third of the clip width so a tiny clip
    // doesn't become "all edge" (impossible to move). For very wide
    // clips the cap never kicks in.
    const edge = Math.min(TRIM_EDGE_PX, region.w / 3)
    if (leftDist <= edge) return 'left'
    if (rightDist <= edge) return 'right'
    return null
  }

  /** True if the clip's libraryItemId points at a saved-clip library
   *  item (i.e. this is a linked instance). Independent clips whose
   *  libraryItemId points at an audio-file, or whose libraryItemId is
   *  missing from the library, return false. */
  function isClipLinkedToSavedClip(clip: { libraryItemId?: string }): boolean {
    const libId = clip.libraryItemId
    if (!libId) return false
    const item = library.byId[libId]
    return item?.kind === 'saved-clip'
  }

  /** Source-file duration for a clip's underlying audio in ms. Used to
   *  clamp the right-edge trim so we can't ask the engine to play
   *  beyond the file's end. Falls back to the clip's current `inMs +
   *  durationMs` (i.e. assume "we're already at the end") if the
   *  library doesn't know about it yet — defensive: that gives the
   *  user no extra right-stretch room until library metadata loads. */
  function getSourceDurationMs(clip: { filePath: string; inMs: number; durationMs: number }): number {
    const item = library.items.find((i) => i.filePath === clip.filePath)
    if (item && item.durationMs > 0) return item.durationMs
    // Peaks fallback: same PEAKS_PER_SECOND constant as the renderer.
    return clip.inMs + clip.durationMs
  }

  /** Which track row the pointer's clientY currently lies inside, or
   *  null if the pointer is in the ruler band, in the inter-track gap
   *  between rows, or below the last row. Used by clip drag to allow
   *  cross-track moves: as the cursor moves into a different row,
   *  moveClip is called with the new trackId so the clip re-parents. */
  function pointerToTrackId(clientY: number): string | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const y = clientY - rect.top
    if (y < RULER_HEIGHT) return null
    const worldY = y + scrollY.value
    // `trackIndexAtWorldY` already returns null for the inter-row gap.
    const hit = trackIndexAtWorldY(project.tracks, worldY)
    if (!hit) return null
    return project.tracks[hit.index]?.id ?? null
  }

  return {
    pointerToMs,
    pointerToRawMs,
    pointerToRawMsClamped,
    snapTimelineMs,
    clipAutoScrollDelta,
    hitTestClip,
    hitTestMarker,
    hitTestClipEdge,
    isClipLinkedToSavedClip,
    getSourceDurationMs,
    pointerToTrackId
  }
}
