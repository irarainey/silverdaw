import { type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { RULER_HEIGHT, SCROLLBAR_WIDTH } from './constants'
import type { GridGeometry } from './useGridGeometry'
import { normaliseTimelineSelection } from './timelineSelection'

const DRAG_THRESHOLD_PX = 3

export interface TimelineRangeSelectionOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  geometry: Pick<GridGeometry, 'headerWidth' | 'pxPerSecond' | 'msPerSubBeat'>
  onSeek: (positionMs: number) => void
}

export function useTimelineRangeSelection(opts: TimelineRangeSelectionOptions) {
  const project = useProjectStore()
  const ui = useUiStore()
  let anchorMs: number | null = null
  let pointerStartX = 0
  let pointerStartY = 0
  let dragging = false

  function pointerToTimelineMs(e: PointerEvent, clampToViewport = false): number | null {
    const host = opts.host.value
    const app = opts.app.value
    if (!host || !app) return null
    const rect = host.getBoundingClientRect()
    const inputX = e.clientX - rect.left
    if (inputX < opts.geometry.headerWidth() && !clampToViewport) return null
    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    if (inputX > rightEdge && !clampToViewport) return null
    const localX = Math.max(opts.geometry.headerWidth(), Math.min(rightEdge, inputX))
    const worldX = localX + opts.scrollX.value - opts.geometry.headerWidth()
    const rawMs = (worldX / opts.geometry.pxPerSecond.value) * 1000
    const durationMs = project.durationMs
    if (!Number.isFinite(rawMs) || durationMs <= 0) return null
    const clampedMs = Math.max(0, Math.min(durationMs, rawMs))
    if (e.altKey) return clampedMs
    const snapMs = opts.geometry.msPerSubBeat()
    return Math.max(0, Math.min(durationMs, Math.round(clampedMs / snapMs) * snapMs))
  }

  function clearListeners(): void {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  function onPointerMove(e: PointerEvent): void {
    if (anchorMs === null) return
    if (!dragging) {
      const dx = e.clientX - pointerStartX
      const dy = e.clientY - pointerStartY
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      dragging = true
    }
    const currentMs = pointerToTimelineMs(e, true)
    if (currentMs === null) return
    ui.setTimelineSelection(normaliseTimelineSelection(anchorMs, currentMs))
  }

  function onPointerUp(e: PointerEvent): void {
    if (anchorMs === null) return
    const startMs = anchorMs
    const wasDragging = dragging
    anchorMs = null
    dragging = false
    clearListeners()

    const currentMs = pointerToTimelineMs(e, true)
    const selection = wasDragging && currentMs !== null
      ? normaliseTimelineSelection(startMs, currentMs)
      : null
    ui.setTimelineSelection(selection)
    ui.persistTimelineSelectionView()
    opts.onSeek(selection?.startMs ?? startMs)
  }

  /** Claims an unmodified ruler press; Shift remains reserved for marker dragging. */
  function tryBegin(e: PointerEvent): boolean {
    if (e.button !== 0 || e.shiftKey) return false
    const host = opts.host.value
    if (!host) return false
    const rect = host.getBoundingClientRect()
    const localY = e.clientY - rect.top
    if (localY < 0 || localY >= RULER_HEIGHT) return false
    const startMs = pointerToTimelineMs(e)
    if (startMs === null) return false

    anchorMs = startMs
    pointerStartX = e.clientX
    pointerStartY = e.clientY
    dragging = false
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    e.preventDefault()
    return true
  }

  return { tryBegin }
}
