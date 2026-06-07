// Geometry prefilter for drag-created crossfade candidates; backend still validates.

/** Timeline clip geometry; `endMs` is the warp-scaled footprint. */
export interface ClipGeometry {
  readonly id: string
  readonly startMs: number
  readonly endMs: number
}

export interface ExistingTransitionPair {
  readonly leftClipId: string
  readonly rightClipId: string
}

export interface TransitionCandidate {
  readonly leftClipId: string
  readonly rightClipId: string
}

/** Gesture floor to avoid snap-induced micro-transitions. */
export const MIN_AUTO_TRANSITION_OVERLAP_MS = 10

const EPS = 1e-6

/**
 * Find a clean tail/head overlap matching backend transition invariants.
 * Dragging `right` makes the trimmed clip the left partner; `left` makes it the right partner.
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
    const overlapEnd = left.endMs
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
