import { type ShallowRef } from 'vue'
import type { Container, Graphics } from 'pixi.js'
import { type Track, beatRepeatDivisionBeats } from '@/stores/projectTypes'
import { useTransportStore } from '@/stores/transportStore'
import {
  BEAT_REPEAT_FILL,
  BEAT_REPEAT_FILL_ALPHA,
  BEAT_REPEAT_LINE,
  BEAT_REPEAT_LINE_ALPHA,
  CLIP_VERTICAL_PADDING
} from './constants'
import type { GridGeometry } from './useGridGeometry'

type PooledGraphics = InstanceType<NonNullable<typeof Graphics>>

interface BeatRepeatOverlayRendererDeps {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  acquireGraphics: (G: NonNullable<typeof Graphics>) => PooledGraphics
}

export function createBeatRepeatOverlayRenderer(deps: BeatRepeatOverlayRendererDeps) {
  const { tracksLayer, GraphicsCtor, geometry, acquireGraphics } = deps
  const { pxPerSecond, headerWidth } = geometry
  const transport = useTransportStore()

  /** Draw beat-space captured-loop regions above the source clips on their owning track. */
  function drawTrackBeatRepeats(
    track: Track,
    rowWorldY: number,
    rowHeight: number,
    worldLeft: number,
    worldRight: number
  ): void {
    if (!track.beatRepeats || track.beatRepeats.length === 0) return
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G || transport.bpm <= 0) return

    const innerY = rowWorldY + CLIP_VERTICAL_PADDING
    const innerH = rowHeight - CLIP_VERTICAL_PADDING * 2
    if (innerH <= 0) return

    const msPerBeat = 60000 / transport.bpm
    const loopMarkerMinWidth = 10
    for (const region of track.beatRepeats) {
      const startMs = region.startBeat * msPerBeat
      const endMs = (region.startBeat + region.lengthBeats) * msPerBeat
      const x0 = headerWidth() + (startMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (endMs / 1000) * pxPerSecond.value
      if (x1 <= x0 || x1 < worldLeft || x0 > worldRight) continue

      const overlay = acquireGraphics(G)
      overlay
        .roundRect(x0, innerY, x1 - x0, innerH, 3)
        .fill({ color: BEAT_REPEAT_FILL, alpha: BEAT_REPEAT_FILL_ALPHA })
        .moveTo(x0, innerY)
        .lineTo(x0, innerY + innerH)

      const divisionMs = beatRepeatDivisionBeats(region.division) * msPerBeat
      for (let repeatMs = startMs; repeatMs < endMs; repeatMs += divisionMs) {
        const x = headerWidth() + (repeatMs / 1000) * pxPerSecond.value
        if (repeatMs > startMs) {
          overlay.moveTo(x, innerY).lineTo(x, innerY + innerH)
        }

        const segmentEndMs = Math.min(repeatMs + divisionMs, endMs)
        const segmentWidth = ((segmentEndMs - repeatMs) / 1000) * pxPerSecond.value
        if (segmentWidth < loopMarkerMinWidth) continue

        const centerX = x + segmentWidth / 2
        const centerY = innerY + innerH / 2
        const radius = Math.min(6, Math.max(3.5, Math.min(innerH * 0.2, segmentWidth * 0.3)))
        const arrowStartAngle = -Math.PI * 0.9
        const arrowEndAngle = Math.PI * 0.72
        const arcStartX = centerX + Math.cos(arrowStartAngle) * radius
        const arcStartY = centerY + Math.sin(arrowStartAngle) * radius
        const arrowX = centerX + Math.cos(arrowEndAngle) * radius
        const arrowY = centerY + Math.sin(arrowEndAngle) * radius
        const arrowLength = radius * 0.8
        overlay
          .moveTo(arcStartX, arcStartY)
          .arc(centerX, centerY, radius, arrowStartAngle, arrowEndAngle)
          .moveTo(arrowX, arrowY)
          .lineTo(arrowX - arrowLength, arrowY - arrowLength * 0.15)
          .moveTo(arrowX, arrowY)
          .lineTo(arrowX - arrowLength * 0.15, arrowY - arrowLength)
      }
      overlay.moveTo(x1, innerY).lineTo(x1, innerY + innerH)
      overlay.stroke({ color: BEAT_REPEAT_LINE, width: 1.25, alpha: BEAT_REPEAT_LINE_ALPHA })
      tracksL.addChild(overlay)
    }
  }

  return { drawTrackBeatRepeats }
}
