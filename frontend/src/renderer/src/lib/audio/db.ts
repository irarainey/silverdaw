// Decibel-domain helpers for the UI gain layer.
//
// The backend and project files store *linear* gain (0..MAX_TRACK_GAIN_LINEAR
// for tracks, 0..1 for the master). The UI presents gain in dB to match
// professional DAW convention — see GarageBand / Logic / Ableton, which
// all use dB on fader readouts and tooltips. This module is the single
// source of truth for:
//
//   - linear ↔ dB conversion (with explicit `-Infinity` ↔ `0` handling)
//   - the slider-position taper that puts 0 dB near the top of fader
//     travel (rather than in the middle), giving fine resolution in
//     the audible range
//   - human-readable formatting (`"+0.0"`, `"-3.5"`, `"-∞"`)
//   - tolerant text parsing (`"-3"`, `"+1.5 dB"`, `"-inf"`)
//
// All maths are pure and deterministic — no I/O, no Vue / Pinia — so
// they're trivially unit-testable.

/** Display floor in dB. Anything at or below this is rendered as the
 * floor's literal value (e.g. `"-60.0"`) *unless* the underlying linear
 * gain is exactly 0, in which case we render `"-∞"`. Keeping these two
 * semantics distinct prevents the user from typing `-60` and seeing
 * `-∞` (which would imply silence when the channel is actually still
 * passing audible signal). */
export const MIN_DISPLAY_DB = -60

/** Internal arithmetic floor — never surfaced to the UI. Used to keep
 * `linearToDb` finite for tiny but non-zero values so downstream maths
 * (taper position, slider clamping) never see `-Infinity` unless the
 * caller explicitly passed `0`. */
const MIN_INTERNAL_DB = -120

/** Maximum boost above unity for the per-track fader. +6 dB matches
 * Logic Pro / Ableton Live / GarageBand. */
export const MAX_TRACK_DB = 6

/** The master bus does not allow boost above unity — pushing the
 * digital ceiling there courts inter-sample clipping with no benefit
 * the user can't get by lifting individual track faders. */
export const MAX_MASTER_DB = 0

/** Linear-gain equivalent of `MAX_TRACK_DB`. ≈1.9953. Drives the
 * project store's `MAX_TRACK_VOLUME` clamp so the cap stays in sync
 * with the dB ceiling above. */
export const MAX_TRACK_GAIN_LINEAR = Math.pow(10, MAX_TRACK_DB / 20)

/** Bottom slice of the fader (0..TAPER_INFINITY_FRACTION) snaps to
 * exactly `-Infinity` so the user can drag fully to silence without
 * having to land precisely on position 0. */
const TAPER_INFINITY_FRACTION = 0.02

/** Above that, the fader is linear in dB from `MIN_DISPLAY_DB` up to
 * `maxDb`. Choosing 0.02 (rather than 0) for the silence band means a
 * tiny visual "dead zone" at the bottom of the bar, matching how
 * physical motorised faders behave. */

/** Convert a linear gain (>=0) to dB. Returns `-Infinity` for `linear <= 0`. */
export function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return -Infinity
  const db = 20 * Math.log10(linear)
  // Clamp the internal range so callers that immediately re-feed the
  // result into `dbToLinear` or `taperDbToPosition` don't have to
  // special-case extremely negative values from sub-denormal inputs.
  return db < MIN_INTERNAL_DB ? MIN_INTERNAL_DB : db
}

/** Convert dB back to linear gain. `-Infinity` maps to exactly `0` so
 * a true mute round-trips through the display layer without leaking a
 * tiny residual that would be audible after summing with the rest of
 * the mix. */
export function dbToLinear(db: number): number {
  if (db === -Infinity || (Number.isFinite(db) && db <= MIN_INTERNAL_DB)) return 0
  if (!Number.isFinite(db)) return 0
  return Math.pow(10, db / 20)
}

/** Human-readable dB formatter for the in-UI readouts (track gain
 * column, tooltips). Returns `"-∞"` ONLY when the input is `-Infinity`,
 * otherwise a signed fixed-point string. The `unit` flag appends `" dB"`
 * for tooltips; compact readouts omit it. */
export function formatDb(db: number, options: { unit?: boolean; decimals?: number } = {}): string {
  const { unit = false, decimals = 1 } = options
  if (db === -Infinity) return unit ? '-∞ dB' : '-∞'
  if (!Number.isFinite(db)) return unit ? '-∞ dB' : '-∞'
  const clamped = db <= MIN_DISPLAY_DB ? MIN_DISPLAY_DB : db
  const sign = clamped >= 0 ? '+' : ''
  return `${sign}${clamped.toFixed(decimals)}${unit ? ' dB' : ''}`
}

/** Convenience: format a linear gain directly. */
export function formatLinearAsDb(
  linear: number,
  options: { unit?: boolean; decimals?: number } = {}
): string {
  return formatDb(linearToDb(linear), options)
}

/**
 * Map a slider position in [0, 1] to a dB value, using a real-DAW
 * tapered curve:
 *
 *   - `pos === 0`                          → `-Infinity`  (true mute)
 *   - `pos in (0, TAPER_INFINITY_FRACTION]` → `MIN_DISPLAY_DB`
 *   - `pos > TAPER_INFINITY_FRACTION`       → linear-in-dB ramp from
 *                                              `MIN_DISPLAY_DB` to `maxDb`
 *
 * Result: 0 dB lands near the *top* of the fader (≈91% travel for the
 * track fader's +6 dB ceiling; exactly 100% travel for the master's
 * 0 dB ceiling). The lower 3/4 of the bar covers the wide
 * `[-60, 0]` dB attenuation range where the user does most of their
 * mixing.
 */
export function taperPositionToDb(pos: number, maxDb: number): number {
  if (!Number.isFinite(pos) || pos <= 0) return -Infinity
  if (pos <= TAPER_INFINITY_FRACTION) return MIN_DISPLAY_DB
  const clamped = pos >= 1 ? 1 : pos
  const t = (clamped - TAPER_INFINITY_FRACTION) / (1 - TAPER_INFINITY_FRACTION)
  return MIN_DISPLAY_DB + t * (maxDb - MIN_DISPLAY_DB)
}

/** Inverse of `taperPositionToDb`. `-Infinity` maps to `0` so a muted
 * track round-trips back to slider position 0. */
export function taperDbToPosition(db: number, maxDb: number): number {
  if (db === -Infinity) return 0
  if (!Number.isFinite(db)) return 0
  if (db <= MIN_DISPLAY_DB) return TAPER_INFINITY_FRACTION
  if (db >= maxDb) return 1
  const t = (db - MIN_DISPLAY_DB) / (maxDb - MIN_DISPLAY_DB)
  return TAPER_INFINITY_FRACTION + t * (1 - TAPER_INFINITY_FRACTION)
}

/** Linear ↔ slider-position helpers — what the `<input type="range">`
 * actually binds to. Keeps the taper transformation hidden from the
 * components so they just hand us linear gain and a position. */
export function linearToTaperPosition(linear: number, maxDb: number): number {
  return taperDbToPosition(linearToDb(linear), maxDb)
}

export function taperPositionToLinear(pos: number, maxDb: number): number {
  return dbToLinear(taperPositionToDb(pos, maxDb))
}

/** Parse user-typed dB input. Tolerates leading `+`, trailing whitespace,
 * trailing `dB`/`db` unit suffix, and the canonical "minus infinity"
 * spellings (`"-inf"`, `"-infinity"`, `"-∞"`). Returns `null` when the
 * input is unrecognisable so the caller can reject the commit and keep
 * the previous value. */
export function parseDbInput(raw: string): number | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase()
  if (s.length === 0) return null
  // Strip an optional unit suffix.
  if (s.endsWith('db')) s = s.slice(0, -2).trim()
  if (s === '-∞' || s === '-inf' || s === '-infinity') return -Infinity
  // `+0.5` and `+0` are valid; `Number('+0.5')` is fine.
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}
