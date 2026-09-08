// A rigid beat grid synthesised from a tempo and a phase, for library items whose
// grid is known rather than detected: a window inherited from a source item, or a
// recording played against the project's own grid (ADR 0024, ADR 0030).
//
// The timeline and the Clip Editor both render a grid by extrapolating from
// (bpm, anchor), so the list this builds only has to agree with those two values —
// it never invents phase of its own.

/**
 * Beat times in seconds across `durationSec`, in phase with `anchorSec`.
 *
 * The first beat is the one at or after local time 0, so an anchor that sits
 * before the item's own start (a window cut out of a longer source) still
 * produces the same grid. Never returns an empty list for a valid tempo:
 * `setItemAnalysis` reads an empty list as "no grid" and drops the anchor with
 * it, which would leave an item holding a tempo but drawing no markers.
 */
export function buildRigidBeatGrid(bpm: number, anchorSec: number, durationSec: number): number[] {
  if (!(bpm > 0)) return []
  const spacingSec = 60 / bpm
  const span = durationSec > 0 ? durationSec : 0
  const firstBeat = anchorSec + Math.ceil((0 - anchorSec) / spacingSec) * spacingSec
  const beats: number[] = []
  for (let t = firstBeat; t <= span + 1e-6; t += spacingSec) beats.push(t)
  if (beats.length === 0) beats.push(Math.max(0, firstBeat))
  return beats
}
