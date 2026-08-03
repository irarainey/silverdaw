// Pure musical-time helpers shared by transport, timeline grid and tests.

import { beatsPerSnapStep, snapsFreely, type SnapGrid } from '@shared/snapGrid'

// Nudges a position that is already sitting on a grid line off it, so floating-point
// dust in the ms position cannot make a step land back on the line it started from.
const GRID_STEP_EPSILON_MS = 1e-6

export const DEFAULT_SUBS_PER_BEAT = 4
export const DEFAULT_BEATS_PER_BAR = 4

/** Milliseconds per sub-beat; clamps BPM to avoid infinite timeline geometry. */
export function msPerSubBeat(bpm: number, subsPerBeat: number = DEFAULT_SUBS_PER_BEAT): number {
  return 60000 / (Math.max(1, bpm) * subsPerBeat)
}

/**
 * Milliseconds in one snap step of `grid`, or 0 for **Free**, which means "do
 * not snap" — callers must branch on 0 rather than dividing by it.
 */
export function msPerSnapUnit(bpm: number, grid: SnapGrid): number {
  if (snapsFreely(grid)) return 0
  return (60000 / Math.max(1, bpm)) * beatsPerSnapStep(grid)
}

/**
 * Quantise a timeline position. `fineMode` (Alt) and a **Free** grid both give
 * exact 1 ms placement, so Alt stays a no-op rather than an inversion when the
 * grid is already free. Never returns a negative position.
 */
export function snapMs(positionMs: number, bpm: number, grid: SnapGrid, fineMode: boolean): number {
  const unit = fineMode ? 0 : msPerSnapUnit(bpm, grid)
  if (unit <= 0) return Math.max(0, Math.round(positionMs))
  return Math.max(0, Math.round(positionMs / unit) * unit)
}

/**
 * Step for a **Free** snap grid, where there is no grid line to walk to.
 *
 * A stepped control — the arrow keys, a MIDI jog detent — still needs a usable
 * increment, and a literal millisecond is not one: it takes thousands of presses
 * to cross a single bar. Free therefore borrows the Quarter beat step and
 * applies it *relative* to the current position, so movement stays as quick as
 * on any other grid while the off-grid placement is preserved. `Alt` remains the
 * fine, per-pixel override.
 */
export function freeGridStepMs(bpm: number): number {
  return msPerSubBeat(bpm)
}

/**
 * Walk one step along the snap grid from `positionMs`.
 *
 * Distinct from `snapMs`, which *rounds* to the nearest line: this always moves,
 * landing on the next line in `direction` even when the position is already on
 * one. That is what a stepped control needs — the arrow keys, a MIDI jog detent.
 *
 * On a **Free** grid there is no line to land on, so the step is applied
 * *relatively* and the off-grid position is preserved. Shared so every stepped
 * control agrees on both the epsilon and the Free-grid semantics.
 */
export function stepToGridMs(
  positionMs: number,
  bpm: number,
  grid: SnapGrid,
  direction: 1 | -1
): number {
  const unit = msPerSnapUnit(bpm, grid)
  if (unit <= 0) return Math.max(0, positionMs + direction * freeGridStepMs(bpm))
  return direction < 0
    ? Math.max(0, Math.floor((positionMs - GRID_STEP_EPSILON_MS) / unit) * unit)
    : (Math.floor(positionMs / unit + GRID_STEP_EPSILON_MS) + 1) * unit
}

/**
 * Clip start that puts the clip's first source beat on `alignedBeatMs`, a position
 * already resolved onto the snap grid.
 *
 * Beat-aware placement snaps the beat, not the clip's left edge, so the start is the
 * grid position minus the offset from the edge to that beat — which can fall before
 * the timeline origin. Clamping that to 0 keeps the clip on the timeline but throws
 * the beat off the line by the whole offset, and always in the same direction: a clip
 * dropped or dragged against the start of the timeline drew its first beat marker a
 * fraction of a beat ahead of bar 1, every time. Stepping forward by whole snap units
 * instead keeps the beat on a line, which is the point of aligning it at all.
 *
 * A **Free** grid has no line to step to, so there the clamp is all there is.
 */
export function startMsForAlignedBeat(
  alignedBeatMs: number,
  beatOffsetMs: number,
  bpm: number,
  grid: SnapGrid
): number {
  const startMs = alignedBeatMs - beatOffsetMs
  if (startMs >= 0) return startMs
  const unit = msPerSnapUnit(bpm, grid)
  if (unit <= 0) return 0
  return Math.max(0, startMs + Math.ceil(-startMs / unit) * unit)
}

export interface BarPositionOptions {
  subsPerBeat?: number
  beatsPerBar?: number
}

/** Format as 0-indexed `Bar.Beat.Sub` using integer sub-beats to avoid drift. */
export function barPositionDisplay(
  positionMs: number,
  bpm: number,
  options: BarPositionOptions = {}
): string {
  const subsPerBeat = options.subsPerBeat ?? DEFAULT_SUBS_PER_BEAT
  const beatsPerBar = options.beatsPerBar ?? DEFAULT_BEATS_PER_BAR
  const subsPerBar = subsPerBeat * beatsPerBar
  const msPerSub = msPerSubBeat(bpm, subsPerBeat)
  const totalSubs = Math.max(0, Math.round(positionMs / msPerSub))
  const bar = Math.floor(totalSubs / subsPerBar)
  const subsInBar = totalSubs % subsPerBar
  const beatInBar = Math.floor(subsInBar / subsPerBeat)
  const subInBeat = subsInBar % subsPerBeat
  return `${bar}.${beatInBar}.${subInBeat}`
}

/** Format milliseconds as `mm:ss` or `h:mm:ss`, clamping negatives to zero. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Format ruler labels as elapsed minutes and seconds at the supplied tick precision. */
export function formatRulerTime(ms: number, stepMs: number): string {
  const decimals = stepMs < 100 ? 2 : stepMs < 1000 ? 1 : 0
  const factor = 10 ** decimals
  const sign = ms < 0 ? '-' : ''
  const roundedSeconds = Math.round((Math.abs(ms) / 1000) * factor) / factor
  const minutes = Math.floor(roundedSeconds / 60)
  const seconds = roundedSeconds - minutes * 60
  const secondWidth = decimals === 0 ? 2 : decimals + 3
  return `${sign}${minutes}:${seconds.toFixed(decimals).padStart(secondWidth, '0')}`
}

/** Parse `ss`, `mm:ss` or `h:mm:ss` into milliseconds; malformed input returns `null`. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':').map((p) => p.trim())
  if (parts.length > 3) return null
  for (const p of parts) {
    if (p === '' || Number.isNaN(Number(p))) return null
  }
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 1) {
    s = Number(parts[0])
  } else if (parts.length === 2) {
    m = Number(parts[0])
    s = Number(parts[1])
  } else {
    h = Number(parts[0])
    m = Number(parts[1])
    s = Number(parts[2])
  }
  if (h < 0 || m < 0 || s < 0) return null
  return Math.round((h * 3600 + m * 60 + s) * 1000)
}
