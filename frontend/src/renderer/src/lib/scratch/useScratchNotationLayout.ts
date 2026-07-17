// Viewport layout for the Scratch Notation Editor: responsive SVG sizing,
// zoom, horizontal scroll (native + custom scrollbar), and the
// platter/crossfader lane-height split (draggable divider). Pure Vue
// reactivity + DOM measurement glue — no notation/pattern knowledge.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { DEFAULT_NOTATION_LAYOUT } from './scratchNotationCoordinates'

const MIN_ZOOM_PERCENT = 100
const MAX_ZOOM_PERCENT = 800
const ZOOM_STEP_PERCENT = 10
const BASE_PIXELS_PER_SECOND = 180
const LANE_VERTICAL_MARGIN = 24 // 12px gap between lanes + 12px bottom padding
const MIN_SVG_HEIGHT =
  DEFAULT_NOTATION_LAYOUT.platterLaneHeight +
  DEFAULT_NOTATION_LAYOUT.cfLaneHeight +
  LANE_VERTICAL_MARGIN
// The crossfader's share of the lane area is user-adjustable by dragging the
// separator between the two lanes; it seeds from the fixed default proportion.
const DEFAULT_CF_LANE_RATIO =
  DEFAULT_NOTATION_LAYOUT.cfLaneHeight /
  (DEFAULT_NOTATION_LAYOUT.platterLaneHeight + DEFAULT_NOTATION_LAYOUT.cfLaneHeight)

export interface ScratchNotationLayout {
  zoomPercent: Ref<number>
  scrollLeftPx: Ref<number>
  cfLaneRatio: Ref<number>
  svgWidth: ComputedRef<number>
  svgHeight: ComputedRef<number>
  contentWidth: ComputedRef<number>
  platterLaneHeight: ComputedRef<number>
  cfLaneHeight: ComputedRef<number>
  cfLaneTop: ComputedRef<number>
  laneArea: ComputedRef<number>
  canScrollHorizontally: ComputedRef<boolean>
  scrollThumbWidthPct: ComputedRef<number>
  scrollThumbLeftPct: ComputedRef<number>
  setZoom(nextZoom: number): Promise<void>
  stopPlaybackFollowing(): void
  resetPlaybackPosition(): void
  followPlayback(timeUs: number): void
  onZoomWheel(event: WheelEvent): void
  onViewportScroll(): void
  onScrollbarMouseDown(event: MouseEvent): void
}

export function useScratchNotationLayout(refs: {
  containerEl: Ref<HTMLElement | null>
  viewportEl: Ref<HTMLElement | null>
  durationUs: Ref<number>
}): ScratchNotationLayout {
  const { containerEl, viewportEl, durationUs } = refs
  const { paddingX: PADDING_X } = DEFAULT_NOTATION_LAYOUT

  const zoomPercent = ref(100)
  const scrollLeftPx = ref(0)
  const cfLaneRatio = ref(DEFAULT_CF_LANE_RATIO)
  let playbackTargetScrollLeft: number | null = null
  let playbackFollowFrame: number | null = null
  let lastPlaybackFollowAt = 0
  let lastPlaybackTimeUs = 0

  // Resize observer for SVG width/height tracking.
  let resizeObserver: ResizeObserver | null = null
  const resizeKey = ref(0)
  onMounted(() => {
    if (containerEl.value) {
      resizeObserver = new ResizeObserver(() => {
        resizeKey.value++
      })
      resizeObserver.observe(containerEl.value)
    }
  })
  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (playbackFollowFrame !== null) {
      cancelAnimationFrame(playbackFollowFrame)
      playbackFollowFrame = null
    }
  })

  const svgWidth = computed(() => {
    void resizeKey.value // depend on resize trigger
    const viewportWidth = viewportEl.value?.clientWidth ?? 600
    const timelineWidth = (durationUs.value / 1_000_000) * BASE_PIXELS_PER_SECOND + PADDING_X * 2
    const baseWidth = Math.max(300, viewportWidth, timelineWidth)
    return (baseWidth * zoomPercent.value) / 100
  })
  const contentWidth = computed(() => Math.max(1, svgWidth.value - PADDING_X * 2))
  const svgHeight = computed(() => {
    void resizeKey.value // depend on resize trigger
    const measured = viewportEl.value?.clientHeight ?? 0
    return Math.max(MIN_SVG_HEIGHT, measured)
  })
  const laneArea = computed(() => svgHeight.value - LANE_VERTICAL_MARGIN)
  const platterLaneHeight = computed(() => laneArea.value * (1 - cfLaneRatio.value))
  const cfLaneHeight = computed(() => laneArea.value * cfLaneRatio.value)
  const cfLaneTop = computed(() => platterLaneHeight.value + 12)

  async function setZoom(nextZoom: number): Promise<void> {
    const viewport = viewportEl.value
    const previousCentre =
      viewport && viewport.scrollWidth > 0
        ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
        : 0.5
    zoomPercent.value = Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, nextZoom))
    await nextTick()
    if (viewport) {
      viewport.scrollLeft = previousCentre * viewport.scrollWidth - viewport.clientWidth / 2
      scrollLeftPx.value = viewport.scrollLeft
    }
  }

  function stopPlaybackFollowing(): void {
    if (playbackFollowFrame !== null) {
      cancelAnimationFrame(playbackFollowFrame)
      playbackFollowFrame = null
    }
    playbackTargetScrollLeft = null
    lastPlaybackFollowAt = 0
    lastPlaybackTimeUs = 0
  }

  function resetPlaybackPosition(): void {
    stopPlaybackFollowing()
    if (viewportEl.value) viewportEl.value.scrollLeft = 0
    scrollLeftPx.value = 0
  }

  function followPlayback(timeUs: number): void {
    const viewport = viewportEl.value
    if (!viewport || svgWidth.value <= viewport.clientWidth) return

    const normalizedTime = durationUs.value > 0
      ? Math.max(0, Math.min(1, timeUs / durationUs.value))
      : 0
    const playheadX = PADDING_X + normalizedTime * contentWidth.value
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth
    const desiredScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, playheadX - viewport.clientWidth / 2)
    )
    if (timeUs < lastPlaybackTimeUs) {
      playbackTargetScrollLeft = null
      lastPlaybackFollowAt = 0
    }
    lastPlaybackTimeUs = timeUs
    if (desiredScrollLeft <= viewport.scrollLeft) return

    playbackTargetScrollLeft = desiredScrollLeft
    if (playbackFollowFrame === null) {
      playbackFollowFrame = requestAnimationFrame(advancePlaybackFollow)
    }
  }

  function advancePlaybackFollow(now: number): void {
    playbackFollowFrame = null
    const viewport = viewportEl.value
    const target = playbackTargetScrollLeft
    if (!viewport || target === null || target <= viewport.scrollLeft) {
      lastPlaybackFollowAt = 0
      return
    }

    const elapsedSeconds = lastPlaybackFollowAt === 0
      ? 1 / 60
      : Math.min(0.1, (now - lastPlaybackFollowAt) / 1000)
    lastPlaybackFollowAt = now
    const gap = target - viewport.scrollLeft
    const playbackPixelsPerSecond = durationUs.value > 0
      ? contentWidth.value / (durationUs.value / 1_000_000)
      : 0
    const ratePerSecond = Math.max(playbackPixelsPerSecond * 3, gap * 5)
    const step = Math.min(gap, ratePerSecond * elapsedSeconds)
    viewport.scrollLeft += step
    scrollLeftPx.value = viewport.scrollLeft

    if (target - viewport.scrollLeft > 0.5) {
      playbackFollowFrame = requestAnimationFrame(advancePlaybackFollow)
    } else {
      lastPlaybackFollowAt = 0
    }
  }

  function onZoomWheel(event: WheelEvent): void {
    const delta = event.deltaY < 0 ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT
    void setZoom(zoomPercent.value + delta)
  }

  // Custom horizontal scrollbar. The viewport scrolls natively but hides its
  // native scrollbars; this overlay reflects and drives the scroll position.
  function onViewportScroll(): void {
    scrollLeftPx.value = viewportEl.value?.scrollLeft ?? 0
  }

  const canScrollHorizontally = computed(() => {
    void resizeKey.value
    const view = viewportEl.value?.clientWidth ?? 0
    return svgWidth.value - view > 0.5
  })

  const scrollThumbWidthPct = computed(() => {
    void resizeKey.value
    const total = svgWidth.value
    const view = viewportEl.value?.clientWidth ?? 0
    if (total <= 0) return 100
    return Math.max(2, Math.min(100, (view / total) * 100))
  })

  const scrollThumbLeftPct = computed(() => {
    const total = svgWidth.value
    if (total <= 0) return 0
    const maxLeft = 100 - scrollThumbWidthPct.value
    return Math.max(0, Math.min(maxLeft, (scrollLeftPx.value / total) * 100))
  })

  function onScrollbarMouseDown(event: MouseEvent): void {
    const viewport = viewportEl.value
    const track = event.currentTarget as HTMLElement
    if (!viewport) return
    const rect = track.getBoundingClientRect()
    const total = svgWidth.value
    const view = viewport.clientWidth
    if (total <= view || rect.width <= 0) return

    const thumbWidth = (view / total) * rect.width
    const thumbLeft = (viewport.scrollLeft / total) * rect.width
    const clickX = event.clientX - rect.left

    let grabOffset: number
    if (clickX < thumbLeft || clickX > thumbLeft + thumbWidth) {
      // Page to the click position, then drag from the thumb centre.
      viewport.scrollLeft = ((clickX - thumbWidth / 2) / rect.width) * total
      grabOffset = thumbWidth / 2
    } else {
      grabOffset = clickX - thumbLeft
    }
    scrollLeftPx.value = viewport.scrollLeft

    const onMove = (moveEvent: MouseEvent): void => {
      const x = moveEvent.clientX - rect.left - grabOffset
      viewport.scrollLeft = Math.max(0, Math.min(total - view, (x / rect.width) * total))
      scrollLeftPx.value = viewport.scrollLeft
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return {
    zoomPercent,
    scrollLeftPx,
    cfLaneRatio,
    svgWidth,
    svgHeight,
    contentWidth,
    platterLaneHeight,
    cfLaneHeight,
    cfLaneTop,
    laneArea,
    canScrollHorizontally,
    scrollThumbWidthPct,
    scrollThumbLeftPct,
    setZoom,
    stopPlaybackFollowing,
    resetPlaybackPosition,
    followPlayback,
    onZoomWheel,
    onViewportScroll,
    onScrollbarMouseDown
  }
}

export { BASE_PIXELS_PER_SECOND, MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT, ZOOM_STEP_PERCENT }
