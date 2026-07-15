// Zoom/scroll/pan state and the playhead-follow RAF loop for the Scratch
// Editor waveform bar. Owns canvas DPR sizing (via a ResizeObserver) and
// exposes the view window (visibleStartMs/visibleDurationMs) the renderer
// draws from — it does no drawing itself.

import { computed, onMounted, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'

const MIN_ZOOM = 1
const MAX_ZOOM = 64
const ZOOM_STEP = 0.1

export interface ScratchWaveformViewOptions {
  canvasEl: Ref<HTMLCanvasElement | null>
  preparedDurationMs: Ref<number>
  positionMs: Ref<number>
  isPlaying: Ref<boolean>
  playbackRate: Ref<number>
  /** Renderer's px/second zoom preference (shared with the main timeline). */
  zoomPxPerSecond: Ref<number>
  /** Invoked once the canvas has been resized, to force an immediate redraw. */
  onResize(): void
}

export interface ScratchWaveformView {
  zoom: Ref<number>
  scrollMs: Ref<number>
  canvasCssWidth: Ref<number>
  visibleDurationMs: ComputedRef<number>
  maxScrollMs: ComputedRef<number>
  visibleStartMs: ComputedRef<number>
  MIN_ZOOM: number
  MAX_ZOOM: number
  zoomOut(): void
  resetZoom(): void
  zoomIn(): void
  onWheel(event: WheelEvent): void
  onScrollbarMouseDown(event: MouseEvent): void
}

export function useScratchWaveformView(options: ScratchWaveformViewOptions): ScratchWaveformView {
  const { canvasEl, preparedDurationMs, positionMs, isPlaying, playbackRate, zoomPxPerSecond, onResize } = options

  const zoom = ref(1)
  const scrollMs = ref(0)
  const canvasCssWidth = ref(0)

  const basePxPerMs = computed(() => {
    const durationMs = preparedDurationMs.value
    const fitPxPerMs = canvasCssWidth.value > 0 && durationMs > 0 ? canvasCssWidth.value / durationMs : 0
    return Math.max(fitPxPerMs, Math.max(0.001, zoomPxPerSecond.value / 1000))
  })
  const visibleDurationMs = computed(() => {
    const durationMs = preparedDurationMs.value
    if (durationMs <= 0 || canvasCssWidth.value <= 0) return durationMs
    return Math.min(durationMs, canvasCssWidth.value / (basePxPerMs.value * zoom.value))
  })
  const maxScrollMs = computed(() => Math.max(0, preparedDurationMs.value - visibleDurationMs.value))
  const visibleStartMs = computed(() => Math.max(0, Math.min(maxScrollMs.value, scrollMs.value)))

  function setZoomAnchored(nextZoom: number, anchorMs: number): void {
    const previousDurationMs = visibleDurationMs.value
    const anchorFraction = previousDurationMs > 0 ? (anchorMs - visibleStartMs.value) / previousDurationMs : 0.5
    const steppedZoom = Math.round(nextZoom / ZOOM_STEP) * ZOOM_STEP
    zoom.value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, steppedZoom))
    const nextDurationMs = visibleDurationMs.value
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, anchorMs - anchorFraction * nextDurationMs))
  }

  function setZoomAroundCenter(nextZoom: number): void {
    setZoomAnchored(nextZoom, visibleStartMs.value + visibleDurationMs.value / 2)
  }

  function zoomOut(): void {
    setZoomAroundCenter(zoom.value - ZOOM_STEP)
  }

  function resetZoom(): void {
    setZoomAroundCenter(MIN_ZOOM)
  }

  function zoomIn(): void {
    setZoomAroundCenter(zoom.value + ZOOM_STEP)
  }

  function onWheel(event: WheelEvent): void {
    const canvas = canvasEl.value
    const vDur = visibleDurationMs.value
    if (!canvas || vDur <= 0) return
    const rect = canvas.getBoundingClientRect()
    event.preventDefault()

    // Match the clip editor / preview panel: Ctrl-wheel zooms (anchored under the
    // pointer); a horizontal or Shift-wheel gesture pans. A plain vertical wheel
    // does nothing, as there is no vertical axis to scroll here.
    if (event.ctrlKey) {
      const anchorMs = visibleStartMs.value + ((event.clientX - rect.left) / rect.width) * vDur
      setZoomAnchored(zoom.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), anchorMs)
      return
    }

    const absX = Math.abs(event.deltaX)
    const absY = Math.abs(event.deltaY)
    const wantsPan = absX > absY || (event.shiftKey && absY > 0)
    if (wantsPan) {
      const dx = absX > 0 ? event.deltaX : event.deltaY
      if (dx === 0) return
      const msPerPx = vDur / rect.width
      const next = scrollMs.value + dx * msPerPx
      scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, next))
    }
  }

  function onScrollbarMouseDown(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const durationMs = preparedDurationMs.value
    if (durationMs <= 0) return
    const thumbWidth = (visibleDurationMs.value / durationMs) * rect.width
    const grabOffsetMs = ((event.clientX - rect.left) / rect.width) * durationMs - scrollMs.value
    const onMove = (moveEvent: MouseEvent): void => {
      const next = ((moveEvent.clientX - rect.left) / rect.width) * durationMs - grabOffsetMs
      scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, next))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    const thumbLeft = (scrollMs.value / durationMs) * rect.width
    if (event.clientX - rect.left < thumbLeft || event.clientX - rect.left > thumbLeft + thumbWidth) {
      scrollMs.value = Math.max(
        0,
        Math.min(maxScrollMs.value, ((event.clientX - rect.left - thumbWidth / 2) / rect.width) * durationMs)
      )
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function syncSize(): void {
    const canvas = canvasEl.value
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvasCssWidth.value = rect.width
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w
      canvas.height = h
    }
    onResize()
  }

  // A new prepared source resets the view to its default framing.
  watch(preparedDurationMs, () => {
    zoom.value = 1
    scrollMs.value = 0
  })

  // Keep the scroll position valid as the visible window changes size (e.g. on resize).
  watch(maxScrollMs, (maximum) => {
    scrollMs.value = Math.max(0, Math.min(maximum, scrollMs.value))
  })

  // Live audition follow: keeps the playhead roughly centred while playing, at
  // a rate proportional to how far it has drifted, using the same session-clock
  // interpolation as the main timeline follow.
  let followFrame: number | null = null
  let lastFollowMs = 0
  let positionReceivedAtMs = 0
  let resizeObserver: ResizeObserver | null = null

  watch(positionMs, () => {
    positionReceivedAtMs = performance.now()
  }, { immediate: true })

  function followPlayhead(now: number): void {
    const fullDurationMs = preparedDurationMs.value
    const viewDurationMs = visibleDurationMs.value
    if (isPlaying.value && viewDurationMs > 0 && viewDurationMs < fullDurationMs - 0.5) {
      const dtSeconds = lastFollowMs === 0 ? 0 : Math.min(0.1, (now - lastFollowMs) / 1000)
      lastFollowMs = now
      const elapsedSincePositionMs = Math.min(100, Math.max(0, now - positionReceivedAtMs))
      const estimatedPositionMs = positionMs.value + elapsedSincePositionMs * Math.max(0, playbackRate.value)
      const desiredMs = Math.max(0, Math.min(maxScrollMs.value, estimatedPositionMs - viewDurationMs / 2))
      const gapMs = desiredMs - scrollMs.value
      if (gapMs > 0.5) {
        const rateMsPerSecond = Math.max(3000, gapMs * 5)
        scrollMs.value += Math.min(gapMs, rateMsPerSecond * dtSeconds)
      }
    } else {
      lastFollowMs = 0
    }
    followFrame = window.requestAnimationFrame(followPlayhead)
  }

  onMounted(() => {
    const canvas = canvasEl.value
    if (!canvas) return
    resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(canvas)
    syncSize()
    followFrame = window.requestAnimationFrame(followPlayhead)
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (followFrame !== null) window.cancelAnimationFrame(followFrame)
    followFrame = null
  })

  return {
    zoom,
    scrollMs,
    canvasCssWidth,
    visibleDurationMs,
    maxScrollMs,
    visibleStartMs,
    MIN_ZOOM,
    MAX_ZOOM,
    zoomOut,
    resetZoom,
    zoomIn,
    onWheel,
    onScrollbarMouseDown
  }
}
