// Clip Editor canvas pointer, wheel, scrollbar, and keyboard-nudge handlers.
// Pointer math uses CSS pixels; waveform drawing uses device pixels.
import type { Ref } from 'vue'
import {
  hitTestHandle,
  overlayGainToY,
  overlayLaneIndexForY,
  overlayYToGain,
  sourceMsToVolumeTime,
  volumeOverlayLanes,
  volumeTimeToSourceMs
} from '@/lib/clipEditor/volumeOverlay'
import type { LibraryItem } from '@/stores/libraryStore'
import type { usePreviewStore } from '@/stores/previewStore'
import type { ClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'

type PreviewStore = ReturnType<typeof usePreviewStore>

export interface ClipEditorCanvasInteractionDeps {
  getCanvas: () => HTMLCanvasElement | null
  preview: PreviewStore
  volumeShapeDraft: ClipEditorVolumeShapeDraft

  // Writable view/selection state owned by the viewport composable.
  selectionInMs: Ref<number>
  selectionDurationMs: Ref<number>
  scrollMs: Ref<number>
  waveformStereoLanes: Ref<boolean>

  // Reactive reads (called at handler time, never cached).
  viewInMs: () => number
  viewEndMs: () => number
  viewDurationMs: () => number
  visibleInMs: () => number
  visibleDurationMs: () => number
  selectionEndMs: () => number
  maxScrollMs: () => number
  playheadAbsMs: () => number
  hasPlaybackSelection: () => boolean
  volumeEditActive: () => boolean
  volumeShapeDurationMs: () => number
  draftEffectiveRatio: () => number
  sourceItem: () => LibraryItem | null
  zoom: () => number

  setZoomAnchored: (zoom: number, anchorMs: number) => void
}

export interface ClipEditorCanvasInteraction {
  onCanvasMouseDown: (e: MouseEvent) => void
  onCanvasContextMenu: (e: MouseEvent) => void
  onCanvasWheel: (e: WheelEvent) => void
  onScrollbarMouseDown: (e: MouseEvent) => void
  seekPlayheadToSourceMs: (sourceMs: number) => void
  nudgePlayhead: (direction: -1 | 1, snapToBeats: boolean) => void
  extendSelection: (direction: -1 | 1, snapToBeats: boolean) => void
  clearSelection: () => void
}

const SMALLEST_NUDGE_MS = 1

export function useClipEditorCanvasInteraction(
  deps: ClipEditorCanvasInteractionDeps
): ClipEditorCanvasInteraction {
  const { preview, volumeShapeDraft, selectionInMs, selectionDurationMs, scrollMs, waveformStereoLanes } = deps

  function onCanvasMouseDown(e: MouseEvent): void {
    const canvas = deps.getCanvas()
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const vIn = deps.visibleInMs()
    const vDur = deps.visibleDurationMs()
    // Clamp to full clip bounds so edge-drag can extend past the visible window.
    const fullIn = deps.viewInMs()
    const fullEnd = deps.viewEndMs()
    if (vDur <= 0) return

    // Volume edit mode owns the canvas pointer before selection logic.
    if (deps.volumeEditActive()) {
      onCanvasEnvelopePointerDown(e, rect, vIn, vDur)
      return
    }

    const xToMs = (clientX: number): number =>
      Math.max(fullIn, Math.min(fullEnd, vIn + ((clientX - rect.left) / rect.width) * vDur))
    const startSx = ((selectionInMs.value - vIn) / vDur) * rect.width
    const endSx = ((deps.selectionEndMs() - vIn) / vDur) * rect.width
    const localX = e.clientX - rect.left
    const startX = e.clientX
    const HANDLE_PX = 12

    // Wider hit zone covers the edge line and triangle grab markers.
    const hasSubSel = selectionInMs.value > fullIn + 0.5 || deps.selectionEndMs() < fullEnd - 0.5
    let mode: 'start' | 'end' | 'select' | 'click' = 'click'
    if (hasSubSel && Math.abs(localX - startSx) <= HANDLE_PX) mode = 'start'
    else if (hasSubSel && Math.abs(localX - endSx) <= HANDLE_PX) mode = 'end'

    const anchorMs = xToMs(e.clientX)

    const onMove = (ev: MouseEvent): void => {
      const ms = xToMs(ev.clientX)
      if (mode === 'click') {
        // Promote click to drag-select only after real movement.
        if (Math.abs(ev.clientX - startX) > 3) mode = 'select'
        else return
      }
      if (mode === 'start') {
        const next = Math.min(ms, deps.selectionEndMs() - 50)
        const delta = next - selectionInMs.value
        selectionInMs.value = Math.max(fullIn, next)
        selectionDurationMs.value = Math.max(50, selectionDurationMs.value - delta)
      } else if (mode === 'end') {
        const next = Math.min(fullEnd, Math.max(ms, selectionInMs.value + 50))
        selectionDurationMs.value = Math.max(50, next - selectionInMs.value)
      } else if (mode === 'select') {
        const lo = Math.max(fullIn, Math.min(anchorMs, ms))
        const hi = Math.min(fullEnd, Math.max(anchorMs, ms))
        selectionInMs.value = lo
        selectionDurationMs.value = Math.max(50, hi - lo)
      }
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (mode === 'click') {
        const ms = xToMs(ev.clientX)
        // Outside clicks clear a narrowed selection; inside clicks just scrub.
        if (
          deps.hasPlaybackSelection() &&
          (ms < selectionInMs.value || ms > deps.selectionEndMs())
        ) {
          clearSelection()
        }
        seekPlayheadToSourceMs(ms)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Canvas volume editing mirrors SVG gestures, but in CSS-pixel space.
  function onCanvasEnvelopePointerDown(
    e: MouseEvent,
    rect: DOMRect,
    vIn: number,
    vDur: number
  ): void {
    const ratio = deps.draftEffectiveRatio() > 0 ? deps.draftEffectiveRatio() : 1
    const clipStartSourceMs = deps.viewInMs()
    const durMs = deps.volumeShapeDurationMs()
    const rulerCss = 18
    const waveTopCss = rulerCss
    const waveHCss = Math.max(1, rect.height - rulerCss)

    const timeToXCss = (timelineMs: number): number => {
      const sourceMs = volumeTimeToSourceMs(timelineMs, clipStartSourceMs, ratio)
      return ((sourceMs - vIn) / vDur) * rect.width
    }
    const xToTime = (clientX: number): number => {
      const sourceMs = vIn + ((clientX - rect.left) / rect.width) * vDur
      return Math.max(0, Math.min(durMs, sourceMsToVolumeTime(sourceMs, clipStartSourceMs, ratio)))
    }
    // In stereo view, hit-test and drag within the pointer's lane only.
    const lanes = volumeOverlayLanes(waveTopCss, waveHCss, waveformStereoLanes.value)
    const lx = e.clientX - rect.left
    const ly = e.clientY - rect.top
    const activeLane = lanes[overlayLaneIndexForY(ly, lanes)] ?? lanes[lanes.length - 1]!
    const yToGain = (clientY: number): number =>
      overlayYToGain(clientY - rect.top, activeLane.top, activeLane.height)

    const points = volumeShapeDraft.draftPoints.value
    // Active-lane handle index maps directly to the breakpoint.
    const positions = points.map((p) => ({
      x: timeToXCss(p.timeMs),
      y: overlayGainToY(p.gain, activeLane.top, activeLane.height)
    }))
    const hit = hitTestHandle(positions, lx, ly, 12)

    // Alt/right-click removes non-endpoint handles.
    if (hit !== null && (e.altKey || e.button === 2)) {
      volumeShapeDraft.removePoint(hit)
      return
    }
    if (e.button === 2) return

    let dragIndex = hit
    if (dragIndex === null) {
      dragIndex = volumeShapeDraft.addPoint(xToTime(e.clientX), yToGain(e.clientY))
    }
    e.preventDefault()

    const onMove = (ev: MouseEvent): void => {
      if (dragIndex === null) return
      volumeShapeDraft.movePoint(dragIndex, xToTime(ev.clientX), yToGain(ev.clientY))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Let right-click delete breakpoints while shaping volume.
  function onCanvasContextMenu(e: MouseEvent): void {
    if (deps.volumeEditActive()) e.preventDefault()
  }

  function seekPlayheadToSourceMs(sourceMs: number): void {
    const fullIn = deps.viewInMs()
    const fullDur = deps.viewDurationMs()
    if (fullDur <= 0) return
    const rel = Math.max(0, Math.min(fullDur, sourceMs - fullIn))
    preview.seek(rel)
  }

  // Step by one ms or to the adjacent BPM+anchor beat, clamped to the view.
  function stepMsFrom(fromMs: number, direction: -1 | 1, snapToBeats: boolean): number {
    const fullIn = deps.viewInMs()
    const fullEnd = deps.viewEndMs()
    if (!snapToBeats) {
      return Math.max(fullIn, Math.min(fullEnd, fromMs + direction * SMALLEST_NUDGE_MS))
    }
    const src = deps.sourceItem()
    const sourceBpm = src?.bpm
    const anchorSec = src?.beatAnchorSec ?? src?.beats?.[0]
    if (!sourceBpm || sourceBpm <= 0 || anchorSec === undefined) {
      return Math.max(fullIn, Math.min(fullEnd, fromMs + direction * SMALLEST_NUDGE_MS))
    }
    const beatSpacingMs = (60 / sourceBpm) * 1000
    const anchorMs = anchorSec * 1000
    const epsilon = 1
    const beatsFromAnchor = (fromMs - anchorMs) / beatSpacingMs
    const nextIdx =
      direction > 0
        ? Math.floor(beatsFromAnchor + epsilon / beatSpacingMs) + 1
        : Math.ceil(beatsFromAnchor - epsilon / beatSpacingMs) - 1
    const targetAbs = anchorMs + nextIdx * beatSpacingMs
    return Math.max(fullIn, Math.min(fullEnd, targetAbs))
  }

  function nudgePlayhead(direction: -1 | 1, snapToBeats: boolean): void {
    const fullDur = deps.viewDurationMs()
    if (fullDur <= 0) return
    seekPlayheadToSourceMs(stepMsFrom(deps.playheadAbsMs(), direction, snapToBeats))
  }

  // Shift+Arrow extends selection from the playhead; Alt uses 1 ms steps.
  function extendSelection(direction: -1 | 1, snapToBeats: boolean): void {
    const fullDur = deps.viewDurationMs()
    if (fullDur <= 0) return
    const ph = deps.playheadAbsMs()
    const hasSel = deps.hasPlaybackSelection()
    let newEdge: number
    if (!hasSel) {
      if (direction > 0) {
        const end = stepMsFrom(ph, 1, snapToBeats)
        selectionInMs.value = ph
        selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, end - ph)
        newEdge = end
      } else {
        const start = stepMsFrom(ph, -1, snapToBeats)
        selectionInMs.value = start
        selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, ph - start)
        newEdge = start
      }
    } else if (direction > 0) {
      newEdge = stepMsFrom(deps.selectionEndMs(), 1, snapToBeats)
      selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, newEdge - selectionInMs.value)
    } else {
      newEdge = stepMsFrom(selectionInMs.value, -1, snapToBeats)
      const delta = newEdge - selectionInMs.value
      selectionInMs.value = newEdge
      selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, selectionDurationMs.value - delta)
    }
    seekPlayheadToSourceMs(newEdge)
  }

  function onCanvasWheel(e: WheelEvent): void {
    const canvas = deps.getCanvas()
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const vIn = deps.visibleInMs()
    const vDur = deps.visibleDurationMs()
    if (vDur <= 0) return
    // Shift or horizontal wheel pans; vertical wheel zooms at cursor.
    const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
    e.preventDefault()
    if (pan) {
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY
      const msPerPx = vDur / rect.width
      const next = scrollMs.value + dx * msPerPx
      scrollMs.value = Math.max(0, Math.min(deps.maxScrollMs(), next))
    } else {
      const pointerMs = vIn + ((e.clientX - rect.left) / rect.width) * vDur
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      deps.setZoomAnchored(deps.zoom() * factor, pointerMs)
    }
  }

  function onScrollbarMouseDown(e: MouseEvent): void {
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const vDur = deps.viewDurationMs()
    if (vDur <= 0) return
    const visDur = deps.visibleDurationMs()
    const thumbWidth = (visDur / vDur) * rect.width
    // Track clicks jump the thumb, then continue as a drag.
    const initialThumbLeft = (scrollMs.value / vDur) * rect.width
    const clickInThumb =
      e.clientX - rect.left >= initialThumbLeft &&
      e.clientX - rect.left <= initialThumbLeft + thumbWidth
    if (!clickInThumb) {
      const targetLeft = e.clientX - rect.left - thumbWidth / 2
      scrollMs.value = Math.max(0, Math.min(deps.maxScrollMs(), (targetLeft / rect.width) * vDur))
    }
    const grabOffsetMs = (e.clientX - rect.left) / rect.width * vDur - scrollMs.value
    const onMove = (ev: MouseEvent): void => {
      const ms = (ev.clientX - rect.left) / rect.width * vDur - grabOffsetMs
      scrollMs.value = Math.max(0, Math.min(deps.maxScrollMs(), ms))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Restore whole-view selection semantics.
  function clearSelection(): void {
    selectionInMs.value = deps.viewInMs()
    selectionDurationMs.value = deps.viewDurationMs()
  }

  return {
    onCanvasMouseDown,
    onCanvasContextMenu,
    onCanvasWheel,
    onScrollbarMouseDown,
    seekPlayheadToSourceMs,
    nudgePlayhead,
    extendSelection,
    clearSelection
  }
}
