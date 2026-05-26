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
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  useProjectStore,
  type Clip,
  TRACK_PALETTE,
  PEAKS_PER_SECOND
} from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName, libraryItemSourceBpm } from '@/stores/libraryStore'
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
import { isWarpPending } from '@/lib/warp'
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
  const library = useLibraryStore()
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
  let redrawCount = 0
  let lastRedrawStats = { rows: 0, clips: 0, durationMs: 0 }
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

    // `screen.width` is the renderer's logical (CSS-pixel) drawing-space
    // width — i.e. the width we should draw to in stage coordinates so
    // that content reaches the right edge of the canvas regardless of
    // devicePixelRatio.
    const width = a.renderer.screen.width

    drawRulerChrome(width)
    drawRulerTicks(width)
    drawMarkers()
    drawTracks(width)
    drawHeaderDivider()

    // After a full redraw the world layers may need to be re-translated
    // — particularly on initial mount where `applyScroll` hadn't yet
    // been called by anyone.
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
   *
   * Tick range covers the FULL project duration (plus a small margin)
   * rather than just the current viewport, because `applyScroll` now
   * just translates the layer rather than redrawing — so any region
   * the user could scroll into must already have ticks drawn.
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

    // Cover the whole project plus one viewport-width of margin on the
    // right so a fresh project (duration ~ 0) still shows a bit of
    // grid for orientation. Subs are integer indices from 0 upward.
    const viewWidth = rightEdge - headerWidth()
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const lastSub = Math.ceil((projectPx + viewWidth) / pxPerSub)

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = 0; s <= lastSub; s++) {
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
      for (let s = 0; s <= lastSub; s += subsPerBar) {
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
   * WORLD coordinates on `tracksLayer`, covering the FULL project
   * duration so scroll-without-redraw never reveals empty space.
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
    // drawn on a non-translated layer). Row bg + clip cull bounds
    // extend across the FULL project so a translate-only scroll never
    // reveals empty rows. One viewport width of margin on the right
    // covers the "scroll past the end" affordance.
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

      // Cull rows that are entirely outside the visible track area.
      if (viewportY + rowHeight <= RULER_HEIGHT) continue
      if (viewportY >= visibleBottom) break

      // Row background — drawn in world coords across the whole
      // project. The header column bg above masks its left edge.
      const rowBg = new G()
      rowBg.rect(0, worldY, worldRowRight, rowHeight).fill(TRACK_BG)
      tracksL.addChild(rowBg)

      // Selected-track highlight — a 2 px inset border in the
      // palette's accent colour around the row. Drawn after the bg
      // so it overlays the row colour but before the grid + clips so
      // they still draw on top.
      if (project.selectedTrackId === track.id) {
        const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
        const highlight = new G()
        highlight
          .rect(1, worldY + 1, worldRowRight - 2, rowHeight - 2)
          .stroke({ color: palette.border, width: 2, alpha: 0.9 })
        tracksL.addChild(highlight)
      }

      // Per-track header — drawn on the static headers layer in
      // viewport coords so it doesn't scroll horizontally.
      const header = new G()
      header.rect(0, viewportY, headerWidth(), rowHeight).fill(TRACK_HEADER_BG)
      header
        .moveTo(headerWidth() - 0.5, viewportY)
        .lineTo(headerWidth() - 0.5, viewportY + rowHeight)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
      headers.addChild(header)

      visibleRows.push({ track, worldY, rowHeight })
    }

    // Grid lines after row bgs so clips overlay both.
    drawGrid(width)

    // Pass 2: clips.
    let visibleClipCount = 0
    for (const { track, worldY, rowHeight } of visibleRows) {
      const trackPalette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
      for (const clipId of track.clipIds) {
        const clip = project.clips[clipId]
        if (!clip) continue
        // Per-clip colour override wins over the track's palette entry.
        const palette =
          typeof clip.colorIndex === 'number'
            ? TRACK_PALETTE[clip.colorIndex % TRACK_PALETTE.length]!
            : trackPalette
        drawClip(clip, worldY, rowHeight, palette, worldLeft, worldRight)
        ++visibleClipCount
      }
    }
    lastRedrawStats = { ...lastRedrawStats, rows: visibleRows.length, clips: visibleClipCount }
  }

  function drawClip(
    clip: Clip,
    rowWorldY: number,
    rowHeight: number,
    palette: (typeof TRACK_PALETTE)[number],
    worldLeft: number,
    worldRight: number
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
    const libItem = clip.libraryItemId
      ? library.items.find((i) => i.id === clip.libraryItemId)
      : library.items.find((i) => i.filePath === clip.filePath)
    const effectiveDurMs = effectiveClipDurationMs(clip)
    const w = (effectiveDurMs / 1000) * pxPerSecond.value
    const warpRatio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1

    // Generous world-space cull: anything entirely outside the current
    // viewport plus one viewport's worth of margin on each side is
    // skipped. The margin keeps scroll-without-redraw smooth — by the
    // time scroll has moved a viewport width, the next user action
    // (zoom, content change) will trigger a fresh redraw.
    if (absX + w < worldLeft || absX > worldRight) return

    const padding = 4
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    const midY = innerY + innerH / 2

    // Unresolved clips (source file missing on disk) render in muted
    // greys with a dashed red border so they're visibly broken at a
    // glance; clicking through to the toast's Locate-files… affordance
    // is how the user repairs them.
    const fillColour = clip.unresolved ? 0x3f3f46 : palette.fill // zinc-700 vs palette
    const borderColour = clip.unresolved ? 0xef4444 : palette.border // red-500 vs palette
    const waveColour = clip.unresolved ? 0x71717a : palette.wave // zinc-500 vs palette
    const fillAlpha = clip.unresolved ? 0.5 : 0.85
    const borderAlpha = clip.unresolved ? 0.85 : 0.9

    // Selected clips get a noticeably thicker border so the user can
    // see at a glance which clip Cut / Copy would act on. The colour
    // stays the palette border (slightly brighter) so the selection
    // doesn't conflict with the unresolved-red warning.
    const isSelected = project.selectedClipId === clip.id
    const borderWidth = isSelected ? 3 : 1
    const effectiveBorderAlpha = isSelected ? 1.0 : borderAlpha

    // Clip block + border (palette-coloured; muted when unresolved).
    const block = new G()
    block
      .roundRect(absX, innerY, w, innerH, 4)
      .fill({ color: fillColour, alpha: fillAlpha })
      .stroke({ color: borderColour, width: borderWidth, alpha: effectiveBorderAlpha })
    tracksL.addChild(block)

    // Hit region in WORLD coordinates — useDragHandlers converts to
    // viewport space at test time using the current scrollX/Y.
    clipHitRegions.push({ clipId: clip.id, x: absX, y: innerY, w, h: innerH })

    // Waveform — iterate the clip's pixel range once. Map each pixel
    // proportionally onto the peak-index space so the rendering stays
    // time-accurate at both ends of the zoom range:
    //
    //   - Zoomed OUT (peakCount ≥ w):  multiple peaks per pixel → take
    //     the min/max over the covered range (visual decimation).
    //   - Zoomed IN  (peakCount < w):  multiple pixels per peak → each
    //     pixel reads the single peak whose time it falls into, which
    //     produces a horizontally-stretched envelope. The previous
    //     algorithm clamped `samplesPerPixel` to 1, which incorrectly
    //     spaced peaks 1 px apart regardless of width — causing the
    //     waveform to "drift" leftward off its clip block at high
    //     zoom.
    const wave = new G()
    const peaks = clip.peaks
    const peakCount = peaks.length / 2
    const half = innerH / 2 - 2

    if (peakCount > 0 && w > 0) {
      // Peaks are at a constant rate over the SOURCE file; the actual
      // rate can differ slightly from the requested nominal rate because
      // peak buckets contain an integer number of samples. Use the
      // payload-provided rate so transients do not drift against beat
      // markers over long clips. The clip may be a trimmed window.
      // Convert the clip's
      // `[inMs, inMs + durationMs]` ms-window into peak indices and
      // distribute those across the clip's pixel width.
      const peaksPerSecond = clip.peaksPerSecond ?? libItem?.peaksPerSecond ?? PEAKS_PER_SECOND
      const startPeak = Math.max(0, Math.floor((clip.inMs / 1000) * peaksPerSecond))
      const endPeak = Math.min(
        peakCount,
        Math.max(startPeak + 1, Math.ceil(((clip.inMs + clip.durationMs) / 1000) * peaksPerSecond))
      )
      const windowSize = endPeak - startPeak
      const peaksPerPixel = windowSize / w
      for (let px = 0; px < w; px++) {
        const startIdx = startPeak + Math.floor(px * peaksPerPixel)
        // Always read at least one peak per pixel — when zoomed in
        // (peaksPerPixel < 1) consecutive pixels would otherwise share
        // the same `startIdx` AND `endIdx`, producing no draw.
        const endIdx = Math.min(
          endPeak,
          Math.max(startIdx + 1, startPeak + Math.ceil((px + 1) * peaksPerPixel))
        )
        if (startIdx >= endPeak) break

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
      wave.stroke({ color: waveColour, width: 1, alpha: 0.95 })
      tracksL.addChild(wave)
    }

    // Beat markers — synthesised on a *source-global* beat grid so a
    // split clip's right half keeps in lockstep with its left half.
    //
    // The grid is anchored on the first detected beat (`beats[0]`) and
    // spaced by `60 / sourceBpm` seconds. Each clip windows that
    // shared grid by its trim range, finding the smallest synthetic
    // beat ≥ `inMs` and stepping forward from there. Picking the
    // first *detected* beat ≥ inMs (the old behaviour) wobbled by a
    // few ms after a split because BTrack's per-beat timestamps
    // wander relative to the implied uniform tempo.
    const beats = libItem?.beats
    const markerSourceBpm = libItem ? libraryItemSourceBpm(libItem, library.items) : undefined
    // Prefer the regression-derived anchor over the first raw
    // detected beat — it's the implied phase of the ideal beat
    // grid and is robust to BTrack's per-beat jitter. Older saved
    // projects without the anchor fall back to `beats[0]`.
    const anchorSec = libItem?.beatAnchorSec ?? beats?.[0]
    if (beats && beats.length > 0 && markerSourceBpm && markerSourceBpm > 0 && anchorSec !== undefined && w > 0) {
      const pxPerMs = pxPerSecond.value / 1000
      const inMs = clip.inMs
      const outMs = inMs + clip.durationMs
      const beatSpacingMs = (60 / markerSourceBpm) * 1000
      const universalAnchorMs = anchorSec * 1000
      // First synthetic beat ≥ inMs. ceil() can produce a value < inMs
      // when `(inMs - universalAnchorMs)` is exactly on a beat, so we
      // bump by spacing once if needed.
      let firstBeatMs =
        universalAnchorMs +
        Math.ceil((inMs - universalAnchorMs) / beatSpacingMs) * beatSpacingMs
      while (firstBeatMs < inMs) firstBeatMs += beatSpacingMs
      const minMarkerSpacingPx = 4
      const markers = new G()
      let drew = 0
      let lastMarkerPx = Number.NEGATIVE_INFINITY
      for (let beatMs = firstBeatMs; beatMs <= outMs; beatMs += beatSpacingMs) {
        const offsetInClipMs = beatMs - inMs
        if (offsetInClipMs < 0) continue
        const x = absX + (offsetInClipMs / warpRatio) * pxPerMs
        if (x - lastMarkerPx < minMarkerSpacingPx) continue
        markers.moveTo(x + 0.5, innerY + 1).lineTo(x + 0.5, innerY + innerH - 1)
        lastMarkerPx = x
        ++drew
        if (beatSpacingMs <= 0) break
      }
      if (drew > 0) {
        markers.stroke({ color: 0xffffff, width: 1, alpha: 0.4 })
        tracksL.addChild(markers)
      }
    }

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

    const HEADER_H = 18
    const PAD_X = 4
    const FONT_SIZE = 11
    const APPROX_CHAR_W = 6
    const LINK_BADGE_FULL_W = 18
    const WARP_BADGE_FULL_W = 40
    const STATUS_BADGE_H = 14
    const STATUS_BADGE_R = 5
    const BADGE_GAP = 4
    const NAME_BADGE_GAP = 6
    const PITCH_BADGE_FULL_W = 18

    if (clipW < 20) return

    // Resolve the parent library item by id (the authoritative link
    // recorded in the project file). When the parent is a saved-clip
    // the clip is "linked" — edits in the Clip Editor propagate to
    // every sibling sharing the same `libraryItemId`. We surface this
    // with a small chain-link badge at the right edge of the header
    // so the user can tell linked from independent clips at a glance.
    const libItem = library.items.find((i) => i.id === clip.libraryItemId)
    const isLinked = libItem?.kind === 'saved-clip'
    const headerSourceBpm = libItem ? libraryItemSourceBpm(libItem, library.items) : undefined
    const warpIsPending = isWarpPending({
      warpEnabled: clip.warpEnabled,
      tempoRatio: clip.tempoRatio,
      pendingAutoWarp: clip.pendingAutoWarp,
      sourceBpm: headerSourceBpm,
      projectBpm: transport.bpm
    })
    const warpIsActive = !warpIsPending && isClipTempoWarpActive(clip)

    // Prefer the clip's own custom name (set via inline rename on the
    // timeline) first. Otherwise fall back to the parent library
    // item's display name, then to the clip's filename.
    const displayName = clip.name?.trim()
      ? clip.name
      : libItem ? libraryItemDisplayName(libItem) : clip.fileName

    // Reserve room on the right for timeline status badges so the text
    // doesn't slide under them. Use the actual Pixi text measurement
    // rather than a character-count approximation because bold
    // proportional glyphs can be much wider than the average.
    const LINK_BADGE_W = isLinked ? LINK_BADGE_FULL_W : 0
    const WARP_BADGE_W = warpIsPending || warpIsActive ? WARP_BADGE_FULL_W : 0
    const pitchShifted = (clip.semitones ?? 0) !== 0 || (clip.cents ?? 0) !== 0
    const PITCH_BADGE_W = pitchShifted ? PITCH_BADGE_FULL_W : 0
    const BADGE_COUNT = (isLinked ? 1 : 0) + (pitchShifted ? 1 : 0) + (warpIsPending || warpIsActive ? 1 : 0)
    const BADGES_W =
      BADGE_COUNT === 0
        ? 0
        : NAME_BADGE_GAP +
          LINK_BADGE_W +
          PITCH_BADGE_W +
          WARP_BADGE_W +
          Math.max(0, BADGE_COUNT - 1) * BADGE_GAP
    const maxTextW = Math.max(0, clipW - PAD_X * 2 - BADGES_W)
    const label = new T({
      text: displayName,
      style: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: FONT_SIZE,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x09090b, width: 2 }
      }
    })
    if (label.width > maxTextW) {
      if (maxTextW <= APPROX_CHAR_W) {
        label.text = ''
      } else {
        let lo = 0
        let hi = displayName.length
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          label.text = displayName.slice(0, mid) + '…'
          if (label.width <= maxTextW) lo = mid
          else hi = mid - 1
        }
        label.text = lo > 0 ? displayName.slice(0, lo) + '…' : ''
      }
    }

    const labelW = label.text.length > 0 ? label.width : 0
    const desiredW = Math.min(clipW, Math.ceil(labelW) + PAD_X * 2 + BADGES_W)
    const headerBg = new G()
    headerBg
      .rect(clipX, clipInnerY, desiredW, HEADER_H)
      .fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    if (label.text.length > 0) tracksL.addChild(label)

    let badgeRight = clipX + desiredW - PAD_X
    if (isLinked) {
      const badge = new G()
      const cx = badgeRight - LINK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      badge
        .roundRect(
          cx - LINK_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          LINK_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x09090b, alpha: 0.85 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      badge
        .circle(cx - 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
        .circle(cx + 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
      tracksL.addChild(badge)
      badgeRight -= LINK_BADGE_FULL_W + BADGE_GAP
    }
    if (pitchShifted) {
      const bg = new G()
      const cx = badgeRight - PITCH_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - PITCH_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          PITCH_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x18181b, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: '♪',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 11,
          fontWeight: '700',
          fill: 0xffffff
        }
      })
      badge.x = Math.round(cx - 4)
      badge.y = Math.round(cy - 8)
      tracksL.addChild(badge)
      badgeRight -= PITCH_BADGE_FULL_W + BADGE_GAP
    }
    if (warpIsPending) {
      const badge = new G()
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const phase = Math.floor(Date.now() / 125) % 8
      const radius = 4.2
      badge
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      for (let i = 0; i < 8; i++) {
        const angle = ((i - phase) / 8) * Math.PI * 2
        const alpha = 0.25 + ((i + 1) / 8) * 0.65
        badge
          .circle(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 1.1)
          .fill({ color: 0xffffff, alpha })
      }
      tracksL.addChild(badge)
    } else if (warpIsActive) {
      const bg = new G()
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'WARP',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0xfacc15
        }
      })
      badge.x = Math.round(cx - 14)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
    }
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
    const targetTrack = project.tracks[dp.trackIndex]
    const rowH = trackHeightOf(targetTrack)
    // World-space top of the target row, then convert to viewport.
    let worldTop = RULER_HEIGHT
    for (let i = 0; i < dp.trackIndex; i++) {
      worldTop += trackHeightOf(project.tracks[i]) + TRACK_GAP
    }
    const yTop = worldTop - scrollY.value
    // Off-screen vertically — skip.
    if (yTop + rowH <= RULER_HEIGHT) return
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
