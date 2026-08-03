import { describe, expect, it } from 'vitest'
import {
  libraryItemIsSample,
  libraryItemIsSimple,
  libraryItemShowsLinkBadge,
  libraryItemSourceBpm,
  libraryItemTempoUnverified,
  libraryItemWarpSourceBpm,
  stemPartLabel,
  STEM_NAME_SEPARATOR
} from '@/stores/libraryItemHelpers'

const sampleSource = { sourceItemId: 'origin-1', inMs: 0, durationMs: 8_000 }

describe('libraryItemIsSample', () => {
  it('returns false for a nullish item', () => {
    expect(libraryItemIsSample(undefined)).toBe(false)
    expect(libraryItemIsSample(null)).toBe(false)
  })

  it('flags both music and simple saved samples (explicit sample kind)', () => {
    expect(libraryItemIsSample({ kind: 'sample', derivedFrom: sampleSource })).toBe(true)
  })

  it('does NOT flag a music-classified original import', () => {
    // The bug: an ordinary musical import is audioType "music" but is a source
    // kind, so it must never read as a sample.
    expect(libraryItemIsSample({ kind: 'source', audioType: 'music' })).toBe(false)
    expect(libraryItemIsSample({ kind: 'source' })).toBe(false)
  })

  it('does not flag stems or saved clips (they have their own kind)', () => {
    expect(libraryItemIsSample({ kind: 'stem', derivedFrom: sampleSource })).toBe(false)
    expect(libraryItemIsSample({ kind: 'clip', derivedFrom: sampleSource })).toBe(false)
  })
})

describe('libraryItemShowsLinkBadge', () => {
  it('returns false for an undefined item', () => {
    expect(libraryItemShowsLinkBadge(undefined)).toBe(false)
    expect(libraryItemShowsLinkBadge(null)).toBe(false)
  })

  it('flags saved clips as linked', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'clip' })).toBe(true)
  })

  it('flags saved sample assets (explicit sample kind) as linked', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'sample', derivedFrom: sampleSource })).toBe(true)
  })

  it('does not flag a plain or music-classified imported source file', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'source' })).toBe(false)
    expect(libraryItemShowsLinkBadge({ kind: 'source', audioType: 'music' })).toBe(false)
    expect(libraryItemShowsLinkBadge({ kind: 'stem' })).toBe(false)
  })
})

describe('libraryItemIsSimple', () => {
  it('treats a low-confidence detection as music, not simple', () => {
    expect(
      libraryItemIsSimple(
        { lowConfidence: true } as Parameters<typeof libraryItemIsSimple>[0],
        {}
      )
    ).toBe(false)
  })

  it('honours an explicit simple override regardless of confidence', () => {
    expect(libraryItemIsSimple({ audioType: 'simple' }, {})).toBe(true)
  })

  it('honours an explicit music override regardless of confidence', () => {
    expect(libraryItemIsSimple({ audioType: 'music' }, {})).toBe(false)
  })

  it('falls back to the source override for a derived item but ignores source confidence', () => {
    const byId = {
      src: { id: 'src', kind: 'source', audioType: 'simple', lowConfidence: false }
    } as never
    expect(
      libraryItemIsSimple({ derivedFrom: { sourceItemId: 'src' } as never }, byId)
    ).toBe(true)
    const byIdLowConf = {
      src: { id: 'src', kind: 'source', lowConfidence: true }
    } as never
    expect(
      libraryItemIsSimple({ derivedFrom: { sourceItemId: 'src' } as never }, byIdLowConf)
    ).toBe(false)
  })
})

describe('libraryItemTempoUnverified', () => {
  it('flags a low-confidence item with no explicit classification', () => {
    expect(libraryItemTempoUnverified({ lowConfidence: true }, {})).toBe(true)
  })

  it('is cleared once the user sets any explicit classification', () => {
    expect(libraryItemTempoUnverified({ audioType: 'music', lowConfidence: true }, {})).toBe(false)
    expect(libraryItemTempoUnverified({ audioType: 'simple', lowConfidence: true }, {})).toBe(false)
  })

  it('is false for a confident item', () => {
    expect(libraryItemTempoUnverified({ lowConfidence: false }, {})).toBe(false)
  })

  it('inherits the unverified state from an un-overridden source', () => {
    const byId = {
      src: { id: 'src', kind: 'source', lowConfidence: true }
    } as never
    expect(
      libraryItemTempoUnverified({ derivedFrom: { sourceItemId: 'src' } as never }, byId)
    ).toBe(true)
  })
})

describe('libraryItemSourceBpm', () => {
  // The single frontend resolver. Its cases must stay in step with the backend's
  // ProjectState::getLibraryItemBpm — a clip has ONE original tempo, and when the
  // two processes each derived their own it could be drawn stretched but played
  // unwarped.
  const byId = {
    track: { id: 'track', kind: 'source', bpm: 105.5 },
    hit: { id: 'hit', kind: 'sample', audioType: 'simple', derivedFrom: { sourceItemId: 'track', inMs: 0, durationMs: 800 } }
  } as never

  it('prefers the item\u2019s own tempo', () => {
    expect(libraryItemSourceBpm({ kind: 'source', bpm: 105.5 } as never, byId)).toBe(105.5)
  })

  it('inherits the source tempo when the item has none of its own', () => {
    expect(
      libraryItemSourceBpm(
        { kind: 'stem', derivedFrom: { sourceItemId: 'track', inMs: 0, durationMs: 60_000 } } as never,
        byId
      )
    ).toBe(105.5)
  })

  it('resolves no tempo for a one-shot, even with a musical parent', () => {
    expect(
      libraryItemSourceBpm(
        { audioType: 'simple', derivedFrom: { sourceItemId: 'track', inMs: 0, durationMs: 800 } } as never,
        byId
      )
    ).toBeUndefined()
  })

  it('resolves no tempo for a clip cut from a one-shot', () => {
    expect(
      libraryItemSourceBpm(
        { kind: 'clip', derivedFrom: { sourceItemId: 'hit', inMs: 0, durationMs: 400 } } as never,
        byId
      )
    ).toBeUndefined()
  })
})

describe('libraryItemWarpSourceBpm', () => {
  const byId = { src: { id: 'src', kind: 'source', bpm: 128 } } as never

  it('exposes a music sample\u2019s own tempo so it can follow or pin project BPM', () => {
    expect(
      libraryItemWarpSourceBpm(
        { kind: 'sample', bpm: 105.8, audioType: 'music', derivedFrom: sampleSource } as never,
        byId
      )
    ).toBe(105.8)
  })

  it('exposes no tempo for a simple sample, even when its source has one', () => {
    expect(
      libraryItemWarpSourceBpm(
        { kind: 'sample', audioType: 'simple', derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 1_000 } } as never,
        byId
      )
    ).toBeUndefined()
  })

  it('still inherits the source tempo for non-sample derived items', () => {
    expect(
      libraryItemWarpSourceBpm(
        { kind: 'clip', derivedFrom: { sourceItemId: 'src', inMs: 0, durationMs: 1_000 } } as never,
        byId
      )
    ).toBe(128)
  })
})

describe('stemPartLabel', () => {
  it('extracts the part before the separator from a composite stem name', () => {
    expect(stemPartLabel({ name: `Drums ${STEM_NAME_SEPARATOR} Long Train` })).toBe('Drums')
    expect(stemPartLabel({ name: `Vocals ${STEM_NAME_SEPARATOR} A — B` })).toBe('Vocals')
  })

  it('falls back to the whole name when there is no separator (e.g. renamed)', () => {
    expect(stemPartLabel({ name: 'My Custom Stem' })).toBe('My Custom Stem')
  })

  it('returns "Stem" for an empty or missing name', () => {
    expect(stemPartLabel({ name: '   ' })).toBe('Stem')
    expect(stemPartLabel({})).toBe('Stem')
  })
})
