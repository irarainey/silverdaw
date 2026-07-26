// Pure canvas rendering pipeline for the Scratch Editor's waveform bar: ruler,
// beat grid, stereo/mono waveform lanes, baseline, and playhead. Takes an
// explicit options bundle (no closures over component state) so it stays
// testable without mounting a component or touching a real canvas.

import {
  COL_BEAT,
  COL_EDITOR_BG,
  COL_PLAYHEAD,
  COL_RULER_BG,
  COL_RULER_BORDER,
  COL_RULER_TICK,
  COL_WAVE
} from '@/lib/clipEditor/clipEditorWaveformTheme'
import { drawScratchWaveformLane } from '@/lib/scratch/scratchWaveformLane'
import { formatRulerTime } from '@/lib/musicTime'

const RULER_HEIGHT = 20

export interface ScratchWaveformRenderOptions {
  width: number
  height: number
  viewStartMs: number
  viewDurationMs: number
  peaks: Float32Array
  peaksPerSecond: number
  channelPeaks: readonly Float32Array[]
  /** Whether to render `channelPeaks` as separate lanes rather than the mono `peaks`. */
  useStereoLanes: boolean
  channelPeaksPerSecond: number
  sourceDurationMs: number
  preparedDurationMs: number
  inMs: number
  reversed: boolean
  sourceBpm: number | undefined
  beatAnchorSec: number | undefined
  positionMs: number
}

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function drawBaseline(ctx: CanvasRenderingContext2D, width: number, midY: number): void {
  const lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1))
  const y = Math.round(midY) + (lineWidth % 2 === 1 ? 0.5 : 0)
  ctx.strokeStyle = cssHex(COL_WAVE)
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(width, y)
  ctx.stroke()
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  viewStartMs: number,
  viewDurationMs: number
): void {
  ctx.strokeStyle = cssHex(COL_RULER_BORDER)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, RULER_HEIGHT - 0.5)
  ctx.lineTo(width, RULER_HEIGHT - 0.5)
  ctx.stroke()

  if (viewDurationMs <= 0) return
  const majorStepsMs = [100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000]
  const desiredStepMs = (viewDurationMs / width) * 80
  const majorMs = majorStepsMs.find((step) => step >= desiredStepMs) ?? 60_000
  const minorMs = majorMs / 5
  const viewEndMs = viewStartMs + viewDurationMs
  const firstTickMs = Math.ceil(viewStartMs / minorMs) * minorMs
  ctx.strokeStyle = cssHex(COL_RULER_TICK)
  ctx.fillStyle = '#a1a1aa'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  for (let timeMs = firstTickMs; timeMs <= viewEndMs + 0.001; timeMs += minorMs) {
    const x = Math.round(((timeMs - viewStartMs) / viewDurationMs) * width) + 0.5
    const isMajor = Math.abs(timeMs / majorMs - Math.round(timeMs / majorMs)) < 1e-6
    const tickHeight = isMajor ? 8 : 4
    ctx.beginPath()
    ctx.moveTo(x, RULER_HEIGHT - tickHeight)
    ctx.lineTo(x, RULER_HEIGHT)
    ctx.stroke()
    if (isMajor) {
      ctx.fillText(formatRulerTime(timeMs, majorMs), x + 3, 10)
    }
  }
}

function drawBeatMarkers(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewStartMs: number,
  viewDurationMs: number,
  options: ScratchWaveformRenderOptions
): void {
  const { sourceBpm, beatAnchorSec, inMs, sourceDurationMs, reversed, preparedDurationMs } = options
  if (!sourceBpm || sourceBpm <= 0 || beatAnchorSec === undefined || sourceDurationMs <= 0) return
  const beatSpacingMs = (60 / sourceBpm) * 1000
  const windowEndMs = inMs + sourceDurationMs
  let beatMs = beatAnchorSec * 1000 + Math.ceil((inMs - beatAnchorSec * 1000) / beatSpacingMs) * beatSpacingMs
  ctx.strokeStyle = cssHex(COL_BEAT)
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  let lastX = Number.NEGATIVE_INFINITY
  while (beatMs <= windowEndMs + 0.5) {
    const sourceFraction = (beatMs - inMs) / sourceDurationMs
    const preparedMs = (reversed ? 1 - sourceFraction : sourceFraction) * preparedDurationMs
    const x = Math.round(((preparedMs - viewStartMs) / viewDurationMs) * width) + 0.5
    if (x >= 0 && x <= width && Math.abs(x - lastX) >= 4) {
      ctx.beginPath()
      ctx.moveTo(x, RULER_HEIGHT)
      ctx.lineTo(x, height)
      ctx.stroke()
      lastX = x
    }
    beatMs += beatSpacingMs
  }
  ctx.globalAlpha = 1
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewStartMs: number,
  viewDurationMs: number,
  positionMs: number
): void {
  if (viewDurationMs <= 0) return
  const phX = Math.round(((positionMs - viewStartMs) / viewDurationMs) * width)
  if (phX < 0 || phX > width) return
  ctx.strokeStyle = cssHex(COL_PLAYHEAD)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(phX, 0)
  ctx.lineTo(phX, height)
  ctx.stroke()
  ctx.fillStyle = cssHex(COL_PLAYHEAD)
  ctx.beginPath()
  ctx.moveTo(phX - 5, 0)
  ctx.lineTo(phX + 5, 0)
  ctx.lineTo(phX, 8)
  ctx.closePath()
  ctx.fill()
}

/** Renders the full waveform bar (background, ruler, waveform, beat grid, playhead). */
export function renderScratchWaveform(
  ctx: CanvasRenderingContext2D,
  options: ScratchWaveformRenderOptions
): void {
  const { width: W, height: H, viewStartMs, viewDurationMs } = options
  if (W <= 0 || H <= 0) return

  ctx.fillStyle = cssHex(COL_EDITOR_BG)
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = cssHex(COL_RULER_BG)
  ctx.fillRect(0, 0, W, RULER_HEIGHT)
  drawRuler(ctx, W, viewStartMs, viewDurationMs)

  const waveTop = RULER_HEIGHT
  const waveHeight = H - waveTop
  const mid = waveTop + waveHeight / 2

  const { peaks, peaksPerSecond, sourceDurationMs, preparedDurationMs, inMs, reversed } = options
  if (!peaks || peaks.length < 2 || peaksPerSecond <= 0 || sourceDurationMs <= 0 || preparedDurationMs <= 0) {
    drawBaseline(ctx, W, mid)
    drawBeatMarkers(ctx, W, H, viewStartMs, viewDurationMs, options)
    drawPlayhead(ctx, W, H, viewStartMs, viewDurationMs, options.positionMs)
    return
  }

  const visibleStartFraction = viewStartMs / preparedDurationMs
  const visibleFraction = viewDurationMs / preparedDurationMs
  const stereoPeaks = options.useStereoLanes && options.channelPeaks.length === 2 ? options.channelPeaks : null
  const lanes = stereoPeaks ?? [peaks]
  const lanePeaksPerSecond = stereoPeaks ? options.channelPeaksPerSecond : peaksPerSecond
  const laneHeight = waveHeight / lanes.length
  for (let channel = 0; channel < lanes.length; channel++) {
    const laneMidY = waveTop + laneHeight * (channel + 0.5)
    drawScratchWaveformLane({
      ctx,
      peaks: lanes[channel]!,
      peaksPerSecond: lanePeaksPerSecond,
      width: W,
      laneMidY,
      laneHalfHeight: laneHeight / 2 - 1,
      visibleStartFraction,
      visibleFraction,
      inMs,
      sourceDurationMs,
      reversed,
      color: cssHex(COL_WAVE)
    })
  }

  for (let channel = 0; channel < lanes.length; channel++) {
    drawBaseline(ctx, W, waveTop + laneHeight * (channel + 0.5))
  }
  drawBeatMarkers(ctx, W, H, viewStartMs, viewDurationMs, options)
  drawPlayhead(ctx, W, H, viewStartMs, viewDurationMs, options.positionMs)
}
