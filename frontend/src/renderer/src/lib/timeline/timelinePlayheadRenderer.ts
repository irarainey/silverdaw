// Timeline playhead + drop-preview painting. Owns the cached playhead Graphics,
// RAF interpolation position, and auto-follow scroll; the drop-preview ghost is a
// separate cached node so the playhead stays intact.

import { type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import {
  PLAYHEAD,
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH,
  TRACK_GAP
} from './constants'
import { trackHeightOf } from './trackLayout'
import type { DropPreview } from './useDropZone'
import type { GridGeometry } from './useGridGeometry'

export interface TimelinePlayheadRendererDeps {
  app: ShallowRef<Application | null>
  playheadLayer: ShallowRef<Container | null>
  tracksLayer: ShallowRef<Container | null>
  rulerTicksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  scrollX: Ref<number>
  scrollY: Ref<number>
  showScrollbar: ComputedRef<boolean>
  trackAreaHeight: ComputedRef<number>
  tracksContentHeight: ComputedRef<number>
  /** Clamps `scrollX/Y` to valid range; returns true iff anything moved. */
  clampScroll: () => boolean
  /** From `useDragHandlers` — true while the user is dragging the playhead. */
  isDraggingPlayhead: Ref<boolean>
  /** From `useDropZone` — current drag-hover landing rectangle (or null). */
  dropPreview: Ref<DropPreview | null>
  project: ReturnType<typeof useProjectStore>
  transport: ReturnType<typeof useTransportStore>
  ui: ReturnType<typeof useUiStore>
}

export function createTimelinePlayheadRenderer(deps: TimelinePlayheadRendererDeps) {
  const {
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
  } = deps
  const { pxPerSecond, headerWidth } = geometry

  // RAF interpolator writes here to smooth backend playhead ticks.
  let displayPositionMs = 0
  // Auto-follow uses wall-clock deltas so scroll feel is refresh-rate independent.
  let lastUpdateMs = 0

  function setDisplayPositionMs(ms: number): void {
    displayPositionMs = ms
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

    // Auto-follow is a playback affordance only: it eases the view forward to keep
    // the moving playhead in view during playback. Dragging the playhead never
    // re-centres the view (that felt jarring and could scroll the wrong way while
    // catching up) — a drag edge-scrolls in useDragHandlers instead, and a drag
    // inside the visible area leaves the scroll untouched.
    const shouldFollow =
      transport.isPlaying && ui.followPlayback && !isDraggingPlayhead.value
    const now = performance.now()
    const dtSec = lastUpdateMs === 0 ? 0 : Math.min(0.1, (now - lastUpdateMs) / 1000)
    lastUpdateMs = now
    if (shouldFollow) {
      const viewportCentre = headerWidth() + (width - headerWidth()) / 2
      const desired = Math.max(0, absX - viewportCentre)
      // Playback follow eases forward only: playback never runs backwards, and we
      // don't want backward scroll jitter.
      const gap = desired - scrollX.value
      let nextScroll: number | null = null
      if (gap > 0.5) {
        // Mix playback-relative and gap-proportional catch-up; cap prevents overshoot.
        const audioPxPerSec = pxPerSecond.value
        const approachPxPerSec = audioPxPerSec * 3
        const proportionalPxPerSec = Math.abs(gap) * 5
        const ratePxPerSec = Math.max(approachPxPerSec, proportionalPxPerSec)
        const magnitude = Math.min(Math.abs(gap), ratePxPerSec * dtSec)
        if (magnitude > 0) nextScroll = scrollX.value + (gap > 0 ? magnitude : -magnitude)
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

  return { updatePlayhead, setDisplayPositionMs }
}
