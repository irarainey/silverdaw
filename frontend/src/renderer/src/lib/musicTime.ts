// Musical-time helpers — shared across the transport bar, the timeline
// grid composable and the (upcoming) MIDI/automation views.
//
// Single source of truth for the conversions that used to live duplicated
// inside `TransportBar.vue` and `useGridGeometry.ts`:
//
//   - `msPerSubBeat(bpm)` — milliseconds per sub-beat (snap unit).
//   - `barPositionDisplay(ms, bpm)` — "Bar.Beat.Sub" readout.
//   - `formatTime(ms)` / `parseTime(text)` — wall-clock readouts for the
//     position / project-length fields.
//
// Pure functions on purpose: no Pinia / Vue imports so they're trivial to
// unit-test in isolation (see `musicTime.test.ts`).

/** Sub-beats per beat used everywhere in the timeline (1/16 of a 4/4 bar). */
export const DEFAULT_SUBS_PER_BEAT = 4
/** Beats per bar used everywhere in the timeline (4/4 only for now). */
export const DEFAULT_BEATS_PER_BAR = 4

/**
 * Milliseconds per sub-beat at the given tempo.
 *
 * `Math.max(1, bpm)` guards the division — a `0` BPM is nonsense but
 * shouldn't blow up to `Infinity` and propagate `NaN` through the rest of
 * the timeline geometry.
 */
export function msPerSubBeat(bpm: number, subsPerBeat: number = DEFAULT_SUBS_PER_BEAT): number {
  return 60000 / (Math.max(1, bpm) * subsPerBeat)
}

export interface BarPositionOptions {
  subsPerBeat?: number
  beatsPerBar?: number
}

/**
 * Format a playhead position as `Bar.Beat.Sub` (0-indexed) — the usual
 * DAW convention.
 *
 * Operates on *integer* sub-beat counts (rather than fractional beats) so
 * floating-point drift doesn't push exact bar boundaries down to the
 * previous bar (e.g. 3.9999… → bar 0 beat 3 sub 3 instead of bar 1).
 * The error otherwise compounds with position and shows up most clearly
 * far along the timeline.
 */
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

/**
 * Format an absolute millisecond count as `mm:ss` (or `h:mm:ss` for clips
 * longer than an hour). Negative values clamp to zero so a transient
 * underflow during seek doesn't render as `NaN:NaN`.
 */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Parse a user-entered time string into milliseconds. Accepts `ss`,
 * `mm:ss` and `h:mm:ss` (fractional seconds allowed in the last
 * component). Returns `null` on a malformed input so the caller can fall
 * back to the previous value.
 */
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
