import { describe, expect, it } from 'vitest'
import {
  findTransitionCandidate,
  MIN_AUTO_TRANSITION_OVERLAP_MS,
  type ClipGeometry,
  type ExistingTransitionPair
} from '@/lib/transitions/transitionCandidates'

function clip(id: string, startMs: number, endMs: number): ClipGeometry {
  return { id, startMs, endMs }
}

describe('findTransitionCandidate', () => {
  it('detects a right-edge trim extending into a following neighbour', () => {
    // A: 0–1000, B: 800–1800. A's tail overlaps B's head by 200 ms.
    const a = clip('a', 0, 1000)
    const b = clip('b', 800, 1800)
    const candidate = findTransitionCandidate(a, 'right', [b], [])
    expect(candidate).toEqual({ leftClipId: 'a', rightClipId: 'b' })
  })

  it('detects a left-edge trim extending into a preceding neighbour', () => {
    // A: 0–1000, B: 800–1800. Trimming B's left edge left makes B the right
    // partner and A the left partner.
    const a = clip('a', 0, 1000)
    const b = clip('b', 800, 1800)
    const candidate = findTransitionCandidate(b, 'left', [a], [])
    expect(candidate).toEqual({ leftClipId: 'a', rightClipId: 'b' })
  })

  it('rejects when the right clip is fully contained in the left', () => {
    // B sits entirely inside A — not a tail/head shape.
    const a = clip('a', 0, 2000)
    const b = clip('b', 500, 1500)
    expect(findTransitionCandidate(a, 'right', [b], [])).toBeNull()
  })

  it('rejects equal starts', () => {
    const a = clip('a', 0, 1000)
    const b = clip('b', 0, 1200)
    expect(findTransitionCandidate(a, 'right', [b], [])).toBeNull()
  })

  it('rejects an overlap below the minimum threshold', () => {
    // 5 ms overlap < MIN (10 ms).
    const a = clip('a', 0, 1000)
    const b = clip('b', 995, 1995)
    expect(findTransitionCandidate(a, 'right', [b], [])).toBeNull()
    // Same geometry, lowered threshold ⇒ accepted.
    expect(findTransitionCandidate(a, 'right', [b], [], 1)).toEqual({
      leftClipId: 'a',
      rightClipId: 'b'
    })
    expect(MIN_AUTO_TRANSITION_OVERLAP_MS).toBe(10)
  })

  it('rejects a duplicate (left already fades out into a right)', () => {
    const a = clip('a', 0, 1000)
    const b = clip('b', 800, 1800)
    const existing: ExistingTransitionPair[] = [{ leftClipId: 'a', rightClipId: 'b' }]
    expect(findTransitionCandidate(a, 'right', [b], existing)).toBeNull()
  })

  it('rejects a third clip intruding the overlap region', () => {
    // A: 0–1000, B: 800–1800, C: 850–950 sits inside the 800–1000 overlap.
    const a = clip('a', 0, 1000)
    const b = clip('b', 800, 1800)
    const c = clip('c', 850, 950)
    expect(findTransitionCandidate(a, 'right', [b, c], [])).toBeNull()
  })

  it('allows a sandwich: B can be the right of A→B and the left of B→C', () => {
    // A→B already exists. Now A:0–1000, B:800–2000, C:1800–2800.
    // Trimming B's right edge into C makes B the left partner of B→C.
    const b = clip('b', 800, 2000)
    const c = clip('c', 1800, 2800)
    const existing: ExistingTransitionPair[] = [{ leftClipId: 'a', rightClipId: 'b' }]
    // B is used as a RIGHT (in A→B); using it as a LEFT (in B→C) is allowed.
    expect(findTransitionCandidate(b, 'right', [c], existing)).toEqual({
      leftClipId: 'b',
      rightClipId: 'c'
    })
  })

  it('rejects reusing a clip as left when it already fades out elsewhere', () => {
    // B already fades out into C (B is a LEFT). It cannot also be the left of
    // a second transition.
    const b = clip('b', 800, 2000)
    const d = clip('d', 1700, 2700)
    const existing: ExistingTransitionPair[] = [{ leftClipId: 'b', rightClipId: 'c' }]
    expect(findTransitionCandidate(b, 'right', [d], existing)).toBeNull()
  })
})
