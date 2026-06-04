// Canvas pointer + wheel/scrollbar interaction and playhead/selection nudging
// for the Clip Editor, extracted from ClipEditorDialog.vue. These handlers are
// invoked from template events (and the keyboard composable) and operate in the
// canvas's CSS-pixel space. Transient `mousemove`/`mouseup` listeners are
// registered for the duration of a drag and torn down on mouseup — the exact
// behaviour the dialog had inline.
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
    // Drag/click still clamps to the full clip bounds, not the visible window —
    // a user can drag past the canvas edge to keep extending the selection.
    const fullIn = deps.viewInMs()
    const fullEnd = deps.viewEndMs()
    if (vDur <= 0) return

    // Volume edit mode hijacks the canvas pointer to edit the gain envelope
    // instead of the selection. Handled first so none of the selection logic
    // below runs while shaping volume.
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

    // Handle grabs only count when there's actually a visible sub-selection.
    // The hit zone is intentionally wider than the 1-px edge line so the
    // triangle grab markers drawn at the top/bottom of each edge fall
    // inside the grabbable area.
    const hasSubSel = selectionInMs.value > fullIn + 0.5 || deps.selectionEndMs() < fullEnd - 0.5
    let mode: 'start' | 'end' | 'select' | 'click' = 'click'
    if (hasSubSel && Math.abs(localX - startSx) <= HANDLE_PX) mode = 'start'
    else if (hasSubSel && Math.abs(localX - endSx) <= HANDLE_PX) mode = 'end'

    const anchorMs = xToMs(e.clientX)

    const onMove = (ev: MouseEvent): void => {
      const ms = xToMs(ev.clientX)
      if (mode === 'click') {
        // Promote to a drag-select only once the user actually moves the mouse.
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
        // Click outside the current narrowing selection clears it AND
        // moves the playhead. Click inside the selection just moves the
        // playhead (so the user can scrub within their selection).
        if (
          deps.hasPlaybackSelection() &&
          (ms < selectionInMs.value || ms > deps.selectionEndMs())
        ) {
          clearSelection()
        }
        seekPlayheadToSourceMs(ms)
      }
      // Selection changes don't reload the preview — preview window is the
      // whole clip view, so the playhead stays valid as the selection moves.
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Envelope editing on the waveform canvas. Mirrors the SVG editor's gestures
  // (drag a handle to move it, click the curve to add a breakpoint then drag,
  // Alt-click / right-click a handle to remove it) but in the canvas's own
  // pixel space. All coordinates here are CSS pixels (getBoundingClientRect),
  // whereas `drawWaveform` works in device pixels — both map gain/time the
  // same way via the shared `volumeOverlay` helpers, just with a different
  // height/ruler scale.
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
    // In stereo view the one shared envelope is mirrored into two channel
    // lanes. Interaction is lane-local: the lane under the pointer is chosen
    // first, then both hit-testing and the gain mapping happen only within
    // that lane. This keeps exactly one handle per breakpoint in play (so a
    // click can never grab the duplicated handle from the other lane) and
    // pins the whole drag to one lane's gain scale. In summary view there is
    // a single full-height lane, so this is identical to the original mapping.
    const lanes = volumeOverlayLanes(waveTopCss, waveHCss, waveformStereoLanes.value)
    const lx = e.clientX - rect.left
    const ly = e.clientY - rect.top
    const activeLane = lanes[overlayLaneIndexForY(ly, lanes)] ?? lanes[lanes.length - 1]!
    const yToGain = (clientY: number): number =>
      overlayYToGain(clientY - rect.top, activeLane.top, activeLane.height)

    const points = volumeShapeDraft.draftPoints.value
    // Hit-test handles only in the active lane; the index maps straight to the
    // breakpoint (each point is drawn once per lane).
    const positions = points.map((p) => ({
      x: timeToXCss(p.timeMs),
      y: overlayGainToY(p.gain, activeLane.top, activeLane.height)
    }))
    const hit = hitTestHandle(positions, lx, ly, 12)

    // Alt-click or right-click on a handle removes it (endpoints are pinned
    // and protected inside `removePoint`).
    if (hit !== null && (e.altKey || e.button === 2)) {
      volumeShapeDraft.removePoint(hit)
      return
    }
    // Right-click on empty space does nothing (the context menu is suppressed).
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

  // Suppress the browser context menu over the canvas while shaping volume so
  // right-click can delete a breakpoint instead.
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

  // Step forward or backward from a given source-ms position. When
  // `snapToBeats` is true, jumps to the next/prev beat on the extrapolated
  // grid (BPM + anchor). Otherwise nudges by 1 ms. Result is clamped to
  // the clip view bounds.
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

  // Shift+Arrow extends the selection from the playhead position. With
  // Alt held, extension is in 1-ms increments; otherwise it snaps to
  // beats. Works for both audio-file (start a new selection) and
  // saved-clip (narrow the existing window).
  function extendSelection(direction: -1 | 1, snapToBeats: boolean): void {
    const fullDur = deps.viewDurationMs()
    if (fullDur <= 0) return
    const ph = deps.playheadAbsMs()
    const hasSel = deps.hasPlaybackSelection()
    let newEdge: number
    if (!hasSel) {
      // Anchor the new selection at the playhead.
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
    // Move the playhead to the new edge so the user sees the change.
    seekPlayheadToSourceMs(newEdge)
  }

  function onCanvasWheel(e: WheelEvent): void {
    const canvas = deps.getCanvas()
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const vIn = deps.visibleInMs()
    const vDur = deps.visibleDurationMs()
    if (vDur <= 0) return
    // Shift+wheel or any horizontal wheel delta → pan; otherwise → zoom anchored at cursor.
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
    // If user clicks on the thumb start it as a drag, else jump-to-here then drag.
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

  // Clear the user-narrowing selection so playback (and Save-as-new /
  // Apply-trim gating) revert to whole-view semantics.
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
