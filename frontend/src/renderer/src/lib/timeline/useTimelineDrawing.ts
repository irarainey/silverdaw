// PixiJS scene drawing for the timeline canvas.
// Owns ruler/grid/rows/playhead/drop-preview painting; hit regions are host-owned.

import { type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { useProjectStore, TRACK_PALETTE } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { log } from '@/lib/log'
import {
  GRID_BAR,
  GRID_BEAT,
  GRID_SUB,
  MARKER,
  PLAYHEAD,
  RULER_BG,
  RULER_HEIGHT,
  RULER_LABEL_HINT,
  RULER_TICK,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH,
  SUBDIVISIONS_PER_BEAT,
  TIME_SIG_NUM,
  TRACK_BG,
  TRACK_GAP,
  TRACK_HEADER_BG
} from './constants'
import { trackHeightOf, buildTrackRowLayout } from './trackLayout'
import type { ClipHitRegion } from './useDragHandlers'
import type { DropPreview } from './useDropZone'
import type { GridGeometry } from './useGridGeometry'
import { createClipRenderer } from './clipRenderer'

export interface TimelineDrawingOptions {
  app: ShallowRef<Application | null>
  rulerLayer: ShallowRef<Container | null>
  rulerTicksLayer: ShallowRef<Container | null>
  tracksLayer: ShallowRef<Container | null>
  headersLayer: ShallowRef<Container | null>
  playheadLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
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
    geometry,
    clipHitRegions
  })

  // RAF interpolator writes here to smooth backend playhead ticks.
  let displayPositionMs = 0
  let redrawCount = 0
  let lastRedrawStats = { rows: 0, clips: 0, durationMs: 0 }
  // Auto-follow uses wall-clock deltas so scroll feel is refresh-rate independent.
  let lastUpdateMs = 0

  function setDisplayPositionMs(ms: number): void {
    displayPositionMs = ms
  }

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
    updatePlayhead()
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

    drawRulerChrome(width)
    drawRulerTicks(width)
    drawMarkers()
    drawTracks(width)
    drawHeaderDivider()

    // Full redraws reset layer transforms, so reapply current scroll.
    tracks.x = -Math.round(scrollX.value)
    tracks.y = -Math.round(scrollY.value)
    rulerTicks.x = -Math.round(scrollX.value)
    lastRedrawStats.durationMs = performance.now() - redrawStart
    ++redrawCount
    if (redrawCount % 20 === 0 || lastRedrawStats.durationMs > 16) {
      log.debug(
        'perf.timeline',
        `redraw#${redrawCount} ms=${lastRedrawStats.durationMs.toFixed(2)} rows=${lastRedrawStats.rows} ` +
          `clips=${lastRedrawStats.clips} totalClips=${Object.keys(project.clips).length} ` +
          `pxPerSecond=${pxPerSecond.value.toFixed(2)}`
      )
    }
  }

  function drawMarkers(): void {
    const rulerTicks = rulerTicksLayer.value
    const G = GraphicsCtor.value
    if (!rulerTicks || !G || project.markers.length === 0) return

    const markerW = 10
    const markerTop = 3
    const markerBottom = 15
    const markers = new G()
    for (const marker of project.markers) {
      const x = headerWidth() + (marker.positionMs / 1000) * pxPerSecond.value
      markers.poly([
        x - markerW / 2,
        markerTop,
        x + markerW / 2,
        markerTop,
        x,
        markerBottom
      ]).fill({ color: MARKER, alpha: 0.95 })
      markers
        .moveTo(x + 0.5, markerBottom)
        .lineTo(x + 0.5, RULER_HEIGHT - 1)
    }
    markers.stroke({ color: MARKER, width: 1, alpha: 0.8 })
    rulerTicks.addChild(markers)
  }

  /** Full-height header divider; playhead renders above it at t=0. */
  function drawHeaderDivider(): void {
    const a = app.value
    const headers = headersLayer.value
    const G = GraphicsCtor.value
    if (!a || !headers || !G) return
    const bottom = a.renderer.screen.height
    const divider = new G()
    divider
      .moveTo(headerWidth() - 0.5, 0)
      .lineTo(headerWidth() - 0.5, bottom)
      .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    headers.addChild(divider)
  }

  /** Ruler background and pinned header corner. */
  function drawRulerChrome(width: number): void {
    const ruler = rulerLayer.value
    const G = GraphicsCtor.value
    if (!ruler || !G) return

    const rightEdge = width - SCROLLBAR_WIDTH

    const bg = new G()
    bg.rect(0, 0, rightEdge, RULER_HEIGHT).fill(RULER_BG)
    bg.moveTo(0, RULER_HEIGHT - 0.5)
      .lineTo(rightEdge, RULER_HEIGHT - 0.5)
      .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    ruler.addChild(bg)

    // Pinned header corner above the track header column.
    const headerCorner = new G()
    headerCorner.rect(0, 0, headerWidth(), RULER_HEIGHT).fill(TRACK_HEADER_BG)
    ruler.addChild(headerCorner)
  }

  /** Bar/beat/sub ticks drawn in world coordinates for translate-only scroll. */
  function drawRulerTicks(width: number): void {
    const rulerTicks = rulerTicksLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!rulerTicks || !G) return

    if (project.tracks.length === 0) return

    const rightEdge = width - SCROLLBAR_WIDTH

    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    // Cover project duration plus one viewport margin for translate-only scroll.
    const viewWidth = rightEdge - headerWidth()
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const lastSub = Math.ceil((projectPx + viewWidth) / pxPerSub)

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = 0; s <= lastSub; s++) {
      const x = headerWidth() + s * pxPerSub + 0.5
      const isBar = s % subsPerBar === 0
      const isBeat = s % SUBDIVISIONS_PER_BEAT === 0
      const tickH = isBar ? 14 : isBeat ? 10 : 5
      const target = isBar ? barTicks : isBeat ? beatTicks : subTicks
      target.moveTo(x, RULER_HEIGHT - tickH).lineTo(x, RULER_HEIGHT - 1)
    }
    subTicks.stroke({ color: GRID_SUB, width: 1, alpha: 0.9 })
    beatTicks.stroke({ color: GRID_BEAT, width: 1, alpha: 0.95 })
    barTicks.stroke({ color: GRID_BAR, width: 1, alpha: 1.0 })
    rulerTicks.addChild(subTicks)
    rulerTicks.addChild(beatTicks)
    rulerTicks.addChild(barTicks)

    // Bar labels: offset 0 (default) labels the first bar "1"; -1 labels it "0".
    if (T) {
      const barCounterStart = project.barCounterStart
      for (let s = 0; s <= lastSub; s += subsPerBar) {
        const x = headerWidth() + s * pxPerSub + 0.5
        const barNumber = s / subsPerBar + 1 + barCounterStart
        const label = new T({
          text: String(barNumber),
          style: {
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 10,
            fill: RULER_LABEL_HINT
          }
        })
        label.x = Math.round(x - label.width / 2)
        label.y = 0
        rulerTicks.addChild(label)
      }
    }
  }

  /** Full-height grid lines in world coordinates for translate-only scroll. */
  function drawGrid(width: number): void {
    const tracks = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracks || !G) return

    if (project.tracks.length === 0) return

    const rightEdge = width - SCROLLBAR_WIDTH
    const gridLeft = headerWidth()
    const gridTop = RULER_HEIGHT
    const gridBottom = RULER_HEIGHT + trackAreaHeight.value
    if (gridBottom <= gridTop || rightEdge <= gridLeft) return

    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const viewWidth = rightEdge - gridLeft
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const lastSub = Math.ceil((projectPx + viewWidth) / pxPerSub)

    const subLines = new G()
    const beatLines = new G()
    const barLines = new G()

    for (let s = 0; s <= lastSub; s++) {
      const x = gridLeft + s * pxPerSub + 0.5
      const isBar = s % subsPerBar === 0
      const isBeat = s % SUBDIVISIONS_PER_BEAT === 0
      const target = isBar ? barLines : isBeat ? beatLines : subLines
      target.moveTo(x, gridTop).lineTo(x, gridBottom)
    }
    subLines.stroke({ color: GRID_SUB, width: 1, alpha: 0.5 })
    beatLines.stroke({ color: GRID_BEAT, width: 1, alpha: 0.7 })
    barLines.stroke({ color: GRID_BAR, width: 1, alpha: 0.95 })

    tracks.addChild(subLines)
    tracks.addChild(beatLines)
    tracks.addChild(barLines)
  }

  function drawTracks(width: number): void {
    const a = app.value
    const tracksL = tracksLayer.value
    const headers = headersLayer.value
    const G = GraphicsCtor.value
    if (!a || !tracksL || !headers || !G) return

    const rightEdge = width - SCROLLBAR_WIDTH
    const visibleBottom = RULER_HEIGHT + trackAreaHeight.value

    // Pinned header-column bg sits under per-track headers.
    const headerColumnBg = new G()
    headerColumnBg
      .rect(0, RULER_HEIGHT, headerWidth(), a.renderer.screen.height - RULER_HEIGHT)
      .fill(TRACK_HEADER_BG)
    headers.addChildAt(headerColumnBg, 0)

    // Pass 1: visible row backgrounds and pinned per-track headers.
    const tracks = project.tracks
    const viewWidth = rightEdge - headerWidth()
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const worldRowRight = headerWidth() + projectPx + viewWidth
    const worldLeft = 0
    const worldRight = worldRowRight
    const rowLayout = buildTrackRowLayout(tracks)
    const visibleRows: {
      track: (typeof tracks)[number]
      worldY: number
      rowHeight: number
    }[] = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (!track) continue
      const slot = rowLayout[i]
      if (!slot) continue
      const worldY = slot.top
      const rowHeight = slot.height
      const viewportY = worldY - scrollY.value

      if (viewportY + rowHeight <= RULER_HEIGHT) continue
      if (viewportY >= visibleBottom) break

      // Header-column bg masks the row's left edge.
      const rowBg = new G()
      rowBg.rect(0, worldY, worldRowRight, rowHeight).fill(TRACK_BG)
      tracksL.addChild(rowBg)

      // Selected-track highlight sits above row bg but below grid and clips.
      if (project.selectedTrackId === track.id) {
        const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
        const highlight = new G()
        highlight
          .rect(1, worldY + 1, worldRowRight - 2, rowHeight - 2)
          .stroke({ color: palette.border, width: 2, alpha: 0.9 })
        tracksL.addChild(highlight)
      }

      // Per-track header stays pinned in viewport coordinates.
      const header = new G()
      header.rect(0, viewportY, headerWidth(), rowHeight).fill(TRACK_HEADER_BG)
      header
        .moveTo(headerWidth() - 0.5, viewportY)
        .lineTo(headerWidth() - 0.5, viewportY + rowHeight)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
      headers.addChild(header)

      visibleRows.push({ track, worldY, rowHeight })
    }

    drawGrid(width)

    let visibleClipCount = 0
    for (const { track, worldY, rowHeight } of visibleRows) {
      const trackPalette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
      for (const clipId of track.clipIds) {
        const clip = project.clips[clipId]
        if (!clip) continue
        const palette =
          typeof clip.colorIndex === 'number'
            ? TRACK_PALETTE[clip.colorIndex % TRACK_PALETTE.length]!
            : trackPalette
        clipRenderer.drawClip(clip, worldY, rowHeight, palette, worldLeft, worldRight, track.pan ?? 0)
        ++visibleClipCount
      }
      // Overlap hatch sits above the clip blocks; crossfade curves above that.
      clipRenderer.drawClipOverlaps(track, worldY, rowHeight, worldLeft, worldRight)
      // Crossfade overlays sit above both partner clips.
      clipRenderer.drawTrackTransitions(track, worldY, rowHeight, worldLeft, worldRight)
    }
    lastRedrawStats = { ...lastRedrawStats, rows: visibleRows.length, clips: visibleClipCount }
  }

  // Cached playhead Graphics: rebuild only when height changes.

  let playheadGfx: Graphics | null = null
  let playheadDrawnHeight = -1
  // Identity of the playhead layer the caches were built against. A GPU reset
  // (TDR) rebuilds the Pixi app with new layers and destroys the old playhead /
  // drop-preview Graphics; drop the stale references when the layer is swapped so
  // they are re-created instead of reused dead (blank playhead / flicker).
  let playheadCacheLayer: Container | null = null

  function syncPlayheadCacheLayer(): void {
    if (playheadLayer.value !== playheadCacheLayer) {
      playheadGfx = null
      playheadDrawnHeight = -1
      dropPreviewGfx = null
      playheadCacheLayer = playheadLayer.value
    }
  }

  function ensurePlayheadGfx(bottomY: number): Graphics | null {
    const G = GraphicsCtor.value
    const playhead = playheadLayer.value
    if (!G || !playhead) return null
    if (playheadGfx && playheadDrawnHeight === bottomY) return playheadGfx
    // Rebuild when height changes.
    if (playheadGfx) {
      playhead.removeChild(playheadGfx)
      playheadGfx.destroy()
    }
    const g = new G()
    g.moveTo(0.5, 0)
      .lineTo(0.5, bottomY)
      .stroke({ color: PLAYHEAD, width: 1, alpha: 0.9 })
    const headW = 8
    g.poly([-headW / 2, 0, headW / 2, 0, 0, headW]).fill({ color: PLAYHEAD, alpha: 0.95 })
    g.poly([-headW / 2, bottomY, headW / 2, bottomY, 0, bottomY - headW]).fill({
      color: PLAYHEAD,
      alpha: 0.95
    })
    playhead.addChildAt(g, 0)
    playheadGfx = g
    playheadDrawnHeight = bottomY
    return g
  }

  /** Update cached playhead x and run O(1) auto-follow scroll. */
  function updatePlayhead(): void {
    const a = app.value
    const playhead = playheadLayer.value
    if (!a || !playhead) return
    syncPlayheadCacheLayer()

    const width = a.renderer.screen.width - SCROLLBAR_WIDTH
    const posMs = displayPositionMs || transport.positionMs
    const absX = headerWidth() + (posMs / 1000) * pxPerSecond.value

    // Auto-follow eases forward only; never teleport scroll backwards.
    const shouldFollow =
      (transport.isPlaying && ui.followPlayback) || isDraggingPlayhead.value
    const now = performance.now()
    const dtSec = lastUpdateMs === 0 ? 0 : Math.min(0.1, (now - lastUpdateMs) / 1000)
    lastUpdateMs = now
    if (shouldFollow) {
      const viewportCentre = headerWidth() + (width - headerWidth()) / 2
      const desired = Math.max(0, absX - viewportCentre)
      let nextScroll: number | null = null
      if (desired > scrollX.value) {
        const gap = desired - scrollX.value
        if (gap > 0.5) {
          // Mix playback-relative and gap-proportional catch-up; cap prevents overshoot.
          const audioPxPerSec = pxPerSecond.value
          const approachPxPerSec = audioPxPerSec * 3
          const proportionalPxPerSec = gap * 5
          const ratePxPerSec = Math.max(approachPxPerSec, proportionalPxPerSec)
          const step = Math.min(gap, ratePxPerSec * dtSec)
          if (step > 0) nextScroll = scrollX.value + step
        }
      }

      if (nextScroll !== null) {
        scrollX.value = nextScroll
        clampScroll()
        const tracks = tracksLayer.value
        const rulerTicks = rulerTicksLayer.value
        if (tracks) {
          tracks.x = -Math.round(scrollX.value)
          tracks.y = -Math.round(scrollY.value)
        }
        if (rulerTicks) rulerTicks.x = -Math.round(scrollX.value)
      }
    }

    // Rebuild the rare drop-preview ghost on demand.
    if (dropPreview.value) {
      removeDropPreviewGfx()
      drawDropPreview()
    } else {
      removeDropPreviewGfx()
    }

    if (project.tracks.length === 0) {
      if (playheadGfx) playheadGfx.visible = false
      return
    }

    const viewportX = absX - scrollX.value
    const onScreen = viewportX >= headerWidth() && viewportX <= width

    if (!onScreen) {
      if (playheadGfx) playheadGfx.visible = false
      return
    }

    const tracksHeight = tracksContentHeight.value
    const bottomY = Math.min(
      RULER_HEIGHT + trackAreaHeight.value,
      RULER_HEIGHT + tracksHeight - scrollY.value
    )
    const g = ensurePlayheadGfx(bottomY)
    if (!g) return
    g.visible = true
    g.x = viewportX
  }

  // Drop preview ghost is separate so the cached playhead stays intact.
  let dropPreviewGfx: Graphics | null = null
  function removeDropPreviewGfx(): void {
    const playhead = playheadLayer.value
    if (!playhead || !dropPreviewGfx) return
    playhead.removeChild(dropPreviewGfx)
    dropPreviewGfx.destroy()
    dropPreviewGfx = null
  }

  /** Render the viewport-space ghost for the timeline-unit drop preview. */
  function drawDropPreview(): void {
    const a = app.value
    const playhead = playheadLayer.value
    const G = GraphicsCtor.value
    const dp = dropPreview.value
    if (!a || !playhead || !G || !dp) return
    syncPlayheadCacheLayer()

    if (dp.trackIndex < 0 || dp.trackIndex >= project.tracks.length) return

    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    const targetTrack = project.tracks[dp.trackIndex]
    const rowH = trackHeightOf(targetTrack)
    let worldTop = RULER_HEIGHT
    for (let i = 0; i < dp.trackIndex; i++) {
      worldTop += trackHeightOf(project.tracks[i]) + TRACK_GAP
    }
    const yTop = worldTop - scrollY.value
    if (yTop + rowH <= RULER_HEIGHT) return
    if (yTop >= a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)) return

    const absLeft = headerWidth() + (dp.startMs / 1000) * pxPerSecond.value
    const width = Math.max(2, (dp.durationMs / 1000) * pxPerSecond.value)
    const xLeft = absLeft - scrollX.value
    const xRight = xLeft + width
    if (xRight <= headerWidth() || xLeft >= rightEdge) return

    // Clip to the header and scrollbar lanes.
    const clippedLeft = Math.max(headerWidth(), xLeft)
    const clippedRight = Math.min(rightEdge, xRight)
    const w = clippedRight - clippedLeft
    if (w <= 0) return

    const bottomLimit = Math.min(
      a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0),
      RULER_HEIGHT + trackAreaHeight.value
    )
    const clippedTop = Math.max(RULER_HEIGHT, yTop)
    const clippedBottom = Math.min(bottomLimit, yTop + rowH)
    const h = clippedBottom - clippedTop
    if (h <= 0) return

    const colour = dp.valid ? 0x22c55e : 0xef4444 // green-500 / red-500

    const g = new G()
    g.rect(clippedLeft, clippedTop, w, h).fill({ color: colour, alpha: 0.18 })
    g.rect(clippedLeft + 0.5, clippedTop + 0.5, w - 1, h - 1).stroke({
      color: colour,
      width: 1.5,
      alpha: 0.9
    })
    playhead.addChild(g)
    dropPreviewGfx = g
  }

  return { redraw, applyScroll, updatePlayhead, setDisplayPositionMs }
}
