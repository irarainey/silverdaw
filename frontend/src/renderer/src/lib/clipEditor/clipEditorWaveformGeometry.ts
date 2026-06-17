// Clip Editor waveform geometry: layout constants and pure coordinate helpers
// shared by the composable and its draw passes.

import { horizontalOverscanPx } from '@/lib/timeline/timelineWindow'
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

export function formatRulerTime(ms: number, stepMs: number): string {
  const totalSec = ms / 1000
  if (stepMs < 1000) {
    const decimals = stepMs < 100 ? 2 : 1
    return totalSec.toFixed(decimals) + 's'
  }
  const sign = totalSec < 0 ? '-' : ''
  const t = Math.abs(totalSec)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${sign}${m}:${s.toString().padStart(2, '0')}`
}
