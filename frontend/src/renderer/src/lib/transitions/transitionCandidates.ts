// §12.1 — pure geometry for the clip-to-clip crossfade ("transition")
// CREATION gesture. When the user drags a clip's edge over a same-track
// neighbour, this decides whether the resulting overlap is a clean
// candidate for a sanctioned transition.
//
// This is a UX PREFILTER, not the authority: the backend `addTransition`
// re-validates the exact same invariant and is the sole judge (it simply
// leaves state unchanged and rebroadcasts `PROJECT_STATE` on rejection).
// We mirror only the candidate SHAPE here so we don't emit obviously-doomed
// `TRANSITION_CREATE` envelopes — keeping the logic in one tested unit
// rather than inline in the store keeps it from drifting.

/** Timeline geometry of one clip, in master-timeline milliseconds.
 *  `endMs` is `startMs + effectiveDurationMs` (the warp-scaled footprint,
 *  never the raw source `durationMs`). */
export interface ClipGeometry {
  readonly id: string
  readonly startMs: number
  readonly endMs: number
}

/** The clip-id pair of an existing transition on the same track. */
export interface ExistingTransitionPair {
  readonly leftClipId: string
  readonly rightClipId: string
}

/** A clean (left, right) pair ready to be sent as `TRANSITION_CREATE`. */
export interface TransitionCandidate {
  readonly leftClipId: string
  readonly rightClipId: string
}

/** Minimum overlap (ms) before a drag-created overlap is treated as an
 *  intentional crossfade. Grid snapping can leave a 1–2 ms overlap that the
 *  user never meant as a transition; the backend only rejects a strictly
 *  degenerate (zero-width) span, so this frontend gesture floor avoids
 *  surprise micro-transitions. */
export const MIN_AUTO_TRANSITION_OVERLAP_MS = 10

const EPS = 1e-6

/**
 * Find the same-track neighbour that the just-trimmed clip now forms a
 * valid tail/head crossfade with, or `null` if there is no clean candidate.
 *
 * `edge` is the edge the user dragged:
 *  - `'right'` → the trimmed clip extended its tail rightward, so it is the
 *    LEFT (fade-out) partner and we look for a following RIGHT partner.
 *  - `'left'`  → the trimmed clip extended its head leftward, so it is the
 *    RIGHT (fade-in) partner and we look for a preceding LEFT partner.
 *
 * Mirrors the backend invariant: a proper tail/head overlap
 * `leftStart < rightStart < leftEnd <= rightEnd`, at least
 * `minOverlapMs` wide, no THIRD clip intruding the overlap, and the
 * single-neighbour reuse rule (a clip may be the LEFT of at most one
 * transition and the RIGHT of at most one — so a "sandwiched" clip used as
 * the right of one transition can still become the left of another).
 */
export function findTransitionCandidate(
  trimmed: ClipGeometry,
  edge: 'left' | 'right',
  others: readonly ClipGeometry[],
  existing: readonly ExistingTransitionPair[],
  minOverlapMs: number = MIN_AUTO_TRANSITION_OVERLAP_MS
): TransitionCandidate | null {
  for (const other of others) {
    if (other.id === trimmed.id) continue

    const left = edge === 'right' ? trimmed : other
    const right = edge === 'right' ? other : trimmed

    // Proper tail/head shape (rejects equal starts and full containment).
    if (
      !(
        left.startMs + EPS < right.startMs &&
        right.startMs + EPS < left.endMs &&
        left.endMs <= right.endMs + EPS
      )
    ) {
      continue
    }

    const overlapStart = right.startMs
    const overlapEnd = left.endMs // == min(left.endMs, right.endMs) given the shape
    if (overlapEnd - overlapStart < minOverlapMs) continue

    // Single-neighbour reuse: this left can't already fade out into another
    // right, and this right can't already fade in from another left.
    if (existing.some((t) => t.leftClipId === left.id)) continue
    if (existing.some((t) => t.rightClipId === right.id)) continue

    // No third clip may intrude into the sanctioned overlap region.
    const intruded = others.some(
      (o) =>
        o.id !== left.id &&
        o.id !== right.id &&
        o.startMs + EPS < overlapEnd &&
        o.endMs - EPS > overlapStart
    )
    if (intruded) continue

    return { leftClipId: left.id, rightClipId: right.id }
  }

  return null
}
