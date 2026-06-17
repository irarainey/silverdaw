// Track-header column resize: pointer-capture drag that writes the persisted
// header width into the UI store. Self-contained interaction unit extracted
// from the timeline view controller.

import { useUiStore } from '@/stores/uiStore'

export interface TimelineHeaderResize {
  onHeaderResizePointerDown: (e: PointerEvent) => void
  onHeaderResizePointerMove: (e: PointerEvent) => void
  onHeaderResizePointerUp: (e: PointerEvent) => void
}

export function useTimelineHeaderResize(): TimelineHeaderResize {
  const ui = useUiStore()

  let headerResizePointerId: number | null = null
  let headerResizeStartX = 0
  let headerResizeStartWidth = 0

  function onHeaderResizePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    headerResizePointerId = e.pointerId
    headerResizeStartX = e.clientX
    headerResizeStartWidth = ui.trackHeaderWidth
      ; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onHeaderResizePointerMove(e: PointerEvent): void {
    if (headerResizePointerId !== e.pointerId) return
    const delta = e.clientX - headerResizeStartX
    ui.setTrackHeaderWidth(headerResizeStartWidth + delta)
  }

  function onHeaderResizePointerUp(e: PointerEvent): void {
    if (headerResizePointerId !== e.pointerId) return
    headerResizePointerId = null
      ; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  return { onHeaderResizePointerDown, onHeaderResizePointerMove, onHeaderResizePointerUp }
}
