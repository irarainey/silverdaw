// Display-only auto-fit for the recording waveforms.
//
// A voice or an instrument recorded at a sensible level peaks well below full
// scale — a mic take sitting around -18 dBFS is normal and correct — while a
// mastered track is limited to within a decibel of the ceiling. Drawn literally
// at the same scale, the take is a thin line next to a solid block even though
// the two sound equally loud, because loudness is not peak amplitude.
//
// So the *recording* views auto-fit: the record dialog and the review pane are
// asking "is this a good take", a question about shape, timing and clipping, and
// a shape you cannot see answers nothing. The **timeline deliberately does not**
// — there, every clip shares one scale, and that is what makes the lanes
// comparable at a glance and a quiet clip visibly quiet.
//
// This scales pixels only. The file, its peaks cache, the meters and everything
// downstream are untouched.

/** Leaves the loudest peak just short of the edge so it still reads as a peak. */
export const WAVEFORM_FILL_HEADROOM = 0.94

/** A quiet take is drawn up, but only so far: past this the noise bed comes with
 *  it and a near-silent take would be drawn as though it were a performance. */
export const WAVEFORM_MAX_BOOST = 8

/**
 * How much to multiply peak magnitudes by so the loudest one just fills the box.
 *
 * `loudest` is the largest absolute magnitude in the data being drawn. Returns 1
 * for silence, so an empty view is drawn flat rather than amplified into noise.
 */
export function waveformFillScale(loudest: number): number {
  if (!(loudest > 0)) return 1
  return Math.min(WAVEFORM_MAX_BOOST, WAVEFORM_FILL_HEADROOM / loudest)
}
