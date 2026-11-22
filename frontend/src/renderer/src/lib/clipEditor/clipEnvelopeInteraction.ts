import { snapTimelineMsToBeat } from './envelopeBeatSnap'
import { RULER_H } from './clipEditorWaveformGeometry'
import {
  hitTestHandle, nudgeOverlayGain, overlayGainToY, overlayLaneIndexForY, overlayYToGain,
  sourceMsToVolumeTime, volumeOverlayLanes, volumeTimeToSourceMs
} from './volumeOverlay'
import type { ClipEditorCanvasInteractionDeps } from './useClipEditorCanvasInteraction'

type EnvelopeInteractionDeps = Pick<ClipEditorCanvasInteractionDeps,
  'volumeShapeDraft' | 'viewInMs' | 'draftEffectiveRatio' | 'volumeShapeDurationMs' |
  'volumeEditActive' | 'sourceBeatGrid' | 'waveformStereoLanes'>

export function createClipEnvelopeInteraction(deps: EnvelopeInteractionDeps) {
  const draft = deps.volumeShapeDraft
  let releaseDrag: (() => void) | undefined

  function clearEnvelopeFocus(): void {
    releaseDrag?.()
    draft.selectedIndex.value = null
  }

  function onEnvelopeFocus(): void {
    if (deps.volumeEditActive()) draft.selectedIndex.value ??= 0
  }

  function onEnvelopeKeydown(e: KeyboardEvent): void {
    if (!deps.volumeEditActive() || e.ctrlKey || e.metaKey || e.isComposing) return
    const index = draft.selectedIndex.value
    const points = draft.draftPoints.value
    if (index === null || !points[index]) return
    const { timeMs, gain } = points[index]
    const dt = e.altKey ? 1 : 5
    const stepDb = e.shiftKey ? 0.1 : 1
    switch (e.key) {
      case 'Tab': {
        const next = index + (e.shiftKey ? -1 : 1)
        if (next < 0 || next >= points.length) return // Leave the editor normally.
        draft.selectedIndex.value = next
        break
      }
      case 'ArrowLeft': draft.movePoint(index, timeMs - dt, gain); break
      case 'ArrowRight': draft.movePoint(index, timeMs + dt, gain); break
      case 'ArrowUp': draft.movePoint(index, timeMs, nudgeOverlayGain(gain, stepDb)); break
      case 'ArrowDown': draft.movePoint(index, timeMs, nudgeOverlayGain(gain, -stepDb)); break
      case 'Delete':
      case 'Backspace':
        draft.removePoint(index)
        draft.selectedIndex.value = Math.min(index, draft.draftPoints.value.length - 1)
        break
      default: return
    }
    releaseDrag?.()
    e.preventDefault()
    e.stopPropagation()
  }

  function onEnvelopePointerDown(e: MouseEvent, rect: DOMRect, vIn: number, vDur: number): void {
    if (e.button !== 0 && e.button !== 2) return
    releaseDrag?.()
    const base = deps.viewInMs()
    const ratio = deps.draftEffectiveRatio()
    const durationMs = deps.volumeShapeDurationMs()
    const snapCtx = { baseSourceMs: base, ratio, grid: deps.sourceBeatGrid(), durationMs }
    const timeAt = (x: number, snap: boolean): number => {
      const t = sourceMsToVolumeTime(vIn + x / rect.width * vDur, base, ratio)
      const bounded = Math.max(0, Math.min(durationMs, t))
      return snap ? snapTimelineMsToBeat(bounded, snapCtx) : bounded
    }
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const lanes = volumeOverlayLanes(RULER_H, Math.max(1, rect.height - RULER_H), deps.waveformStereoLanes.value)
    const lane = lanes[overlayLaneIndexForY(y, lanes)]!
    const positions = draft.draftPoints.value.map((p) => ({
      x: (volumeTimeToSourceMs(p.timeMs, base, ratio) - vIn) / vDur * rect.width,
      y: overlayGainToY(p.gain, lane.top, lane.height)
    }))
    const previous = draft.selectedIndex.value
    const hit = hitTestHandle(positions, x, y, 12, previous)
    if (hit === null && e.button === 2) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
    if (hit !== null && (e.altKey || e.button === 2)) {
      draft.removePoint(hit)
      return
    }
    let index = hit ?? draft.addPoint(timeAt(x, e.shiftKey), overlayYToGain(y, lane.top, lane.height))
    draft.selectedIndex.value = index
    const origin = draft.draftPoints.value[index]!
    const grabX = hit !== null ? positions[hit]!.x - x : 0
    const grabY = hit !== null ? positions[hit]!.y - y : 0
    let dragged = false
    const move = (ev: MouseEvent): void => {
      if (!deps.volumeEditActive() || draft.selectedIndex.value !== index) {
        releaseDrag?.()
        return
      }
      if (!dragged && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 2) return
      dragged = true
      // Do not round-trip the untouched axis through the clamped display scale.
      const t = ev.clientX === e.clientX && !ev.shiftKey ? origin.timeMs :
        timeAt(ev.clientX - rect.left + grabX, ev.shiftKey)
      const gain = ev.clientY === e.clientY ? origin.gain :
        overlayYToGain(ev.clientY - rect.top + grabY, lane.top, lane.height)
      index = draft.movePoint(index, t, gain)
    }
    const up = (): void => {
      if (!dragged && hit !== null && draft.selectedIndex.value === index) {
        draft.selectedIndex.value = hitTestHandle(positions, x, y, 12, previous, true)
      }
      releaseDrag?.()
    }
    releaseDrag = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('blur', clearEnvelopeFocus)
      releaseDrag = undefined
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('blur', clearEnvelopeFocus)
  }

  return { onEnvelopePointerDown, onEnvelopeKeydown, clearEnvelopeFocus, onEnvelopeFocus }
}
