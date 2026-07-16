const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

export interface ScratchWaveformRange {
  startPair: number
  endPair: number
}

export function peakPairPositionForDisplayFraction(
  displayFraction: number,
  inMs: number,
  sourceDurationMs: number,
  peaksPerSecond: number,
  reversed: boolean
): number {
  const sourceFraction = reversed ? 1 - clamp01(displayFraction) : clamp01(displayFraction)
  return ((inMs + sourceFraction * sourceDurationMs) / 1000) * peaksPerSecond
}

export function peakPairRangeForDisplaySpan(
  displayStartFraction: number,
  displayEndFraction: number,
  inMs: number,
  sourceDurationMs: number,
  peaksPerSecond: number,
  reversed: boolean
): ScratchWaveformRange {
  const startPair = peakPairPositionForDisplayFraction(
    displayStartFraction,
    inMs,
    sourceDurationMs,
    peaksPerSecond,
    reversed
  )
  const endPair = peakPairPositionForDisplayFraction(
    displayEndFraction,
    inMs,
    sourceDurationMs,
    peaksPerSecond,
    reversed
  )
  return startPair <= endPair
    ? { startPair, endPair }
    : { startPair: endPair, endPair: startPair }
}
