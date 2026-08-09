import { describe, expect, it } from 'vitest'
import { scrollYToRevealRow } from '@/lib/timeline/trackLayout'

// A 400 px viewport over 1000 px of content, so the offset can run 0..600.
const VIEW = 400
const MAX = 600

describe('scrollYToRevealRow', () => {
  it('leaves the offset alone when the row is already fully visible', () => {
    expect(scrollYToRevealRow(100, 80, 0, VIEW, MAX)).toBe(0)
    expect(scrollYToRevealRow(500, 80, 300, VIEW, MAX)).toBe(300)
  })

  it('scrolls up to the row top when the row starts above the viewport', () => {
    expect(scrollYToRevealRow(100, 80, 300, VIEW, MAX)).toBe(100)
  })

  it('scrolls down just far enough to show the row bottom', () => {
    // Row 520..600 with the view at 0..400: 600 - 400 puts its bottom on the edge.
    expect(scrollYToRevealRow(520, 80, 0, VIEW, MAX)).toBe(200)
  })

  it('clamps to the scrollable range', () => {
    expect(scrollYToRevealRow(-50, 80, 300, VIEW, MAX)).toBe(0)
    expect(scrollYToRevealRow(950, 80, 0, VIEW, MAX)).toBe(MAX)
  })

  // A track expanded by automation lanes can be taller than the viewport, and
  // the lanes sit at the bottom of the row.
  it('shows the bottom of an oversized row when asked to align bottom', () => {
    // Row 300..900 is 600 px tall against a 400 px viewport, view at 400..800.
    expect(scrollYToRevealRow(300, 600, 400, VIEW, MAX, 'bottom')).toBe(500)
    // The default would have shown the top instead, hiding the new lane.
    expect(scrollYToRevealRow(300, 600, 400, VIEW, MAX, 'nearest')).toBe(300)
  })

  it('still scrolls up to a row that sits entirely above the viewport when aligning bottom', () => {
    expect(scrollYToRevealRow(100, 80, 400, VIEW, MAX, 'bottom')).toBe(100)
  })

  it('does not move for a visible row when aligning bottom', () => {
    expect(scrollYToRevealRow(100, 80, 0, VIEW, MAX, 'bottom')).toBe(0)
  })
})
