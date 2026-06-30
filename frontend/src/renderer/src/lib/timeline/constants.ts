// Shared timeline layout, theme, and musical constants.

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
// Zoom caps keep redraw cost bounded while allowing sub-beat alignment.
export const DEFAULT_PX_PER_SECOND = 100
export const MIN_PX_PER_SECOND = 10
export const MAX_PX_PER_SECOND = 800
export const ZOOM_STEP_PX_PER_SECOND = 10

// ─── Musical grid ───────────────────────────────────────────────────────────
// Quarter-beat snap resolution keeps the grid useful without overcrowding.
export const TIME_SIG_NUM = 4
export const SUBDIVISIONS_PER_BEAT = 4

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
export const AUTOMATION_LANE_HEIGHT = 88
export const AUTOMATION_LANE_BG = 0x111114
export const AUTOMATION_LINE = 0x38bdf8 // sky-400
export const AUTOMATION_HANDLE = 0xe0f2fe // sky-100
export const AUTOMATION_HANDLE_RADIUS_PX = 4
