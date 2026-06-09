// Read-only spatial queries for timeline pointer, hit-test, and scroll geometry.

import { type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { RULER_HEIGHT, SCROLLBAR_WIDTH } from './constants'
import { trackIndexAtWorldY } from './trackLayout'
import type { GridGeometry } from './useGridGeometry'
import type { ClipHitRegion } from './useDragHandlers'

/** Pixel edge zone for trim-vs-move hit detection. */
const TRIM_EDGE_PX = 8

/**
 * At a butt-join the previous clip's right edge and the next clip's left edge
 * sit on the same pixel. Bias the boundary toward the later clip's left edge so
 * aiming at the visible seam line reliably grabs the start of the right clip;
 * the previous clip's right edge stays reachable a few pixels deeper inside it.
 */
const BOUNDARY_LEFT_BIAS_PX = 3

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
  getClipHitRegions: () => readonly ClipHitRegion[]
}

export function createTimelineQueries(ctx: TimelineQueriesContext) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const { host, app, scrollX, scrollY, maxScrollX, geometry, getClipHitRegions } = ctx

  /** Convert client x to timeline ms; Alt uses 1 ms fine mode instead of grid snap. */
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
      // Alt fine mode: whole milliseconds, no grid snap.
      return Math.max(0, Math.round(rawMs))
    }
    const snap = geometry.msPerSubBeat()
    return Math.max(0, Math.round(rawMs / snap) * snap)
  }

  /** Unsnapped pointer x to timeline ms; null outside track content. */
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
    // Hit regions are stored in world coordinates.
    const worldX = (clientX - rect.left) + scrollX.value
    const worldY = (clientY - rect.top) + scrollY.value
    const regions = getClipHitRegions()
    // Last drawn clip wins overlaps.
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

  /** True when timeline trim is permitted for the clip backing this region. */
  function isRegionTrimmable(region: ClipHitRegion): boolean {
    const clip = project.clips[region.clipId]
    // Linked saved clips resize only through the Clip Editor, not timeline trim.
    if (clip && isClipLinkedToSavedClip(clip)) return false
    // Locked clips suppress trim affordances; the store remains the backstop.
    if (clip?.locked) return false
    return true
  }

  /**
   * Resolve a trim edge for a single clip, returning the edge and its pixel
   * distance. The left edge is detectable a few pixels before the clip start so a
   * butt-joined start stays grabbable right at the seam; the right edge stays
   * inside-only so the seam splits cleanly the rest of the time.
   */
  function resolveRegionEdge(
    worldX: number,
    region: ClipHitRegion
  ): { edge: 'left' | 'right'; dist: number } | null {
    const leftDist = worldX - region.x
    const rightDist = region.x + region.w - worldX
    // Keep tiny clips moveable by capping the edge zone.
    const edge = Math.min(TRIM_EDGE_PX, region.w / 3)
    if (leftDist >= -BOUNDARY_LEFT_BIAS_PX && leftDist <= edge) {
      return { edge: 'left', dist: Math.abs(leftDist) }
    }
    if (rightDist >= 0 && rightDist <= edge) return { edge: 'right', dist: rightDist }
    return null
  }

  /**
   * Resolve a trim edge across every clip under the pointer, independent of draw
   * order. This lets the later clip's left edge be grabbed at a join even when an
   * adjacent or overlapping neighbour is drawn on top.
   */
  function hitTestTrimEdge(
    clientX: number,
    clientY: number
  ): { region: ClipHitRegion; edge: 'left' | 'right' } | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const worldX = (clientX - rect.left) + scrollX.value
    const worldY = (clientY - rect.top) + scrollY.value
    const regions = getClipHitRegions()
    let best: { region: ClipHitRegion; edge: 'left' | 'right'; dist: number } | null = null
    for (const region of regions) {
      if (worldY < region.y || worldY > region.y + region.h) continue
      if (!isRegionTrimmable(region)) continue
      const resolved = resolveRegionEdge(worldX, region)
      if (!resolved) continue
      // A later clip's left edge always wins over a previous clip's right edge at
      // a shared boundary; otherwise the nearest edge wins.
      if (best === null || isBetterTrimCandidate(resolved, best)) {
        best = { region, edge: resolved.edge, dist: resolved.dist }
      }
    }
    return best ? { region: best.region, edge: best.edge } : null
  }

  /** Rank trim candidates: left edges outrank right edges, then nearest wins. */
  function isBetterTrimCandidate(
    candidate: { edge: 'left' | 'right'; dist: number },
    best: { edge: 'left' | 'right'; dist: number }
  ): boolean {
    if (candidate.edge !== best.edge) return candidate.edge === 'left'
    return candidate.dist < best.dist
  }

  /** True when the clip is linked to a saved-clip library item. */
  function isClipLinkedToSavedClip(clip: { libraryItemId?: string }): boolean {
    const libId = clip.libraryItemId
    if (!libId) return false
    const item = library.byId[libId]
    return item?.kind === 'saved-clip'
  }

  /** Source-file duration in ms; unknown files allow no extra right-trim room. */
  function getSourceDurationMs(clip: { filePath: string; inMs: number; durationMs: number }): number {
    const item = library.items.find((i) => i.filePath === clip.filePath)
    if (item && item.durationMs > 0) return item.durationMs
    return clip.inMs + clip.durationMs
  }

  /** Track row under clientY, or null in ruler/gaps/below rows. */
  function pointerToTrackId(clientY: number): string | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const y = clientY - rect.top
    if (y < RULER_HEIGHT) return null
    const worldY = y + scrollY.value
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
    hitTestTrimEdge,
    isClipLinkedToSavedClip,
    getSourceDurationMs,
    pointerToTrackId
  }
}
