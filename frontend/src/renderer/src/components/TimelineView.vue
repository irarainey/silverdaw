<script setup lang="ts">
// Timeline canvas. Renders track rows with their clips' waveforms.
//
// Implementation is split across composables under `@/lib/timeline/`:
//   - usePixiApp         — PixiJS Application lifecycle + scene-graph layers
//   - useGridGeometry    — zoom (pxPerSecond), header width, BPM-derived units
//   - useTimelineScroll  — scrollX/Y, scrollbar thumb geometry, clampScroll
//   - useTimelineDrawing — every Pixi draw routine (ruler, grid, tracks,
//                          clips, playhead, drop-preview ghost)
//   - useScrollbarDrag   — pointer-driven horizontal + vertical scrollbar drag
//   - useDragHandlers    — pointer-down → clip drag or playhead seek-drag
//   - useDropZone        — library-item drag/drop landing zone + preview ghost
//
// The component itself owns wheel-zoom, the track-header-column resize
// handle, the watches that trigger repaints, and the host element +
// template wiring. Drawing logic lives in `useTimelineDrawing`; scrollbar
// pointer handling lives in `useScrollbarDrag`.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { isWarpPending } from '@/lib/warp'
import TrackHeaderPanel from '@/components/TrackHeaderPanel.vue'
import ClipContextMenu from '@/components/ClipContextMenu.vue'
import ClipWarpDialog from '@/components/ClipWarpDialog.vue'
import ClipEditorDialog from '@/components/ClipEditorDialog.vue'
import LibraryItemInfoDialog from '@/components/LibraryItemInfoDialog.vue'
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

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const ui = useUiStore()
const host = ref<HTMLDivElement | null>(null)

// `redraw` / `updatePlayhead` are populated once `useTimelineDrawing` has
// been instantiated below. Declared as `let`-bindings up front so the
// callbacks we pass to `usePixiApp`, `useDragHandlers` and `useDropZone`
// (which fire long after wiring, on resize / pointer / drop events) can
// dispatch to the real functions without a chicken-and-egg.
let redraw: () => void = () => { }
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

// Viewport-space rectangles for every drawn clip; populated by
// `useTimelineDrawing` on each redraw and consumed by `useDragHandlers`
// for hit-testing. Shared as a stable array reference; the drag handlers
// read the live contents via a getter so we never copy.
const clipHitRegions: ClipHitRegion[] = []

const pixi = usePixiApp({
  host, viewportWidth, viewportHeight,
  onResize: () => { clampScroll(); redraw(); updatePlayhead() },
  onReady: () => { redraw(); updatePlayhead() }
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
redraw = drawing.redraw
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

// Template refs for the two scrollbar lanes. Declared here (rather than
// inside `useScrollbarDrag`) so the `ref="scrollbarTrack"` /
// `ref="vScrollbarTrack"` template bindings are visible to the TS
// language server in the component's own scope.
const scrollbarTrack = ref<HTMLDivElement | null>(null)
const vScrollbarTrack = ref<HTMLDivElement | null>(null)

const {
  onThumbPointerDown, onThumbPointerMove, onThumbPointerUp, onTrackPointerDown,
  onVThumbPointerDown, onVThumbPointerMove, onVThumbPointerUp, onVTrackPointerDown
} = useScrollbarDrag({
  scrollX, maxScrollX, trackAreaWidth, thumbWidthPx, showScrollbar, scrollbarTrack,
  scrollY, maxScrollY, vLaneHeight, vThumbHeightPx, vScrollbarTrack,
  // Scrollbar drag is now O(1): just translate the world layers.
  // `applyScroll` internally calls `updatePlayhead` so the head re-pins
  // to the right viewport x.
  onScroll: () => { applyScroll() }
})

// Mouse-wheel zoom is attached directly to the host so we can
// `preventDefault` (passive: false is only available via addEventListener).
// The PixiJS init and all other pointer/drag handlers live in composables.
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
})

// ─── Clip context menu + dialogs ──────────────────────────────────────────
// State + handlers live in two composables under `@/lib/timeline/`:
//   - useClipDialogs        — open state + resolved LibraryItem for the
//                             Clip Editor, Library Info, and Warp/Pitch
//                             dialogs.
//   - useTimelineContextMenu — right-click hit-test, dynamic item list,
//                             and command dispatcher (delete, duplicate,
//                             split, save-to-library, save-as-sample,
//                             unlink, warp, pitch, openEditor, info,
//                             relink, color). Calls into the dialog
//                             composable for open/close. Hit-testing
//                             uses the same world-space `clipHitRegions`
//                             array `useDragHandlers` reads.
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
// Double-click a clip's title strip to float an HTML <input> over it. The
// feature (state, overlay geometry, commit/cancel, document key/pointer
// handlers) lives in `useClipRename`; the SFC keeps the watch below that
// toggles the capture-phase document listeners.
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
// Marker hit-test, ruler snap, and the double-click router (rename / open
// editor / add-or-remove marker) live in `useTimelineRulerInteraction`.
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
// `applyZoomRequest` (keyboard / View-menu) and `onWheel` (pointer wheel zoom
// + horizontal pan) share their re-pin math inside `useTimelineZoom`. The
// `ui.timelineZoomRequest` forwarding watch stays in the SFC below.
const { applyZoomRequest, onWheel } = useTimelineZoom({
  getScreenWidth: () => pixi.app.value?.renderer.screen.width ?? null,
  getHostRect: () => host.value?.getBoundingClientRect() ?? null,
  headerWidth,
  pxPerSecond: () => pxPerSecond.value,
  scrollX,
  maxScrollX: () => maxScrollX.value,
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
// We paint the playhead from `requestAnimationFrame` rather than from a
// `watch(transport.positionMs)`:
//   - It batches per-frame work to the display's vsync, avoiding wasted
//     paints when several backend updates land in the same frame.
//   - The cached playhead Graphics + O(1) `applyScroll` make the per-
//     frame cost trivial, so running it every RAF tick is cheap.
//
// We do NOT extrapolate the position locally between backend updates.
// Earlier attempts to do so introduced "playhead lies about where audio
// is" bugs (jumping forward by the pause duration on Play after a seek,
// or snapping backward when the first backend update arrived). The
// playhead now strictly mirrors `transport.positionMs`, which itself
// reflects the audio engine's authoritative position. A 60 Hz backend
// cadence is well above the visual smoothness threshold for a DAW
// timeline, so the trade-off is favourable.
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

// Track / clip count changed → full repaint (new row stack or waveform).
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

// Per-track height changes (drag-resize handle in TrackHeaderPanel)
// shift every row below the resized track and grow / shrink the
// tracksContentHeight used by the vertical scrollbar. Both the canvas
// and the scrollbar geometry need to repaint; tracksContentHeightPx is
// already reactive so a `redraw` here is enough.
watch(
  () => project.tracks.map((t) => t.heightPx ?? 0).join(','),
  () => {
    clampScroll()
    redraw()
    updatePlayhead()
  }
)

// Waveform peaks arrived asynchronously for one or more clips (e.g.
// post-reload `WAVEFORM_REQUEST` round-trip). Counter ticks on every
// `setClipPeaks`; cheaper than a deep watch on `project.clips`.
watch(
  () => project.peaksRevision,
  () => redraw()
)

// Switching the waveform display mode (summary ↔ stereo) changes how
// every clip's waveform is drawn, so force a full repaint.
watch(
  () => ui.waveformDisplayMode,
  () => redraw()
)

// Per-track pan changes how stereo waveform lanes are drawn (each
// channel's height + opacity reflects its equal-power pan gain), so
// repaint when any track's pan changes. Cheap string signature avoids a
// deep watch on the track array.
watch(
  () => project.tracks.map((t) => t.pan ?? 0).join(','),
  () => redraw()
)

watch(
  () => project.markers.map((marker) => `${marker.id}:${marker.positionMs}`).join('|'),
  () => redraw()
)

// Transition (crossfade) create / delete / reconcile changes the overlay
// set without necessarily moving a clip, so watch a cheap signature of
// every track's transitions to repaint when they change (§12.1).
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

// Project length changed → re-clamp scroll. Translation only; no redraw
// needed because clip content didn't change.
watch([maxScrollX, maxScrollY], () => {
  if (pendingSavedScrollX !== null) {
    applySavedScrollX(pendingSavedScrollX)
    if (pendingSavedScrollX !== null) return
  }
  if (clampScroll()) applyScroll()
})

// BPM is editable from the transport bar; the ruler ticks, grid lines and
// snap unit all derive from it, so any change requires a full repaint.
watch(() => transport.bpm, () => {
  redraw()
  updatePlayhead()
})

// The track-header column is user-resizable via the divider drag handle.
// Every cached pixel position (ruler ticks, header backgrounds, clip
// x-coordinates) is computed off `headerWidth()`, so we just repaint on
// each width change.
watch(headerWidthRef, () => {
  redraw()
  updatePlayhead()
})

// ─── Zoom + scroll persistence ─────────────────────────────────────────────
// `project.viewPxPerSecond` and `project.viewScrollX` are the backend-
// authoritative view state. We watch both directions:
//
//   1. backend → renderer:  on PROJECT_STATE the projectStore updates
//      `viewPxPerSecond` / `viewScrollX`. Apply them locally so a
//      freshly-loaded project opens at the zoom AND scroll position
//      that were saved with it. Guards prevent the change bouncing
//      back to the backend.
//   2. renderer → backend:  any wheel zoom OR scroll change that
//      survives a short debounce gets pushed via `PROJECT_SET_VIEW`.
//      The backend stores both fields on the project root without
//      flipping the dirty flag — view state isn't a meaningful edit.
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
  (next) => {
    // Mirror to the uiStore so the StatusBar (and any other consumer)
    // can show the current zoom without reaching into the timeline
    // composable.
    ui.setZoomPxPerSecond(next)
    if (suppressZoomEmit) return
    if (zoomEmitTimer) clearTimeout(zoomEmitTimer)
    zoomEmitTimer = setTimeout(() => {
      zoomEmitTimer = null
      if (project.viewPxPerSecond !== null && Math.abs(project.viewPxPerSecond - next) < 0.01) return
      sendBridge('PROJECT_SET_VIEW', { pxPerSecond: next })
    }, 200)
  },
  // `immediate` so the StatusBar gets the initial value at mount; the
  // debounced send still waits 200 ms, and the guard below catches the
  // "no change vs. backend" case so we don't spuriously emit.
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

// Project length changes also affect grid extent — make sure the grid
// covers the new duration. (Track / clip count changes already trigger
// a redraw via the watcher below; this catches the "user edited Length
// in the transport bar" case where neither count changes.)
watch(
  () => project.durationMs,
  () => redraw()
)

// ─── Track-header column resize ────────────────────────────────────────────
// The user can drag the vertical divider on the right edge of the track
// header column to grow / shrink it. Width is persisted via `uiStore`.

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
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <div
      ref="host"
      class="absolute inset-0"
      :style="{ cursor: hoverCursor }"
    />

    <!-- HTML overlay for track headers (name + M/S/X buttons). -->
    <TrackHeaderPanel :scroll-y="scrollY" />

    <!-- Inline rename input for a clip's title strip. Floats over the
             drawn header pixels and updates its position reactively as the
             user scrolls or zooms during the edit. -->
    <input
      v-if="renameOverlayStyle"
      ref="renameInputRef"
      v-model="renameValue"
      type="text"
      spellcheck="false"
      data-borderless-button="true"
      class="z-30 rounded-sm border border-cyan-500 bg-zinc-950 px-1 text-[10px] font-medium text-zinc-100 outline-none"
      :style="renameOverlayStyle"
      @pointerdown.stop
      @dblclick.stop
      @click.stop
    >

    <!-- Vertical divider drag handle. Sits on top of the column boundary
             between the track-header panel and the timeline canvas. The
             visible line is 1px (drawn by Pixi); this hit area is 6px wide
             and straddles the seam so it's easy to grab. -->
    <div
      class="absolute inset-y-0 z-20 w-1.5 cursor-col-resize"
      :style="{ left: (headerWidth() - 3) + 'px' }"
      title="Drag to resize track header column"
      @pointerdown="onHeaderResizePointerDown"
      @pointermove="onHeaderResizePointerMove"
      @pointerup="onHeaderResizePointerUp"
      @pointercancel="onHeaderResizePointerUp"
    />

    <!-- Vertical scrollbar lane. Spans the full canvas height (over the
             ruler row at the top and over the corner above the horizontal
             scrollbar at the bottom) so the thumb travels the entire canvas.
             The thumb only becomes interactive when there's overflow
             (`maxScrollY > 0`). -->
    <div
      ref="vScrollbarTrack"
      class="absolute inset-y-0 right-0 bg-zinc-900/80"
      :class="maxScrollY > 0 ? 'cursor-pointer' : ''"
      :style="{
        width: SCROLLBAR_WIDTH + 'px'
      }"
      @pointerdown="onVTrackPointerDown"
    >
      <div
        v-if="maxScrollY > 0"
        class="absolute left-1 w-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ top: vThumbTopPx + 'px', height: vThumbHeightPx + 'px' }"
        @pointerdown="onVThumbPointerDown"
        @pointermove="onVThumbPointerMove"
        @pointerup="onVThumbPointerUp"
        @pointercancel="onVThumbPointerUp"
      />
    </div>

    <!-- Horizontal scrollbar. Sits above the transport bar (which lives
             outside this component) and to the right of the track header
             column. Only rendered when content overflows the viewport. -->
    <div
      v-if="showScrollbar"
      ref="scrollbarTrack"
      class="absolute bottom-0 cursor-pointer bg-zinc-900/80"
      :style="{
        left: headerWidth() + 'px',
        right: SCROLLBAR_WIDTH + 'px',
        height: SCROLLBAR_HEIGHT + 'px'
      }"
      @pointerdown="onTrackPointerDown"
    >
      <div
        class="absolute top-1 h-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ left: thumbLeftPx + 'px', width: thumbWidthPx + 'px' }"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
        @pointerup="onThumbPointerUp"
        @pointercancel="onThumbPointerUp"
      />
    </div>

    <!-- Empty state hint. -->
    <div
      v-if="project.tracks.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600"
    >
      Add a track or open a project to start
    </div>

    <!-- Right-click context menu for clip blocks. Teleported to body
         so its z-index / positioning are independent of the timeline's
         transformed children. -->
    <ClipContextMenu
      :open="contextMenuOpen"
      :x="contextMenuX"
      :y="contextMenuY"
      :items="contextMenuItems"
      @close="onContextMenuClose"
      @command="onContextMenuCommand"
    />

    <!-- Per-clip warp settings. Surfaced from the right-click context
         menu; every control commits live through projectStore so close
         is just a dismiss, never a confirm/cancel. -->
    <ClipWarpDialog
      :open="warpDialogOpen"
      :clip-id="warpDialogClipId"
      :panel="warpDialogPanel"
      @close="dialogs.closeWarp()"
    />
    <LibraryItemInfoDialog
      :open="infoClipId !== null && infoItem !== null"
      :item="infoItem"
      :clip-id="infoClipId"
      @close="dialogs.closeInfo()"
    />
    <ClipEditorDialog
      :open="editorClipId !== null && editorItem !== null"
      :item="editorItem"
      :clip-id="editorClipId"
      @close="dialogs.closeEditor()"
    />
  </div>
</template>
