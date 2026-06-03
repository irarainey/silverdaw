// Single source of truth for the timeline horizontal-zoom presets surfaced
// under View ▸ Zoom Presets. The menu (`menu.ts`), the menu-action handler
// (`App.vue`), and the unit tests all go through the helpers here so the
// preset list, the action-string grammar, and the percent labelling can
// never drift apart.

import { DEFAULT_PX_PER_SECOND } from './constants'

/**
 * Zoom presets expressed directly in px-per-second (NOT percent). Each value
 * is an exact multiple of `ZOOM_STEP_PX_PER_SECOND` (10) and sits inside
 * `[MIN_PX_PER_SECOND, MAX_PX_PER_SECOND]`, so it round-trips through
 * `useGridGeometry.setPxPerSecond` (which snaps to the step and clamps)
 * without the stored value drifting away from the chosen preset.
 *
 * Ordered low → high so the menu reads zoomed-out → zoomed-in.
 */
export const ZOOM_PRESET_PX_PER_SECOND = [20, 50, 100, 200, 400] as const

const ZOOM_PRESET_ACTION_PREFIX = 'view.zoomPreset:'

/** Percentage label for a px/sec zoom level (100 px/s = 100%). */
export function zoomPercentLabel(pxPerSecond: number): string {
  return `${Math.round((pxPerSecond / DEFAULT_PX_PER_SECOND) * 100)}%`
}

/** Menu action ID for a preset, e.g. `view.zoomPreset:200`. */
export function zoomPresetAction(pxPerSecond: number): string {
  return `${ZOOM_PRESET_ACTION_PREFIX}${pxPerSecond}`
}

/** True when `action` is a (possibly malformed) zoom-preset action ID. */
export function isZoomPresetAction(action: string): boolean {
  return action.startsWith(ZOOM_PRESET_ACTION_PREFIX)
}

/**
 * Decode a preset action to its px/sec value, or `null` when the action is
 * not a recognised preset. Validating against `ZOOM_PRESET_PX_PER_SECOND`
 * keeps the dispatch constrained to the values the menu actually offers, so
 * a drifted or hand-crafted action string can't push an arbitrary zoom.
 */
export function parseZoomPresetAction(action: string): number | null {
  if (!isZoomPresetAction(action)) return null
  const raw = Number.parseInt(action.slice(ZOOM_PRESET_ACTION_PREFIX.length), 10)
  return (ZOOM_PRESET_PX_PER_SECOND as readonly number[]).includes(raw) ? raw : null
}
