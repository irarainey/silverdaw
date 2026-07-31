import { describe, expect, it } from 'vitest'
import {
  beatRepeatOwnerClipId,
  beatRepeatRegionsForClip,
  trackClipBeatSpans,
  type ClipBeatSpan
} from '@/lib/timeline/beatRepeatAttribution'
import type { BeatRepeatRegion, Clip, Track } from '@/stores/projectTypes'

function clip(id: string, startMs: number, durationMs: number): Clip {
  return {
    id,
    trackId: 't1',
    libraryItemId: 'l1',
    filePath: '',
    fileName: '',
    startMs,
    inMs: 0,
    durationMs,
    sampleRate: 44100,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false
  } as Clip
}

function region(id: string, startBeat: number, lengthBeats: number): BeatRepeatRegion {
  return { id, startBeat, lengthBeats, division: '1/8' }
}

// The spans below are the real ones from a project where each clip is placed four
// beats apart but is only 3.95 beats long, so every clip ends a hair past the beat
// the next region starts on.
const OFF_GRID_SPANS: ClipBeatSpan[] = [
  { id: 'c1', startBeat: 4.072131, endBeat: 8.022601 },
  { id: 'c2', startBeat: 8.072131, endBeat: 12.022601 },
  { id: 'c3', startBeat: 12.072131, endBeat: 16.022601 },
  { id: 'c4', startBeat: 16.072131, endBeat: 20.022601 }
]

describe('beatRepeatOwnerClipId', () => {
  it('ignores the previous clip whose tail grazes the region start', () => {
    expect(beatRepeatOwnerClipId(region('r', 16, 1), OFF_GRID_SPANS)).toBe('c4')
  })

  it('attributes a region wholly inside a clip to that clip', () => {
    expect(beatRepeatOwnerClipId(region('r', 17, 1), OFF_GRID_SPANS)).toBe('c4')
    expect(beatRepeatOwnerClipId(region('r', 7, 1), OFF_GRID_SPANS)).toBe('c1')
  })

  it('returns null when the region overlaps no clip', () => {
    expect(beatRepeatOwnerClipId(region('r', 40, 1), OFF_GRID_SPANS)).toBeNull()
  })

  it('keeps the earlier clip in track order when the overlap is an exact tie', () => {
    const spans: ClipBeatSpan[] = [
      { id: 'early', startBeat: 0, endBeat: 8.5 },
      { id: 'late', startBeat: 8.5, endBeat: 16 }
    ]
    expect(beatRepeatOwnerClipId(region('r', 8, 1), spans)).toBe('early')
  })
})

describe('beatRepeatRegionsForClip', () => {
  it('gives each region to exactly one clip', () => {
    const regions = [region('a', 7, 1), region('b', 16, 1), region('c', 17, 1)]
    expect(beatRepeatRegionsForClip(regions, 'c1', OFF_GRID_SPANS).map((r) => r.id)).toEqual(['a'])
    expect(beatRepeatRegionsForClip(regions, 'c3', OFF_GRID_SPANS)).toEqual([])
    expect(beatRepeatRegionsForClip(regions, 'c4', OFF_GRID_SPANS).map((r) => r.id)).toEqual([
      'b',
      'c'
    ])
  })
})

describe('trackClipBeatSpans', () => {
  it('converts the track clips to beat spans in track order', () => {
    const track = { id: 't1', clipIds: ['c2', 'c1'] } as Track
    const clipsById = { c1: clip('c1', 0, 1000), c2: clip('c2', 2000, 1000) }

    const spans = trackClipBeatSpans(track, clipsById, 120)

    expect(spans).toEqual([
      { id: 'c2', startBeat: 4, endBeat: 6 },
      { id: 'c1', startBeat: 0, endBeat: 2 }
    ])
  })

  it('returns nothing without a track or a usable tempo', () => {
    const track = { id: 't1', clipIds: ['c1'] } as Track
    expect(trackClipBeatSpans(undefined, {}, 120)).toEqual([])
    expect(trackClipBeatSpans(track, { c1: clip('c1', 0, 1000) }, 0)).toEqual([])
  })
})
