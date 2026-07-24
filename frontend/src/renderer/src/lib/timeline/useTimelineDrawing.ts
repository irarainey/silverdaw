// PixiJS scene drawing for the timeline canvas.
// Thin orchestrator: owns the redraw lifecycle and scroll translation, delegating
// ruler, track-area, and playhead painting to focused sibling renderers. Hit
// regions are host-owned.

import { type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Mesh, MeshGeometry, Text, Texture } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { log } from '@/lib/log'
import { SCROLLBAR_WIDTH } from './constants'
import type { ClipHitRegion } from './useDragHandlers'
import type { DropPreview } from './useDropZone'
import type { GridGeometry } from './useGridGeometry'
import { createClipRenderer } from './clipRenderer'
import { createTimelineRulerRenderer } from './timelineRulerRenderer'
import { createTimelineTracksRenderer } from './timelineTracksRenderer'
import { createTimelinePlayheadRenderer } from './timelinePlayheadRenderer'
import { exceedsRebuildThreshold } from './timelineWindow'

export interface TimelineDrawingOptions {
  app: ShallowRef<Application | null>
  rulerLayer: ShallowRef<Container | null>
  rulerTicksLayer: ShallowRef<Container | null>
  tracksLayer: ShallowRef<Container | null>
  headersLayer: ShallowRef<Container | null>
  playheadLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  MeshCtor: ShallowRef<typeof Mesh | null>
  MeshGeometryCtor: ShallowRef<typeof MeshGeometry | null>
  whiteTexture: ShallowRef<Texture | null>
  geometry: GridGeometry
  scrollX: Ref<number>
  scrollY: Ref<number>
  showScrollbar: ComputedRef<boolean>
  maxScrollX: ComputedRef<number>
  trackAreaHeight: ComputedRef<number>
  tracksContentHeight: ComputedRef<number>
  /** Clamps `scrollX/Y` to valid range; returns true iff anything moved. */
  clampScroll: () => boolean
  /** Output sink for clip hit-test rectangles. */
  clipHitRegions: ClipHitRegion[]
  /** From `useDragHandlers` — true while the user is dragging the playhead. */
  isDraggingPlayhead: Ref<boolean>
  /** From `useDropZone` — current drag-hover landing rectangle (or null). */
  dropPreview: Ref<DropPreview | null>
}

export interface TimelineDrawing {
  /** Full repaint for content, zoom, BPM, or viewport changes; not per frame. */
  redraw: () => void
  /** O(1) layer translation for scroll; no Pixi nodes are rebuilt. */
  applyScroll: () => void
  /** Update cached playhead position and optional auto-follow scroll. */
  updatePlayhead: () => void
  /** Override visual playhead ms for RAF interpolation between backend ticks. */
  setDisplayPositionMs: (ms: number) => void
  /** True when horizontal scroll has left the built band and needs a rebuild. */
  horizontalRebuildNeeded: () => boolean
}

export function useTimelineDrawing(opts: TimelineDrawingOptions): TimelineDrawing {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const {
    app,
    rulerLayer,
    rulerTicksLayer,
    tracksLayer,
    headersLayer,
    playheadLayer,
    GraphicsCtor,
    TextCtor,
    MeshCtor,
    MeshGeometryCtor,
    whiteTexture,
    geometry,
    scrollX,
    scrollY,
    showScrollbar,
    trackAreaHeight,
    tracksContentHeight,
    clampScroll,
    clipHitRegions,
    isDraggingPlayhead,
    dropPreview
  } = opts
  const { pxPerSecond, headerWidth } = geometry
  const clipRenderer = createClipRenderer({
    tracksLayer,
    GraphicsCtor,
    TextCtor,
    MeshCtor,
    MeshGeometryCtor,
    whiteTexture,
    geometry,
    clipHitRegions
  })
  const rulerRenderer = createTimelineRulerRenderer({
    app,
    rulerLayer,
    rulerTicksLayer,
    headersLayer,
    GraphicsCtor,
    TextCtor,
    geometry,
    scrollX,
    project,
    transport
  })
  const tracksRenderer = createTimelineTracksRenderer({
    app,
    tracksLayer,
    headersLayer,
    GraphicsCtor,
    geometry,
    scrollX,
    scrollY,
    trackAreaHeight,
    tracksContentHeight,
    project,
    transport,
    clipRenderer
  })
  const playheadRenderer = createTimelinePlayheadRenderer({
    app,
    playheadLayer,
    tracksLayer,
    rulerTicksLayer,
    GraphicsCtor,
    geometry,
    scrollX,
    scrollY,
    showScrollbar,
    trackAreaHeight,
    tracksContentHeight,
    clampScroll,
    isDraggingPlayhead,
    dropPreview,
    project,
    transport,
    ui
  })

  let redrawCount = 0
  let lastRedrawStats = {
    rows: 0,
    clips: 0,
    durationMs: 0,
    rulerMs: 0,
    tracksMs: 0,
    columns: 0,
    lanes: 0,
    graphics: 0,
    rects: 0,
    meshes: 0
  }
  // Horizontal scroll position the current scene band was built at; horizontal
  // scroll translates the band (O(1)) and only rebuilds once it drifts past the
  // overscan threshold (see `horizontalRebuildNeeded`). NaN until the first draw.
  let lastBuiltScrollX = Number.NaN

  /** Re-translate world layers for scroll; no scene rebuild. */
  function applyScroll(): void {
    const tracks = tracksLayer.value
    const rulerTicks = rulerTicksLayer.value
    if (!tracks || !rulerTicks) return
    // Round scroll to keep 1 px waveform columns and ruler ticks crisp.
    const sx = Math.round(scrollX.value)
    const sy = Math.round(scrollY.value)
    tracks.x = -sx
    tracks.y = -sy
    rulerTicks.x = -sx
    // Playhead lives in viewport coordinates.
    playheadRenderer.updatePlayhead()
  }

  /** Width of the scrollable content area (excludes the pinned header column). */
  function viewportWidth(): number {
    const a = app.value
    if (!a) return 0
    return a.renderer.screen.width - SCROLLBAR_WIDTH - headerWidth()
  }

  /**
   * True when horizontal scroll has drifted far enough from the built band that
   * it must be rebuilt; false means an O(1) `applyScroll` translate still covers
   * the viewport. Keeps playback auto-follow and panning rebuild-free per frame.
   */
  function horizontalRebuildNeeded(): boolean {
    return exceedsRebuildThreshold(scrollX.value, lastBuiltScrollX, viewportWidth())
  }

  function redraw(): void {
    const redrawStart = performance.now()
    const a = app.value
    const ruler = rulerLayer.value
    const rulerTicks = rulerTicksLayer.value
    const tracks = tracksLayer.value
    const headers = headersLayer.value
    if (!a || !ruler || !rulerTicks || !tracks || !headers) return

    ruler.removeChildren()
    rulerTicks.removeChildren()
    tracks.removeChildren()
    headers.removeChildren()
    clipHitRegions.length = 0
    // Pooled clip graphics were just detached above; reset the pool so the next
    // frame reuses them instead of allocating fresh Graphics per clip.
    clipRenderer.beginFrame()

    // `screen.width` is Pixi's CSS-pixel drawing width, independent of DPR.
    const width = a.renderer.screen.width

    const rulerStart = performance.now()
    rulerRenderer.drawRulerChrome(width)
    rulerRenderer.drawTimelineSelection()
    rulerRenderer.drawRulerTicks(width)
    rulerRenderer.drawMarkers()
    const tracksStart = performance.now()
    const trackStats = tracksRenderer.drawTracks(width)
    const tracksEnd = performance.now()
    rulerRenderer.drawHeaderDivider()

    // Full redraws reset layer transforms, so reapply current scroll.
    tracks.x = -Math.round(scrollX.value)
    tracks.y = -Math.round(scrollY.value)
    rulerTicks.x = -Math.round(scrollX.value)
    lastBuiltScrollX = scrollX.value
    const waveStats = clipRenderer.getFrameStats()
    lastRedrawStats = {
      ...lastRedrawStats,
      rows: trackStats.rows,
      clips: trackStats.clips,
      durationMs: performance.now() - redrawStart,
      rulerMs: tracksStart - rulerStart,
      tracksMs: tracksEnd - tracksStart,
      columns: waveStats.columns,
      lanes: waveStats.lanes,
      graphics: waveStats.graphics,
      rects: waveStats.rects,
      meshes: waveStats.meshes
    }
    ++redrawCount
    if (redrawCount % 20 === 0 || lastRedrawStats.durationMs > 16) {
      log.debug(
        'perf.timeline',
        `redraw#${redrawCount} ms=${lastRedrawStats.durationMs.toFixed(2)} ` +
          `(ruler=${lastRedrawStats.rulerMs.toFixed(2)} tracks=${lastRedrawStats.tracksMs.toFixed(2)}) ` +
          `rows=${lastRedrawStats.rows} clips=${lastRedrawStats.clips} ` +
          `totalClips=${Object.keys(project.clips).length} ` +
          `waveCols=${lastRedrawStats.columns} rects=${lastRedrawStats.rects} lanes=${lastRedrawStats.lanes} ` +
          `meshes=${lastRedrawStats.meshes} gfx=${lastRedrawStats.graphics} pxPerSecond=${pxPerSecond.value.toFixed(2)}`
      )
    }
  }

  return {
    redraw,
    applyScroll,
    updatePlayhead: playheadRenderer.updatePlayhead,
    setDisplayPositionMs: playheadRenderer.setDisplayPositionMs,
    horizontalRebuildNeeded
  }
}
