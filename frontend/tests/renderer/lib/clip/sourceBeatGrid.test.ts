import { describe, it, expect } from 'vitest'
import {
  clipFirstBeatOffsetMs,
  clipTimelineBeatSpacingMs,
  firstSourceBeatMsAtOrAfter,
  resolveSourceBeatGrid
} from '@/lib/clip/sourceBeatGrid'
import type { LibraryItem } from '@/stores/libraryTypes'

/** A minimally valid library item; tests override only the grid-relevant fields. */
function makeItem(overrides: Partial<LibraryItem> & { id: string }): LibraryItem {
  return {
    kind: 'source',
    filePath: `C:\\${overrides.id}.wav`,
    fileName: `${overrides.id}.wav`,
    durationMs: 10_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array(),
    playbackFilePath: `C:\\${overrides.id}.wav`,
    ...overrides
  }
}

// 120 bpm -> 500 ms per beat, anchored at 0 s.
const source = makeItem({ id: 'src', bpm: 120, beats: [0, 0.5, 1], beatAnchorSec: 0 })

describe('resolveSourceBeatGrid', () => {
  it('resolves the grid from the item itself', () => {
    expect(resolveSourceBeatGrid(source, { src: source })).toEqual({
      bpm: 120,
      spacingMs: 500,
      anchorMs: 0
    })
  })

  it('inherits bpm, beats, and anchor from the source item', () => {
    // A stem carries its own audio but inherits the source's musical identity.
    const stem = makeItem({ id: 'stem', kind: 'stem', derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 10_000 } })
    expect(resolveSourceBeatGrid(stem, { src: source, stem })).toEqual({
      bpm: 120,
      spacingMs: 500,
      anchorMs: 0
    })
  })

  it('falls back to the first beat when no anchor was persisted', () => {
    const legacy = makeItem({ id: 'legacy', bpm: 120, beats: [0.25, 0.75] })
    expect(resolveSourceBeatGrid(legacy, { legacy })?.anchorMs).toBe(250)
  })

  it('has no grid for a simple one-shot, even with detected beats', () => {
    const oneShot = makeItem({ id: 'hit', bpm: 120, beats: [0], audioType: 'simple' })
    expect(resolveSourceBeatGrid(oneShot, { hit: oneShot })).toBeNull()
  })

  it('has no grid when the item inherits a simple classification', () => {
    const simpleSource = makeItem({ id: 'ssrc', bpm: 120, beats: [0], audioType: 'simple' })
    const derived = makeItem({ id: 'cut', kind: 'clip', derivedFrom: { sourceItemId: 'ssrc', inMs: 0, durationMs: 10_000 } })
    expect(resolveSourceBeatGrid(derived, { ssrc: simpleSource, cut: derived })).toBeNull()
  })

  it('has no grid for a one-shot on any caller, including Chop to Grid', () => {
    // The opt-out is gone: a simple sample cannot hold a BPM, so there is never a
    // grid to chop against, and no caller may resolve lines nothing draws.
    const oneShot = makeItem({ id: 'hit', bpm: 120, beats: [0], beatAnchorSec: 0, audioType: 'simple' })
    expect(resolveSourceBeatGrid(oneShot, { hit: oneShot })).toBeNull()
  })

  it('inherits a bpm so a stem always grids', () => {
    const stem = makeItem({ id: 'stem', kind: 'stem', derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 10_000 } })
    expect(resolveSourceBeatGrid(stem, { src: source, stem })?.bpm).toBe(120)
  })

  it('has no grid without a bpm or without beats', () => {
    const noBpm = makeItem({ id: 'nobpm', beats: [0], beatAnchorSec: 0 })
    const noBeats = makeItem({ id: 'nobeats', bpm: 120, beatAnchorSec: 0 })
    expect(resolveSourceBeatGrid(noBpm, { nobpm: noBpm })).toBeNull()
    expect(resolveSourceBeatGrid(noBeats, { nobeats: noBeats })).toBeNull()
  })
})

describe('firstSourceBeatMsAtOrAfter', () => {
  const grid = { bpm: 120, spacingMs: 500, anchorMs: 0 }

  it('returns the window start when it already sits on a beat', () => {
    expect(firstSourceBeatMsAtOrAfter(grid, 500)).toBe(500)
  })

  it('advances to the next beat from mid-beat', () => {
    expect(firstSourceBeatMsAtOrAfter(grid, 100)).toBe(500)
  })

  it('works backwards from before the anchor', () => {
    expect(firstSourceBeatMsAtOrAfter({ ...grid, anchorMs: 250 }, 250)).toBe(250)
    expect(firstSourceBeatMsAtOrAfter({ ...grid, anchorMs: 250 }, 0)).toBe(250)
    expect(firstSourceBeatMsAtOrAfter({ ...grid, anchorMs: 250 }, -300)).toBe(-250)
  })

  it('holds the beat when a split lands a float hair above or below it', () => {
    // Split/trim arithmetic never lands exactly on the beat it cut. A bare `ceil` would
    // skip a whole beat on the "above" case, dropping the clip's leading marker and
    // moving a bar-snapped clip by a beat.
    expect(firstSourceBeatMsAtOrAfter(grid, 500 + 1e-9)).toBe(500)
    expect(firstSourceBeatMsAtOrAfter(grid, 500 - 1e-9)).toBe(500)
  })

  it('still advances for a beat the user genuinely trimmed away', () => {
    expect(firstSourceBeatMsAtOrAfter(grid, 500.5)).toBe(1000)
  })
})

describe('clipFirstBeatOffsetMs', () => {
  const lib = { byId: { lib1: source }, items: [source] }

  it('returns null when the source has no usable beat grid', () => {
    const clip = { libraryItemId: 'none', filePath: 'C:\\b.wav', inMs: 0, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, { byId: {}, items: [] })).toBeNull()
  })

  it('offsets to the first in-window beat (window starting on a beat = 0)', () => {
    const clip = { libraryItemId: 'lib1', filePath: 'C:\\src.wav', inMs: 0, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, lib)).toBe(0)
  })

  it('offsets to the next beat when the window starts mid-beat', () => {
    // Window starts at 100 ms; next beat is 500 ms -> 400 ms offset.
    const clip = { libraryItemId: 'lib1', filePath: 'C:\\src.wav', inMs: 100, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, lib)).toBe(400)
  })

  it('falls back to the file-path lookup when libraryItemId misses', () => {
    const clip = { filePath: 'C:\\src.wav', inMs: 0, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, lib)).toBe(0)
  })

  it('scales the source-time offset to timeline time for warped clips', () => {
    // 400 ms source offset / ratio 2 -> 200 ms timeline offset.
    const clip = {
      libraryItemId: 'lib1',
      filePath: 'C:\\src.wav',
      inMs: 100,
      durationMs: 1000,
      effectiveWarpActive: true,
      effectiveTempoRatio: 2
    }
    expect(clipFirstBeatOffsetMs(clip, lib)).toBe(200)
  })

  it('returns null when no beat falls inside the trim window', () => {
    // Window 100..200 ms contains no beat (beats at 0 / 500 / 1000 ms).
    const clip = { libraryItemId: 'lib1', filePath: 'C:\\src.wav', inMs: 100, durationMs: 100 }
    expect(clipFirstBeatOffsetMs(clip, lib)).toBeNull()
  })

  it('snaps a stem clip on the grid it inherits, matching the drawn markers', () => {
    const stem = makeItem({ id: 'stem', kind: 'stem', derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 10_000 } })
    const stemLib = { byId: { src: source, stem }, items: [source, stem] }
    const clip = { libraryItemId: 'stem', filePath: stem.filePath, inMs: 100, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, stemLib)).toBe(400)
  })

  it('does not snap a simple one-shot, which draws no markers either', () => {
    const oneShot = makeItem({ id: 'hit', bpm: 120, beats: [0], audioType: 'simple' })
    const hitLib = { byId: { hit: oneShot }, items: [oneShot] }
    const clip = { libraryItemId: 'hit', filePath: oneShot.filePath, inMs: 100, durationMs: 1000 }
    expect(clipFirstBeatOffsetMs(clip, hitLib)).toBeNull()
  })
})

// The timeline draws each source beat at `(beatMs - inMs) / tempoRatio` from the clip's
// left edge (see the marker pass in `clipRenderer`). A clip following the project tempo
// must therefore land its markers exactly on the project's own beat grid — that is what
// warping is for — and it has to hold for every kind of item that carries a grid, since
// each kind resolves its BPM differently (own, or inherited from the item it came from).
describe('beat markers on warped clips', () => {
  const PROJECT_BPM = 140
  const projectBeatMs = 60_000 / PROJECT_BPM

  /** The timeline's marker projection: marker positions as ms from the clip's left edge. */
  function markerOffsetsMs(
    grid: { spacingMs: number; anchorMs: number; bpm: number },
    inMs: number,
    durationMs: number,
    tempoRatio: number,
    opts?: { pinned?: boolean; warpActive?: boolean }
  ): number[] {
    const clip = {
      effectiveWarpActive: opts?.warpActive ?? tempoRatio !== 1,
      effectiveTempoRatio: tempoRatio,
      tempoRatio: opts?.pinned === true ? tempoRatio : undefined
    }
    const spacingMs = clipTimelineBeatSpacingMs(clip, grid.spacingMs, PROJECT_BPM)
    const offsets: number[] = []
    const effectiveDurationMs = durationMs / tempoRatio
    const firstOffsetMs = (firstSourceBeatMsAtOrAfter(grid, inMs) - inMs) / tempoRatio
    for (let offset = firstOffsetMs; offset < effectiveDurationMs; offset += spacingMs) {
      offsets.push(offset)
    }
    return offsets
  }

  // Every kind that carries a grid: detected on the item itself, or inherited from the
  // source it was derived from. A saved sample is a new file cut from its source, so its
  // beats/anchor are re-based onto its own timeline (see `inheritSourceAnalysis`) — it
  // therefore carries its own values rather than inheriting them.
  const musicSample = makeItem({
    id: 'smp',
    kind: 'sample',
    audioType: 'music',
    bpm: 120,
    beats: [0, 0.5, 1],
    beatAnchorSec: 0,
    derivedFrom: { sourceItemId: 'src', inMs: 4000, durationMs: 4000 }
  })
  const stem = makeItem({
    id: 'stem',
    kind: 'stem',
    derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 10_000 }
  })
  const savedClip = makeItem({
    id: 'cut',
    kind: 'clip',
    derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 10_000 }
  })
  const byId = { src: source, smp: musicSample, stem, cut: savedClip }

  for (const item of [source, stem, savedClip, musicSample]) {
    it(`spaces a warped ${item.kind}'s markers on the project grid`, () => {
      const grid = resolveSourceBeatGrid(item, byId)
      expect(grid).not.toBeNull()
      // Follow project BPM: ratio = project / source.
      const ratio = PROJECT_BPM / grid!.bpm
      const offsets = markerOffsetsMs(grid!, 0, 4000, ratio)
      expect(offsets.length).toBeGreaterThan(1)
      for (let i = 1; i < offsets.length; ++i) {
        expect(offsets[i]! - offsets[i - 1]!).toBeCloseTo(projectBeatMs, 9)
      }
    })
  }

  it('keeps the first marker on the position the beat-aware snap aligns to', () => {
    // Markers and snap must agree, or a clip snapped to the grid draws its first beat
    // off the line it was snapped to.
    const inMs = 100
    const ratio = PROJECT_BPM / 120
    const grid = resolveSourceBeatGrid(source, byId)!
    const clip = {
      libraryItemId: 'src',
      filePath: source.filePath,
      inMs,
      durationMs: 4000,
      effectiveWarpActive: true,
      effectiveTempoRatio: ratio
    }
    expect(markerOffsetsMs(grid, inMs, 4000, ratio)[0]).toBeCloseTo(
      clipFirstBeatOffsetMs(clip, { byId, items: Object.values(byId) })!,
      9
    )
  })

  it('leaves an unwarped clip on its own source spacing', () => {
    const grid = resolveSourceBeatGrid(source, byId)!
    const offsets = markerOffsetsMs(grid, 0, 2000, 1)
    expect(offsets[1]! - offsets[0]!).toBeCloseTo(500, 9)
  })

  // The regression a reanalysis caused: the item's BPM moved, so the grid rebuilt
  // instantly, but the clip kept the ratio built from the *old* BPM until the backend
  // re-derived it. Deriving the spacing arithmetically (source / ratio) put the markers
  // out by exactly the tempo change; the project tempo is the answer either way.
  it('follows the project tempo even when the clip carries a stale warp ratio', () => {
    const grid = resolveSourceBeatGrid(source, byId)!
    const staleRatio = PROJECT_BPM / 105.8
    const offsets = markerOffsetsMs(grid, 0, 4000, staleRatio)
    expect(offsets.length).toBeGreaterThan(1)
    for (let i = 1; i < offsets.length; ++i) {
      expect(offsets[i]! - offsets[i - 1]!).toBeCloseTo(projectBeatMs, 9)
    }
  })

  // A pinned ratio is a deliberate, fixed stretch that is *not* tracking the project, so
  // its beats sit at the source spacing divided by that ratio.
  it('spaces a pinned warp by its own ratio rather than the project tempo', () => {
    const grid = resolveSourceBeatGrid(source, byId)!
    const offsets = markerOffsetsMs(grid, 0, 4000, 2, { pinned: true })
    expect(offsets.length).toBeGreaterThan(1)
    expect(offsets[1]! - offsets[0]!).toBeCloseTo(250, 9)
  })

  // The Clip Editor and Scratch surfaces show the *source* audio unstretched, with a
  // playhead converted back into source time, so their grid stays at the source spacing
  // whatever warp the timeline clip is under. Drawing the project tempo there would pull
  // the lines off the transients they exist to mark.
  it('keeps the Clip Editor grid at source spacing, independent of any warp', () => {
    for (const item of [source, stem, savedClip, musicSample]) {
      const grid = resolveSourceBeatGrid(item, byId)
      expect(grid?.spacingMs).toBeCloseTo(60_000 / grid!.bpm, 9)
      expect(grid?.spacingMs).toBeCloseTo(500, 9)
    }
  })
})
