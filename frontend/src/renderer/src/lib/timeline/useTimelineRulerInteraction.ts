// Ruler / clip double-click pointer interaction, extracted from TimelineView.vue.
// Owns the marker hit-test on the ruler row, the ruler-position snap, and the
// double-click router: a double-click on a clip's title strip starts an inline
// rename; on the clip body opens the Clip Editor; on a ruler marker removes it;
// elsewhere on the ruler toggles a marker at the snapped position.
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { RULER_HEIGHT, SCROLLBAR_WIDTH } from '@/lib/timeline/constants'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import { CLIP_HEADER_H } from '@/lib/timeline/useClipRename'

export interface TimelineRulerInteractionDeps {
  // Host element bounding rect, or null when the canvas isn't mounted.
  getHostRect: () => DOMRect | null
  // PixiJS renderer screen width, or null when the app isn't ready.
  getScreenWidth: () => number | null
  headerWidth: () => number
  pxPerSecond: () => number
  scrollX: () => number
  scrollY: () => number
  // Snap resolution in ms (one sub-beat at the current tempo).
  msPerSubBeat: () => number
  // Live world-space rectangles for every drawn clip (shared array).
  getClipHitRegions: () => ClipHitRegion[]
  startClipRename: (clipId: string) => void
  openClipEditor: (clipId: string) => void
}

export interface TimelineRulerInteraction {
  onDoubleClick: (e: MouseEvent) => void
}

export function useTimelineRulerInteraction(
  deps: TimelineRulerInteractionDeps
): TimelineRulerInteraction {
  const project = useProjectStore()
  const library = useLibraryStore()

  function markerAtPointer(e: MouseEvent): string | null {
    const rect = deps.getHostRect()
    if (!rect) return null
    const screenWidth = deps.getScreenWidth()
    if (screenWidth === null) return null
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const rightEdge = screenWidth - SCROLLBAR_WIDTH
    if (y < 0 || y > RULER_HEIGHT || x < deps.headerWidth() || x > rightEdge) return null
    const worldX = x + deps.scrollX()
    const hitHalfWidth = 7
    for (let i = project.markers.length - 1; i >= 0; i--) {
      const marker = project.markers[i]
      if (!marker) continue
      const markerX = deps.headerWidth() + (marker.positionMs / 1000) * deps.pxPerSecond()
      if (Math.abs(worldX - markerX) <= hitHalfWidth) return marker.id
    }
    return null
  }

  function pointerToSnappedRulerMs(e: MouseEvent): number | null {
    const rect = deps.getHostRect()
    if (!rect) return null
    const screenWidth = deps.getScreenWidth()
    if (screenWidth === null) return null
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const rightEdge = screenWidth - SCROLLBAR_WIDTH
    if (y < 0 || y > RULER_HEIGHT || x < deps.headerWidth() || x > rightEdge) return null
    const rawMs = ((deps.scrollX() + x - deps.headerWidth()) / deps.pxPerSecond()) * 1000
    const snap = deps.msPerSubBeat()
    return Math.max(0, Math.round(rawMs / snap) * snap)
  }

  function onDoubleClick(e: MouseEvent): void {
    if (e.button !== 0) return

    // First: did the user double-click a clip's title header?
    // If so, open the inline rename overlay. This takes priority over the
    // marker / ruler handling below so the rename gesture is reachable
    // anywhere the title strip is visible.
    const rect = deps.getHostRect()
    if (rect) {
      const clipHitRegions = deps.getClipHitRegions()
      const worldX = (e.clientX - rect.left) + deps.scrollX()
      const worldY = (e.clientY - rect.top) + deps.scrollY()
      for (let i = clipHitRegions.length - 1; i >= 0; i--) {
        const r = clipHitRegions[i]
        if (!r) continue
        if (
          worldX >= r.x &&
          worldX <= r.x + r.w &&
          worldY >= r.y &&
          worldY <= r.y + CLIP_HEADER_H
        ) {
          e.preventDefault()
          deps.startClipRename(r.clipId)
          return
        }
      }
      for (let i = clipHitRegions.length - 1; i >= 0; i--) {
        const r = clipHitRegions[i]
        if (!r) continue
        if (
          worldX >= r.x &&
          worldX <= r.x + r.w &&
          worldY >= r.y &&
          worldY <= r.y + r.h
        ) {
          const clip = project.clips[r.clipId]
          const hasLibraryItem = clip ? library.items.some((candidate) => candidate.id === clip.libraryItemId) : false
          if (clip && !clip.unresolved && hasLibraryItem) {
            e.preventDefault()
            deps.openClipEditor(r.clipId)
          }
          return
        }
      }
    }

    const markerId = markerAtPointer(e)
    if (markerId) {
      e.preventDefault()
      project.removeMarker(markerId)
      return
    }

    const snappedMs = pointerToSnappedRulerMs(e)
    if (snappedMs === null) return
    e.preventDefault()
    project.toggleMarkerAt(snappedMs)
  }

  return { onDoubleClick }
}
