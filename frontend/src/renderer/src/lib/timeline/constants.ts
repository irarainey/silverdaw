// Shared timeline layout, theme, and musical constants.

import { BEATS_PER_BAR } from '@shared/snapGrid'

// ─── Layout (pixels) ────────────────────────────────────────────────────────
/** Default height of a freshly-created track row. */
export const TRACK_HEIGHT = 120
/** Minimum row height that still fits the stacked header controls (name,
 *  volume slider + meter, pan slider, and the button row) without cropping the
 *  pan or overlapping the buttons. Raised when pan moved into the header. */
export const MIN_TRACK_HEIGHT = 120
/** Maximum row height so one track cannot dominate the viewport. */
export const MAX_TRACK_HEIGHT = 400
export const TRACK_GAP = 2
export const RULER_HEIGHT = 28
/** Vertical inset (px) between a track row's edges and its clip blocks, applied
 *  top and bottom. Small so clips fill most of the row height. */
export const CLIP_VERTICAL_PADDING = 2
// Reserve the vertical scrollbar lane to avoid layout jitter.
export const SCROLLBAR_HEIGHT = 12
export const SCROLLBAR_WIDTH = 12

// ─── Horizontal zoom (px per second) ────────────────────────────────────────
// Zoom caps keep redraw cost bounded while allowing sub-beat alignment. The
// floor is low enough that Ctrl+F (zoom-to-fit) can show an hours-long project
// at once; the backend mirrors both bounds in `ProjectState::setViewPxPerSecond`
// (backend/src/project/ProjectStateSettings.cpp) — keep them in lockstep.
export const DEFAULT_PX_PER_SECOND = 100
export const MIN_PX_PER_SECOND = 0.1
export const MAX_PX_PER_SECOND = 800
/**
 * Multiplicative zoom factor per zoom key press / per full wheel notch (see
 * `zoomTargetFor` and `zoomTargetForDelta` in `useTimelineZoom`). Proportional
 * by design: the same gesture scales the zoom by this factor at every level,
 * instead of a fixed px-per-second delta that feels huge zoomed out and tiny
 * zoomed in. Keep the value subtle and tune here — 1.2 is ~20% per step.
 */
export const ZOOM_STEP_FACTOR = 1.2
/**
 * Wheel deltaY that counts as one notch (Chromium pixel-delta convention).
 * A touchpad pinch arrives as a rapid stream of much smaller deltas, which
 * `zoomTargetForDelta` converts into a proportionally smaller zoom change.
 */
export const ZOOM_WHEEL_NOTCH = 20

// ─── Ruler & grid density ───────────────────────────────────────────────────
// Below these spacings tiers would draw as a solid smear, so finer tiers are
// suppressed and the bar tier thins (see `barThinningStep`). Bars get a wider
// minimum than the beat/sub tiers: they are the strongest lines and read as
// solid walls when packed tighter than this.
export const MIN_TICK_SPACING_PX = 5
export const MIN_BAR_SPACING_PX = 10
export const MIN_BAR_LABEL_SPACING_PX = 40

// ─── Musical grid ───────────────────────────────────────────────────────────
// The drawn sub-beat tier follows the selected snap grid, so it is resolved per
// read from `useGridGeometry` rather than fixed here. 4/4 is defined once, in
// `@shared/snapGrid`.
export const TIME_SIG_NUM = BEATS_PER_BAR

// ─── Theme (matches tailwind zinc palette) ──────────────────────────────────
export const BG = 0x09090b // zinc-950 (timeline canvas)
export const TRACK_BG = 0x18181b // zinc-900
export const TRACK_HEADER_BG = 0x18181b // zinc-900 (matches TransportBar)
export const RULER_BG = 0x18181b
export const RULER_TICK = 0x52525b // zinc-600 (ruler baseline + header divider)
export const RULER_LABEL_HINT = 0xa1a1aa // zinc-400 (bar-number labels)

// Three-tier grid hierarchy: bar, beat, then sub-beat.
export const GRID_BAR = 0x71717a // zinc-500
export const GRID_BEAT = 0x52525b // zinc-600
export const GRID_SUB = 0x3f3f46 // zinc-700

export const PLAYHEAD = 0xef4444 // red-500
export const MARKER = 0x10b981 // emerald-500

// ─── Transition (crossfade) overlay ─────────────────────────────────────────
// X-fade overlay for sanctioned clip overlaps.
export const TRANSITION_FILL = 0x38bdf8 // sky-400
export const TRANSITION_FILL_ALPHA = 0.18
export const TRANSITION_LINE = 0x7dd3fc // sky-300
export const TRANSITION_LINE_ALPHA = 0.9

// ─── Beat Repeat ───────────────────────────────────────────────────────────
// A quiet sky overlay marks a per-track captured-loop region. The beat-division
// bars make the stutter density readable without obscuring the waveform.
export const BEAT_REPEAT_FILL = 0x38bdf8 // sky-400
export const BEAT_REPEAT_FILL_ALPHA = 0.14
export const BEAT_REPEAT_LINE = 0x7dd3fc // sky-300
export const BEAT_REPEAT_LINE_ALPHA = 0.8

// ─── Clip overlap hatch ─────────────────────────────────────────────────────
// Diagonal hatch marking any region where two clips on a track overlap. Amber
// reads clearly over every track-palette colour and stays distinct from the
// blue crossfade curves, so the shared region is obvious even mid-drag, before
// a transition is committed.
export const OVERLAP_HATCH = 0xfbbf24 // amber-400
export const OVERLAP_HATCH_ALPHA = 0.55
export const OVERLAP_HATCH_SPACING_PX = 7

// ─── Turntable brake (record-stop) ──────────────────────────────────────────
// Overlay marking the tail region where a clip decelerates to a stop. Red reads
// as "stop" and stays distinct from the blue crossfade curves and amber overlap
// hatch. The duration + curve come from the brake-settings store (the app
// preference, mirrored to the backend), so the overlay tracks the live setting.
export const BRAKE_FILL = 0xf87171 // red-400
export const BRAKE_FILL_ALPHA = 0.16
export const BRAKE_LINE = 0xfca5a5 // red-300
export const BRAKE_LINE_ALPHA = 0.95

// ─── Turntable backspin (reverse rewind) ────────────────────────────────────
// Overlay marking the tail region where a clip rewinds backwards to a stop.
// Violet distinguishes it from the red brake and blue crossfades. Duration +
// curve come from the backspin-settings store (the app preference).
export const BACKSPIN_FILL = 0xa78bfa // violet-400
export const BACKSPIN_FILL_ALPHA = 0.16
export const BACKSPIN_LINE = 0xc4b5fd // violet-300
export const BACKSPIN_LINE_ALPHA = 0.95

// Automation lane: a strip reserved at the bottom of a track row when a
// parameter's curve is shown. Clips compress into the remaining height above it.
export const AUTOMATION_LANE_HEIGHT = 80
export const AUTOMATION_LANE_DIVIDER = 0x52525b // zinc-600
export const AUTOMATION_LINE = 0x38bdf8 // sky-400
export const AUTOMATION_HANDLE = 0xe0f2fe // sky-100
export const AUTOMATION_HANDLE_SELECTED = 0x0284c7 // sky-600
export const AUTOMATION_HANDLE_RADIUS_PX = 4
