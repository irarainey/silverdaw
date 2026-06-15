import { computed, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
// Timeline canvas shell; Pixi drawing, drag/drop, scroll, and dialogs live in composables.

import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { isWarpPending } from '@/lib/warp'
import { SCROLLBAR_HEIGHT, SCROLLBAR_WIDTH } from '@/lib/timeline/constants'
import { useGridGeometry } from '@/lib/timeline/useGridGeometry'
import { useTimelineScroll } from '@/lib/timeline/useTimelineScroll'
import { tracksContentHeight as tracksContentHeight_ } from '@/lib/timeline/trackLayout'
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

  const tracksContentHeightPx = computed(() => tracksContentHeight_(project.tracks))
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

  const { isDraggingPlayhead, hoverCursor } = useDragHandlers({
    host, app: pixi.app, scrollX, scrollY, maxScrollX, showScrollbar, geometry,
    getClipHitRegions: () => clipHitRegions,
    onClipMoved: () => { redraw(); updatePlayhead() },
    onMarkerMoved: () => { redraw(); updatePlayhead() },
    onPlayheadMoved: () => { updatePlayhead() }
  })

  const { dropPreview } = useDropZone({
    host, app: pixi.app, scrollX, scrollY, showScrollbar, geometry,
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
    editorItem,
    infoItem
  } = dialogs
  const contextMenu = useTimelineContextMenu({
    host,
    scrollX,
    scrollY,
    getClipHitRegions: () => clipHitRegions,
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

  // ─── Ruler / clip double-click interaction ────────────────────────────────
  const { onDoubleClick } = useTimelineRulerInteraction({
    getHostRect: () => host.value?.getBoundingClientRect() ?? null,
    getScreenWidth: () => pixi.app.value?.renderer.screen.width ?? null,
    headerWidth,
    pxPerSecond: () => pxPerSecond.value,
    scrollX: () => scrollX.value,
    scrollY: () => scrollY.value,
    msPerSubBeat: () => geometry.msPerSubBeat(),
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

  // ─── Watches that trigger repaints ────────────────────────────────────────
  watch(
    () => [project.tracks.length, Object.keys(project.clips).length] as const,
    () => {
      redraw()
      updatePlayhead()
    }
  )

  watch(
    () => Object.values(project.clips)
      .map((clip) => [
        clip.id,
        clip.warpEnabled === true ? 1 : 0,
        clip.pendingAutoWarp === true ? 1 : 0,
        clip.warpMode ?? '',
        clip.tempoRatio ?? '',
        clip.semitones ?? '',
        clip.cents ?? ''
      ].join(':'))
      .join('|'),
    () => {
      redraw()
      updatePlayhead()
    }
  )

  watch(
    () => Object.values(project.clips)
      .map((clip) => {
        const item = library.byId[clip.libraryItemId]
        const sourceBpm = item ? libraryItemSourceBpm(item, library.byId) : undefined
        return [
          clip.id,
          clip.libraryItemId,
          item?.kind ?? '',
          item ? libraryItemDisplayName(item) : '',
          item?.durationMs ?? '',
          item?.derivedFrom?.inMs ?? '',
          item?.derivedFrom?.durationMs ?? '',
          sourceBpm ?? ''
        ].join(':')
      })
      .join('|'),
    () => {
      redraw()
      updatePlayhead()
    }
  )

  // Track-height changes affect row positions and vertical scrollbar geometry.
  watch(
    () => project.tracks.map((t) => t.heightPx ?? 0).join(','),
    () => {
      clampScroll()
      redraw()
      updatePlayhead()
    }
  )

  // Peaks revision avoids a deep watch on clip waveform data.
  watch(
    () => project.peaksRevision,
    () => redraw()
  )

  // Both scroll axes change which content falls inside the culled draw window
  // (vertical = which rows; horizontal = which clip/grid/tick band). Vertical
  // scroll always rebuilds. Horizontal scroll translates the band immediately
  // (O(1), crisp this frame) and only schedules a coalesced rebuild once it
  // drifts past the overscan threshold — so panning and playback auto-follow
  // stay translate-only per frame instead of rebuilding the scene each tick.
  watch(scrollX, () => {
    applyScroll()
    if (drawing.horizontalRebuildNeeded()) redraw()
  })
  watch(scrollY, () => redraw())

  watch(
    () => ui.waveformDisplayMode,
    () => redraw()
  )

  // Track pan affects stereo waveform lane height/opacity.
  watch(
    () => project.tracks.map((t) => t.pan ?? 0).join(','),
    () => redraw()
  )

  watch(
    () => project.markers.map((marker) => `${marker.id}:${marker.positionMs}`).join('|'),
    () => redraw()
  )

  // Transition overlays can change without clip movement.
  watch(
    () =>
      project.tracks
        .map((t) =>
          (t.transitions ?? [])
            .map((tr) => `${tr.id}:${tr.leftClipId}>${tr.rightClipId}:${tr.recipe.kind}`)
            .join(',')
        )
        .join('|'),
    () => redraw()
  )

  // Project length changes only need scroll re-clamping.
  watch([maxScrollX, maxScrollY], () => {
    if (pendingSavedScrollX !== null) {
      applySavedScrollX(pendingSavedScrollX)
      if (pendingSavedScrollX !== null) return
    }
    if (clampScroll()) applyScroll()
  })

  // BPM drives ruler ticks, grid lines, and snap units.
  watch(() => transport.bpm, () => {
    redraw()
    updatePlayhead()
  })

  // Ruler bar labels depend on the project's bar-counter offset.
  watch(() => project.barCounterStart, () => {
    redraw()
  })

  // Header width participates in cached x positions.
  watch(headerWidthRef, () => {
    redraw()
    updatePlayhead()
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

  // Project length changes affect grid extent even when clip counts stay unchanged.
  watch(
    () => project.durationMs,
    () => redraw()
  )

  // ─── Track-header column resize ────────────────────────────────────────────

  let headerResizePointerId: number | null = null
  let headerResizeStartX = 0
  let headerResizeStartWidth = 0

  function onHeaderResizePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    headerResizePointerId = e.pointerId
    headerResizeStartX = e.clientX
    headerResizeStartWidth = ui.trackHeaderWidth
      ; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onHeaderResizePointerMove(e: PointerEvent): void {
    if (headerResizePointerId !== e.pointerId) return
    const delta = e.clientX - headerResizeStartX
    ui.setTrackHeaderWidth(headerResizeStartWidth + delta)
  }

  function onHeaderResizePointerUp(e: PointerEvent): void {
    if (headerResizePointerId !== e.pointerId) return
    headerResizePointerId = null
      ; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  return {
    project,
    host,
    hoverCursor,
    scrollY,
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
    dialogs,
    infoClipId,
    infoItem,
    editorClipId,
    editorItem,
  }
}
