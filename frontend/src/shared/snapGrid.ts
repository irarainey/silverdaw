// The timeline snap grid: one user-selectable setting that drives both the
// interval every timeline-time edit quantises to and the density of the drawn
// grid lines, so what a user sees is what they snap to. Shared because the
// value round-trips through the bridge as project view state.

export const SNAP_GRIDS = ['bar', 'beat', 'half', 'quarter', 'free'] as const

export type SnapGrid = (typeof SNAP_GRIDS)[number]

/** Quarter beat preserves the behaviour that shipped before the grid was selectable. */
export const DEFAULT_SNAP_GRID: SnapGrid = 'quarter'

export function isSnapGrid(value: unknown): value is SnapGrid {
  return typeof value === 'string' && (SNAP_GRIDS as readonly string[]).includes(value)
}

/** Falls back to the default so an unknown or absent stored value never breaks the grid. */
export function toSnapGrid(value: unknown): SnapGrid {
  return isSnapGrid(value) ? value : DEFAULT_SNAP_GRID
}

/** Short label for the Snap control. */
export const SNAP_GRID_LABELS: Record<SnapGrid, string> = {
  bar: 'Bar',
  beat: 'Beat',
  half: 'Half beat',
  quarter: 'Quarter beat',
  free: 'Free'
}

/** Silverdaw is 4/4 throughout; this is the single definition of that assumption. */
export const BEATS_PER_BAR = 4

// Beats spanned by one snap step. `free` is 0, meaning "do not snap" rather
// than "snap to zero", so callers must branch on it instead of dividing by it.
const BEATS_PER_SNAP_STEP: Record<SnapGrid, number> = {
  bar: BEATS_PER_BAR,
  beat: 1,
  half: 0.5,
  quarter: 0.25,
  free: 0
}

export function snapsFreely(grid: SnapGrid): boolean {
  return grid === 'free'
}

export function beatsPerSnapStep(grid: SnapGrid): number {
  return BEATS_PER_SNAP_STEP[grid]
}

// Sub-beat tier the renderers draw. Kept to 1, 2 or 4 so the existing integer
// bar/beat tick maths still holds: at `beat` and `bar` every subdivision *is* a
// beat, which suppresses the fine tier and leaves the bar/beat hierarchy. `free`
// keeps the finest lines as a visual reference even though nothing snaps.
const GRID_SUBDIVISIONS_PER_BEAT: Record<SnapGrid, number> = {
  bar: 1,
  beat: 1,
  half: 2,
  quarter: 4,
  free: 4
}

export function gridSubdivisionsPerBeat(grid: SnapGrid): number {
  return GRID_SUBDIVISIONS_PER_BEAT[grid]
}
