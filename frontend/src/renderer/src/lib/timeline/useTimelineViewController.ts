import { computed, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
// Timeline canvas shell; Pixi drawing, drag/drop, scroll, and dialogs live in composables.

import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { isWarpPending } from '@/lib/warp'
import { SCROLLBAR_HEIGHT, SCROLLBAR_WIDTH, RULER_HEIGHT } from '@/lib/timeline/constants'
import { useGridGeometry } from '@/lib/timeline/useGridGeometry'
import { useTimelineScroll } from '@/lib/timeline/useTimelineScroll'
import { tracksContentHeight as tracksContentHeight_, buildTrackRowLayout } from '@/lib/timeline/trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import { usePixiApp } from '@/lib/timeline/usePixiApp'
import { useDragHandlers, type ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import { useDropZone } from '@/lib/timeline/useDropZone'
import { useTimelineDrawing } from '@/lib/timeline/useTimelineDrawing'
import { useScrollbarDrag } from '@/lib/timeline/useScrollbarDrag'
import { send as sendBridge } from '@/lib/bridgeService'
import { useClipDialogs } from '@/lib/timeline/useClipDialogs'
import { useTimelineContextMenu } from '@/lib/timeline/useTimelineContextMenu'
import { useClipRename } from '@/lib/timeline/useClipRename'
import { useTimelineRulerInteraction } from '@/lib/timeline/useTimelineRulerInteraction'
import { useTimelineZoom } from '@/lib/timeline/useTimelineZoom'
import { createRedrawScheduler } from '@/lib/timeline/useRedrawScheduler'
import { useTimelineRepaintWatches } from '@/lib/timeline/useTimelineRepaintWatches'
import { useTimelineHeaderResize } from '@/lib/timeline/useTimelineHeaderResize'


export function useTimelineViewController(
  host: Ref<HTMLDivElement | null>,
  scrollbarTrack: Ref<HTMLDivElement | null>,
  vScrollbarTrack: Ref<HTMLDivElement | null>
) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()

  // Late-bound so lifecycle callbacks can call drawing after composables wire up.
  // `redraw` is the rAF-coalesced entry point used by watchers and interaction
  // handlers; `redrawNow` is the synchronous rebuild for paths that must paint in
  // the same frame (resize/first paint, where the renderer renders immediately).
  let redraw: () => void = () => { }
  let redrawNow: () => void = () => { }
  let updatePlayhead: () => void = () => { }

  // ─── Composables ──────────────────────────────────────────────────────────
  const geometry = useGridGeometry()
  const { pxPerSecond, headerWidth, headerWidthRef, contentPx } = geometry

  const tracksContentHeightPx = computed(() => tracksContentHeight_(project.tracks, makeLaneHeightOf()))
  const scroll = useTimelineScroll({ contentPx, headerWidthRef, tracksContentHeightPx })
  const {
    scrollX, scrollY, viewportWidth, viewportHeight,
    trackAreaWidth, maxScrollX, showScrollbar, thumbWidthPx, thumbLeftPx,
    tracksContentHeight, trackAreaHeight, vLaneHeight, maxScrollY,
    vThumbHeightPx, vThumbTopPx, clampScroll
  } = scroll

  // Stable hit-region array: drawing mutates it, drag handlers read it without copying.
  const clipHitRegions: ClipHitRegion[] = []

  const pixi = usePixiApp({
    host, viewportWidth, viewportHeight,
    onResize: () => { clampScroll(); redrawNow(); updatePlayhead() },
    onReady: () => { redrawNow(); updatePlayhead() }
  })

  const { isDraggingPlayhead, hoverCursor, removeAutomationPointAt } = useDragHandlers({
    host, app: pixi.app, scrollX, scrollY, maxScrollX, showScrollbar, geometry,
    getClipHitRegions: () => clipHitRegions,
    onClipMoved: () => { redraw(); updatePlayhead() },
    onMarkerMoved: () => { redraw(); updatePlayhead() },
    onPlayheadMoved: () => { updatePlayhead() }
  })

  const { dropPreview } = useDropZone({
    host, app: pixi.app, scrollX, scrollY, maxScrollX, showScrollbar, geometry,
    onPreviewChanged: () => { updatePlayhead() }
  })

  const drawing = useTimelineDrawing({
    app: pixi.app,
    rulerLayer: pixi.rulerLayer,
    rulerTicksLayer: pixi.rulerTicksLayer,
    tracksLayer: pixi.tracksLayer,
    headersLayer: pixi.headersLayer,
    playheadLayer: pixi.playheadLayer,
    GraphicsCtor: pixi.GraphicsCtor,
    TextCtor: pixi.TextCtor,
    MeshCtor: pixi.MeshCtor,
    MeshGeometryCtor: pixi.MeshGeometryCtor,
    whiteTexture: pixi.whiteTexture,
    geometry,
    scrollX, scrollY, showScrollbar, maxScrollX,
    trackAreaHeight, tracksContentHeight,
    clampScroll,
    clipHitRegions, isDraggingPlayhead, dropPreview
  })
  redrawNow = drawing.redraw
  // All watcher / interaction redraw requests coalesce to one rebuild per frame.
  const redrawScheduler = createRedrawScheduler(redrawNow)
  redraw = redrawScheduler.schedule
  updatePlayhead = drawing.updatePlayhead
  const applyScroll = drawing.applyScroll
  const setDisplayPositionMs = drawing.setDisplayPositionMs

  const hasPendingWarpClip = computed(() =>
    Object.values(project.clips).some((clip) => {
      const libItem = library.byId[clip.libraryItemId]
      const sourceBpm = libItem ? libraryItemSourceBpm(libItem, library.byId) : undefined
      return isWarpPending({
        warpEnabled: clip.warpEnabled,
        tempoRatio: clip.tempoRatio,
        pendingAutoWarp: clip.pendingAutoWarp,
        sourceBpm,
        projectBpm: transport.bpm
      })
    })
  )


  const {
    onThumbPointerDown, onThumbPointerMove, onThumbPointerUp, onTrackPointerDown,
    onVThumbPointerDown, onVThumbPointerMove, onVThumbPointerUp, onVTrackPointerDown
  } = useScrollbarDrag({
    scrollX, maxScrollX, trackAreaWidth, thumbWidthPx, showScrollbar, scrollbarTrack,
    scrollY, maxScrollY, vLaneHeight, vThumbHeightPx, vScrollbarTrack,
    // O(1) scroll: translate layers and re-pin the playhead.
    onScroll: () => { applyScroll() }
  })

  // Wheel listener needs passive:false so zoom/pan can prevent page scrolling.
  onMounted(() => {
    host.value?.addEventListener('wheel', onWheel, { passive: false })
    host.value?.addEventListener('contextmenu', onContextMenu)
    host.value?.addEventListener('dblclick', onDoubleClick)
    startPlayheadRaf()
  })
  onBeforeUnmount(() => {
    host.value?.removeEventListener('wheel', onWheel)
    host.value?.removeEventListener('contextmenu', onContextMenu)
    host.value?.removeEventListener('dblclick', onDoubleClick)
    document.removeEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
    document.removeEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
    stopPlayheadRaf()
    redrawScheduler.cancel()
  })

  // ─── Clip context menu + dialogs ──────────────────────────────────────────
  // Dialog state and context-menu hit-testing live in timeline composables.
  const dialogs = useClipDialogs()
  const {
    editorClipId,
    infoClipId,
    warpDialogOpen,
    warpDialogClipId,
    warpDialogPanel,
    sampleTypeOpen,
    sampleTypeClipId,
    editorItem,
    infoItem
  } = dialogs
  const contextMenu = useTimelineContextMenu({
    host,
    scrollX,
    scrollY,
    getClipHitRegions: () => clipHitRegions,
    headerWidth,
    removeAutomationPointAt,
    dialogs
  })
  const {
    contextMenuOpen,
    contextMenuX,
    contextMenuY,
    contextMenuItems,
    onContextMenu,
    onContextMenuCommand,
    onContextMenuClose
  } = contextMenu

  // ─── Inline clip-name rename ──────────────────────────────────────────────
  // The SFC only toggles capture-phase document listeners.
  const {
    renamingClipId,
    renameValue,
    renameInputRef,
    renameOverlayStyle,
    startClipRename,
    onRenameDocumentKeyDown,
    onRenameDocumentPointerDown
  } = useClipRename({
    headerWidth,
    pxPerSecond: () => pxPerSecond.value,
    scrollX: () => scrollX.value,
    scrollY: () => scrollY.value
  })

  watch(renamingClipId, (id) => {
    if (id) {
      document.addEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
      document.addEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
    } else {
      document.removeEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
      document.removeEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
    }
  })

  // ─── Clip double-click interaction (rename / open editor) ─────────────────
  const { onDoubleClick } = useTimelineRulerInteraction({
    getHostRect: () => host.value?.getBoundingClientRect() ?? null,
    scrollX: () => scrollX.value,
    scrollY: () => scrollY.value,
    getClipHitRegions: () => clipHitRegions,
    startClipRename,
    openClipEditor: (clipId) => dialogs.openEditor(clipId)
  })

  // ─── Zoom control (wheel + zoom requests) ─────────────────────────────────
  const { applyZoomRequest, onWheel } = useTimelineZoom({
    getScreenWidth: () => pixi.app.value?.renderer.screen.width ?? null,
    getHostRect: () => host.value?.getBoundingClientRect() ?? null,
    headerWidth,
    pxPerSecond: () => pxPerSecond.value,
    getProjectDurationMs: () => project.durationMs,
    scrollX,
    maxScrollX: () => maxScrollX.value,
    scrollY,
    maxScrollY: () => maxScrollY.value,
    trackAreaWidth: () => trackAreaWidth.value,
    setPxPerSecond: (value) => geometry.setPxPerSecond(value),
    getPlayheadPositionMs: () => transport.positionMs,
    getTrackCount: () => project.tracks.length,
    applyScroll,
    redraw: () => redraw(),
    updatePlayhead: () => updatePlayhead()
  })

  watch(
    () => ui.timelineZoomRequest,
    (request, previous) => {
      if (!request || request.id === previous?.id) return
      applyZoomRequest(request)
    }
  )

  // ─── Playhead paint loop (RAF) ────────────────────────────────────────────
  // Paint on RAF for vsync batching, but never extrapolate beyond backend position.
  let rafId: number | null = null
  let lastWarpSpinnerRedrawMs = 0

  function startPlayheadRaf(): void {
    const tick = (): void => {
      rafId = requestAnimationFrame(tick)
      setDisplayPositionMs(transport.positionMs)
      if (hasPendingWarpClip.value) {
        const now = performance.now()
        if (now - lastWarpSpinnerRedrawMs >= 125) {
          lastWarpSpinnerRedrawMs = now
          redraw()
        }
      }
      updatePlayhead()
    }
    rafId = requestAnimationFrame(tick)
  }

  function stopPlayheadRaf(): void {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
  }

  // ─── Watches that trigger repaints ────────────────────────────
  // Each watcher sources a distinct reactive input; details live in the composable.
  useTimelineRepaintWatches({
    redraw: () => redraw(),
    updatePlayhead: () => updatePlayhead(),
    clampScroll,
    applyScroll,
    horizontalRebuildNeeded: () => drawing.horizontalRebuildNeeded(),
    scrollX,
    scrollY,
    headerWidthRef
  })

  // Project length changes only need scroll re-clamping.
  watch([maxScrollX, maxScrollY], () => {
    if (pendingSavedScrollX !== null) {
      applySavedScrollX(pendingSavedScrollX)
      if (pendingSavedScrollX !== null) return
    }
    if (clampScroll()) applyScroll()
  })

  // ─── Zoom + scroll persistence ─────────────────────────────────────────────
  // Persist view state both directions without marking the project dirty.
  let suppressZoomEmit = false
  let suppressScrollEmit = false
  let zoomEmitTimer: ReturnType<typeof setTimeout> | null = null
  let scrollEmitTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSavedScrollX: number | null = null

  function applySavedScrollX(saved: number): void {
    if (saved > 0 && maxScrollX.value <= 0) {
      pendingSavedScrollX = saved
      return
    }
    pendingSavedScrollX = null
    const clamped = Math.max(0, Math.min(maxScrollX.value, saved))
    if (Math.abs(clamped - scrollX.value) < 0.5) return
    suppressScrollEmit = true
    scrollX.value = clamped
    applyScroll()
    requestAnimationFrame(() => {
      suppressScrollEmit = false
    })
  }

  watch(
    () => project.viewPxPerSecond,
    (saved) => {
      if (saved === null) return
      if (Math.abs(saved - pxPerSecond.value) < 0.01) return
      suppressZoomEmit = true
      geometry.setPxPerSecond(saved)
      redraw()
      updatePlayhead()
      requestAnimationFrame(() => {
        suppressZoomEmit = false
      })
    }
  )

  watch(
    () => project.viewScrollX,
    (saved) => {
      if (saved === null) return
      applySavedScrollX(saved)
    }
  )

  watch(
    () => ui.timelineScrollRequest,
    (request) => {
      if (!request) return
      let next: number
      if ('edge' in request) {
        next = request.edge === 'start' ? 0 : maxScrollX.value
      } else {
        const targetX = (request.positionMs / 1000) * pxPerSecond.value
        const margin = 24
        const visibleLeft = scrollX.value + margin
        const visibleRight = scrollX.value + trackAreaWidth.value - margin
        if (targetX >= visibleLeft && targetX <= visibleRight) return
        next = targetX < visibleLeft ? targetX - margin : targetX - trackAreaWidth.value + margin
        next = Math.max(0, Math.min(maxScrollX.value, next))
      }
      if (Math.abs(next - scrollX.value) < 0.5) return
      scrollX.value = next
      applyScroll()
    }
  )

  // Scroll a freshly-added (or otherwise off-screen) track row into the
  // visible vertical band. Mirrors the horizontal scroll-into-view above.
  watch(
    () => ui.timelineRevealTrackRequest,
    (request) => {
      if (!request) return
      const index = project.tracks.findIndex((t) => t.id === request.trackId)
      if (index < 0) return
      const slot = buildTrackRowLayout(project.tracks, makeLaneHeightOf())[index]
      if (!slot) return
      // Content-relative bounds: 0 = first track top (just below the ruler).
      const rowTop = slot.top - RULER_HEIGHT
      const rowBottom = rowTop + slot.height
      const viewTop = scrollY.value
      const viewBottom = scrollY.value + trackAreaHeight.value
      let next = scrollY.value
      if (rowTop < viewTop) next = rowTop
      else if (rowBottom > viewBottom) next = rowBottom - trackAreaHeight.value
      next = Math.max(0, Math.min(maxScrollY.value, next))
      if (Math.abs(next - scrollY.value) < 0.5) return
      scrollY.value = next
      applyScroll()
    }
  )

  watch(
    pxPerSecond,
    (next, prev) => {
      // Always seed the StatusBar mirror, including the immediate on-mount call.
      ui.setZoomPxPerSecond(next)
      // The immediate call (prev === undefined) only seeds the mirror: it must
      // not write the project store or emit, or it would clobber a zoom a
      // just-loaded project restored and fire a spurious PROJECT_SET_VIEW.
      if (prev === undefined) return
      // Live-mirror into the project store so view-state/full saves persist zoom
      // (matches how the scrollX watch keeps project.viewScrollX current).
      project.viewPxPerSecond = next
      if (suppressZoomEmit) return
      if (zoomEmitTimer) clearTimeout(zoomEmitTimer)
      zoomEmitTimer = setTimeout(() => {
        zoomEmitTimer = null
        sendBridge('PROJECT_SET_VIEW', { pxPerSecond: next })
      }, 200)
    },
    // Seed StatusBar immediately; debounce still guards backend writes.
    { immediate: true }
  )

  watch(
    scrollX,
    (next) => {
      if (suppressScrollEmit) return
      project.viewScrollX = next
      if (scrollEmitTimer) clearTimeout(scrollEmitTimer)
      scrollEmitTimer = setTimeout(() => {
        scrollEmitTimer = null
        sendBridge('PROJECT_SET_VIEW', { scrollX: next })
      }, 200)
    },
    { flush: 'sync' }
  )


  // ─── Track-header column resize ────────────────────────────────────────────
  const {
    onHeaderResizePointerDown,
    onHeaderResizePointerMove,
    onHeaderResizePointerUp
  } = useTimelineHeaderResize()

  return {
    project,
    host,
    hoverCursor,
    scrollY,
    onWheel,
    renameOverlayStyle,
    renameInputRef,
    renameValue,
    headerWidth,
    onHeaderResizePointerDown,
    onHeaderResizePointerMove,
    onHeaderResizePointerUp,
    vScrollbarTrack,
    maxScrollY,
    SCROLLBAR_WIDTH,
    vThumbTopPx,
    vThumbHeightPx,
    onVTrackPointerDown,
    onVThumbPointerDown,
    onVThumbPointerMove,
    onVThumbPointerUp,
    showScrollbar,
    scrollbarTrack,
    SCROLLBAR_HEIGHT,
    onTrackPointerDown,
    thumbLeftPx,
    thumbWidthPx,
    onThumbPointerDown,
    onThumbPointerMove,
    onThumbPointerUp,
    contextMenuOpen,
    contextMenuX,
    contextMenuY,
    contextMenuItems,
    onContextMenuClose,
    onContextMenuCommand,
    warpDialogOpen,
    warpDialogClipId,
    warpDialogPanel,
    sampleTypeOpen,
    sampleTypeClipId,
    dialogs,
    infoClipId,
    infoItem,
    editorClipId,
    editorItem,
  }
}
