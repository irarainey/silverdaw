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
  BRAKE_FILL,
  BRAKE_FILL_ALPHA,
  BRAKE_LINE,
  BRAKE_LINE_ALPHA,
  BACKSPIN_FILL,
  BACKSPIN_FILL_ALPHA,
  BACKSPIN_LINE,
  BACKSPIN_LINE_ALPHA,
  CLIP_VERTICAL_PADDING
} from './constants'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'
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
  const brakeSettings = useBrakeSettingsStore()
  const backspinSettings = useBackspinSettingsStore()

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

  /** Tail overlay marking a clip's turntable brake (record-stop): a fixed
   *  platter-stop time over which playback decelerates 1 → 0. A linear speed
   *  ramp (constant deceleration) plus groove ticks at equal source intervals,
   *  which bunch at full speed and spread apart as the platter halts. */
  function drawClipBrakes(
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

    const brakeMsMax = brakeSettings.seconds * 1000
    const curvePower = brakeSettings.curvePower

    for (const id of track.clipIds) {
      const clip = project.clips[id]
      if (!clip || clip.brake !== true) continue
      // The engine applies the brake to forward clips (it composes with warp now);
      // reverse is still excluded, so don't draw a misleading overlay there.
      if (clip.reversed === true) continue

      // The brake occupies the last `T_stop` of the clip (clamped to its length),
      // and always decelerates fully to a stop across that span.
      const durMs = effectiveClipDurationMs(clip)
      const brakeMs = Math.min(brakeMsMax, durMs)
      if (brakeMs <= 0) continue
      const endMs = clip.startMs + durMs
      const startMs = endMs - brakeMs

      const x0 = headerWidth() + (startMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (endMs / 1000) * pxPerSecond.value
      const w = x1 - x0
      if (w < 1) continue
      if (x1 < worldLeft || x0 > worldRight) continue

      const yTop = innerY
      const yBot = innerY + innerH
      const overlay = acquireGraphics(G)
      overlay.rect(x0, yTop, w, innerH).fill({ color: BRAKE_FILL, alpha: BRAKE_FILL_ALPHA })

      // Groove ticks at equal source-consumed fractions. The timeline position of
      // source fraction f is u/T = 1 − (1−f)^(1/(p+1)), so equal grooves are dense at
      // full speed and spread out as playback slows.
      const invP = 1 / (curvePower + 1)
      const TICKS = 7
      for (let k = 1; k < TICKS; k++) {
        const f = k / TICKS
        const u = 1 - Math.pow(1 - f, invP) // normalised timeline position in [0, 1]
        const tx = x0 + w * u
        overlay.moveTo(tx, yTop).lineTo(tx, yBot)
      }
      overlay.stroke({ color: BRAKE_LINE, width: 1, alpha: BRAKE_LINE_ALPHA * 0.4 })

      // Speed ramp: the playback rate (1−u/T)^p falling from full speed (top) at the
      // brake start to a stop (bottom) at the clip end, plus a crisp left boundary.
      overlay.moveTo(x0, yTop).lineTo(x0, yBot)
      const STEPS = 24
      overlay.moveTo(x0, yTop)
      for (let i = 1; i <= STEPS; i++) {
        const u = i / STEPS
        const rate = Math.pow(1 - u, curvePower)
        overlay.lineTo(x0 + w * u, yTop + innerH * (1 - rate))
      }
      overlay.stroke({ color: BRAKE_LINE, width: 1.5, alpha: BRAKE_LINE_ALPHA })
      tracksL.addChild(overlay)
    }
  }

  /** Tail overlay marking a clip's turntable backspin (reverse rewind): the audio
   *  rewinds backwards at a high speed that decays to a stop. Drawn in violet with
   *  back-pointing chevrons that thin out as the spin slows, plus a rate-magnitude
   *  curve, to read clearly as "reverse" and distinct from the brake. */
  function drawClipBackspins(
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

    const spinMsMax = backspinSettings.seconds * 1000
    const curvePower = backspinSettings.curvePower

    for (const id of track.clipIds) {
      const clip = project.clips[id]
      if (!clip || clip.backspin !== true) continue
      if (clip.reversed === true) continue

      const durMs = effectiveClipDurationMs(clip)
      const spinMs = Math.min(spinMsMax, durMs)
      if (spinMs <= 0) continue
      const endMs = clip.startMs + durMs
      const startMs = endMs - spinMs

      const x0 = headerWidth() + (startMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (endMs / 1000) * pxPerSecond.value
      const w = x1 - x0
      if (w < 1) continue
      if (x1 < worldLeft || x0 > worldRight) continue

      const yTop = innerY
      const yBot = innerY + innerH
      const overlay = acquireGraphics(G)
      overlay.rect(x0, yTop, w, innerH).fill({ color: BACKSPIN_FILL, alpha: BACKSPIN_FILL_ALPHA })

      // Back-pointing chevrons (◄) along the region; spacing widens toward the end
      // as the spin loses momentum and slows. Position uses the same equal-rewind
      // mapping as the audio: u/T = 1 − (1−f)^(1/(p+1)).
      const invP = 1 / (curvePower + 1)
      const CHEVRONS = 6
      const ch = Math.min(5, innerH * 0.3)
      for (let k = 1; k <= CHEVRONS; k++) {
        const f = k / (CHEVRONS + 1)
        const u = 1 - Math.pow(1 - f, invP)
        const cxp = x0 + w * u
        const cyp = (yTop + yBot) / 2
        overlay
          .moveTo(cxp + ch * 0.6, cyp - ch)
          .lineTo(cxp - ch * 0.6, cyp)
          .lineTo(cxp + ch * 0.6, cyp + ch)
      }
      overlay.stroke({ color: BACKSPIN_LINE, width: 1, alpha: BACKSPIN_LINE_ALPHA * 0.55 })

      // Rate-magnitude curve: full reverse speed (top) at the trigger falling to a
      // stop (bottom) at the clip end, plus a crisp left boundary.
      overlay.moveTo(x0, yTop).lineTo(x0, yBot)
      const STEPS = 24
      overlay.moveTo(x0, yTop)
      for (let i = 1; i <= STEPS; i++) {
        const u = i / STEPS
        const rate = Math.pow(1 - u, curvePower)
        overlay.lineTo(x0 + w * u, yTop + innerH * (1 - rate))
      }
      overlay.stroke({ color: BACKSPIN_LINE, width: 1.5, alpha: BACKSPIN_LINE_ALPHA })
      tracksL.addChild(overlay)
    }
  }

  return { drawClipOverlaps, drawTrackTransitions, drawClipBrakes, drawClipBackspins }
}
