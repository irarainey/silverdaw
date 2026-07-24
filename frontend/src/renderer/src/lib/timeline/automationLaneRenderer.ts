// Per-track automation lane: geometry + PixiJS drawing for a parameter's curve in
// the strip reserved at the bottom of a track row. Shared by the renderer and the
// pointer-edit interaction so they agree on layout.

import type { Container, Graphics } from 'pixi.js'
import {
  AUTOMATION_LANE_HEIGHT,
  AUTOMATION_LANE_DIVIDER,
  AUTOMATION_LINE,
  AUTOMATION_HANDLE,
  AUTOMATION_HANDLE_RADIUS_PX
} from './constants'
import type { AutomationParamId, AutomationPoint } from '@shared/bridge-protocol'
import { valueToFraction, automationDescriptor } from '@/lib/automation/automationParams'

export const LANE_PX = AUTOMATION_LANE_HEIGHT

/** Lane strip [top, bottom] in world Y: sits below the clip area (`clipHeight`). */
export function laneRegion(
  worldY: number,
  clipHeight: number,
  laneOffset = 0,
  laneHeight = LANE_PX
): { top: number; bottom: number } {
  const top = worldY + clipHeight + laneOffset
  return { top, bottom: top + laneHeight }
}

const PAD = 8 // keeps min/max breakpoints off the strip edges so they stay visible

/** Native value -> world Y inside the lane (full value near top, min near bottom). */
export function valueToLaneY(
  paramId: AutomationParamId,
  value: number,
  top: number,
  laneHeight = LANE_PX
): number {
  return top + PAD + (1 - valueToFraction(paramId, value)) * (laneHeight - 2 * PAD)
}

/** World Y inside the lane -> native value. */
export function laneYToValue(
  paramId: AutomationParamId,
  y: number,
  top: number,
  laneHeight = LANE_PX
): number {
  const frac = 1 - Math.min(1, Math.max(0, (y - top - PAD) / (laneHeight - 2 * PAD)))
  const d = automationDescriptor(paramId)
  return d.min + frac * (d.max - d.min)
}

/** Draw the lane's faint divider, curve, and breakpoint handles (no fill). */
export function drawAutomationLane(
  layer: Container,
  G: typeof Graphics,
  paramId: AutomationParamId,
  points: AutomationPoint[] | undefined,
  worldY: number,
  clipHeight: number,
  laneOffset: number,
  laneHeight: number,
  headerWidth: number,
  pxPerSecond: number,
  rightEdgePx: number,
  baselineValue: number
): void {
  const { top, bottom } = laneRegion(worldY, clipHeight, laneOffset, laneHeight)
  // Draw every lane boundary so stacked lanes remain visually distinct.
  const chrome = new G()
  chrome
    .moveTo(headerWidth, top)
    .lineTo(rightEdgePx, top)
    .stroke({ color: AUTOMATION_LANE_DIVIDER, width: 1, alpha: 0.95 })
  // Faint guide line at the parameter's resting (static FX) value, so a lane
  // with no curve reflects the live track value rather than a fixed default.
  const restY = valueToLaneY(paramId, baselineValue, top, laneHeight)
  chrome.moveTo(headerWidth, restY).lineTo(rightEdgePx, restY).stroke({ color: AUTOMATION_LINE, width: 1, alpha: 0.2 })
  layer.addChild(chrome)

  const xAt = (ms: number): number => headerWidth + (ms / 1000) * pxPerSecond
  const curve = new G()
  if (points && points.length >= 2) {
    curve.moveTo(headerWidth, valueToLaneY(paramId, points[0]!.value, top, laneHeight))
    for (const p of points) {
      curve.lineTo(xAt(p.timeMs), valueToLaneY(paramId, p.value, top, laneHeight))
    }
    curve.lineTo(
      rightEdgePx,
      valueToLaneY(paramId, points[points.length - 1]!.value, top, laneHeight)
    )
    curve.stroke({ color: AUTOMATION_LINE, width: 2, alpha: 0.95 })
    for (const p of points) {
      const h = new G()
      h.circle(
        xAt(p.timeMs),
        valueToLaneY(paramId, p.value, top, laneHeight),
        AUTOMATION_HANDLE_RADIUS_PX
      ).fill(AUTOMATION_HANDLE)
      layer.addChild(h)
    }
  } else {
    curve.moveTo(headerWidth, restY).lineTo(rightEdgePx, restY).stroke({ color: AUTOMATION_LINE, width: 1.5, alpha: 0.5 })
  }
  layer.addChild(curve)
  void bottom
}
