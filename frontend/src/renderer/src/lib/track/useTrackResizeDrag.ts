// Track-height resize gesture for the track-header overlay. Pointermove
// previews locally; pointerup commits one undoable backend change. Extracted
// from TrackHeaderPanel.vue so the component stays focused on layout.

import { useProjectStore } from '@/stores/projectStore'
import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT } from '@/lib/timeline/constants'
import { trackHeightOf } from '@/lib/timeline/trackLayout'

export interface TrackResizeDrag {
  onHandlePointerDown: (track: { id: string }, ev: PointerEvent) => void
}

interface ResizeDragState {
  trackId: string
  startY: number
  startHeightPx: number
  moved: boolean
}

export function useTrackResizeDrag(): TrackResizeDrag {
  const project = useProjectStore()

  let resizeDrag: ResizeDragState | null = null

  function onHandlePointerDown(track: { id: string }, ev: PointerEvent): void {
    if (ev.button !== 0) return
    const current = project.tracks.find((t) => t.id === track.id)
    if (!current) return
    ev.preventDefault()
    ev.stopPropagation()
    resizeDrag = {
      trackId: track.id,
      startY: ev.clientY,
      startHeightPx: trackHeightOf(current),
      moved: false
    }
    ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
    window.addEventListener('pointermove', onHandlePointerMove)
    window.addEventListener('pointerup', onHandlePointerUp)
    window.addEventListener('pointercancel', onHandlePointerUp)
  }

  function onHandlePointerMove(ev: PointerEvent): void {
    if (!resizeDrag) return
    const dy = ev.clientY - resizeDrag.startY
    if (!resizeDrag.moved && Math.abs(dy) < 1) return
    resizeDrag.moved = true
    const next = Math.max(
      MIN_TRACK_HEIGHT,
      Math.min(MAX_TRACK_HEIGHT, Math.round(resizeDrag.startHeightPx + dy))
    )
    project.setTrackHeightLocal(resizeDrag.trackId, next)
  }

  function onHandlePointerUp(): void {
    window.removeEventListener('pointermove', onHandlePointerMove)
    window.removeEventListener('pointerup', onHandlePointerUp)
    window.removeEventListener('pointercancel', onHandlePointerUp)
    const drag = resizeDrag
    resizeDrag = null
    if (!drag || !drag.moved) return
    const t = project.tracks.find((x) => x.id === drag.trackId)
    if (!t) return
    // Commit once per drag.
    project.setTrackHeight(drag.trackId, trackHeightOf(t))
  }

  return { onHandlePointerDown }
}
