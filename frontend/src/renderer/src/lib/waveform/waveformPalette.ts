// The one waveform palette.
//
// Every waveform in Silverdaw — the Clip Editor, the Record Audio dialog — is the
// same picture of the same kind of thing, so it is the same blue on the same
// baseline with the same beat grid over it. The colours live here as CSS strings
// because the Canvas-2D waveforms take them directly; the Clip Editor's Pixi
// theme derives its numeric colours from these, so the two cannot drift apart.

export const WAVEFORM_COLORS = {
  /** The waveform body. */
  wave: '#3b82f6',
  /** The zero line under it. */
  baseline: '#27272a',
  /** Beat and bar lines. */
  beat: '#facc15',
  /** The playback position. */
  playhead: '#f97316',
  /** The area behind the waveform (neutral-950). */
  background: '#0a0a0a'
} as const

/** Beat lines sit under the audio, not over it, so they are drawn faint. */
export const WAVEFORM_BEAT_ALPHA = 0.55

/** Bar lines are the same colour held back less, so bars read before beats. */
export const WAVEFORM_BAR_ALPHA = 0.9

/** A palette colour as the 24-bit integer Pixi wants. */
export function waveformColorValue(color: string): number {
  return Number.parseInt(color.slice(1), 16)
}
