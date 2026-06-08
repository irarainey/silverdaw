// Track reorder gesture for the track-header overlay. A grip drag previews a
// drop indicator; pointerup commits one undoable backend reorder. Extracted
// from TrackHeaderPanel.vue so the component stays focused on layout.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { RULER_HEIGHT } from '@/lib/timeline/constants'
import type { buildTrackRowLayout } from '@/lib/timeline/trackLayout'

type TrackRowLayout = ReturnType<typeof buildTrackRowLayout>[number]

export interface TrackReorderDrag {
  rowsHostEl: Ref<HTMLDivElement | null>
  dropIndicatorIndex: Ref<number | null>
  reorderingTrackId: Ref<string | null>
  dropIndicatorTopPx: ComputedRef<number>
  onGripPointerDown: (track: { id: string }, ev: PointerEvent) => void
}

// A movement threshold prevents accidental reorder commits from grip misclicks.
const REORDER_THRESHOLD_PX = 4

interface ReorderDragState {
  trackId: string
  startY: number
  startIndex: number
  moved: boolean
}

export function useTrackReorderDrag(rowLayout: ComputedRef<TrackRowLayout[]>): TrackReorderDrag {
  const project = useProjectStore()

  let reorderDrag: ReorderDragState | null = null
  const dropIndicatorIndex = ref<number | null>(null)
  const reorderingTrackId = ref<string | null>(null)
  const rowsHostEl = ref<HTMLDivElement | null>(null)

  function computeDropIndex(clientY: number, rowsHostRect: DOMRect): number {
    // Convert pointer y into row-layout content space.
    const localY = clientY - rowsHostRect.top + RULER_HEIGHT
    const layout = rowLayout.value
    for (let i = 0; i < layout.length; i++) {
      const row = layout[i]!
      const mid = row.top + row.height / 2
      if (localY < mid) return i
    }
    return layout.length
  }

  function onGripPointerDown(track: { id: string }, ev: PointerEvent): void {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const startIndex = project.tracks.findIndex((t) => t.id === track.id)
    if (startIndex < 0) return
    reorderDrag = {
      trackId: track.id,
      startY: ev.clientY,
      startIndex,
      moved: false
    }
    ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
    window.addEventListener('pointermove', onGripPointerMove)
    window.addEventListener('pointerup', onGripPointerUp)
    window.addEventListener('pointercancel', onGripPointerUp)
  }

  function onGripPointerMove(ev: PointerEvent): void {
    if (!reorderDrag) return
    const dy = ev.clientY - reorderDrag.startY
    if (!reorderDrag.moved && Math.abs(dy) < REORDER_THRESHOLD_PX) return
    reorderDrag.moved = true
    reorderingTrackId.value = reorderDrag.trackId
    const host = rowsHostEl.value
    if (!host) return
    const rect = host.getBoundingClientRect()
    let target = computeDropIndex(ev.clientY, rect)
    // Convert visual slot to post-removal target; hide no-op indicators.
    if (target > reorderDrag.startIndex) target -= 1
    dropIndicatorIndex.value = target === reorderDrag.startIndex ? null : target
  }

  function onGripPointerUp(): void {
    window.removeEventListener('pointermove', onGripPointerMove)
    window.removeEventListener('pointerup', onGripPointerUp)
    window.removeEventListener('pointercancel', onGripPointerUp)
    const drag = reorderDrag
    reorderDrag = null
    reorderingTrackId.value = null
    const indicator = dropIndicatorIndex.value
    dropIndicatorIndex.value = null
    if (!drag || !drag.moved || indicator === null) return
    project.reorderTrack(drag.trackId, indicator)
  }

  // Drop-indicator top in rows-host content space.
  const dropIndicatorTopPx = computed<number>(() => {
    const idx = dropIndicatorIndex.value
    const layout = rowLayout.value
    if (idx === null) return 0
    if (idx >= layout.length) {
      const last = layout[layout.length - 1]
      if (!last) return 0
      return last.top + last.height - RULER_HEIGHT
    }
    const row = layout[idx]
    if (!row) return 0
    return row.top - RULER_HEIGHT - 1
  })

  return { rowsHostEl, dropIndicatorIndex, reorderingTrackId, dropIndicatorTopPx, onGripPointerDown }
}
