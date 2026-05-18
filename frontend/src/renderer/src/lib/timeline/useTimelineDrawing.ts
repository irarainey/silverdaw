// PixiJS scene drawing for the timeline canvas.
//
// Owns every "paint pixels onto the scene-graph" routine: ruler ticks,
// bar/beat/sub gridlines, track rows + headers, clip blocks + waveforms,
// playhead, and the drag-drop preview ghost. Extracted from
// `TimelineView.vue` so the component stays focused on wiring
// (composables, watches, template) and the drawing code can be reasoned
// about in isolation.
//
// Threading model: every function runs synchronously on the renderer
// thread driven by Vue watchers and Pixi resize callbacks. The composable
// holds no internal state besides the `clipHitRegions` array passed in by
// the host (populated by `drawClip`, consumed by `useDragHandlers` for
// hit-testing).

import { type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { useProjectStore, type Clip, TRACK_PALETTE } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import {
  GRID_BAR,
  GRID_BEAT,
  GRID_SUB,
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
  TRACK_HEADER_BG,
  TRACK_HEIGHT
} from './constants'
import type { ClipHitRegion } from './useDragHandlers'
import type { DropPreview } from './useDropZone'
import type { GridGeometry } from './useGridGeometry'

export interface TimelineDrawingOptions {
  // ─── Pixi handles (from `usePixiApp`) ─────────────────────────────────
  app: ShallowRef<Application | null>
  rulerLayer: ShallowRef<Container | null>
  tracksLayer: ShallowRef<Container | null>
  headersLayer: ShallowRef<Container | null>
  playheadLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  // ─── Geometry + scroll state ──────────────────────────────────────────
  geometry: GridGeometry
  scrollX: Ref<number>
  scrollY: Ref<number>
  showScrollbar: ComputedRef<boolean>
  maxScrollX: ComputedRef<number>
  trackAreaHeight: ComputedRef<number>
  tracksContentHeight: ComputedRef<number>
  /** Clamps `scrollX/Y` to valid range; returns true iff anything moved. */
  clampScroll: () => boolean
  // ─── Wiring with other composables ────────────────────────────────────
  /**
   * Output: `drawClip` pushes a hit-test rectangle per visible clip.
   * Consumed by `useDragHandlers` via its own getter. Owned by the host
   * so both composables share the same underlying array.
   */
  clipHitRegions: ClipHitRegion[]
  /** From `useDragHandlers` — true while the user is dragging the playhead. */
  isDraggingPlayhead: Ref<boolean>
  /** From `useDropZone` — current drag-hover landing rectangle (or null). */
  dropPreview: Ref<DropPreview | null>
}

export interface TimelineDrawing {
  /** Full repaint: ruler + tracks + clips + header divider. */
  redraw: () => void
  /** Repaint just the playhead layer (and the drop-preview ghost). */
  updatePlayhead: () => void
}

export function useTimelineDrawing(opts: TimelineDrawingOptions): TimelineDrawing {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const {
    app,
    rulerLayer,
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

  function redraw(): void {
    const a = app.value
    const ruler = rulerLayer.value
    const tracks = tracksLayer.value
    const headers = headersLayer.value
    if (!a || !ruler || !tracks || !headers) return

    ruler.removeChildren()
    tracks.removeChildren()
    headers.removeChildren()
    clipHitRegions.length = 0

    // `screen.width` is the renderer's logical (CSS-pixel) drawing-space
    // width — i.e. the width we should draw to in stage coordinates so
    // that content reaches the right edge of the canvas regardless of
    // devicePixelRatio.
    const width = a.renderer.screen.width

    drawRuler(width)
    drawTracks(width)
    drawHeaderDivider()
  }

  /**
   * Vertical divider line down the right edge of the track-header column.
   * Drawn on the headers layer so the playhead layer renders ABOVE it —
   * the playhead and its triangle sit on top of the divider when the
   * transport is at t=0. We draw it as a single full-height line rather
   * than the per-row stub drawn inside `drawTracks` so the divider is
   * continuous over the ruler row and the empty area below the last track.
   */
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

  function drawRuler(width: number): void {
    const ruler = rulerLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!ruler || !G) return

    // Ruler stops short of the vertical scrollbar lane on the right.
    const rightEdge = width - SCROLLBAR_WIDTH

    const bg = new G()
    bg.rect(0, 0, rightEdge, RULER_HEIGHT).fill(RULER_BG)
    bg.moveTo(0, RULER_HEIGHT - 0.5)
      .lineTo(rightEdge, RULER_HEIGHT - 0.5)
      .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    ruler.addChild(bg)

    // Iterate quarter-beat (sub) indices in content-space, drawing into
    // one of three Graphics buckets by tier so each tier can have its
    // own stroke style applied in a single call.
    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const firstSub = Math.max(0, Math.floor(scrollX.value / pxPerSub))
    const lastSub = Math.ceil((scrollX.value + (rightEdge - headerWidth())) / pxPerSub)

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = firstSub; s <= lastSub; s++) {
      const x = headerWidth() + s * pxPerSub - scrollX.value + 0.5
      if (x < headerWidth() || x > rightEdge) continue
      const isBar = s % subsPerBar === 0
      const isBeat = s % SUBDIVISIONS_PER_BEAT === 0
      const tickH = isBar ? 14 : isBeat ? 10 : 5
      const target = isBar ? barTicks : isBeat ? beatTicks : subTicks
      target.moveTo(x, RULER_HEIGHT - tickH).lineTo(x, RULER_HEIGHT - 1)
    }
    subTicks.stroke({ color: GRID_SUB, width: 1, alpha: 0.9 })
    beatTicks.stroke({ color: GRID_BEAT, width: 1, alpha: 0.95 })
    barTicks.stroke({ color: GRID_BAR, width: 1, alpha: 1.0 })
    ruler.addChild(subTicks)
    ruler.addChild(beatTicks)
    ruler.addChild(barTicks)

    // Bar-number labels centred above each bar line. Bars are 0-indexed,
    // so the first bar line (t=0) is labelled "0" and each subsequent
    // bar line increments by one — matching the Bar.Beat.Sub display in
    // the transport bar.
    if (T) {
      const startSub = Math.ceil(firstSub / subsPerBar) * subsPerBar
      for (let s = startSub; s <= lastSub; s += subsPerBar) {
        const x = headerWidth() + s * pxPerSub - scrollX.value + 0.5
        if (x < headerWidth() || x > rightEdge) continue
        const barNumber = s / subsPerBar
        const label = new T({
          text: String(barNumber),
          style: {
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 10,
            fill: RULER_LABEL_HINT
          }
        })
        // Centre the digits horizontally on the bar line.
        label.x = Math.round(x - label.width / 2)
        label.y = 0
        ruler.addChild(label)
      }
    }

    // Header column background sits in the ruler row too.
    const headerCorner = new G()
    headerCorner.rect(0, 0, headerWidth(), RULER_HEIGHT).fill(TRACK_HEADER_BG)
    ruler.addChild(headerCorner)
  }

  /**
   * Full-height vertical grid lines spanning the track area. Same musical
   * subdivisions as `drawRuler` (bar / beat / sub-beat) so the ruler
   * ticks and the grid stay visually aligned, allowing items to be placed
   * at quarter-beat resolution later. Drawn on `tracksLayer` between the
   * row backgrounds and the clip blocks so clips obscure the grid where
   * they sit on top of it.
   */
  function drawGrid(width: number): void {
    const tracks = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracks || !G) return

    // Don't draw a grid on an empty timeline — it just adds visual noise
    // to the empty-state. The grid reappears when the first track is added.
    if (project.tracks.length === 0) return

    const rightEdge = width - SCROLLBAR_WIDTH
    const gridLeft = headerWidth()
    const gridTop = RULER_HEIGHT
    const gridBottom = RULER_HEIGHT + trackAreaHeight.value
    if (gridBottom <= gridTop || rightEdge <= gridLeft) return

    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const firstSub = Math.max(0, Math.floor(scrollX.value / pxPerSub))
    const lastSub = Math.ceil((scrollX.value + (rightEdge - gridLeft)) / pxPerSub)

    const subLines = new G()
    const beatLines = new G()
    const barLines = new G()

    for (let s = firstSub; s <= lastSub; s++) {
      const x = gridLeft + s * pxPerSub - scrollX.value + 0.5
      if (x < gridLeft || x > rightEdge) continue
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

    // Track rows live in the area between the ruler and the horizontal
    // scrollbar lane and to the left of the vertical scrollbar lane.
    const rightEdge = width - SCROLLBAR_WIDTH
    const visibleBottom = RULER_HEIGHT + trackAreaHeight.value

    // Full-height track-header column fill: ensures the left strip reads
    // as a continuous `zinc-900` panel (matching the TransportBar) even
    // when there are no tracks or the track list doesn't fill the
    // viewport. The per-row header rectangles drawn below sit on top of
    // this, so the colour is identical either way.
    const headerColumnBg = new G()
    headerColumnBg
      .rect(0, RULER_HEIGHT, headerWidth(), a.renderer.screen.height - RULER_HEIGHT)
      .fill(TRACK_HEADER_BG)
    tracksL.addChild(headerColumnBg)

    // Pass 1: row backgrounds + headers. Collect visible rows so we can
    // do a second pass for clips AFTER the grid is drawn, ensuring clip
    // blocks visually sit on top of the grid lines.
    const tracks = project.tracks
    const visibleRows: { track: (typeof tracks)[number]; y: number }[] = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (!track) continue
      const y = RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value

      // Cull rows that are entirely outside the visible track area.
      if (y + TRACK_HEIGHT <= RULER_HEIGHT) continue
      if (y >= visibleBottom) break

      // Row background (clipped to the track area on the right so it
      // doesn't bleed under the vertical scrollbar lane).
      const rowBg = new G()
      rowBg.rect(0, y, rightEdge, TRACK_HEIGHT).fill(TRACK_BG)
      tracksL.addChild(rowBg)

      // Track header.
      const header = new G()
      header.rect(0, y, headerWidth(), TRACK_HEIGHT).fill(TRACK_HEADER_BG)
      header
        .moveTo(headerWidth() - 0.5, y)
        .lineTo(headerWidth() - 0.5, y + TRACK_HEIGHT)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
      headers.addChild(header)

      visibleRows.push({ track, y })
    }

    // Grid lines: drawn after row backgrounds and across the full visible
    // track area (even past the last row) so the time grid always fills
    // the canvas vertically. Must come BEFORE clip drawing below so clips
    // overlay the grid.
    drawGrid(width)

    // Pass 2: clips.
    for (const { track, y } of visibleRows) {
      // Modular index is always in-bounds; the non-null assertion is for
      // noUncheckedIndexedAccess.
      const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
      for (const clipId of track.clipIds) {
        const clip = project.clips[clipId]
        if (!clip) continue
        drawClip(clip, y, palette)
      }
    }
  }

  function drawClip(clip: Clip, rowY: number, palette: (typeof TRACK_PALETTE)[number]): void {
    const a = app.value
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!a || !tracksL || !G) return

    const viewportWidthPx = a.renderer.screen.width - SCROLLBAR_WIDTH
    const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
    const w = (clip.durationMs / 1000) * pxPerSecond.value
    const x = absX - scrollX.value

    // Cull entirely off-screen clips so we don't waste CPU on their waveform.
    if (x + w < headerWidth() || x > viewportWidthPx) return

    const padding = 4
    const innerY = rowY + padding
    const innerH = TRACK_HEIGHT - padding * 2
    const midY = innerY + innerH / 2

    // Clip block + border (palette-coloured).
    const block = new G()
    block
      .roundRect(x, innerY, w, innerH, 4)
      .fill({ color: palette.fill, alpha: 0.85 })
      .stroke({ color: palette.border, width: 1, alpha: 0.9 })
    tracksL.addChild(block)

    // Record the viewport-space rectangle so pointer-down can hit-test
    // for drag-to-move. The visible region (after culling) is enough.
    clipHitRegions.push({ clipId: clip.id, x, y: innerY, w, h: innerH })

    // Waveform. Only iterate the visible pixel range so very long clips
    // don't tank the framerate when zooming or scrolling.
    const wave = new G()
    const peaks = clip.peaks
    const peakCount = peaks.length / 2
    const samplesPerPixel = Math.max(1, peakCount / w)
    const half = innerH / 2 - 2

    const pxStart = Math.max(0, Math.floor(headerWidth() - x))
    const pxEnd = Math.min(w, Math.ceil(viewportWidthPx - x))

    for (let px = pxStart; px < pxEnd; px++) {
      const startIdx = Math.floor(px * samplesPerPixel)
      const endIdx = Math.min(peakCount, Math.floor((px + 1) * samplesPerPixel))
      if (startIdx >= peakCount) break

      let min = 0
      let max = 0
      for (let i = startIdx; i < endIdx; i++) {
        // Peaks are written in [min, max] pairs by computePeaks(); the
        // bounds check above guarantees both indices are in range.
        const lo = peaks[i * 2]!
        const hi = peaks[i * 2 + 1]!
        if (lo < min) min = lo
        if (hi > max) max = hi
      }

      // Skip silent columns (single-pixel-wide minimum to keep continuity).
      const yTop = midY + max * -half
      const yBot = midY + min * -half
      wave.moveTo(x + px + 0.5, yTop).lineTo(x + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
    }
    wave.stroke({ color: palette.wave, width: 1, alpha: 0.95 })
    tracksL.addChild(wave)

    // Filename header strip in the top-left of the clip. Sized to fit
    // the filename but capped by the clip width, and skipped entirely
    // if the clip is too narrow to be useful. Drawn last so it overlays
    // the waveform near the top edge.
    drawClipHeader(clip, x, innerY, w, palette)
  }

  /**
   * Draw the clip's filename in a coloured strip pinned to its top-left
   * corner. The strip's width is the lesser of the clip's full width and
   * whatever fits the filename plus padding, so short filenames don't
   * span unnecessarily wide. The label is truncated with an ellipsis if
   * even that doesn't fit. Character-width is approximated rather than
   * measured to keep per-clip cost flat.
   */
  function drawClipHeader(
    clip: Clip,
    clipX: number,
    clipInnerY: number,
    clipW: number,
    palette: (typeof TRACK_PALETTE)[number]
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!tracksL || !G || !T) return

    const HEADER_H = 14
    const PAD_X = 4
    const FONT_SIZE = 10
    const APPROX_CHAR_W = 5.5

    // A clip narrower than this can't usefully show even an ellipsis.
    if (clipW < 20) return

    const maxChars = Math.max(1, Math.floor((clipW - PAD_X * 2) / APPROX_CHAR_W))
    const text =
      clip.fileName.length > maxChars
        ? clip.fileName.slice(0, Math.max(1, maxChars - 1)) + '…'
        : clip.fileName

    // Header background: same colour as the clip border so it blends
    // with the outline. Width caps at the clip's own width.
    const desiredW = Math.min(clipW, text.length * APPROX_CHAR_W + PAD_X * 2)
    const headerBg = new G()
    headerBg
      .rect(clipX, clipInnerY, desiredW, HEADER_H)
      .fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    const label = new T({
      text,
      style: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: FONT_SIZE,
        fill: 0x09090b // zinc-950, high contrast against the bright header
      }
    })
    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    tracksL.addChild(label)
  }

  /**
   * Draw / move the playhead. Cheap to call every frame because we just
   * recreate one Graphics on the dedicated layer rather than rebuilding
   * the whole scene. Position is read from `transport.positionMs`
   * (mirrored from the backend's PLAYHEAD_UPDATE messages at 60 Hz).
   *
   * Also runs the auto-scroll logic: while playing, once the playhead
   * reaches the horizontal centre of the visible timeline, the content
   * scrolls so the playhead stays pinned at the centre.
   */
  function updatePlayhead(): void {
    const a = app.value
    const playhead = playheadLayer.value
    const G = GraphicsCtor.value
    if (!a || !playhead || !G) return

    const width = a.renderer.screen.width - SCROLLBAR_WIDTH
    const absX = headerWidth() + (transport.positionMs / 1000) * pxPerSecond.value

    // Auto-follow during playback OR while the user is dragging the
    // playhead: once the head crosses the viewport midpoint, scroll the
    // content so it stays pinned at the centre. `clampScroll()` will cap
    // `scrollX` at the end of the timeline content, so once the scroll
    // has reached the end the head naturally continues toward the right
    // edge. Playback follow is gated on the user's `followPlayback`
    // preference; playhead drag always follows because the user is
    // actively positioning.
    const shouldFollow =
      (transport.isPlaying && ui.followPlayback) || isDraggingPlayhead.value
    if (shouldFollow) {
      const viewportCentre = headerWidth() + (width - headerWidth()) / 2
      const desired = Math.max(0, absX - viewportCentre)
      if (Math.abs(desired - scrollX.value) > 0.5) {
        scrollX.value = desired
        clampScroll()
        redraw()
      }
    }

    playhead.removeChildren()

    const trackN = project.tracks.length
    if (trackN === 0) {
      // No tracks → nothing to draw, including no drop ghost.
      return
    }

    const x = absX - scrollX.value
    const playheadOnScreen = x >= headerWidth() && x <= width

    if (playheadOnScreen) {
      // Line spans the ruler + exactly the visible track rows, clipped
      // to the bottom of the visible track area so it never crosses
      // into the horizontal-scrollbar lane.
      const tracksHeight = tracksContentHeight.value
      const bottomY = Math.min(
        RULER_HEIGHT + trackAreaHeight.value,
        RULER_HEIGHT + tracksHeight - scrollY.value
      )

      const g = new G()

      // Vertical line.
      g.moveTo(x + 0.5, 0)
        .lineTo(x + 0.5, bottomY)
        .stroke({ color: PLAYHEAD, width: 1, alpha: 0.9 })

      // Small triangular heads at each end so the playhead is easy to
      // spot. Top: points down into the ruler. Bottom: points up from
      // the end of the visible track area (or the project end if it's
      // higher up).
      const headW = 8
      g.poly([x - headW / 2, 0, x + headW / 2, 0, x, headW]).fill({
        color: PLAYHEAD,
        alpha: 0.95
      })
      g.poly([x - headW / 2, bottomY, x + headW / 2, bottomY, x, bottomY - headW]).fill({
        color: PLAYHEAD,
        alpha: 0.95
      })

      playhead.addChild(g)
    }

    // Drop-preview ghost — drawn on top of the playhead regardless of
    // whether the playhead itself is currently visible. Shown while a
    // library item is being dragged over a valid track row; green for
    // "OK to drop", red for "would overlap".
    if (dropPreview.value) drawDropPreview()
  }

  /**
   * Render the translucent rectangle showing where a dragged library
   * item would land. Coordinates are in viewport space; `dropPreview`
   * itself is in timeline units (track index + ms) so the ghost stays
   * correct as the user scrolls / zooms.
   */
  function drawDropPreview(): void {
    const a = app.value
    const playhead = playheadLayer.value
    const G = GraphicsCtor.value
    const dp = dropPreview.value
    if (!a || !playhead || !G || !dp) return

    if (dp.trackIndex < 0 || dp.trackIndex >= project.tracks.length) return

    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    const yTop = RULER_HEIGHT + dp.trackIndex * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value
    // Off-screen vertically — skip.
    if (yTop + TRACK_HEIGHT <= RULER_HEIGHT) return
    if (yTop >= a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)) return

    const absLeft = headerWidth() + (dp.startMs / 1000) * pxPerSecond.value
    const width = Math.max(2, (dp.durationMs / 1000) * pxPerSecond.value)
    const xLeft = absLeft - scrollX.value
    const xRight = xLeft + width
    if (xRight <= headerWidth() || xLeft >= rightEdge) return

    // Clip horizontally so the ghost never spills over the header column
    // or the right scrollbar lane.
    const clippedLeft = Math.max(headerWidth(), xLeft)
    const clippedRight = Math.min(rightEdge, xRight)
    const w = clippedRight - clippedLeft
    if (w <= 0) return

    // Clip vertically against the bottom-of-tracks-area as well.
    const bottomLimit = Math.min(
      a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0),
      RULER_HEIGHT + trackAreaHeight.value
    )
    const clippedTop = Math.max(RULER_HEIGHT, yTop)
    const clippedBottom = Math.min(bottomLimit, yTop + TRACK_HEIGHT)
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
  }

  return { redraw, updatePlayhead }
}
