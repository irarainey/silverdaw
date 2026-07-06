// Clip double-click pointer interaction, extracted from TimelineView.vue.
// A double-click on a clip's title strip starts an inline rename; on the clip
// body it opens the Clip Editor. The timeline ruler has no double-click action —
// markers are toggled at the playhead with the M key.
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import { CLIP_HEADER_H } from '@/lib/timeline/useClipRename'

export interface TimelineRulerInteractionDeps {
  // Host element bounding rect, or null when the canvas isn't mounted.
  getHostRect: () => DOMRect | null
  scrollX: () => number
  scrollY: () => number
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

  function onDoubleClick(e: MouseEvent): void {
    if (e.button !== 0) return

    // Double-click a clip: the title header strip starts an inline rename, the
    // body opens the Clip Editor. The ruler has no double-click action.
    const rect = deps.getHostRect()
    if (!rect) return
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

  return { onDoubleClick }
}
