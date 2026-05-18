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
  rulerTicksLayer: ShallowRef<Container | null>
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
  /**
   * Full repaint of all content. Call when project content, zoom, BPM,
   * or viewport size changes. NOT called per playback frame — scroll is
   * handled by `applyScroll` which is O(1).
   */
  redraw: () => void
  /**
   * O(1) layer-translation update. Call whenever `scrollX` or `scrollY`
   * changes; no Pixi nodes are rebuilt. The world content (clips, grid,
   * row backgrounds, ruler ticks) is drawn in absolute world coordinates
   * and the relevant Containers are translated by `-scrollX` / `-scrollY`.
   */
  applyScroll: () => void
  /**
   * Update the playhead position (cached Graphics, just sets `.x`) and
   * — if needed — auto-scroll to keep the playhead visible. Cheap: no
   * Graphics allocation, no clip iteration.
   */
  updatePlayhead: () => void
  /**
   * Position used by `updatePlayhead` for visual drawing. Defaults to
   * `transport.positionMs` but can be overridden by the RAF interpolation
   * loop in TimelineView.vue to give sub-frame smoothness between the
   * backend's 60 Hz updates.
   */
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

  // Visual playhead position. The renderer-side RAF interpolator writes
  // here during playback so the visible line is smooth even if backend
  // PLAYHEAD_UPDATE ticks are jittery. Falls back to `transport.positionMs`
  // when nobody else has written.
  let displayPositionMs = 0
  // Wall-clock timestamp of the previous `updatePlayhead` call. Used by
  // the auto-follow catch-up logic to step the scroll by a time-based
  // amount (so the feel is identical at 60 Hz / 120 Hz / variable
  // refresh rates and during dropped frames).
  let lastUpdateMs = 0

  function setDisplayPositionMs(ms: number): void {
    displayPositionMs = ms
  }

  /**
   * Re-translate the world layers to reflect the current scrollX/Y.
   * Cheap: just three `.x`/`.y` writes plus a playhead position update.
   * Called from the host on every scrollbar drag / auto-follow tick.
   */
  function applyScroll(): void {
    const tracks = tracksLayer.value
    const rulerTicks = rulerTicksLayer.value
    if (!tracks || !rulerTicks) return
    // Round to integer pixels so per-pixel sub-pixel sampling doesn't
    // make the ruler ticks shimmer. `tracksLayer` carries both row bgs
    // (which look fine at fractional offsets) and the clip waveforms
    // (which DON'T because each pixel column is a 1 px line); rounding
    // keeps them crisp during auto-follow.
    const sx = Math.round(scrollX.value)
    const sy = Math.round(scrollY.value)
    tracks.x = -sx
    tracks.y = -sy
    rulerTicks.x = -sx
    // Playhead lives in viewport coords; recompute its x because scroll
    // changed.
    updatePlayhead()
  }

  function redraw(): void {
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

    // `screen.width` is the renderer's logical (CSS-pixel) drawing-space
    // width — i.e. the width we should draw to in stage coordinates so
    // that content reaches the right edge of the canvas regardless of
    // devicePixelRatio.
    const width = a.renderer.screen.width

    drawRulerChrome(width)
    drawRulerTicks(width)
    drawTracks(width)
    drawHeaderDivider()

    // After a full redraw the world layers may need to be re-translated
    // — particularly on initial mount where `applyScroll` hadn't yet
    // been called by anyone.
    tracks.x = -Math.round(scrollX.value)
    tracks.y = -Math.round(scrollY.value)
    rulerTicks.x = -Math.round(scrollX.value)
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

  /**
   * Ruler background + header corner. Lives on the non-translated
   * `rulerLayer` so it stays pinned regardless of scroll.
   */
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

    // Header column corner — pinned, sits in the ruler row above the
    // track header column. Drawn on the static `rulerLayer` so it
    // stays put when the user scrolls horizontally.
    const headerCorner = new G()
    headerCorner.rect(0, 0, headerWidth(), RULER_HEIGHT).fill(TRACK_HEADER_BG)
    ruler.addChild(headerCorner)
  }

  /**
   * Bar/beat/sub tick lines + bar-number labels. Drawn in WORLD
   * coordinates on `rulerTicksLayer`, which is translated by
   * `-scrollX` so the ticks pan with the timeline content for free.
   */
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

    // Generate ticks for the full visible-at-current-scroll range plus
    // a generous margin so a quick auto-follow scroll doesn't reveal
    // empty space. `viewWidth` is the visible track-content width.
    const viewWidth = rightEdge - headerWidth()
    const sx = scrollX.value
    const firstSub = Math.max(0, Math.floor((sx - viewWidth) / pxPerSub))
    const lastSub = Math.ceil((sx + viewWidth * 2) / pxPerSub)

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = firstSub; s <= lastSub; s++) {
      // World x: header offset + tick position. The layer translation
      // by `-scrollX` handles the on-screen positioning.
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

    // Bar-number labels centred above each bar line. Bars are 0-indexed,
    // so the first bar line (t=0) is labelled "0".
    if (T) {
      const startSub = Math.ceil(firstSub / subsPerBar) * subsPerBar
      for (let s = startSub; s <= lastSub; s += subsPerBar) {
        const x = headerWidth() + s * pxPerSub + 0.5
        const barNumber = s / subsPerBar
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

  /**
   * Full-height vertical grid lines spanning the track area. Drawn in
   * WORLD coordinates on `tracksLayer`, so they pan with scrollX for
   * free (and scrollY-translate with the row backgrounds; the ruler
   * chrome on top hides any bleed into the ruler row).
   */
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
    const sx = scrollX.value
    const firstSub = Math.max(0, Math.floor((sx - viewWidth) / pxPerSub))
    const lastSub = Math.ceil((sx + viewWidth * 2) / pxPerSub)

    const subLines = new G()
    const beatLines = new G()
    const barLines = new G()

    for (let s = firstSub; s <= lastSub; s++) {
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

    // Header column bg lives on the (non-translated) headers layer so it
    // stays pinned over the left strip while tracks scroll horizontally
    // underneath. `addChildAt(_, 0)` keeps it under the per-track header
    // rectangles drawn below.
    const headerColumnBg = new G()
    headerColumnBg
      .rect(0, RULER_HEIGHT, headerWidth(), a.renderer.screen.height - RULER_HEIGHT)
      .fill(TRACK_HEADER_BG)
    headers.addChildAt(headerColumnBg, 0)

    // Pass 1: row backgrounds (world y) + per-track header rectangles
    // (viewport y so they stay visually aligned with the row but are
    // drawn on a non-translated layer).
    const tracks = project.tracks
    // Generous horizontal cull bounds in world space so scroll-without-
    // redraw never reveals empty rows: extend by one viewport width
    // on each side.
    const viewWidth = rightEdge - headerWidth()
    const worldLeft = scrollX.value - viewWidth
    const worldRight = scrollX.value + viewWidth * 2
    const visibleRows: { track: (typeof tracks)[number]; worldY: number }[] = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (!track) continue
      const worldY = RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP)
      const viewportY = worldY - scrollY.value

      // Cull rows that are entirely outside the visible track area.
      if (viewportY + TRACK_HEIGHT <= RULER_HEIGHT) continue
      if (viewportY >= visibleBottom) break

      // Row background — drawn in world coords. Spans from x=0 (so it
      // continues under the header column for visual continuity) to a
      // wide world x; the header column bg above masks the left edge.
      const rowBg = new G()
      rowBg.rect(0, worldY, worldRight, TRACK_HEIGHT).fill(TRACK_BG)
      tracksL.addChild(rowBg)

      // Per-track header — drawn on the static headers layer in
      // viewport coords so it doesn't scroll horizontally.
      const header = new G()
      header.rect(0, viewportY, headerWidth(), TRACK_HEIGHT).fill(TRACK_HEADER_BG)
      header
        .moveTo(headerWidth() - 0.5, viewportY)
        .lineTo(headerWidth() - 0.5, viewportY + TRACK_HEIGHT)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
      headers.addChild(header)

      visibleRows.push({ track, worldY })
    }

    // Grid lines after row bgs so clips overlay both.
    drawGrid(width)

    // Pass 2: clips.
    for (const { track, worldY } of visibleRows) {
      const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
      for (const clipId of track.clipIds) {
        const clip = project.clips[clipId]
        if (!clip) continue
        drawClip(clip, worldY, palette, worldLeft, worldRight)
      }
    }
  }

  function drawClip(
    clip: Clip,
    rowWorldY: number,
    palette: (typeof TRACK_PALETTE)[number],
    worldLeft: number,
    worldRight: number
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
    const w = (clip.durationMs / 1000) * pxPerSecond.value

    // Generous world-space cull: anything entirely outside the current
    // viewport plus one viewport's worth of margin on each side is
    // skipped. The margin keeps scroll-without-redraw smooth — by the
    // time scroll has moved a viewport width, the next user action
    // (zoom, content change) will trigger a fresh redraw.
    if (absX + w < worldLeft || absX > worldRight) return

    const padding = 4
    const innerY = rowWorldY + padding
    const innerH = TRACK_HEIGHT - padding * 2
    const midY = innerY + innerH / 2

    // Clip block + border (palette-coloured).
    const block = new G()
    block
      .roundRect(absX, innerY, w, innerH, 4)
      .fill({ color: palette.fill, alpha: 0.85 })
      .stroke({ color: palette.border, width: 1, alpha: 0.9 })
    tracksL.addChild(block)

    // Hit region in WORLD coordinates — useDragHandlers converts to
    // viewport space at test time using the current scrollX/Y.
    clipHitRegions.push({ clipId: clip.id, x: absX, y: innerY, w, h: innerH })

    // Waveform — iterate full clip width once. We're no longer redrawn
    // on every scroll tick, so this is a redraw-time cost, not a
    // per-frame one.
    const wave = new G()
    const peaks = clip.peaks
    const peakCount = peaks.length / 2
    const samplesPerPixel = Math.max(1, peakCount / w)
    const half = innerH / 2 - 2

    for (let px = 0; px < w; px++) {
      const startIdx = Math.floor(px * samplesPerPixel)
      const endIdx = Math.min(peakCount, Math.floor((px + 1) * samplesPerPixel))
      if (startIdx >= peakCount) break

      let min = 0
      let max = 0
      for (let i = startIdx; i < endIdx; i++) {
        const lo = peaks[i * 2]!
        const hi = peaks[i * 2 + 1]!
        if (lo < min) min = lo
        if (hi > max) max = hi
      }

      const yTop = midY + max * -half
      const yBot = midY + min * -half
      wave.moveTo(absX + px + 0.5, yTop).lineTo(absX + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
    }
    wave.stroke({ color: palette.wave, width: 1, alpha: 0.95 })
    tracksL.addChild(wave)

    drawClipHeader(clip, absX, innerY, w, palette)
  }

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

    if (clipW < 20) return

    const maxChars = Math.max(1, Math.floor((clipW - PAD_X * 2) / APPROX_CHAR_W))
    const text =
      clip.fileName.length > maxChars
        ? clip.fileName.slice(0, Math.max(1, maxChars - 1)) + '…'
        : clip.fileName

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
        fill: 0x09090b
      }
    })
    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    tracksL.addChild(label)
  }

  // ─── Cached playhead Graphics ──────────────────────────────────────────
  // The playhead is a vertical line with two small triangular heads.
  // Built once and only re-positioned via `.x` on each `updatePlayhead`
  // call — this is the single biggest per-frame win because we used to
  // rebuild + re-stroke + re-fill every tick.

  let playheadGfx: Graphics | null = null
  let playheadDrawnHeight = -1

  function ensurePlayheadGfx(bottomY: number): Graphics | null {
    const G = GraphicsCtor.value
    const playhead = playheadLayer.value
    if (!G || !playhead) return null
    if (playheadGfx && playheadDrawnHeight === bottomY) return playheadGfx
    // Heights changed (track count, viewport resize) → rebuild geometry.
    if (playheadGfx) {
      playhead.removeChild(playheadGfx)
      playheadGfx.destroy()
    }
    const g = new G()
    // Draw at local x=0; translate the Graphics' `.x` to position.
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

  /**
   * Update the playhead position and run auto-follow. Cheap: no Graphics
   * allocation, no clip iteration. The playhead itself is cached
   * (`playheadGfx`); we just write `.x` per call. Auto-follow uses
   * `applyScroll` (an O(1) layer translation) instead of `redraw()`.
   */
  function updatePlayhead(): void {
    const a = app.value
    const playhead = playheadLayer.value
    if (!a || !playhead) return

    const width = a.renderer.screen.width - SCROLLBAR_WIDTH
    const posMs = displayPositionMs || transport.positionMs
    const absX = headerWidth() + (posMs / 1000) * pxPerSecond.value

    // Auto-follow: while playing (and the user wants follow) OR while
    // the user is dragging the playhead, scroll the world to keep the
    // playhead near the centre of the visible area. NOTE: no `redraw()`
    // — `applyScroll` just translates the world layers.
    //
    // Smoothness rules — applied uniformly to playback follow AND
    // click-to-seek / drag:
    //   - desired <= scrollX (target lands BEFORE the centre, e.g. the
    //     user moved to an earlier point): hold the scroll where it is.
    //     The playhead just draws at its viewport position and, during
    //     playback, advances naturally until it reaches the centre.
    //     Avoids the jarring backward teleport.
    //   - desired > scrollX: ease in over a wall-clock duration. The
    //     catch-up rate is intentionally only a few times the playback
    //     rate so the playhead VISIBLY drifts toward the centre rather
    //     than appearing locked to the waveform.
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
          // Catch-up speed mixes a steady "approach rate" (3× playback,
          // so the playhead visibly drifts within the waveform at a
          // 2/3 ratio of leftward motion) with a gap-proportional term
          // (so a large initial offset closes in ~half a second). The
          // `min(gap, ...)` cap prevents overshoot.
          const audioPxPerSec = pxPerSecond.value
          const approachPxPerSec = audioPxPerSec * 3
          const proportionalPxPerSec = gap * 5
          const ratePxPerSec = Math.max(approachPxPerSec, proportionalPxPerSec)
          const step = Math.min(gap, ratePxPerSec * dtSec)
          if (step > 0) nextScroll = scrollX.value + step
        }
      }
      // (desired <= scrollX → nextScroll stays null → hold.)

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

    // Reset the drop-preview ghost. We allocate it per frame only when
    // a drop is active (rare), so no caching needed.
    if (dropPreview.value) {
      removeDropPreviewGfx()
      drawDropPreview()
    } else {
      removeDropPreviewGfx()
    }

    if (project.tracks.length === 0) {
      // Nothing to point at → hide the playhead.
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

  // Drop preview ghost — kept on the playhead layer; rebuilt per frame
  // when active (which is rare) and removed otherwise. Tracking the
  // child separately so the playhead Graphics isn't disturbed.
  let dropPreviewGfx: Graphics | null = null
  function removeDropPreviewGfx(): void {
    const playhead = playheadLayer.value
    if (!playhead || !dropPreviewGfx) return
    playhead.removeChild(dropPreviewGfx)
    dropPreviewGfx.destroy()
    dropPreviewGfx = null
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
    dropPreviewGfx = g
  }

  return { redraw, applyScroll, updatePlayhead, setDisplayPositionMs }
}
