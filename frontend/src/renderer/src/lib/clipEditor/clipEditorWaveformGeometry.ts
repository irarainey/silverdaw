// Clip Editor waveform geometry: layout constants and pure coordinate helpers
// shared by the composable and its draw passes.

import { horizontalOverscanPx } from '@/lib/timeline/timelineWindow'
import { formatRulerTime } from '@/lib/musicTime'
import type { SceneGeometry } from './clipEditorWaveformTypes'

/** Ruler band height in CSS pixels. */
export const RULER_H = 18
/** Minimum CSS-px height for each stacked stereo lane. */
export const EDITOR_MIN_STEREO_LANE_PX = 24

export function worldX(ms: number, g: SceneGeometry): number {
  return (ms - g.viewIn) * g.worldPxPerMs
}

/** Source-ms range covered by the built band (visible window + overscan). */
export function bandMsRange(g: SceneGeometry): { fromMs: number; toMs: number } {
  const overscan = horizontalOverscanPx(g.W)
  const msPerWorldPx = g.worldPxPerMs > 0 ? 1 / g.worldPxPerMs : 0
  const fromPx = Math.max(0, g.scrollPx - overscan)
  const toPx = Math.min(g.worldW, g.scrollPx + g.W + overscan)
  return { fromMs: g.viewIn + fromPx * msPerWorldPx, toMs: g.viewIn + toPx * msPerWorldPx }
}

export { formatRulerTime }
