// Timeline ruler painting: background chrome, bar/beat/sub ticks, bar labels,
// markers, and the pinned header divider. World-space ticks translate on scroll.

import { type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import {
  GRID_BAR,
  GRID_BEAT,
  GRID_SUB,
  MARKER,
  RULER_BG,
  RULER_HEIGHT,
  RULER_LABEL_HINT,
  RULER_TICK,
  SCROLLBAR_WIDTH,
  SUBDIVISIONS_PER_BEAT,
  TIME_SIG_NUM,
  TRACK_HEADER_BG
} from './constants'
import type { GridGeometry } from './useGridGeometry'
import { visibleSubRange } from './timelineWindow'

export interface TimelineRulerRendererDeps {
  app: ShallowRef<Application | null>
  rulerLayer: ShallowRef<Container | null>
  rulerTicksLayer: ShallowRef<Container | null>
  headersLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  scrollX: Ref<number>
  project: ReturnType<typeof useProjectStore>
  transport: ReturnType<typeof useTransportStore>
}

export function createTimelineRulerRenderer(deps: TimelineRulerRendererDeps) {
  const {
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
  } = deps
  const { pxPerSecond, headerWidth } = geometry

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

    // Project extent in subdivisions, used as the clamp ceiling for the band.
    const viewWidth = rightEdge - headerWidth()
    const projectPx = (project.durationMs / 1000) * pxPerSecond.value
    const lastSub = Math.ceil((projectPx + viewWidth) / pxPerSub)
    // Window to the visible band: at high zoom a long project spans thousands of
    // ticks/labels, almost all off-screen. Horizontal scroll rebuilds the band.
    const { first: firstSub, last: lastVisibleSub } = visibleSubRange(
      scrollX.value,
      viewWidth,
      pxPerSub,
      lastSub
    )

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = firstSub; s <= lastVisibleSub; s++) {
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

    // Bar labels: barCounterStart is the first bar's number (default 1; 0 or lower for lead-in).
    if (T) {
      const barCounterStart = project.barCounterStart
      const firstBarSub = Math.ceil(firstSub / subsPerBar) * subsPerBar
      for (let s = firstBarSub; s <= lastVisibleSub; s += subsPerBar) {
        const x = headerWidth() + s * pxPerSub + 0.5
        const barNumber = s / subsPerBar + barCounterStart
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

  return { drawRulerChrome, drawRulerTicks, drawMarkers, drawHeaderDivider }
}
