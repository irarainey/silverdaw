// Shared layout, theme, and musical constants for the timeline canvas.
//
// These are split out of TimelineView.vue so the timeline composables
// (`useGridGeometry`, `useTimelineScroll`, `useDragHandlers`, etc.) can
// agree on a single source of truth without each composable having to
// import the others. The component itself also imports from here so the
// drawing code uses identical values.

// ─── Layout (pixels) ────────────────────────────────────────────────────────
/** Default height of a freshly-created track row. Individual tracks
 *  can override this via the user-resizable handle on each header. */
export const TRACK_HEIGHT = 120
/** Lower bound on per-track height. Picked so the M / S / Import / X
 *  controls and the volume slider remain visible without overflowing
 *  the header card. */
export const MIN_TRACK_HEIGHT = 60
/** Upper bound on per-track height. Picked so a single track can't
 *  hog the entire viewport leaving siblings off-screen. */
export const MAX_TRACK_HEIGHT = 400
export const TRACK_GAP = 4
export const RULER_HEIGHT = 28
// Reserved width of the vertical scrollbar lane and height of the
// horizontal one. The vertical lane is permanently reserved (always
// visible) to avoid layout jitter when content height changes; the
// horizontal lane is only reserved when its scrollbar is showing.
export const SCROLLBAR_HEIGHT = 12
export const SCROLLBAR_WIDTH = 12

// ─── Horizontal zoom (px per second) ────────────────────────────────────────
// The min/max caps prevent zooming to either a sliver or extreme
// densities where the per-clip / per-grid-line draw work starts to
// stall the UI thread. The 600 px/s ceiling (6× default) gives the
// user enough resolution to align clips on a sub-beat without making
// the redraw cost noticeable on larger projects.
export const DEFAULT_PX_PER_SECOND = 100
export const MIN_PX_PER_SECOND = 10
export const MAX_PX_PER_SECOND = 600
export const ZOOM_STEP_PX_PER_SECOND = 10

// ─── Musical grid ───────────────────────────────────────────────────────────
// SUBDIVISIONS_PER_BEAT=4 means quarter-beat resolution (i.e. 16th notes
// in 4/4), which is the coarsest snap target we want to support without
// making the grid too dense.
export const TIME_SIG_NUM = 4
export const SUBDIVISIONS_PER_BEAT = 4

// ─── Theme (matches tailwind zinc palette) ──────────────────────────────────
// The track-header column shares the transport bar's `bg-zinc-900` so the
// chrome reads as one continuous surface, while the timeline canvas itself
// stays a shade darker (`zinc-950`) to keep the editable area visually
// distinct from the surrounding UI.
export const BG = 0x09090b // zinc-950 (timeline canvas)
export const TRACK_BG = 0x18181b // zinc-900
export const TRACK_HEADER_BG = 0x18181b // zinc-900 (matches TransportBar)
export const RULER_BG = 0x18181b
export const RULER_TICK = 0x52525b // zinc-600 (ruler baseline + header divider)
export const RULER_LABEL_HINT = 0xa1a1aa // zinc-400 (bar-number labels)

// Three-tier grid hierarchy: bar lines the brightest, beat lines mid,
// sub-beat (quarter-beat) lines faintest. Used in both the ruler ticks
// and the full-height background grid.
export const GRID_BAR = 0x71717a // zinc-500
export const GRID_BEAT = 0x52525b // zinc-600
export const GRID_SUB = 0x3f3f46 // zinc-700

export const PLAYHEAD = 0xef4444 // red-500
export const MARKER = 0x10b981 // emerald-500

// ─── Transition (crossfade) overlay ─────────────────────────────────────────
// The X-fade marker drawn over the sanctioned overlap of two clips (§12.1).
// A faint sky-blue fill reads as "blended region" without obscuring the
// underlying waveforms; the crossing diagonals echo the equal-power
// cos/sin crossfade the engine applies.
export const TRANSITION_FILL = 0x38bdf8 // sky-400
export const TRANSITION_FILL_ALPHA = 0.18
export const TRANSITION_LINE = 0x7dd3fc // sky-300
export const TRANSITION_LINE_ALPHA = 0.9
