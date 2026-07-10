// Decibel helpers for UI gain: linear storage, dB display, tapered sliders, parsing.

/** Display floor in dB; exact linear zero still renders as `"-∞"`. */
export const MIN_DISPLAY_DB = -60

/** Internal floor keeps tiny non-zero gains finite. */
const MIN_INTERNAL_DB = -120

/** Maximum boost above unity for the per-track fader. */
export const MAX_TRACK_DB = 6

/** Master bus never boosts above unity to avoid clipping. */
export const MAX_MASTER_DB = 0

/** Linear-gain equivalent of `MAX_TRACK_DB`, keeping store clamps in sync. */
export const MAX_TRACK_GAIN_LINEAR = Math.pow(10, MAX_TRACK_DB / 20)

/** Bottom fader slice snaps to true silence. */
const TAPER_INFINITY_FRACTION = 0.02

/** Front-load useful gain while retaining fine control near unity. */
const FADER_TAPER_EXPONENT = 0.4

/** Convert a linear gain (>=0) to dB. Returns `-Infinity` for `linear <= 0`. */
export function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return -Infinity
  const db = 20 * Math.log10(linear)
  // Keep downstream taper math finite for sub-denormal inputs.
  return db < MIN_INTERNAL_DB ? MIN_INTERNAL_DB : db
}

/** Convert dB to linear gain; `-Infinity` maps to exact zero. */
export function dbToLinear(db: number): number {
  if (db === -Infinity || (Number.isFinite(db) && db <= MIN_INTERNAL_DB)) return 0
  if (!Number.isFinite(db)) return 0
  return Math.pow(10, db / 20)
}

/** Format dB for UI readouts; only exact `-Infinity` renders as `"-∞"`. */
export function formatDb(db: number, options: { unit?: boolean; decimals?: number } = {}): string {
  const { unit = false, decimals = 1 } = options
  if (db === -Infinity) return unit ? '-∞ dB' : '-∞'
  if (!Number.isFinite(db)) return unit ? '-∞ dB' : '-∞'
  const clamped = db <= MIN_DISPLAY_DB ? MIN_DISPLAY_DB : db
  const sign = clamped >= 0 ? '+' : ''
  return `${sign}${clamped.toFixed(decimals)}${unit ? ' dB' : ''}`
}

export function formatLinearAsDb(
  linear: number,
  options: { unit?: boolean; decimals?: number } = {}
): string {
  return formatDb(linearToDb(linear), options)
}

/** Map slider position to dB with a silence band and audio-style tapered travel. */
export function taperPositionToDb(pos: number, maxDb: number): number {
  if (!Number.isFinite(pos) || pos <= 0) return -Infinity
  if (pos <= TAPER_INFINITY_FRACTION) return MIN_DISPLAY_DB
  const clamped = pos >= 1 ? 1 : pos
  const t = (clamped - TAPER_INFINITY_FRACTION) / (1 - TAPER_INFINITY_FRACTION)
  return MIN_DISPLAY_DB + Math.pow(t, FADER_TAPER_EXPONENT) * (maxDb - MIN_DISPLAY_DB)
}

/** Inverse of `taperPositionToDb`; true mute returns slider position 0. */
export function taperDbToPosition(db: number, maxDb: number): number {
  if (db === -Infinity) return 0
  if (!Number.isFinite(db)) return 0
  if (db <= MIN_DISPLAY_DB) return TAPER_INFINITY_FRACTION
  if (db >= maxDb) return 1
  const tapered = (db - MIN_DISPLAY_DB) / (maxDb - MIN_DISPLAY_DB)
  const t = Math.pow(tapered, 1 / FADER_TAPER_EXPONENT)
  return TAPER_INFINITY_FRACTION + t * (1 - TAPER_INFINITY_FRACTION)
}

export function linearToTaperPosition(linear: number, maxDb: number): number {
  return taperDbToPosition(linearToDb(linear), maxDb)
}

export function taperPositionToLinear(pos: number, maxDb: number): number {
  return dbToLinear(taperPositionToDb(pos, maxDb))
}

/** Parse typed dB input, including unit suffixes and minus-infinity spellings. */
export function parseDbInput(raw: string): number | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase()
  if (s.length === 0) return null
  if (s.endsWith('db')) s = s.slice(0, -2).trim()
  if (s === '-∞' || s === '-inf' || s === '-infinity') return -Infinity
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}
