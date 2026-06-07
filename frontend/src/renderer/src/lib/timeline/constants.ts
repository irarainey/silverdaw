// Shared timeline layout, theme, and musical constants.

// ─── Layout (pixels) ────────────────────────────────────────────────────────
/** Default height of a freshly-created track row. */
export const TRACK_HEIGHT = 120
/** Minimum row height that still fits header controls. */
export const MIN_TRACK_HEIGHT = 60
/** Maximum row height so one track cannot dominate the viewport. */
export const MAX_TRACK_HEIGHT = 400
export const TRACK_GAP = 4
export const RULER_HEIGHT = 28
// Reserve the vertical scrollbar lane to avoid layout jitter.
export const SCROLLBAR_HEIGHT = 12
export const SCROLLBAR_WIDTH = 12

// ─── Horizontal zoom (px per second) ────────────────────────────────────────
// Zoom caps keep redraw cost bounded while allowing sub-beat alignment.
export const DEFAULT_PX_PER_SECOND = 100
export const MIN_PX_PER_SECOND = 10
export const MAX_PX_PER_SECOND = 600
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
