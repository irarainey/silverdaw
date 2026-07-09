import { describe, expect, it, vi } from 'vitest'
import { inheritSourceAnalysis } from '@/lib/library/inheritSourceAnalysis'

// The composable imports the library store only for its type; passing a fake
// store into the function is enough, but the module-level import still runs, so
// keep it inert.
vi.mock('@/stores/libraryStore', () => ({ useLibraryStore: () => ({}) }))

type SetItemAnalysisArgs = [
  string,
  number,
  number,
  number[],
  boolean,
  string | undefined,
  boolean
]

function makeLibrary(targetDurationMs: number) {
  const setItemAnalysis = vi.fn()
  const setItemKey = vi.fn()
  const getItem = vi.fn((id: string) => ({ id, durationMs: targetDurationMs }))
  // Cast through unknown: the function only touches these three members.
  return {
    library: { getItem, setItemAnalysis, setItemKey } as unknown as Parameters<
      typeof inheritSourceAnalysis
    >[0],
    setItemAnalysis,
    setItemKey
  }
}

describe('inheritSourceAnalysis', () => {
  it('keeps the in-window detected beats when the window overlaps them', () => {
    const { library, setItemAnalysis } = makeLibrary(4000)
    const source = { bpm: 120, beats: [0.1, 0.5, 1.0, 1.5], beatAnchorSec: 0.5 }
    inheritSourceAnalysis(library, 'stem-1', source as never, 0.2)
    const args = setItemAnalysis.mock.calls[0] as SetItemAnalysisArgs
    expect(args[1]).toBe(120)
    expect(args[2]).toBeCloseTo(0.3, 10)
    // 0.1 → -0.1 drops; the rest shift back by 0.2 s.
    expect(args[3]).toEqual([0.3, 0.8, 1.3])
  })

  it('synthesises a phase-aligned grid when the window starts past the last beat', () => {
    // Source beats end at 59.6 s but the stem window starts at 77.9 s, so every
    // shifted beat is negative and dropped — the regression that hid the markers.
    const { library, setItemAnalysis } = makeLibrary(8000)
    const source = { bpm: 120, beats: [0.5, 30, 59.6], beatAnchorSec: 0.5 }
    inheritSourceAnalysis(library, 'stem-1', source as never, 77.9)
    const args = setItemAnalysis.mock.calls[0] as SetItemAnalysisArgs
    const [, bpm, anchor, beats] = args
    expect(bpm).toBe(120)
    // Anchor is the source phase shifted onto the stem timeline (negative is fine;
    // the grid is periodic).
    expect(anchor).toBeCloseTo(0.5 - 77.9, 10)
    // A 120 BPM grid is 0.5 s apart; the 8 s window fits ~16 beats, all >= 0 and
    // in phase with the anchor.
    expect(beats.length).toBeGreaterThan(0)
    expect(beats[0]).toBeGreaterThanOrEqual(0)
    expect(beats[0]).toBeLessThan(0.5)
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]! - beats[i - 1]!).toBeCloseTo(0.5, 10)
    }
    expect(beats[beats.length - 1]!).toBeLessThanOrEqual(8 + 1e-6)
  })

  it('still yields one beat when the derived duration is unknown', () => {
    const { library, setItemAnalysis } = makeLibrary(0)
    const source = { bpm: 120, beats: [0.5], beatAnchorSec: 0.5 }
    inheritSourceAnalysis(library, 'stem-1', source as never, 100)
    const args = setItemAnalysis.mock.calls[0] as SetItemAnalysisArgs
    expect(args[3].length).toBe(1)
    expect(args[3][0]).toBeGreaterThanOrEqual(0)
  })

  it('does nothing when the source has no tempo', () => {
    const { library, setItemAnalysis, setItemKey } = makeLibrary(8000)
    inheritSourceAnalysis(library, 'stem-1', { bpm: 0, beats: [] } as never, 10)
    expect(setItemAnalysis).not.toHaveBeenCalled()
    expect(setItemKey).not.toHaveBeenCalled()
  })
})
