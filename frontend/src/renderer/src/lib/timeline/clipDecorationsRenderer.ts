// Clip decoration overlays: diagonal hatch over clip overlaps and transition fades.

import { type ShallowRef } from 'vue'
import type { Container, Graphics } from 'pixi.js'
import {
  effectiveClipDurationMs,
  useProjectStore,
  type Clip,
  type Track
} from '@/stores/projectStore'
import {
  TRANSITION_FILL,
  TRANSITION_FILL_ALPHA,
  TRANSITION_LINE,
  TRANSITION_LINE_ALPHA,
  OVERLAP_HATCH,
  OVERLAP_HATCH_ALPHA,
  OVERLAP_HATCH_SPACING_PX,
  CLIP_VERTICAL_PADDING
} from './constants'
import type { GridGeometry } from './useGridGeometry'

type PooledGraphics = InstanceType<NonNullable<typeof Graphics>>

export interface ClipDecorationsRendererDeps {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  project: ReturnType<typeof useProjectStore>
  /** Hand back a cleared, pooled Graphics shared with the clip renderer. */
  acquireGraphics: (G: NonNullable<typeof Graphics>) => PooledGraphics
}

export function createClipDecorationsRenderer(deps: ClipDecorationsRendererDeps) {
  const { tracksLayer, GraphicsCtor, geometry, project, acquireGraphics } = deps
  const { pxPerSecond, headerWidth } = geometry

  /** Diagonal hatch over any region where two clips on a track overlap. */
  function drawClipOverlaps(
    track: Track,
    rowWorldY: number,
    rowHeight: number,
    worldLeft: number,
    worldRight: number
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const padding = CLIP_VERTICAL_PADDING
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    if (innerH <= 0) return

    // Sort by timeline start so tail/head overlaps fall between neighbours.
    const ordered = track.clipIds
      .map((id) => project.clips[id])
      .filter((c): c is Clip => Boolean(c))
      .sort((a, b) => a.startMs - b.startMs)

    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i]!
      const b = ordered[i + 1]!
      const overlapStartMs = Math.max(a.startMs, b.startMs)
      const overlapEndMs = Math.min(
        a.startMs + effectiveClipDurationMs(a),
        b.startMs + effectiveClipDurationMs(b)
      )
      if (overlapEndMs - overlapStartMs <= 0) continue

      const x0 = headerWidth() + (overlapStartMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (overlapEndMs / 1000) * pxPerSecond.value
      if (x1 - x0 < 1) continue // ignore sub-pixel (e.g. butt-joined) overlaps
      if (x1 < worldLeft || x0 > worldRight) continue

      const yTop = innerY
      const yBot = innerY + innerH
      const hatch = acquireGraphics(G)
      // 45° lines clipped to the overlap rect: bottom-left → top-right.
      for (let sx = x0 - innerH; sx < x1; sx += OVERLAP_HATCH_SPACING_PX) {
        const ax = Math.max(sx, x0)
        const bx = Math.min(sx + innerH, x1)
        if (ax >= bx) continue
        hatch.moveTo(ax, yBot - (ax - sx)).lineTo(bx, yBot - (bx - sx))
      }
      // Crisp verticals delimit the shared extent.
      hatch
        .moveTo(x0, yTop)
        .lineTo(x0, yBot)
        .moveTo(x1, yTop)
        .lineTo(x1, yBot)
      hatch.stroke({ color: OVERLAP_HATCH, width: 1, alpha: OVERLAP_HATCH_ALPHA })
      tracksL.addChild(hatch)
    }
  }

  /** Draw transition overlaps from live clip geometry; the fade shape encodes the recipe. */
  function drawTrackTransitions(
    track: Track,
    rowWorldY: number,
    rowHeight: number,
    worldLeft: number,
    worldRight: number
  ): void {
    const transitions = track.transitions
    if (!transitions || transitions.length === 0) return
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const padding = CLIP_VERTICAL_PADDING
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    if (innerH <= 0) return

    for (const transition of transitions) {
      const left = project.clips[transition.leftClipId]
      const right = project.clips[transition.rightClipId]
      if (!left || !right) continue

      // Overlap uses warp-scaled timeline footprints, not raw source duration.
      const overlapStartMs = right.startMs
      const overlapEndMs = left.startMs + effectiveClipDurationMs(left)
      if (overlapEndMs - overlapStartMs <= 0) continue

      const x0 = headerWidth() + (overlapStartMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (overlapEndMs / 1000) * pxPerSecond.value
      const w = x1 - x0
      if (w <= 0) continue
      if (x1 < worldLeft || x0 > worldRight) continue

      const overlay = acquireGraphics(G)
      overlay
        .roundRect(x0, innerY, w, innerH, 3)
        .fill({ color: TRANSITION_FILL, alpha: TRANSITION_FILL_ALPHA })

      // The two fade legs are drawn so the recipe is readable at a glance:
      // `linear` ("Fade out / in") is a straight X, while `smooth` (equal-power)
      // bows each leg outward along its sin/cos law. yAt maps a gain (0 bottom,
      // 1 top) to a pixel row inside the overlap.
      const yAt = (gain: number): number => innerY + innerH * (1 - gain)
      const isLinear = transition.recipe?.kind === 'linear'
      if (isLinear) {
        overlay
          .moveTo(x0, yAt(0))
          .lineTo(x1, yAt(1)) // fade-in: rises bottom-left → top-right
          .moveTo(x0, yAt(1))
          .lineTo(x1, yAt(0)) // fade-out: falls top-left → bottom-right
      } else {
        const STEPS = 24
        overlay.moveTo(x0, yAt(0))
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS
          overlay.lineTo(x0 + w * t, yAt(Math.sin((t * Math.PI) / 2)))
        }
        overlay.moveTo(x0, yAt(1))
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS
          overlay.lineTo(x0 + w * t, yAt(Math.cos((t * Math.PI) / 2)))
        }
      }
      overlay.stroke({ color: TRANSITION_LINE, width: 1.5, alpha: TRANSITION_LINE_ALPHA })
      tracksL.addChild(overlay)
    }
  }

  return { drawClipOverlaps, drawTrackTransitions }
}
