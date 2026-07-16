// Pointer interaction (drag) logic for the Scratch Notation Editor.
// Manages pointer capture, coordinate conversion, and drag state as a
// focused composable that the editor component can consume.

import { ref, type Ref } from 'vue'
import type { NotationLane } from './useScratchNotationEditor'
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
  handleDoubleClick(lane: NotationLane, event: MouseEvent): void
  handlePointContextMenu(lane: NotationLane, index: number, event: MouseEvent): void
}

export function createNotationPointerInteraction(
  context: PointerInteractionContext,
  callbacks: PointerCallbacks
): NotationPointerInteraction {
  const dragState = ref<DragState>({ active: false, lane: null, index: -1 })
  let capturedPointerId: number | null = null

  function releaseCaptureIfHeld(event: PointerEvent): void {
    if (capturedPointerId !== null) {
      try {
        ;(event.target as Element)?.releasePointerCapture?.(capturedPointerId)
      } catch {
        // Already released or target changed — safe to ignore.
      }
      capturedPointerId = null
    }
  }

  function resetDrag(): void {
    dragState.value = { active: false, lane: null, index: -1 }
    capturedPointerId = null
    callbacks.onEndEdit()
  }

  function getSvgCoords(event: PointerEvent): { x: number; y: number } | null {
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

  function handlePointDown(lane: NotationLane, index: number, event: PointerEvent): void {
    event.preventDefault()
    focusSvg()
    callbacks.onSelect(lane, index)
    callbacks.onBeginEdit()
    dragState.value = { active: true, lane, index }
    try {
      ;(event.target as Element)?.setPointerCapture?.(event.pointerId)
      capturedPointerId = event.pointerId
    } catch {
      // setPointerCapture may throw if the target is removed — safe fallback.
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragState.value.active) return
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
      callbacks.onMoveCrossfader(dragState.value.index, timeUs, value)
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    releaseCaptureIfHeld(event)
    resetDrag()
  }

  function handlePointerCancel(event: PointerEvent): void {
    releaseCaptureIfHeld(event)
    resetDrag()
  }

  function handleLostPointerCapture(_event: PointerEvent): void {
    capturedPointerId = null
    resetDrag()
  }

  function handleDoubleClick(lane: NotationLane, event: MouseEvent): void {
    const svg = context.svgEl.value
    if (!svg) return
    focusSvg()
    const rect = svg.getBoundingClientRect()
    const coords = clientToSvgCoordinates(
      event.clientX,
      event.clientY,
      rect,
      context.viewBoxWidth.value,
      context.viewBoxHeight.value
    )
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
    focusSvg()
    callbacks.onSelect(lane, index)
    callbacks.onDelete(lane, index)
  }

  return {
    dragState,
    handlePointDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleLostPointerCapture,
    handleDoubleClick,
    handlePointContextMenu
  }
}
