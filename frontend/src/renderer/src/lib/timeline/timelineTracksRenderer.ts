// Timeline track-area painting: world-space grid lines, virtualized row
// backgrounds, pinned per-track headers, and delegated clip rendering.

import { type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics } from 'pixi.js'
import { useProjectStore, TRACK_PALETTE } from '@/stores/projectStore'
import { trackStaticAutomationValue } from '@/stores/projectTrackActions'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import {
  GRID_BAR,
  GRID_BEAT,
  GRID_SUB,
  RULER_HEIGHT,
  RULER_TICK,
  SCROLLBAR_WIDTH,
  SUBDIVISIONS_PER_BEAT,
  TIME_SIG_NUM,
  TRACK_BG,
  TRACK_HEADER_BG
} from './constants'
import { buildTrackRowLayout } from './trackLayout'
import { drawAutomationLane } from './automationLaneRenderer'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import type { GridGeometry } from './useGridGeometry'
import type { createClipRenderer } from './clipRenderer'
import { horizontalOverscanPx } from './timelineWindow'
import { visibleSubRange } from './timelineWindow'

export interface TimelineTracksRendererDeps {
  app: ShallowRef<Application | null>
  tracksLayer: ShallowRef<Container | null>
  headersLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  scrollX: Ref<number>
  scrollY: Ref<number>
  trackAreaHeight: ComputedRef<number>
  tracksContentHeight: ComputedRef<number>
  project: ReturnType<typeof useProjectStore>
  transport: ReturnType<typeof useTransportStore>
  clipRenderer: ReturnType<typeof createClipRenderer>
}

export function createTimelineTracksRenderer(deps: TimelineTracksRendererDeps) {
  const {
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
  } = deps
  const { pxPerSecond, headerWidth } = geometry

  /** Full-height grid lines in world coordinates for translate-only scroll. */
  function drawGrid(width: number): void {
    const tracks = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracks || !G) return

    if (project.tracks.length === 0) return

    const rightEdge = width - SCROLLBAR_WIDTH
    const gridLeft = headerWidth()
    const gridTop = RULER_HEIGHT
    // Span the full stacked track height (not just the visible band) so rows
    // scrolled into view below the first viewport still sit on the grid; when
    // the stack is shorter than the viewport the grid still fills the band.
    const gridBottom = RULER_HEIGHT + Math.max(trackAreaHeight.value, tracksContentHeight.value)
    if (gridBottom <= gridTop || rightEdge <= gridLeft) return

    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const viewWidth = rightEdge - gridLeft
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const lastSub = Math.ceil((projectPx + viewWidth) / pxPerSub)
    // Window to the visible band (see drawRulerTicks); horizontal scroll rebuilds.
    const { first: firstSub, last: lastVisibleSub } = visibleSubRange(
      scrollX.value,
      viewWidth,
      pxPerSub,
      lastSub
    )

    const subLines = new G()
    const beatLines = new G()
    const barLines = new G()

    for (let s = firstSub; s <= lastVisibleSub; s++) {
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

  /** Paint visible rows, headers, grid, and clips. Returns counts for stats. */
  function drawTracks(width: number): { rows: number; clips: number } {
    const a = app.value
    const tracksL = tracksLayer.value
    const headers = headersLayer.value
    const G = GraphicsCtor.value
    if (!a || !tracksL || !headers || !G) return { rows: 0, clips: 0 }

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
    // Horizontal virtualization: build clip geometry only within the visible
    // viewport plus half a viewport of overscan each side, so redraw cost scales
    // with the viewport — not the whole project × zoom. Horizontal scroll fires a
    // coalesced redraw to re-centre this band (mirroring vertical scroll); the
    // overscan covers the small distance scrolled before that redraw lands.
    const overscan = horizontalOverscanPx(viewWidth)
    const worldLeft = Math.max(0, scrollX.value + headerWidth() - overscan)
    const worldRight = scrollX.value + rightEdge + overscan
    const rowLayout = buildTrackRowLayout(tracks, makeLaneHeightOf())
    const visibleRows: {
      track: (typeof tracks)[number]
      worldY: number
      rowHeight: number
      clipHeight: number
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

      visibleRows.push({ track, worldY, rowHeight, clipHeight: slot.clipHeight })
    }

    const selection = useUiStore().timelineSelection
    if (selection) {
      const selectionX = headerWidth() + (selection.startMs / 1000) * pxPerSecond.value
      const selectionWidth =
        ((selection.endMs - selection.startMs) / 1000) * pxPerSecond.value
      const selectionOverlay = new G()
      selectionOverlay
        .rect(
          selectionX,
          RULER_HEIGHT,
          selectionWidth,
          Math.max(trackAreaHeight.value, tracksContentHeight.value)
        )
        .fill({ color: 0x0ea5e9, alpha: 0.1 })
      tracksL.addChild(selectionOverlay)
    }

    drawGrid(width)

    let visibleClipCount = 0
    const ui = useUiStore()
    const headerW = headerWidth()
    for (const { track, worldY, rowHeight, clipHeight } of visibleRows) {
      const lanes = ui.automationLanes[track.id] ?? []
      const trackPalette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
      for (const clipId of track.clipIds) {
        const clip = project.clips[clipId]
        if (!clip) continue
        const palette =
          typeof clip.colorIndex === 'number'
            ? TRACK_PALETTE[clip.colorIndex % TRACK_PALETTE.length]!
            : trackPalette
        clipRenderer.drawClip(clip, worldY, clipHeight, palette, worldLeft, worldRight, track.pan ?? 0)
        ++visibleClipCount
      }
      // Overlap hatch sits above the clip blocks; crossfade curves above that.
      clipRenderer.drawClipOverlaps(track, worldY, clipHeight, worldLeft, worldRight)
      // Crossfade overlays sit above both partner clips.
      clipRenderer.drawTrackTransitions(track, worldY, clipHeight, worldLeft, worldRight)
      // Beat Repeat regions sit above the source clips they capture from.
      clipRenderer.drawTrackBeatRepeats(track, worldY, clipHeight, worldLeft, worldRight)
      // Turntable-brake tail overlay sits above the clip body.
      clipRenderer.drawClipBrakes(track, worldY, clipHeight, worldLeft, worldRight)
      // Turntable-backspin tail overlay (reverse rewind) sits above the clip body.
      clipRenderer.drawClipBackspins(track, worldY, clipHeight, worldLeft, worldRight)
      // Automation lanes occupy the reserved strips below the clips when shown.
      if (lanes.length > 0 && rowHeight > clipHeight) {
        const tracks = tracksLayer.value
        const G = GraphicsCtor.value
        if (tracks && G) {
          let laneOffset = 0
          for (const lane of lanes) {
            drawAutomationLane(
              tracks,
              G,
              lane.paramId,
              track.automation?.[lane.paramId],
              worldY,
              clipHeight,
              laneOffset,
              lane.heightPx,
              headerW,
              pxPerSecond.value,
              worldRowRight,
              trackStaticAutomationValue(track, lane.paramId)
            )
            laneOffset += lane.heightPx
          }
        }
      }
    }
    return { rows: visibleRows.length, clips: visibleClipCount }
  }

  return { drawTracks }
}
