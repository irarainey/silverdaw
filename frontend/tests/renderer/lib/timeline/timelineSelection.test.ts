import { describe, expect, it } from 'vitest'
import { normaliseTimelineSelection } from '@/lib/timeline/timelineSelection'

describe('normaliseTimelineSelection', () => {
  it('orders a backward ruler drag into an ascending range', () => {
    expect(normaliseTimelineSelection(4000, 1000)).toEqual({ startMs: 1000, endMs: 4000 })
  })

  it('rejects an empty or non-finite range', () => {
    expect(normaliseTimelineSelection(1000, 1000)).toBeNull()
    expect(normaliseTimelineSelection(Number.NaN, 1000)).toBeNull()
  })
})
