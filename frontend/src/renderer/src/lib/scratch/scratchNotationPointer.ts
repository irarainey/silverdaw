// Pointer interaction (drag) logic for the Scratch Notation Editor.
// Manages pointer capture, coordinate conversion, and drag state as a
// focused composable that the editor component can consume.

import { ref, type Ref } from 'vue'
import type { ScratchCrossfaderKeyframe } from '@shared/bridge-protocol'
import type { NotationLane, NotationSelection } from './useScratchNotationEditor'
import {
  clientToSvgCoordinates,
  xToTime,
  yToTurns,
  yToCfValue
} from './scratchNotationCoordinates'

export interface DragState {
  active: boolean
  lane: NotationLane | null
  index: number
}

export interface PointerInteractionContext {
  svgEl: Ref<SVGSVGElement | null>
  viewBoxWidth: Ref<number>
  viewBoxHeight: Ref<number>
  durationUs: Ref<number>
  contentWidth: Ref<number>
  paddingX: number
  platterLaneHeight: Ref<number>
  platterMinTurns: Ref<number>
  platterMaxTurns: Ref<number>
  turnsMargin: number
  cfLaneTop: Ref<number>
  cfLaneHeight: Ref<number>
  crossfader: Ref<readonly ScratchCrossfaderKeyframe[]>
  selection: Ref<NotationSelection | null>
}

export interface PointerCallbacks {
  onBeginEdit(): void
  onEndEdit(): void
  onSelect(lane: NotationLane, index: number): void
  onMovePlatter(index: number, timeUs: number, turns: number): void
  onMoveCrossfader(index: number, timeUs: number, value: number): void
  onAddPlatter(timeUs: number): void
  onAddCrossfader(timeUs: number): void
  onDelete(lane: NotationLane, index: number): void
}

export interface NotationPointerInteraction {
  dragState: Ref<DragState>
  handlePointDown(lane: NotationLane, index: number, event: PointerEvent): void
  handlePointerMove(event: PointerEvent): void
  handlePointerUp(event: PointerEvent): void
  handlePointerCancel(event: PointerEvent): void
  handleLostPointerCapture(event: PointerEvent): void
  finishDrag(): void
  handleDoubleClick(lane: NotationLane, event: MouseEvent): void
  handlePointContextMenu(lane: NotationLane, index: number, event: MouseEvent): void
}

export function createNotationPointerInteraction(
  context: PointerInteractionContext,
  callbacks: PointerCallbacks
): NotationPointerInteraction {
  const dragState = ref<DragState>({ active: false, lane: null, index: -1 })
  let capturedPointerId: number | null = null
  let captureTarget: Element | null = null
  let grabTimeUs = 0
  let grabValue = 0

  function finishDrag(): void {
    if (!dragState.value.active) return
    dragState.value = { active: false, lane: null, index: -1 }
    if (capturedPointerId !== null && captureTarget?.hasPointerCapture(capturedPointerId)) {
      captureTarget.releasePointerCapture(capturedPointerId)
    }
    captureTarget = null
    capturedPointerId = null
    callbacks.onEndEdit()
  }

  function getSvgCoords(event: MouseEvent): { x: number; y: number } | null {
    const svg = context.svgEl.value
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    return clientToSvgCoordinates(
      event.clientX,
      event.clientY,
      rect,
      context.viewBoxWidth.value,
      context.viewBoxHeight.value
    )
  }

  function focusSvg(): void {
    context.svgEl.value?.focus({ preventScroll: true })
  }

  function crossfaderHit(index: number, pointerValue: number, cycle: boolean): number {
    const points = context.crossfader.value
    const hit = points[index]!
    let first = index
    while (first > 0 && points[first - 1]!.timeUs === hit.timeUs) first--
    let nearest = first
    let end = first + 1
    for (; end < points.length && points[end]!.timeUs === hit.timeUs; end++) {
      if (Math.abs(points[end]!.value - pointerValue) < Math.abs(points[nearest]!.value - pointerValue)) nearest = end
    }
    const selected = context.selection.value
    if (selected?.lane !== 'crossfader' || selected.index < first || selected.index >= end
      || points[selected.index]!.value !== points[nearest]!.value) return nearest
    if (!cycle) return selected.index
    for (let i = selected.index + 1; i < end; i++) {
      if (points[i]!.value === points[nearest]!.value) return i
    }
    return nearest
  }

  function handlePointDown(lane: NotationLane, index: number, event: PointerEvent): void {
    event.preventDefault()
    if (event.button !== 0 || dragState.value.active) return
    const coords = getSvgCoords(event)
    if (lane === 'crossfader' && coords) {
      const value = yToCfValue(coords.y, context.cfLaneTop.value, context.cfLaneHeight.value)
      index = crossfaderHit(index, value, true)
      const point = context.crossfader.value[index]!
      grabTimeUs = point.timeUs - xToTime(coords.x, context.durationUs.value, context.contentWidth.value, context.paddingX)
      grabValue = point.value - value
    }
    focusSvg()
    callbacks.onSelect(lane, index)
    callbacks.onBeginEdit()
    dragState.value = { active: true, lane, index }
    try {
      captureTarget = event.currentTarget as Element | null
      captureTarget?.setPointerCapture(event.pointerId)
    } catch {
      // setPointerCapture may throw if the target is removed — safe fallback.
    }
    capturedPointerId = event.pointerId
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragState.value.active || capturedPointerId !== event.pointerId) return
    const coords = getSvgCoords(event)
    if (!coords) return

    const timeUs = xToTime(
      coords.x,
      context.durationUs.value,
      context.contentWidth.value,
      context.paddingX
    )

    if (dragState.value.lane === 'platter') {
      const turns = yToTurns(
        coords.y,
        context.platterMinTurns.value,
        context.platterMaxTurns.value,
        context.platterLaneHeight.value,
        context.turnsMargin
      )
      callbacks.onMovePlatter(dragState.value.index, timeUs, turns)
    } else if (dragState.value.lane === 'crossfader') {
      const value = yToCfValue(coords.y, context.cfLaneTop.value, context.cfLaneHeight.value)
      callbacks.onMoveCrossfader(dragState.value.index, timeUs + grabTimeUs, value + grabValue)
      const selected = context.selection.value
      if (selected?.lane === 'crossfader') dragState.value.index = selected.index
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    if (event.pointerId === capturedPointerId) finishDrag()
  }

  function handleDoubleClick(lane: NotationLane, event: MouseEvent): void {
    const svg = context.svgEl.value
    if (!svg) return
    focusSvg()
    const coords = getSvgCoords(event)!
    const timeUs = xToTime(
      coords.x,
      context.durationUs.value,
      context.contentWidth.value,
      context.paddingX
    )
    if (lane === 'platter') {
      callbacks.onAddPlatter(timeUs)
    } else {
      callbacks.onAddCrossfader(timeUs)
    }
  }

  function handlePointContextMenu(lane: NotationLane, index: number, event: MouseEvent): void {
    event.preventDefault()
    const coords = getSvgCoords(event)
    if (lane === 'crossfader' && coords && event.button === 2) {
      index = crossfaderHit(index, yToCfValue(coords.y, context.cfLaneTop.value, context.cfLaneHeight.value), false)
    }
    finishDrag()
    focusSvg()
    callbacks.onSelect(lane, index)
    callbacks.onDelete(lane, index)
  }

  return {
    dragState,
    handlePointDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel: handlePointerUp,
    handleLostPointerCapture: handlePointerUp,
    finishDrag,
    handleDoubleClick,
    handlePointContextMenu
  }
}
