import {
  peakPairPositionForDisplayFraction,
  peakPairRangeForDisplaySpan
} from '@/lib/scratch/scratchWaveformMapping'
import {
  sampleInterpolatedPeak,
  waveformColumnDown,
  waveformColumnUp,
  type InterpolatedPeak
} from '@/lib/timeline/waveformColumn'

interface ScratchWaveformLaneOptions {
  ctx: CanvasRenderingContext2D
  peaks: Float32Array
  peaksPerSecond: number
  width: number
  laneMidY: number
  laneHalfHeight: number
  visibleStartFraction: number
  visibleFraction: number
  inMs: number
  sourceDurationMs: number
  reversed: boolean
  color: string
}

export function drawScratchWaveformLane(options: ScratchWaveformLaneOptions): void {
  const {
    ctx,
    peaks,
    peaksPerSecond,
    width,
    laneMidY,
    laneHalfHeight,
    visibleStartFraction,
    visibleFraction,
    inMs,
    sourceDurationMs,
    reversed,
    color
  } = options
  const pairsTotal = peaks.length >>> 1
  if (
    pairsTotal <= 0 ||
    peaksPerSecond <= 0 ||
    sourceDurationMs <= 0 ||
    width <= 0
  ) return

  const sourceWindowPairs = (sourceDurationMs / 1000) * peaksPerSecond
  const peaksPerPx = (sourceWindowPairs * visibleFraction) / width
  const out: InterpolatedPeak = { min: 0, max: 0 }
  ctx.fillStyle = color

  for (let px = 0; px < width; px++) {
    if (peaksPerPx > 1) {
      const { startPair, endPair } = peakPairRangeForDisplaySpan(
        visibleStartFraction + (px / width) * visibleFraction,
        visibleStartFraction + ((px + 1) / width) * visibleFraction,
        inMs,
        sourceDurationMs,
        peaksPerSecond,
        reversed
      )
      const firstPair = Math.max(0, Math.floor(startPair))
      const lastPair = Math.min(pairsTotal - 1, Math.ceil(endPair))
      let min = 0
      let max = 0
      for (let pair = firstPair; pair <= lastPair; pair++) {
        min = Math.min(min, peaks[pair * 2] ?? 0)
        max = Math.max(max, peaks[pair * 2 + 1] ?? 0)
      }
      out.min = min
      out.max = max
    } else {
      const pairPosition = peakPairPositionForDisplayFraction(
        visibleStartFraction + ((px + 0.5) / width) * visibleFraction,
        inMs,
        sourceDurationMs,
        peaksPerSecond,
        reversed
      )
      sampleInterpolatedPeak(peaks, pairsTotal, pairPosition, out)
    }

    const up = waveformColumnUp(out.max, laneHalfHeight, 1)
    const down = waveformColumnDown(out.min, laneHalfHeight, 1)
    if (up + down >= 0.5) {
      ctx.fillRect(px, laneMidY - up, 1, up + down)
    }
  }
}
