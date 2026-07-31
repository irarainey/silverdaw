import { type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { RULER_HEIGHT, SCROLLBAR_WIDTH } from './constants'
import { edgeAutoScrollDelta } from './edgeAutoScroll'
import type { GridGeometry } from './useGridGeometry'
import { normaliseTimelineSelection } from './timelineSelection'

const DRAG_THRESHOLD_PX = 3

/** The subset of a pointer event the drag needs, so the auto-scroll loop can replay
 *  the last pointer without holding on to the event itself. */
interface RangeDragPointer {
  clientX: number
  altKey: boolean
}

export interface TimelineRangeSelectionOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  maxScrollX: ComputedRef<number>
  geometry: Pick<GridGeometry, 'headerWidth' | 'pxPerSecond' | 'snapTimelineMs'>
  onSeek: (positionMs: number) => void
}

export function useTimelineRangeSelection(opts: TimelineRangeSelectionOptions) {
  const project = useProjectStore()
  const ui = useUiStore()
  let anchorMs: number | null = null
  let pointerStartX = 0
  let pointerStartY = 0
  let dragging = false
  let latestPointer: RangeDragPointer | null = null
  let autoScrollFrame: number | null = null

  function pointerToTimelineMs(pointer: RangeDragPointer, clampToViewport = false): number | null {
    const host = opts.host.value
    const app = opts.app.value
    if (!host || !app) return null
    const rect = host.getBoundingClientRect()
    const inputX = pointer.clientX - rect.left
    if (inputX < opts.geometry.headerWidth() && !clampToViewport) return null
    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    if (inputX > rightEdge && !clampToViewport) return null
    const localX = Math.max(opts.geometry.headerWidth(), Math.min(rightEdge, inputX))
    const worldX = localX + opts.scrollX.value - opts.geometry.headerWidth()
    const rawMs = (worldX / opts.geometry.pxPerSecond.value) * 1000
    const durationMs = project.durationMs
    if (!Number.isFinite(rawMs) || durationMs <= 0) return null
    const clampedMs = Math.max(0, Math.min(durationMs, rawMs))
    if (pointer.altKey) return clampedMs
    return Math.min(durationMs, opts.geometry.snapTimelineMs(clampedMs, false))
  }

  /** Edge auto-scroll pressure for a client x, 0 when there is no room to scroll. */
  function autoScrollDelta(clientX: number): number {
    const host = opts.host.value
    const app = opts.app.value
    if (!host || !app || opts.maxScrollX.value <= 0) return 0
    const rect = host.getBoundingClientRect()
    return edgeAutoScrollDelta(
      clientX - rect.left,
      opts.geometry.headerWidth(),
      app.renderer.screen.width - SCROLLBAR_WIDTH
    )
  }

  function startAutoScroll(pointer: RangeDragPointer): void {
    latestPointer = pointer
    if (autoScrollFrame !== null) return
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll)
  }

  function stopAutoScroll(): void {
    latestPointer = null
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame)
      autoScrollFrame = null
    }
  }

  // Holding the pointer at a viewport edge slides the view and keeps extending the
  // selection to the clamped pointer, so a range can outgrow the visible timeline.
  function runAutoScroll(): void {
    autoScrollFrame = null
    if (anchorMs === null || !dragging || latestPointer === null) return
    const delta = autoScrollDelta(latestPointer.clientX)
    if (delta === 0) return
    const next = Math.max(0, Math.min(opts.maxScrollX.value, opts.scrollX.value + delta))
    if (next === opts.scrollX.value) return
    opts.scrollX.value = next
    const currentMs = pointerToTimelineMs(latestPointer, true)
    if (currentMs !== null) ui.setTimelineSelection(normaliseTimelineSelection(anchorMs, currentMs))
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll)
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
    const pointer = { clientX: e.clientX, altKey: e.altKey }
    if (autoScrollDelta(e.clientX) !== 0) startAutoScroll(pointer)
    else stopAutoScroll()
  }

  function onPointerUp(e: PointerEvent): void {
    if (anchorMs === null) return
    const startMs = anchorMs
    const wasDragging = dragging
    anchorMs = null
    dragging = false
    stopAutoScroll()
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
